import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { PortUtil } from '../utils/PortUtil';

const execAsync = promisify(exec);

export class KongDockerManager {
  private _fileCache: Map<string, string> = new Map();
  constructor(private context: vscode.ExtensionContext) { }

  public getStoragePath(): string {
    const config = vscode.workspace.getConfiguration('kongAgent');
    const customPath = config.get<string>('storagePath');

    const storagePath = customPath || this.context.globalStorageUri.fsPath;

    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }
    return storagePath;
  }

  public async start(): Promise<string> {
    try {
      const config = vscode.workspace.getConfiguration('kongAgent');
      let proxyPort = config.get<number>('proxyPort') || 8000;
      let adminPort = config.get<number>('adminApiPort') || 8001;
      let managerPort = config.get<number>('managerGuiPort') || 8002;
      let dbPort = config.get<number>('databasePort') || 5432;

      // Automatic Port Resolution
      if (await PortUtil.isPortInUse(proxyPort)) {
        vscode.window.showInformationMessage(`Port ${proxyPort} is in use. Finding next available for Proxy...`);
        proxyPort = await PortUtil.findNextAvailablePort(proxyPort);
        await config.update('proxyPort', proxyPort, vscode.ConfigurationTarget.Global);
      }

      if (await PortUtil.isPortInUse(adminPort)) {
        vscode.window.showInformationMessage(`Port ${adminPort} is in use. Finding next available for Admin API...`);
        adminPort = await PortUtil.findNextAvailablePort(adminPort);
        await config.update('adminApiPort', adminPort, vscode.ConfigurationTarget.Global);
      }

      if (await PortUtil.isPortInUse(managerPort)) {
        vscode.window.showInformationMessage(`Port ${managerPort} is in use. Finding next available for Manager GUI...`);
        managerPort = await PortUtil.findNextAvailablePort(managerPort);
        await config.update('managerGuiPort', managerPort, vscode.ConfigurationTarget.Global);
      }

      if (await PortUtil.isPortInUse(dbPort)) {
        vscode.window.showInformationMessage(`Port ${dbPort} is in use. Finding next available for Postgres...`);
        dbPort = await PortUtil.findNextAvailablePort(dbPort);
        await config.update('databasePort', dbPort, vscode.ConfigurationTarget.Global);
      }

      const storagePath = this.getStoragePath();
      const composePath = path.join(storagePath, 'kong-docker-compose.yml');
      const composeContent = this.composeContent(proxyPort, adminPort, managerPort, dbPort);
      fs.writeFileSync(composePath, composeContent, 'utf8');
      this.updateFileCache('kong-docker-compose.yml', composeContent);

      // Open the file in the editor
      const doc = await vscode.workspace.openTextDocument(composePath);
      await vscode.window.showTextDocument(doc);

      vscode.window.showInformationMessage('Kong Agent: Starting Postgres Database...');
      await execAsync('docker-compose -f kong-docker-compose.yml up -d kong-database', { cwd: storagePath });

      vscode.window.showInformationMessage('Kong Agent: Bootstrapping database...');
      await execAsync('docker-compose -f kong-docker-compose.yml run --rm kong kong migrations bootstrap', { cwd: storagePath });

      vscode.window.showInformationMessage('Kong Agent: Starting Kong Gateway...');
      await execAsync('docker-compose -f kong-docker-compose.yml up -d kong', { cwd: storagePath });

      const successMsg = `Kong Gateway started successfully! Here are your access details:

| Component | URL |
| :--- | :--- |
| **Kong Manager (GUI)** | http://localhost:${managerPort} |
| **Admin API** | http://localhost:${adminPort} |
| **Proxy Gateway** | http://localhost:${proxyPort} |
| **Postgres Database** | localhost:${dbPort} |`;

      // Automatically open Kong Manager in browser
      await this.openManager();

      return successMsg;
    } catch (e: any) {
      throw new Error(`Failed to start Kong: ${e.message}`);
    }
  }

  public async openManager(): Promise<string> {
    try {
      const config = vscode.workspace.getConfiguration('kongAgent');
      const managerPort = config.get<number>('managerGuiPort') || 8002;
      const url = `http://localhost:${managerPort}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return `Opened Kong Manager at ${url}`;
    } catch (e: any) {
      return `Failed to open Kong Manager: ${e.message}`;
    }
  }

  public async stop(): Promise<string> {
    try {
      const storagePath = this.getStoragePath();
      await execAsync('docker-compose -f kong-docker-compose.yml down', { cwd: storagePath });
      return "Kong Gateway stopped.";
    } catch (e: any) {
      throw new Error(`Failed to stop Kong: ${e.message}`);
    }
  }

  public async status(): Promise<string> {
    try {
      const storagePath = this.getStoragePath();
      const { stdout } = await execAsync('docker-compose -f kong-docker-compose.yml ps', { cwd: storagePath });
      return `Docker Compose Status:\n${stdout}`;
    } catch (e: any) {
      return `Error fetching status: ${e.message}`;
    }
  }

  public async findExistingContainers(): Promise<string> {
    try {
      // Find any running containers with 'kong' or 'postgres' in the name
      const { stdout: nameOut } = await execAsync('docker ps --format "{{.Id}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}"');
      const lines = nameOut.split('\n').filter(l => l.trim() !== '');

      const existing = lines.filter(line => {
        const parts = line.toLowerCase();
        return parts.includes('kong') || parts.includes('postgres') || parts.includes('database');
      }).map(line => {
        const [id, name, image, status, ports] = line.split('|');
        return { id, name, image, status, ports };
      });

      return JSON.stringify(existing);
    } catch (e) {
      return "[]";
    }
  }

  public async listStorageFiles(): Promise<string[]> {
    try {
      const storagePath = this.getStoragePath();
      if (!fs.existsSync(storagePath)) return [];
      const files = fs.readdirSync(storagePath);
      // Filter for relevant agent-managed files
      return files.filter(f => 
        f.endsWith('.yml') || f.endsWith('.yaml') || f.endsWith('.json') || f.endsWith('.conf')
      );
    } catch (e) {
      return [];
    }
  }

  public async openFile(filename: string): Promise<string> {
    try {
      const storagePath = this.getStoragePath();
      let filePath = path.join(storagePath, filename);

      // Extension Tolerance: if precisely named file not found, check for common kong extensions
      if (!fs.existsSync(filePath)) {
        const altFilename = filename.endsWith('.yml') ? filename.replace('.yml', '.yaml') : (filename.endsWith('.yaml') ? filename.replace('.yaml', '.yml') : null);
        if (altFilename) {
          const altFilePath = path.join(storagePath, altFilename);
          if (fs.existsSync(altFilePath)) {
            filePath = altFilePath;
          }
        }
      }

      if (fs.existsSync(filePath)) {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
        return `Successfully opened '${path.basename(filePath)}' in the editor for you.`;
      } else {
        return `Error: File '${filename}' not found in storage directory (${storagePath}).`;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to open file ${filename}: ${e.message}`);
      return `Error: Failed to open file: ${e.message}`;
    }
  }

  public async writeStorageFile(filename: string, content: string): Promise<void> {
    try {
      const storagePath = this.getStoragePath();
      const filePath = path.join(storagePath, filename);
      fs.writeFileSync(filePath, content, 'utf8');
      this.updateFileCache(filename, content);

      // Try to open it in the editor for visibility
      try {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
      } catch (err) {}
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to write file ${filename}: ${e.message}`);
      throw e;
    }
  }

  public async isDeckInstalled(): Promise<boolean> {
    try {
      await execAsync('deck version');
      return true;
    } catch (e) {
      return false;
    }
  }

  public async installDeck(): Promise<string> {
    try {
      // Step 1: Tap the repo
      await execAsync('brew tap kong/tap');
      // Step 2: Install
      await execAsync('brew install deck');
      return "Successfully installed decK CLI via Homebrew.";
    } catch (e: any) {
      throw new Error(`Failed to install decK: ${e.message}`);
    }
  }

  public async getAdminUrl(isHost: boolean): Promise<string> {
    const config = vscode.workspace.getConfiguration('kongAgent');
    const mode = config.get<string>('kongMode') || 'local';
    
    if (mode === 'remote') {
      return config.get<string>('remoteAdminApiUrl') || 'http://localhost:8001';
    }

    const adminPort = config.get<number>('adminApiPort') || 8001;
    return isHost ? `http://localhost:${adminPort}` : `http://host.docker.internal:${adminPort}`;
  }

  public async getDeckArgs(isHost: boolean): Promise<string[]> {
    const config = vscode.workspace.getConfiguration('kongAgent');
    const adminUrl = await this.getAdminUrl(isHost);
    const args = [`--kong-addr`, adminUrl];

    const workspace = config.get<string>('kongWorkspace');
    if (workspace && workspace !== 'default') {
      args.push('--workspace', workspace);
    }

    const token = config.get<string>('kongAdminToken');
    if (token) {
      args.push('--headers', `Kong-Admin-Token:${token}`);
    }

    if (config.get<boolean>('skipTlsVerify')) {
      args.push('--tls-skip-verify');
    }

    return args;
  }

  public async syncWithDeck(filename: string): Promise<string> {
    try {
      const storagePath = this.getStoragePath();
      const filePath = path.join(storagePath, filename);
      const isHostInstalled = await this.isDeckInstalled();

      if (isHostInstalled) {
        // Option 1: Use Host deck
        const args = await this.getDeckArgs(true);
        let command = `deck gateway sync -s "${filePath}" ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(command);
          return stdout || "Sync completed successfully (Host CLI).";
        } catch (e: any) {
          // Only fallback if the modern 'gateway' command is unrecognized
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            command = `deck sync -s "${filePath}" ${args.join(' ')}`;
            const { stdout } = await execAsync(command);
            return stdout || "Sync completed successfully (Host CLI fallback).";
          }
          throw e; // Rethrow connection or schema errors
        }
      } else {
        // Option 2: Use Docker deck
        const dockerFilePath = `/storage/${filename}`;
        const args = await this.getDeckArgs(false);
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck gateway sync -s "${dockerFilePath}" ${args.join(' ')}`;
        
        try {
          const { stdout } = await execAsync(dockerCommand);
          return stdout || "Sync completed successfully (Dockerized decK).";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            const fallbackDocker = `docker run --rm -v "${storagePath}:/storage" kong/deck sync -s "${dockerFilePath}" ${args.join(' ')}`;
            const { stdout } = await execAsync(fallbackDocker);
            return stdout || "Sync completed successfully (Dockerized fallback).";
          }
          throw e;
        }
      }
    } catch (e: any) {
      if (e.message.includes('docker')) {
        return `decK sync failed: Docker is not running or image 'kong/deck' could not be pulled. \n\nError: ${e.message}`;
      }
      return `decK sync failed: ${e.stderr || e.message}\n\nMake sure your kong.yml is valid and Kong is reachable at ${await this.getAdminUrl(true)}`;
    }
  }

  public async validateWithDeck(filename: string): Promise<string> {
    try {
      const storagePath = this.getStoragePath();
      const filePath = path.join(storagePath, filename);
      const isHostInstalled = await this.isDeckInstalled();

      if (isHostInstalled) {
        // Option 1: Use Host deck
        const args = await this.getDeckArgs(true);
        let command = `deck gateway validate "${filePath}" ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(command);
          return stdout || "Configuration is valid.";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            command = `deck validate -s "${filePath}" ${args.join(' ')}`;
            const { stdout } = await execAsync(command);
            return stdout || "Configuration is valid (fallback mode).";
          }
          throw e;
        }
      } else {
        // Option 2: Use Docker deck
        const dockerFilePath = `/storage/${filename}`;
        const args = await this.getDeckArgs(false);
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck gateway validate -s "${dockerFilePath}" ${args.join(' ')}`;
        
        try {
          const { stdout } = await execAsync(dockerCommand);
          return stdout || "Configuration is valid (Dockerized decK).";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            const fallbackDocker = `docker run --rm -v "${storagePath}:/storage" kong/deck validate -s "${dockerFilePath}" ${args.join(' ')}`;
            const { stdout } = await execAsync(fallbackDocker);
            return stdout || "Configuration is valid (Dockerized fallback).";
          }
          throw e;
        }
      }
    } catch (e: any) {
      return `Validation failed: ${e.stderr || e.message}`;
    }
  }

  public async dumpWithDeck(filename: string): Promise<string> {
    try {
      const storagePath = this.getStoragePath();
      const filePath = path.join(storagePath, filename);
      const isHostInstalled = await this.isDeckInstalled();

      if (isHostInstalled) {
        // Option 1: Use Host deck
        const args = await this.getDeckArgs(true);
        let command = `deck gateway dump -o "${filePath}" ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(command);
          return stdout || `Exported configuration to ${filename} (Host CLI).`;
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            command = `deck dump -o "${filePath}" ${args.join(' ')}`;
            const { stdout } = await execAsync(command);
            return stdout || `Exported configuration to ${filename} (Host CLI fallback).`;
          }
          throw e;
        }
      } else {
        // Option 2: Use Docker deck (Volume-less for reliability)
        const args = await this.getDeckArgs(false);
        const dockerCommand = `docker run --rm kong/deck gateway dump ${args.join(' ')}`;
        
        try {
          const { stdout } = await execAsync(dockerCommand);
          if (stdout && stdout.trim().length > 0) {
            fs.writeFileSync(filePath, stdout);
            return `Exported configuration to ${filename} (Dockerized decK - Volume-less).`;
          }
          throw new Error("decK dump returned empty output.");
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            const fallbackDocker = `docker run --rm kong/deck dump ${args.join(' ')}`;
            const { stdout } = await execAsync(fallbackDocker);
            if (stdout && stdout.trim().length > 0) {
              fs.writeFileSync(filePath, stdout);
              return `Exported configuration to ${filename} (Dockerized fallback - Volume-less).`;
            }
          }
          throw e;
        }
      }
    } catch (e: any) {
      return `decK dump failed: ${e.stderr || e.message}`;
    }
  }

  public async resetWithDeck(): Promise<string> {
    try {
      const isHostInstalled = await this.isDeckInstalled();

      if (isHostInstalled) {
        // Option 1: Use Host deck
        const args = await this.getDeckArgs(true);
        let command = `deck gateway reset --force ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(command);
          return stdout || "Kong configuration reset successfully (Host CLI).";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            command = `deck reset --force ${args.join(' ')}`;
            const { stdout } = await execAsync(command);
            return stdout || "Kong configuration reset successfully (Host CLI fallback).";
          }
          throw e;
        }
      } else {
        // Option 2: Use Docker deck
        const storagePath = this.getStoragePath();
        const args = await this.getDeckArgs(false);
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck gateway reset --force ${args.join(' ')}`;
        
        try {
          const { stdout } = await execAsync(dockerCommand);
          return stdout || "Kong configuration reset successfully (Dockerized decK).";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            const fallbackDocker = `docker run --rm -v "${storagePath}:/storage" kong/deck reset --force ${args.join(' ')}`;
            const { stdout } = await execAsync(fallbackDocker);
            return stdout || "Kong configuration reset successfully (Dockerized fallback).";
          }
          throw e;
        }
      }
    } catch (e: any) {
      return `decK reset failed: ${e.stderr || e.message}`;
    }
  }

  public async diffWithDeck(filename: string): Promise<string> {
    try {
      const storagePath = this.getStoragePath();
      const filePath = path.join(storagePath, filename);
      const isHostInstalled = await this.isDeckInstalled();

      if (isHostInstalled) {
        // Option 1: Use Host deck
        const args = await this.getDeckArgs(true);
        let command = `deck gateway diff "${filePath}" ${args.join(' ')}`;
        try {
          const { stdout, stderr } = await execAsync(command);
          return stdout || stderr || "No differences found. Configuration is in sync.";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            command = `deck diff -s "${filePath}" ${args.join(' ')}`;
            const { stdout, stderr } = await execAsync(command);
            return stdout || stderr || "No differences found (fallback diff).";
          }
          
          // Some deck versions return non-zero exit code if differences exist
          if (e.stdout || e.stderr) {
            return e.stdout + e.stderr;
          }
          throw e;
        }
      } else {
        // Option 2: Use Docker deck
        const dockerFilePath = `/storage/${filename}`;
        const args = await this.getDeckArgs(false);
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck gateway diff -s "${dockerFilePath}" ${args.join(' ')}`;
        
        try {
          const { stdout, stderr } = await execAsync(dockerCommand);
          return stdout || stderr || "No differences found (Dockerized decK).";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            const fallbackDocker = `docker run --rm -v "${storagePath}:/storage" kong/deck diff -s "${dockerFilePath}" ${args.join(' ')}`;
            const { stdout, stderr } = await execAsync(fallbackDocker);
            return stdout || stderr || "No differences found (Dockerized fallback).";
          }
          
          if (e.stdout || e.stderr) {
            return e.stdout + e.stderr;
          }
          throw e;
        }
      }
    } catch (e: any) {
      return `decK diff failed: ${e.stderr || e.message}`;
    }
  }

  public updateFileCache(filename: string, content: string) {
    this._fileCache.set(filename, content);
  }

  public getFileCache(filename: string): string | undefined {
    return this._fileCache.get(filename);
  }

  public async initializeCache() {
    try {
      const storagePath = this.getStoragePath();
      if (!fs.existsSync(storagePath)) return;

      const files = fs.readdirSync(storagePath);
      for (const file of files) {
        if (file.endsWith('.yml') || file.endsWith('.yaml') || file.endsWith('.json')) {
          const fullPath = path.join(storagePath, file);
          const content = fs.readFileSync(fullPath, 'utf8');
          this._fileCache.set(file, content);
        }
      }
    } catch (e) {
      console.error(`Failed to initialize cache: ${e}`);
    }
  }

  public async verifyConnectivity(): Promise<{ admin: boolean, proxy: boolean, error?: string }> {
    const config = vscode.workspace.getConfiguration('kongAgent');
    const proxyPort = config.get<number>('proxyPort') || 8000;
    const adminPort = config.get<number>('adminApiPort') || 8001;

    const results = { admin: false, proxy: false, error: "" };

    try {
      // Check Admin API
      try {
        const adminResp = await axios.get(`http://localhost:${adminPort}/`, { timeout: 2000 });
        results.admin = adminResp.status === 200;
      } catch (e: any) {
        results.error += `Admin API unreachable: ${e.message}. `;
      }

      // Check Proxy
      try {
        // Proxy might return 404 if no routes, but that means it's ALIVE
        const proxyResp = await axios.get(`http://localhost:${proxyPort}/`, { timeout: 2000, validateStatus: () => true });
        results.proxy = proxyResp.status !== 0;
      } catch (e: any) {
        results.error += `Proxy unreachable: ${e.message}. `;
      }

      return results;
    } catch (e: any) {
      return { admin: false, proxy: false, error: e.message };
    }
  }

  private composeContent(proxyPort: number, adminPort: number, managerPort: number, dbPort: number): string {
    return `version: '3.9'
x-kong-config: &kong-env
  KONG_DATABASE: postgres
  KONG_PG_HOST: kong-database
  KONG_PG_USER: kong
  KONG_PG_PASSWORD: kongpass
  KONG_PG_PORT: 5432
  KONG_PROXY_ACCESS_LOG: /dev/stdout
  KONG_ADMIN_ACCESS_LOG: /dev/stdout
  KONG_PROXY_ERROR_LOG: /dev/stderr
  KONG_ADMIN_ERROR_LOG: /dev/stderr
  KONG_ADMIN_LISTEN: 0.0.0.0:8001, 0.0.0.0:8444 ssl
  KONG_ADMIN_GUI_LISTEN: 0.0.0.0:8002, 0.0.0.0:8445 ssl
  KONG_ADMIN_GUI_URL: http://localhost:${managerPort}
  KONG_ADMIN_API_URI: http://localhost:${adminPort}
  KONG_ADMIN_GUI_API_URL: http://localhost:${adminPort}
  KONG_ADMIN_ACCESS_CONTROL_ALLOW_ORIGIN: "*"
  KONG_ADMIN_ACCESS_CONTROL_ALLOW_METHODS: "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD"
  KONG_ADMIN_ACCESS_CONTROL_ALLOW_HEADERS: "Content-Type, Authorization"

networks:
  kong-net:
    driver: bridge

volumes:
  kong_data: {}

services:
  kong-database:
    image: postgres:13
    environment:
      POSTGRES_USER: kong
      POSTGRES_DB: kong
      POSTGRES_PASSWORD: kongpass
    ports:
      - "${dbPort}:5432"
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "kong"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - kong-net
    volumes:
      - kong_data:/var/lib/postgresql/data

  kong:
    image: kong:latest
    depends_on:
      kong-database:
        condition: service_healthy
    environment:
      <<: *kong-env
    ports:
      - "${proxyPort}:8000"
      - "8443:8443"
      - "${adminPort}:8001"
      - "8444:8444"
      - "${managerPort}:8002"
      - "8445:8445"
    networks:
      - kong-net
`;
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { PortUtil } from '../../utils/PortUtil';
import { StorageTool } from './StorageTool';
import { IConfig, IAppPlatform } from '../../interfaces/ICoreInterfaces';

const execAsync = promisify(exec);

export class DockerTool {
  constructor(private storage: StorageTool, private config: IConfig, private platform: IAppPlatform) { }

  public async start(): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      const discovered = await this.storage.findFilesByContent();
      
      let composeFile = discovered.compose || 'kong-docker-compose.yml';
      let composePath = path.join(storagePath, composeFile);
      const isExisting = fs.existsSync(composePath);

      let proxyPort = this.config.get<number>('proxyPort') || 8000;
      let adminPort = this.config.get<number>('adminApiPort') || 8001;
      let managerPort = this.config.get<number>('managerGuiPort') || 8002;
      let dbPort = this.config.get<number>('databasePort') || 5432;

      // Only perform bootstrapping and port resolution if the file does NOT exist
      if (!isExisting) {
        this.platform.showInformationMessage(`No existing Docker Compose found. Bootstrapping at ${composeFile}...`);
        
        if (await PortUtil.isPortInUse(proxyPort)) {
          proxyPort = await PortUtil.findNextAvailablePort(proxyPort);
          await this.config.update?.('proxyPort', proxyPort);
        }

        if (await PortUtil.isPortInUse(adminPort)) {
          adminPort = await PortUtil.findNextAvailablePort(adminPort);
          await this.config.update?.('adminApiPort', adminPort);
        }

        if (await PortUtil.isPortInUse(managerPort)) {
          managerPort = await PortUtil.findNextAvailablePort(managerPort);
          await this.config.update?.('managerGuiPort', managerPort);
        }

        if (await PortUtil.isPortInUse(dbPort)) {
          dbPort = await PortUtil.findNextAvailablePort(dbPort);
          await this.config.update?.('databasePort', dbPort);
        }

        const composeContent = this.composeContent(proxyPort, adminPort, managerPort, dbPort);
        fs.writeFileSync(composePath, composeContent, 'utf8');
        this.storage.updateFileCache(composeFile, composeContent);
      } else {
          this.platform.showInformationMessage(`Using existing configuration: ${composeFile}`);
          // Ensure we are using the ports FROM the file for the final success message
          const filePorts = await this.getPortsFromComposeFile();
          proxyPort = filePorts.proxyPort || proxyPort;
          adminPort = filePorts.adminApiPort || adminPort;
          managerPort = filePorts.managerGuiPort || managerPort;
          dbPort = filePorts.databasePort || dbPort;
      }

      await this.platform.openFileInEditor(composePath);

      this.platform.showInformationMessage('Kong Agent: Starting Postgres Database...');
      await execAsync(`docker-compose -f "${composeFile}" up -d kong-database`, { cwd: storagePath });

      this.platform.showInformationMessage('Kong Agent: Bootstrapping database...');
      // Note: We skip bootstrap if it's already done (Postgres exists), but docker-compose run is safe to re-run.
      await execAsync(`docker-compose -f "${composeFile}" run --rm kong kong migrations bootstrap`, { cwd: storagePath });

      this.platform.showInformationMessage('Kong Agent: Starting Kong Gateway...');
      await execAsync(`docker-compose -f "${composeFile}" up -d kong`, { cwd: storagePath });

      const successMsg = `Kong Gateway started successfully! Here are your access details:

| Component | URL |
| :--- | :--- |
| **Kong Manager (GUI)** | http://localhost:${managerPort} |
| **Admin API** | http://localhost:${adminPort} |
| **Proxy Gateway** | http://localhost:${proxyPort} |
| **Postgres Database** | localhost:${dbPort} |`;

      await this.openManager();

      return successMsg;
    } catch (e: any) {
      throw new Error(`Failed to start Kong: ${e.message}`);
    }
  }

  public async stop(): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      await execAsync('docker-compose -f kong-docker-compose.yml down', { cwd: storagePath });
      return "Kong Gateway stopped.";
    } catch (e: any) {
      throw new Error(`Failed to stop Kong: ${e.message}`);
    }
  }

  public async status(): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      const { stdout } = await execAsync('docker-compose -f kong-docker-compose.yml ps', { cwd: storagePath });
      return `Docker Compose Status:\n${stdout}`;
    } catch (e: any) {
      return `Error fetching status: ${e.message}`;
    }
  }

  public async findExistingContainers(): Promise<string> {
    try {
      const { stdout: nameOut } = await execAsync('docker ps --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}"');
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

  public async verifyConnectivity(): Promise<{ admin: boolean, proxy: boolean, error?: string }> {
      let proxyPort = this.config.get<number>('proxyPort') || 8000;
      let adminPort = this.config.get<number>('adminApiPort') || 8001;

    const results = { admin: false, proxy: false, error: "" };
    try {
      try {
        const adminResp = await axios.get(`http://localhost:${adminPort}/`, { timeout: 2000 });
        results.admin = adminResp.status === 200;
      } catch (e: any) {
        results.error += `Admin API unreachable: ${e.message}. `;
      }

      try {
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

  public async openManager(): Promise<string> {
    try {
      const managerPort = this.config.get<number>('managerGuiPort') || 8002;
      const url = `http://localhost:${managerPort}`;
      await this.platform.openExternal(url);
      return `Opened Kong Manager at ${url}`;
    } catch (e: any) {
      return `Failed to open Kong Manager: ${e.message}`;
    }
  }

  public async getPortsFromRunningContainers(): Promise<Record<string, number>> {
      try {
          const { stdout } = await execAsync('docker ps --format "{{.Ports}}|{{.Image}}"');
          const lines = stdout.split('\n').filter(l => l.trim() !== '');
          const detected: Record<string, number> = {};

          for (const line of lines) {
              const [ports, image] = line.split('|');
              if (!ports || !image) continue;

              // Extract mappings like 0.0.0.0:8003->8001/tcp
              const mappings = ports.split(',').map(p => p.trim());
              for (const mapping of mappings) {
                  const match = mapping.match(/:(\d+)->(\d+)\/tcp/);
                  if (match) {
                      const external = parseInt(match[1]);
                      const internal = parseInt(match[2]);

                      if (image.includes('kong')) {
                          if (internal === 8000) detected.proxyPort = external;
                          if (internal === 8001) detected.adminApiPort = external;
                          if (internal === 8002) detected.managerGuiPort = external;
                      } else if (image.includes('postgres')) {
                          if (internal === 5432) detected.databasePort = external;
                      }
                  }
              }
          }
          return detected;
      } catch (e) {
          console.error("Failed to detect ports from containers:", e);
          return {};
      }
  }

  public async getPortsFromComposeFile(): Promise<Record<string, number>> {
      try {
          const storagePath = this.storage.getStoragePath();
          const composePath = path.join(storagePath, 'kong-docker-compose.yml');
          if (!fs.existsSync(composePath)) return {};

          const content = fs.readFileSync(composePath, 'utf8');
          const detected: Record<string, number> = {};

          // Extract ports using regex from the YAML
          // Matches line "- "8003:8001"" or "- 8003:8001"
          const extractPort = (internalPort: number) => {
              const regex = new RegExp(`["']?(\\d+)["']?:${internalPort}`, 'g');
              const match = regex.exec(content);
              return match ? parseInt(match[1]) : null;
          };

          const proxy = extractPort(8000);
          const admin = extractPort(8001);
          const manager = extractPort(8002);
          const db = extractPort(5432);

          if (proxy) detected.proxyPort = proxy;
          if (admin) detected.adminApiPort = admin;
          if (manager) detected.managerGuiPort = manager;
          if (db) detected.databasePort = db;

          return detected;
      } catch (e) {
          console.error("Failed to detect ports from compose file:", e);
          return {};
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

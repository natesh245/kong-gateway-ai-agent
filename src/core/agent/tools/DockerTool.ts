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

  public async start(signal?: AbortSignal): Promise<string> {
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

      // Only perform bootstrapping if NO compose file was identified by content
      if (!isExisting && !discovered.compose) {
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
      await execAsync(`docker-compose -f "${composeFile}" up -d kong-database`, { cwd: storagePath, signal });

      this.platform.showInformationMessage('Kong Agent: Bootstrapping database...');
      // Note: We skip bootstrap if it's already done (Postgres exists), but docker-compose run is safe to re-run.
      await execAsync(`docker-compose -f "${composeFile}" run --rm kong kong migrations bootstrap`, { cwd: storagePath, signal });

      this.platform.showInformationMessage('Kong Agent: Starting Kong Gateway...');
      await execAsync(`docker-compose -f "${composeFile}" up -d kong`, { cwd: storagePath, signal });

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
      if (e.name === 'AbortError') throw e;
      throw new Error(`Failed to start Kong: ${e.message}`);
    }
  }

  public async stop(signal?: AbortSignal): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      const discovered = await this.storage.findFilesByContent();
      const composeFile = discovered.compose || 'kong-docker-compose.yml';
      
      await execAsync(`docker-compose -f "${composeFile}" down`, { cwd: storagePath, signal });
      return "Kong Gateway stopped.";
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      throw new Error(`Failed to stop Kong: ${e.message}`);
    }
  }


  public async status(signal?: AbortSignal): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      const discovered = await this.storage.findFilesByContent();
      const composeFile = discovered.compose || 'kong-docker-compose.yml';

      const { stdout } = await execAsync(`docker-compose -f "${composeFile}" ps`, { cwd: storagePath, signal });
      return `Docker Compose Status:\n${stdout}`;
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `Error fetching status: ${e.message}`;
    }
  }


  public async findExistingContainers(signal?: AbortSignal): Promise<string> {
    try {
      const { stdout: nameOut } = await execAsync('docker ps --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}"', { signal });
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

  private getAdminUrl(): string {
    const mode = this.config.get<string>('kongMode') || 'local';
    if (mode === 'remote') {
      return this.config.get<string>('remoteAdminApiUrl') || 'http://localhost:8001';
    }
    const adminPort = this.config.get<number>('adminApiPort') || 8001;
    return `http://localhost:${adminPort}`;
  }

  private getManagerUrl(): string {
    const mode = this.config.get<string>('kongMode') || 'local';
    if (mode === 'remote') {
      const remoteManager = this.config.get<string>('remoteManagerGuiUrl');
      const remoteAdmin = this.config.get<string>('remoteAdminApiUrl');
      return remoteManager || (remoteAdmin ? remoteAdmin.replace(/:(\d+)\/?$/, ':8002') : 'http://localhost:8002');
    }
    const managerPort = this.config.get<number>('managerGuiPort') || 8002;
    return `http://localhost:${managerPort}`;
  }

  public async verifyConnectivity(): Promise<{ admin: boolean, proxy: boolean, error?: string }> {
    const proxyPort = this.config.get<number>('proxyPort') || 8000;
    const adminUrl = this.getAdminUrl();
    const proxyUrl = this.config.get<string>('remoteProxyUrl') || `http://localhost:${proxyPort}`;

    const results = { admin: false, proxy: false, error: "" };
    try {
      try {
        const adminResp = await axios.get(`${adminUrl.replace(/\/$/, '')}/`, { timeout: 2000 });
        results.admin = adminResp.status === 200;
      } catch (e: any) {
        results.error += `Admin API unreachable at ${adminUrl}: ${e.message}. `;
      }

      try {
        const proxyResp = await axios.get(`${proxyUrl.replace(/\/$/, '')}/`, { timeout: 2000, validateStatus: () => true });
        results.proxy = proxyResp.status !== 0;
      } catch (e: any) {
        results.error += `Proxy unreachable at ${proxyUrl}: ${e.message}. `;
      }
      return results;
    } catch (e: any) {
      return { admin: false, proxy: false, error: e.message };
    }
  }

  public async getKongConfig(): Promise<any> {
    const adminUrl = this.getAdminUrl();
    try {
      const resp = await axios.get(`${adminUrl.replace(/\/$/, '')}/`, { timeout: 2000 });
      return resp.data;
    } catch (e: any) {
      return { error: `Failed to fetch Kong config from ${adminUrl}: ${e.message}` };
    }
  }

  public async openManager(): Promise<string> {
    try {
      const url = this.getManagerUrl();
      await this.platform.openExternal(url);
      return `Opened Kong Manager at ${url}`;
    } catch (e: any) {
      return `Failed to open Kong Manager: ${e.message}`;
    }
  }

  public async listEntities(entity: string): Promise<string> {
    const adminUrl = this.getAdminUrl();
    try {
      const url = `${adminUrl.replace(/\/$/, '')}/${entity}`;
      const resp = await axios.get(url, { timeout: 5000 });
      const data = resp.data.data || [];
      
      if (data.length === 0) {
          return `No ${entity} found in the current Kong instance.`;
      }

      // Return a concise summary if there are many, otherwise full JSON
      if (data.length > 20) {
          const names = data.map((d: any) => d.name || d.id).join(', ');
          return `Found ${data.length} ${entity}: ${names}`;
      }
      
      return JSON.stringify(data, null, 2);
    } catch (e: any) {
      return `Error fetching ${entity} from Kong Admin API (${adminUrl}): ${e.message}`;
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
          const discovered = await this.storage.findFilesByContent();
          const composeFile = discovered.compose || 'kong-docker-compose.yml';
          const composePath = path.join(storagePath, composeFile);
          if (!fs.existsSync(composePath)) return {};


          const content = fs.readFileSync(composePath, 'utf8');
          const detected: Record<string, number> = {};

          // Extract ports using regex from the YAML
          // Matches line "- "8003:8001"" or "- 127.0.0.1:8003:8001"
          const extractPort = (internalPort: number) => {
              const regex = new RegExp(`^\\s*-\\s+["']?(?:[0-9.]+:)?(\\d+)["']?:${internalPort}\\b`, 'm');
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

  public async updatePortsInComposeFile(updatedPorts: Record<string, number>): Promise<string | null> {
      try {
          const storagePath = this.storage.getStoragePath();
          const discovered = await this.storage.findFilesByContent();
          const composeFile = discovered.compose;
          
          if (!composeFile) {
              return null; // No compose file found to sync with
          }

          const composePath = path.join(storagePath, composeFile);
          if (!fs.existsSync(composePath)) {
              return null;
          }

          let content = fs.readFileSync(composePath, 'utf8');
          const updates: string[] = [];

          const updatePortMapping = (internalPort: number, label: string, newPort?: number) => {
              if (newPort) {
                  // ^\s*-\s+["']?(?:[0-9.]+::?)?(\d+)["']?:8001\b
                  const regex = new RegExp(`(^\\s*-\\s+["']?(?:[0-9.]+:)?)((\\d+))(["']?:${internalPort}\\b)`, 'gm');
                  let didReplace = false;
                  content = content.replace(regex, (match, prefix, oldExternal, portNum, suffix) => {
                      didReplace = true;
                      return `${prefix}${newPort}${suffix}`;
                  });
                  if (didReplace) updates.push(`- ${label} → ${newPort}`);
              }
          };

          const updateEnvVar = (envVar: string, newPort?: number) => {
              if (newPort) {
                  const regex = new RegExp(`(${envVar}:\\s*)(.*)`, 'g');
                  content = content.replace(regex, `$1http://localhost:${newPort}`);
              }
          };

          updatePortMapping(8000, "Proxy Request Port", updatedPorts.proxyPort);
          updatePortMapping(8001, "Admin API Port", updatedPorts.adminApiPort);
          updatePortMapping(8002, "Kong Manager Port", updatedPorts.managerGuiPort);
          updatePortMapping(5432, "Database Port", updatedPorts.databasePort);

          updateEnvVar('KONG_ADMIN_GUI_URL', updatedPorts.managerGuiPort);
          updateEnvVar('KONG_ADMIN_API_URI', updatedPorts.adminApiPort);
          updateEnvVar('KONG_ADMIN_GUI_API_URL', updatedPorts.adminApiPort);

          if (updates.length > 0) {
              fs.writeFileSync(composePath, content, 'utf8');
              this.storage.updateFileCache(composeFile, content);
              return updates.join('\\n');
          }

          return null; // No matching lines were replaced
      } catch (e: any) {
          throw new Error(`Failed to update Docker Compose ports: ${e.message}`);
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

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
    constructor(private context: vscode.ExtensionContext) {}

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
            const proxyPort = config.get<number>('proxyPort') || 8000;
            const adminPort = config.get<number>('adminApiPort') || 8001;
            const managerPort = config.get<number>('managerGuiPort') || 8002;

            // Pre-flight check
            const conflicts: number[] = [];
            if (await PortUtil.isPortInUse(proxyPort)) conflicts.push(proxyPort);
            if (await PortUtil.isPortInUse(adminPort)) conflicts.push(adminPort);
            if (await PortUtil.isPortInUse(managerPort)) conflicts.push(managerPort);

            if (conflicts.length > 0) {
                const suggestedProxy = await PortUtil.findNextAvailablePort(proxyPort);
                const suggestedAdmin = await PortUtil.findNextAvailablePort(adminPort);
                const suggestedManager = await PortUtil.findNextAvailablePort(managerPort);

                throw new Error(
                    `PORT_CONFLICT: The following ports are already in use: ${conflicts.join(', ')}. ` +
                    `Suggested alternatives: Proxy=${suggestedProxy}, Admin=${suggestedAdmin}, Manager=${suggestedManager}. ` +
                    `Please update your settings and try again.`
                );
            }

            const storagePath = this.getStoragePath();
            const composePath = path.join(storagePath, 'kong-docker-compose.yml');
            const composeContent = this.composeContent(proxyPort, adminPort, managerPort);
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
| **Proxy Gateway** | http://localhost:${proxyPort} |`;

            // Automatically open Kong Manager in browser
            vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${managerPort}`));

            return successMsg;
        } catch (e: any) {
            throw new Error(`Failed to start Kong: ${e.message}`);
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

    private composeContent(proxyPort: number, adminPort: number, managerPort: number): string {
        return `version: '3.9'
x-kong-config: &kong-env
  KONG_DATABASE: postgres
  KONG_PG_HOST: kong-database
  KONG_PG_USER: kong
  KONG_PG_PASSWORD: kongpass
  KONG_PROXY_ACCESS_LOG: /dev/stdout
  KONG_ADMIN_ACCESS_LOG: /dev/stdout
  KONG_PROXY_ERROR_LOG: /dev/stderr
  KONG_ADMIN_ERROR_LOG: /dev/stderr
  KONG_ADMIN_LISTEN: 0.0.0.0:8001, 0.0.0.0:8444 ssl
  KONG_ADMIN_GUI_LISTEN: 0.0.0.0:8002, 0.0.0.0:8445 ssl
  KONG_ADMIN_GUI_URL: http://localhost:${managerPort}
  KONG_ADMIN_API_URI: http://localhost:${adminPort}
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
      - "5432:5432"
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

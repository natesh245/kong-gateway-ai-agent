import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class KongDockerManager {
    constructor(private context: vscode.ExtensionContext) {}

    private getStoragePath(): string {
        const storagePath = this.context.globalStorageUri.fsPath;
        if (!fs.existsSync(storagePath)) {
            fs.mkdirSync(storagePath, { recursive: true });
        }
        return storagePath;
    }

    public async start(): Promise<string> {
        try {
            const storagePath = this.getStoragePath();
            const composePath = path.join(storagePath, 'kong-docker-compose.yml');
            fs.writeFileSync(composePath, this.composeContent(), 'utf8');

            vscode.window.showInformationMessage('Kong Agent: Starting Postgres Database...');
            await execAsync('docker-compose -f kong-docker-compose.yml up -d kong-database', { cwd: storagePath });
            
            vscode.window.showInformationMessage('Kong Agent: Bootstrapping database...');
            await execAsync('docker-compose -f kong-docker-compose.yml run --rm kong kong migrations bootstrap', { cwd: storagePath });
            
            vscode.window.showInformationMessage('Kong Agent: Starting Kong Gateway...');
            await execAsync('docker-compose -f kong-docker-compose.yml up -d kong', { cwd: storagePath });
            
            return "Kong Gateway and Postgres Database started successfully (Ports: 8002, 8001).";
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

    private composeContent(): string {
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
      - "8002:8000"
      - "8443:8443"
      - "8001:8001"
      - "8444:8444"
    networks:
      - kong-net
`;
    }
}

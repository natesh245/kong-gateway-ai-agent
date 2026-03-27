import axios from 'axios';
import * as vscode from 'vscode';

export class KongApiClient {
    private getBaseUrl(): string {
        const config = vscode.workspace.getConfiguration('kongAgent');
        const mode = config.get<string>('kongMode') || 'local';
        
        if (mode === 'remote') {
            return config.get<string>('remoteAdminApiUrl') || 'http://localhost:8001';
        }

        const adminPort = config.get<number>('adminApiPort') || 8001;
        return `http://localhost:${adminPort}`;
    }

    public async getStatus(): Promise<string> {
        try {
            const res = await axios.get(`${this.getBaseUrl()}/status`);
            return JSON.stringify(res.data, null, 2);
        } catch (e: any) {
            return `Kong Admin API unreachable: ${e.message}`;
        }
    }

    public async getInstanceInfo(): Promise<string> {
        try {
            const res = await axios.get(`${this.getBaseUrl()}/`);
            return JSON.stringify(res.data, null, 2);
        } catch (e: any) {
            return `Failed to fetch instance info: ${e.message}`;
        }
    }

    public async createService(name: string, url: string): Promise<string> {
        try {
            const res = await axios.post(`${this.getBaseUrl()}/services`, {
                name,
                url
            });
            return `Service created successfully: ${JSON.stringify(res.data.id)}`;
        } catch (e: any) {
            return `Failed to create service: ${e.response?.data?.message || e.message}`;
        }
    }

    public async createRoute(serviceName: string, paths: string[]): Promise<string> {
        try {
            const res = await axios.post(`${this.getBaseUrl()}/services/${serviceName}/routes`, {
                paths,
                name: `${serviceName}-route`
            });
            return `Route created successfully: ${JSON.stringify(res.data.id)}`;
        } catch (e: any) {
             return `Failed to create route: ${e.response?.data?.message || e.message}`;
        }
    }

    public async createConsumer(username: string): Promise<string> {
        try {
            const res = await axios.post(`${this.getBaseUrl()}/consumers`, {
                username
            });
            return `Consumer created successfully: ${JSON.stringify(res.data.id)}`;
        } catch (e: any) {
             return `Failed to create consumer: ${e.response?.data?.message || e.message}`;
        }
    }

    public async getDeclarativeConfig(): Promise<string> {
        try {
            const baseUrl = this.getBaseUrl();
            const servicesRes = await axios.get(`${baseUrl}/services`);
            const routesRes = await axios.get(`${baseUrl}/routes`);

            const services = servicesRes.data.data || [];
            const routes = routesRes.data.data || [];

            let yaml = `_format_version: "3.0"\nservices:\n`;

            for (const svc of services) {
                yaml += `  - name: ${svc.name}\n`;
                yaml += `    url: ${svc.protocol}://${svc.host}${svc.port ? ':' + svc.port : ''}${svc.path || ''}\n`;
                
                const svcRoutes = routes.filter((r: any) => r.service && r.service.id === svc.id);
                if (svcRoutes.length > 0) {
                    yaml += `    routes:\n`;
                    for (const route of svcRoutes) {
                        yaml += `      - name: ${route.name || 'unnamed-route'}\n`;
                        yaml += `        paths:\n`;
                        for (const p of (route.paths || [])) {
                            yaml += `          - ${p}\n`;
                        }
                    }
                }
            }

            return yaml;
        } catch (e: any) {
            throw new Error(`Failed to fetch declarative config: ${e.message}`);
        }
    }

    /**
     * Helper to apply a service and its routes to Kong.
     * Returns a status message for each.
     */
    public async applyServiceState(svc: { name: string, url: string, routes?: any[] }): Promise<string[]> {
        const logs: string[] = [];
        try {
            // Attempt to create service
            const svcResult = await this.createService(svc.name, svc.url);
            logs.push(`Service '${svc.name}': ${svcResult}`);

            if (svc.routes) {
                for (const route of svc.routes) {
                    const routeResult = await this.createRoute(svc.name, route.paths);
                    logs.push(`  Route '${route.name || 'unnamed'}': ${routeResult}`);
                }
            }
        } catch (e: any) {
            logs.push(`Error applying service '${svc.name}': ${e.message}`);
        }
        return logs;
    }
}

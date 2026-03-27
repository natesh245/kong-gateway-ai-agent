import axios from 'axios';
import * as vscode from 'vscode';

export class KongApiClient {
    private getBaseUrl(): string {
        const config = vscode.workspace.getConfiguration('kongAgent');
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
}

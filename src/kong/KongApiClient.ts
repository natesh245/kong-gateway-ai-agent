import axios from 'axios';

export class KongApiClient {
    private baseUrl: string = 'http://localhost:8001';

    public async getStatus(): Promise<string> {
        try {
            const res = await axios.get(`${this.baseUrl}/status`);
            return JSON.stringify(res.data, null, 2);
        } catch (e: any) {
            return `Kong Admin API unreachable: ${e.message}`;
        }
    }

    public async createService(name: string, url: string): Promise<string> {
        try {
            const res = await axios.post(`${this.baseUrl}/services`, {
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
            const res = await axios.post(`${this.baseUrl}/services/${serviceName}/routes`, {
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
            const res = await axios.post(`${this.baseUrl}/consumers`, {
                username
            });
            return `Consumer created successfully: ${JSON.stringify(res.data.id)}`;
        } catch (e: any) {
             return `Failed to create consumer: ${e.response?.data?.message || e.message}`;
        }
    }
}

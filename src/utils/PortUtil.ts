import * as net from 'net';

export class PortUtil {
    /**
     * Checks if a port is currently in use.
     */
    public static async isPortInUse(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();

            server.once('error', (err: any) => {
                if (err.code === 'EADDRINUSE') {
                    resolve(true);
                } else {
                    resolve(false);
                }
            });

            server.once('listening', () => {
                server.close();
                resolve(false);
            });

            server.listen(port, '127.0.0.1');
        });
    }

    /**
     * Finds the next available port starting from the given port.
     */
    public static async findNextAvailablePort(startPort: number): Promise<number> {
        let port = startPort;
        while (await this.isPortInUse(port)) {
            port++;
            if (port > 65535) {
                throw new Error("No available ports found below 65535.");
            }
        }
        return port;
    }
}

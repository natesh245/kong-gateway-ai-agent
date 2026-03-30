import { StorageTool } from './StorageTool';
import { DockerTool } from './DockerTool';
import { DeckTool } from './DeckTool';
import { GitTool } from './GitTool';
import { IConfig, IAppPlatform } from '../../interfaces/ICoreInterfaces';

/**
 * ToolManager
 * Acts as a coordinator for specialized tools.
 */
export class ToolManager {
  public storage: StorageTool;
  public docker: DockerTool;
  public deck: DeckTool;
  public git: GitTool;

  constructor(private config: IConfig, private platform: IAppPlatform) {
    this.storage = new StorageTool(config, platform);
    this.docker = new DockerTool(this.storage, config, platform);
    this.deck = new DeckTool(this.storage, config);
    this.git = new GitTool(this.storage);
  }

  // Delegate Methods for backward compatibility or convenience

  public getStoragePath(): string { return this.storage.getStoragePath(); }
  public async start(): Promise<string> { return this.docker.start(); }
  public async stop(): Promise<string> { return this.docker.stop(); }
  public async status(): Promise<string> { return this.docker.status(); }
  public async findExistingContainers(): Promise<string> { return this.docker.findExistingContainers(); }
  public async listStorageFiles(): Promise<string[]> { return this.storage.listStorageFiles(); }
  public async openFile(filename: string): Promise<string> { return this.storage.openFile(filename); }
  public async writeStorageFile(filename: string, content: string): Promise<void> { return this.storage.writeStorageFile(filename, content); }
  
  public async isDeckInstalled(): Promise<boolean> { return this.deck.isDeckInstalled(); }
  public async installDeck(): Promise<string> { return this.deck.installDeck(); }
  public async getAdminUrl(isHost: boolean): Promise<string> { return this.deck.getAdminUrl(isHost); }
  public async syncWithDeck(filename: string): Promise<string> { return this.deck.syncWithDeck(filename); }
  public async validateWithDeck(filename: string): Promise<string> { return this.deck.validateWithDeck(filename); }
  public async dumpWithDeck(filename: string): Promise<string> { return this.deck.dumpWithDeck(filename); }
  public async resetWithDeck(): Promise<string> { return this.deck.resetWithDeck(); }
  public async diffWithDeck(filename: string): Promise<string> { return this.deck.diffWithDeck(filename); }

  public async gitInit(remoteUrl?: string): Promise<string> { return this.git.gitInit(remoteUrl); }
  public async gitCommit(message: string): Promise<string> { return this.git.gitCommit(message); }
  public async gitPush(): Promise<string> { return this.git.gitPush(); }
  public async gitPull(): Promise<string> { return this.git.gitPull(); }
  public async gitStatus(): Promise<string> { return this.git.gitStatus(); }

  public async initializeCache() { return this.storage.initializeCache(); }
  public updateFileCache(filename: string, content: string) { return this.storage.updateFileCache(filename, content); }
  public getFileCache(filename: string): string | undefined { return this.storage.getFileCache(filename); }
  public async verifyConnectivity() { return this.docker.verifyConnectivity(); }
  public async reconcilePorts(): Promise<string> {
      if (this.config.get('kongMode') !== 'local') {
          return "ℹ️ Port reconciliation is only available for Local (Docker) Kong legacy instances.";
      }

      try {
          const containerPorts = await this.docker.getPortsFromRunningContainers();
          const composePorts = await this.docker.getPortsFromComposeFile();
          
          // Prioritize container ports as they represent the actual running state
          const detected = { ...composePorts, ...containerPorts };
          const updates: string[] = [];

          const checkAndUpdate = async (key: string, label: string) => {
              const current = this.config.get<number>(key);
              const found = detected[key];
              if (found !== undefined && found !== current) {
                  await this.config.update?.(key, found);
                  updates.push(`| **${label}** | \`${current || 'None'}\` → \`${found}\` |`);
              }
          };

          await checkAndUpdate('proxyPort', 'Proxy Port');
          await checkAndUpdate('adminApiPort', 'Admin API Port');
          await checkAndUpdate('managerGuiPort', 'Manager GUI Port');
          await checkAndUpdate('databasePort', 'Postgres Port');

          if (updates.length > 0) {
              return `### 🛠️ Port Settings Reconciled\n\nDetected mismatches between configuration and the running environment. The following settings have been updated:\n\n| Setting | Change |\n| :--- | :--- |\n${updates.join('\n')}\n\n*Connection check now uses these updated values.*`;
          } else {
              return "✅ Port settings are already in sync with the running environment.";
          }
      } catch (e: any) {
          return `❌ Port reconciliation failed: ${e.message}`;
      }
  }

  public async openManager() { return this.docker.openManager(); }
}

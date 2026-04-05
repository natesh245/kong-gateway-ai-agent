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
    this.deck = new DeckTool(this.storage, config, platform);

    this.git = new GitTool(this.storage);
  }

  // Delegate Methods for backward compatibility or convenience

  public getStoragePath(): string { return this.storage.getStoragePath(); }
  public async start(signal?: AbortSignal): Promise<string> { return this.docker.start(signal); }
  public async stop(signal?: AbortSignal): Promise<string> { return this.docker.stop(signal); }
  public async status(signal?: AbortSignal): Promise<string> { return this.docker.status(signal); }
  public async findExistingContainers(signal?: AbortSignal): Promise<string> { return this.docker.findExistingContainers(signal); }
  public async listStorageFiles(): Promise<string[]> { return this.storage.listStorageFiles(); }
  public async readStorageFile(filename: string): Promise<string> { return this.storage.readStorageFile(filename); }
  public async openFile(filename: string): Promise<string> { return this.storage.openFile(filename); }
  public async writeStorageFile(filename: string, content: string): Promise<void> { return this.storage.writeStorageFile(filename, content); }
  
  public get connectivity() { return this.docker; }
  public async getKongConfig(): Promise<any> { return this.docker.getKongConfig(); }
  
  public async isDeckInstalled(signal?: AbortSignal): Promise<boolean> { return this.deck.isDeckInstalled(signal); }
  public async installDeck(signal?: AbortSignal): Promise<string> { return this.deck.installDeck(signal); }
  public async getAdminUrl(isHost: boolean): Promise<string> { return this.deck.getAdminUrl(isHost); }
  public async syncWithDeck(filename: string, signal?: AbortSignal): Promise<string> { return this.deck.syncWithDeck(filename, signal); }
  public async validateWithDeck(filename: string, signal?: AbortSignal): Promise<string> { return this.deck.validateWithDeck(filename, signal); }
  public async dumpWithDeck(filename: string, signal?: AbortSignal): Promise<string> { return this.deck.dumpWithDeck(filename, signal); }
  public async resetWithDeck(signal?: AbortSignal): Promise<string> { return this.deck.resetWithDeck(signal); }
  public async diffWithDeck(filename: string, signal?: AbortSignal): Promise<string> { return this.deck.diffWithDeck(filename, signal); }

  public async gitInit(remoteUrl?: string, signal?: AbortSignal): Promise<string> { return this.git.gitInit(remoteUrl, signal); }
  public async gitCommit(message: string, signal?: AbortSignal): Promise<string> { return this.git.gitCommit(message, signal); }
  public async gitPush(signal?: AbortSignal): Promise<string> { return this.git.gitPush(signal); }
  public async gitPull(signal?: AbortSignal): Promise<string> { return this.git.gitPull(signal); }
  public async gitStatus(signal?: AbortSignal): Promise<string> { return this.git.gitStatus(signal); }

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

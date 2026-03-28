import { StorageProvider } from './StorageProvider';
import { DockerProvider } from './DockerProvider';
import { DeckProvider } from './DeckProvider';
import { GitProvider } from './GitProvider';
import { IConfig, IAppPlatform } from '../interfaces/ICoreInterfaces';

/**
 * ProviderManager (formerly KongDockerManager)
 * Acts as a coordinator for specialized sub-providers.
 */
export class ProviderManager {
  public storage: StorageProvider;
  public docker: DockerProvider;
  public deck: DeckProvider;
  public git: GitProvider;

  constructor(private config: IConfig, private platform: IAppPlatform) {
    this.storage = new StorageProvider(config, platform);
    this.docker = new DockerProvider(this.storage, config, platform);
    this.deck = new DeckProvider(this.storage, config);
    this.git = new GitProvider(this.storage);
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
  public async openManager() { return this.docker.openManager(); }
}

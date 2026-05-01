import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { IConfig, IAppPlatform } from '../../interfaces/ICoreInterfaces';

export class StorageTool {
  private _fileCache: Map<string, string> = new Map();
  private _classificationCache: Map<string, 'compose' | 'kong' | 'ruleset' | 'gateway_config' | 'other'> = new Map();
  private _agent: any;
  private _preWriteSnapshots: Map<string, string> = new Map();
  private _stagedFiles: Map<string, string> = new Map();
  public recentlyWritten: Set<string> = new Set();

  constructor(private config: IConfig, private platform: IAppPlatform) { }

  /**
   * Inject the Agent instance for LLM-powered file classification.
   */
  public setAgent(agent: any) {
    this._agent = agent;
  }
  
  public getStoragePath(): string {
    const customPath = this.config.get<string>('storagePath');
    
    if (!customPath || customPath.trim() === '') {
      return '';
    }

    if (!fs.existsSync(customPath)) {
      fs.mkdirSync(customPath, { recursive: true });
    }
    return customPath;
  }

  public async listStorageFiles(): Promise<string[]> {
    try {
      const storagePath = this.getStoragePath();
      if (!fs.existsSync(storagePath)) return [];
      const files = fs.readdirSync(storagePath);
      return files.filter(f => 
        f.endsWith('.yml') || f.endsWith('.yaml') || f.endsWith('.json') || f.endsWith('.conf')
      );
    } catch (e) {
      return [];
    }
  }

  public async readStorageFile(filename: string): Promise<string> {
    try {
      // If there are staged unaccepted changes, return them so the agent builds on them!
      if (this._stagedFiles.has(filename)) {
        return this._stagedFiles.get(filename)!;
      }
      
      const storagePath = this.getStoragePath();
      if (!storagePath) return "Error: Workspace path is not configured. Please prompt the user to open the Configuration Settings panel and set a Local Workspace Path.";
      
      // Fallback check disk for staged files in case of reload
      const tempFilePath = path.join(storagePath, `.staged_${filename}`);
      if (fs.existsSync(tempFilePath)) {
        const stagedContent = fs.readFileSync(tempFilePath, 'utf8');
        this._stagedFiles.set(filename, stagedContent); // Restore to memory
        return stagedContent;
      }

      let filePath = path.join(storagePath, filename);

      if (!fs.existsSync(filePath)) {
        const altFilename = filename.endsWith('.yml') ? filename.replace('.yml', '.yaml') : (filename.endsWith('.yaml') ? filename.replace('.yaml', '.yml') : null);
        if (altFilename) {
          const altFilePath = path.join(storagePath, altFilename);
          if (fs.existsSync(altFilePath)) {
            filePath = altFilePath;
          }
        }
      }

      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      } else {
        return `Error: File '${filename}' not found in storage directory.`;
      }
    } catch (e: any) {
      return `Error: Failed to read file: ${e.message}`;
    }
  }

  public async openFile(filename: string): Promise<string> {
    try {
      if (this._stagedFiles.has(filename)) {
        return this._stagedFiles.get(filename)!;
      }
      const storagePath = this.getStoragePath();
      if (!storagePath) return "Error: Workspace path is not configured. Please prompt the user to open the Configuration Settings panel and set a Local Workspace Path.";
      
      const tempFilePath = path.join(storagePath, `.staged_${filename}`);
      if (fs.existsSync(tempFilePath)) {
        const stagedContent = fs.readFileSync(tempFilePath, 'utf8');
        this._stagedFiles.set(filename, stagedContent);
        return stagedContent;
      }

      let filePath = path.join(storagePath, filename);

      if (!fs.existsSync(filePath)) {
        const altFilename = filename.endsWith('.yml') ? filename.replace('.yml', '.yaml') : (filename.endsWith('.yaml') ? filename.replace('.yaml', '.yml') : null);
        if (altFilename) {
          const altFilePath = path.join(storagePath, altFilename);
          if (fs.existsSync(altFilePath)) {
            filePath = altFilePath;
          }
        }
      }

      if (fs.existsSync(filePath)) {
        await this.platform.openFileInEditor(filePath);
        return `Successfully opened '${path.basename(filePath)}' in the editor for you.`;
      } else {
        return `Error: File '${filename}' not found in storage directory (${storagePath}).`;
      }
    } catch (e: any) {
      this.platform.showErrorMessage(`Failed to open file ${filename}: ${e.message}`);
      return `Error: Failed to open file: ${e.message}`;
    }
  }

  public async writeStorageFile(filename: string, content: string): Promise<void> {
    try {
      const storagePath = this.getStoragePath();
      if (!storagePath) throw new Error("Workspace path is not configured. Please prompt the user to open the Configuration Settings panel and set a Local Workspace Path.");
      const filePath = path.join(storagePath, filename);
      
      // Save a "Pre-Agent Write" snapshot to ensure the watcher's "Review" button shows the correct diff
      const currentCache = this.getFileCache(filename) || "";
      this._preWriteSnapshots.set(filename, currentCache);

      this.recentlyWritten.add(filename);
      setTimeout(() => this.recentlyWritten.delete(filename), 3000);

      fs.writeFileSync(filePath, content, 'utf8');
      this.updateFileCache(filename, content);

      try {
        await this.platform.openFileInEditor(filePath);
      } catch (err) {}
    } catch (e: any) {
      this.platform.showErrorMessage(`Failed to write file ${filename}: ${e.message}`);
      throw e;
    }
  }

  /**
   * Stages a file modification in memory and writes it to a temporary .staged file 
   * so VS Code can open a native diff view against the original.
   */
  public async stageStorageFile(filename: string, content: string): Promise<string> {
    const storagePath = this.getStoragePath();
    if (!storagePath) throw new Error("Workspace path is not configured.");
    
    const tempFilename = `.staged_${filename}`;
    const tempFilePath = path.join(storagePath, tempFilename);
    
    // Save to memory
    this._stagedFiles.set(filename, content);
    
    // Write to hidden temp file for VS Code diff engine
    fs.writeFileSync(tempFilePath, content, 'utf8');
    
    return tempFilePath;
  }

  /**
   * Commits a previously staged file to the actual target file.
   */
  public async commitStagedFile(filename: string): Promise<void> {
    let content = this._stagedFiles.get(filename);
    
    // Fallback to disk if memory was cleared
    if (content === undefined) {
      const storagePath = this.getStoragePath();
      if (storagePath) {
        const tempFilePath = path.join(storagePath, `.staged_${filename}`);
        if (fs.existsSync(tempFilePath)) {
          content = fs.readFileSync(tempFilePath, 'utf8');
        }
      }
    }

    if (content === undefined) {
      throw new Error(`No staged changes found for ${filename}.`);
    }
    
    // Perform the actual write
    await this.writeStorageFile(filename, content);
    
    // Clean up
    await this.discardStagedFile(filename);
  }

  /**
   * Discards a staged file modification.
   */
  public async discardStagedFile(filename: string): Promise<void> {
    this._stagedFiles.delete(filename);
    const storagePath = this.getStoragePath();
    if (storagePath) {
      const tempFilePath = path.join(storagePath, `.staged_${filename}`);
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  }

  public hasStagedFiles(): boolean {
    return this.getStagedFiles().length > 0;
  }

  public getStagedFiles(): string[] {
    const memoryFiles = Array.from(this._stagedFiles.keys());
    const storagePath = this.getStoragePath();
    if (!storagePath || !fs.existsSync(storagePath)) return memoryFiles;

    const files = fs.readdirSync(storagePath);
    const diskFiles = files
      .filter(f => f.startsWith('.staged_'))
      .map(f => f.replace('.staged_', ''));

    // Merge and deduplicate
    return Array.from(new Set([...memoryFiles, ...diskFiles]));
  }

  public async commitAllStagedFiles(): Promise<void> {
    for (const filename of this.getStagedFiles()) {
      await this.commitStagedFile(filename);
    }
  }

  public async discardAllStagedFiles(): Promise<void> {
    for (const filename of this.getStagedFiles()) {
      await this.discardStagedFile(filename);
    }
  }

  public updateFileCache(filename: string, content: string) {
    this._fileCache.set(filename, content);
  }

  public getFileCache(filename: string): string | undefined {
    return this._fileCache.get(filename);
  }

  public async findFilesByContent(): Promise<{ compose?: string, config?: string, ruleset?: string }> {
    const files = await this.listStorageFiles();
    const storagePath = this.getStoragePath();
    const detected: { compose?: string, config?: string, ruleset?: string } = {};

    for (const file of files) {
      const fullPath = path.join(storagePath, file);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const hash = crypto.createHash('md5').update(content).digest('hex');

        // Check cache first
        let type = this._classificationCache.get(hash);

        // If not in cache and Agent is available, use LLM
        if (!type && this._agent && (file.endsWith('.yml') || file.endsWith('.yaml') || file.endsWith('.conf'))) {
            type = await this._agent.classifyFile(content);
            if (type) {
                this._classificationCache.set(hash, type);
            }
        }

        if (type === 'compose') {
            // Favor: 1. Custom named (not kong-docker-compose) 2. kong-docker-compose.yml
            if (!detected.compose || (detected.compose === 'kong-docker-compose.yml' && file !== 'kong-docker-compose.yml')) {
                detected.compose = file;
            }
        }
        if (type === 'kong') {
            // Favor: 1. Custom named (not kong-deck-state.yml) 2. kong-deck-state.yml
            if (!detected.config || (detected.config === 'kong-deck-state.yml' && file !== 'kong-deck-state.yml')) {
                detected.config = file;
            }
        }
        if (type === 'gateway_config') {
            if (!(detected as any).gateway_config || ((detected as any).gateway_config === 'kong.conf' && file !== 'kong.conf')) {
                (detected as any).gateway_config = file;
            }
        }
        if (type === 'ruleset') {
            // Favor: 1. Custom named (not ruleset.yaml) 2. ruleset.yaml
            if (!detected.ruleset || (detected.ruleset === 'ruleset.yaml' && file !== 'ruleset.yaml')) {
                detected.ruleset = file;
            }
        }
      } catch (e) {
        continue;
      }
    }
    return detected;
  }

  public async initializeCache() {
    try {
      const storagePath = this.getStoragePath();
      if (!fs.existsSync(storagePath)) return;

      const files = fs.readdirSync(storagePath);
      for (const file of files) {
        if (file.endsWith('.yml') || file.endsWith('.yaml') || file.endsWith('.json') || file.endsWith('.conf')) {
          const fullPath = path.join(storagePath, file);
          const content = fs.readFileSync(fullPath, 'utf8');
          this._fileCache.set(file, content);
        }
      }
    } catch (e) {
      console.error(`Failed to initialize cache: ${e}`);
    }
  }

  /**
   * Retrieves a "Pre-Agent Write" snapshot and clears it.
   */
  public getPreWriteSnapshot(filename: string): string | undefined {
    const snapshot = this._preWriteSnapshots.get(filename);
    if (snapshot !== undefined) {
      this._preWriteSnapshots.delete(filename);
    }
    return snapshot;
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { IConfig, IAppPlatform } from '../../interfaces/ICoreInterfaces';

export class StorageTool {
  private _fileCache: Map<string, string> = new Map();

  constructor(private config: IConfig, private platform: IAppPlatform) { }

  public getStoragePath(): string {
    const customPath = this.config.get<string>('storagePath');
    const storagePath = customPath || this.platform.getStoragePath();

    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }
    return storagePath;
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

  public async openFile(filename: string): Promise<string> {
    try {
      const storagePath = this.getStoragePath();
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
      const filePath = path.join(storagePath, filename);
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
}

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { StorageProvider } from './StorageProvider';

const execAsync = promisify(exec);

export class GitProvider {
  constructor(private storage: StorageProvider) { }

  public async gitInit(remoteUrl?: string): Promise<string> {
    const storagePath = this.storage.getStoragePath();
    try {
      await execAsync(`git init`, { cwd: storagePath });
      await execAsync(`git checkout -b main`, { cwd: storagePath }).catch(() => {});
      if (remoteUrl) {
        await execAsync(`git remote add origin "${remoteUrl}"`, { cwd: storagePath }).catch(async () => {
          await execAsync(`git remote set-url origin "${remoteUrl}"`, { cwd: storagePath });
        });
      }
      return "Initialized Git repository in storage folder.";
    } catch (e: any) {
      return `Git init failed: ${e.message}`;
    }
  }

  public async gitCommit(message: string): Promise<string> {
    const storagePath = this.storage.getStoragePath();
    try {
      await execAsync(`git add .`, { cwd: storagePath });
      const { stdout } = await execAsync(`git commit -m "${message}"`, { cwd: storagePath });
      return stdout || "Changes committed.";
    } catch (e: any) {
      if (e.message.includes('nothing to commit')) return "Nothing to commit.";
      return `Git commit failed: ${e.message}`;
    }
  }

  public async gitPush(): Promise<string> {
    const storagePath = this.storage.getStoragePath();
    try {
      const { stdout, stderr } = await execAsync(`git push origin main`, { cwd: storagePath });
      return stdout || stderr || "Changes pushed to remote.";
    } catch (e: any) {
      return `Git push failed: ${e.message}`;
    }
  }

  public async gitPull(): Promise<string> {
    const storagePath = this.storage.getStoragePath();
    try {
      const { stdout, stderr } = await execAsync(`git pull origin main`, { cwd: storagePath });
      return stdout || stderr || "Changes pulled from remote.";
    } catch (e: any) {
      return `Git pull failed: ${e.message}`;
    }
  }

  public async gitStatus(): Promise<string> {
    const storagePath = this.storage.getStoragePath();
    try {
      if (!fs.existsSync(path.join(storagePath, '.git'))) return "Not a git repository.";
      const { stdout } = await execAsync(`git status --short`, { cwd: storagePath });
      return stdout || "Working tree clean.";
    } catch (e: any) {
      return `Git status failed: ${e.message}`;
    }
  }
}

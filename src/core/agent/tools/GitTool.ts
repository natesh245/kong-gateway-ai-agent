import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { StorageTool } from './StorageTool';

const execAsync = promisify(exec);

export class GitTool {
  constructor(private storage: StorageTool) { }

  public async gitInit(remoteUrl?: string, signal?: AbortSignal): Promise<string> {
    const storagePath = this.storage.getStoragePath();
    try {
      await execAsync(`git init`, { cwd: storagePath, signal });
      await execAsync(`git checkout -b main`, { cwd: storagePath, signal }).catch(() => {});
      if (remoteUrl) {
        await execAsync(`git remote add origin "${remoteUrl}"`, { cwd: storagePath, signal }).catch(async () => {
          await execAsync(`git remote set-url origin "${remoteUrl}"`, { cwd: storagePath, signal });
        });
      }
      return "Initialized Git repository in storage folder.";
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `Git init failed: ${e.message}`;
    }
  }

  public async gitCommit(message: string, signal?: AbortSignal): Promise<string> {
    const storagePath = this.storage.getStoragePath();
    try {
      await execAsync(`git add .`, { cwd: storagePath, signal });
      const { stdout } = await execAsync(`git commit -m "${message}"`, { cwd: storagePath, signal });
      return stdout || "Changes committed.";
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      if (e.message.includes('nothing to commit')) return "Nothing to commit.";
      return `Git commit failed: ${e.message}`;
    }
  }

  public async gitPush(signal?: AbortSignal): Promise<string> {
    const storagePath = this.storage.getStoragePath();
    try {
      const { stdout, stderr } = await execAsync(`git push origin main`, { cwd: storagePath, signal });
      return stdout || stderr || "Changes pushed to remote.";
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `Git push failed: ${e.message}`;
    }
  }

  public async gitPull(signal?: AbortSignal): Promise<string> {
    const storagePath = this.storage.getStoragePath();
    try {
      const { stdout, stderr } = await execAsync(`git pull origin main`, { cwd: storagePath, signal });
      return stdout || stderr || "Changes pulled from remote.";
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `Git pull failed: ${e.message}`;
    }
  }

  public async gitStatus(signal?: AbortSignal): Promise<string> {
    const storagePath = this.storage.getStoragePath();
    try {
      if (!fs.existsSync(path.join(storagePath, '.git'))) return "Not a git repository.";
      const { stdout } = await execAsync(`git status --short`, { cwd: storagePath, signal });
      return stdout || "Working tree clean.";
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `Git status failed: ${e.message}`;
    }
  }
}

import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { StorageTool } from './StorageTool';
import { IConfig, IAppPlatform } from '../../interfaces/ICoreInterfaces';


const execAsync = promisify(exec);

export class DeckTool {
  constructor(private storage: StorageTool, private config: IConfig, private platform: IAppPlatform) { }


  public async isDeckInstalled(signal?: AbortSignal): Promise<boolean> {
    try {
      await execAsync('deck version', { signal });
      return true;
    } catch (e) {
      return false;
    }
  }

  public async installDeck(signal?: AbortSignal): Promise<string> {
    if (process.platform !== 'darwin') {
      return "Kong Agent: Automatic installation of decK is currently only supported on macOS via Homebrew. Please install decK manually from https://github.com/Kong/deck/releases";
    }

    try {
      this.platform.showInformationMessage("Kong Agent: Attempting to install decK via Homebrew...");

      await execAsync('brew --version', { signal }); // Check if brew exists
      await execAsync('brew tap kong/tap', { signal });
      await execAsync('brew install deck', { signal });
      return "Successfully installed decK CLI via Homebrew.";
    } catch (e: any) {
      if (e.message.includes('command not found')) {
        return "Kong Agent: Homebrew (brew) was not found on your system. Please install Homebrew first or download decK manually from https://github.com/Kong/deck/releases";
      }
      throw new Error(`Failed to install decK: ${e.message}`);
    }
  }


  public async getAdminUrl(isHost: boolean): Promise<string> {
    const mode = this.config.get<string>('kongMode') || 'local';
    
    if (mode === 'remote') {
      return this.config.get<string>('remoteAdminApiUrl') || 'http://localhost:8001';
    }

    const adminPort = this.config.get<number>('adminApiPort') || 8001;
    return isHost ? `http://localhost:${adminPort}` : `http://host.docker.internal:${adminPort}`;
  }

  public async getDeckArgs(isHost: boolean): Promise<string[]> {
    const adminUrl = await this.getAdminUrl(isHost);
    const args = [`--kong-addr`, adminUrl];

    const workspace = this.config.get<string>('kongWorkspace');
    if (workspace && workspace !== 'default') {
      args.push('--workspace', workspace);
    }

    const token = this.config.get<string>('kongAdminToken');
    if (token) {
      args.push('--headers', `Kong-Admin-Token:${token}`);
    }

    if (this.config.get<boolean>('skipTlsVerify')) {
      args.push('--tls-skip-verify');
    }

    return args;
  }

  public async syncWithDeck(filename: string, signal?: AbortSignal): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      const filePath = path.join(storagePath, filename);
      const isHostInstalled = await this.isDeckInstalled(signal);

      if (isHostInstalled) {
        const args = await this.getDeckArgs(true);
        let command = `deck gateway sync "${filePath}" ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(command, { signal });
          return stdout || "Sync completed successfully (Host CLI).";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            command = `deck sync -s "${filePath}" ${args.join(' ')}`;
            const { stdout } = await execAsync(command, { signal });
            return stdout || "Sync completed successfully (Host CLI fallback).";
          }
          throw e;
        }
      } else {
        const dockerFilePath = `/storage/${filename}`;
        const args = await this.getDeckArgs(false);
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck gateway sync "${dockerFilePath}" ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(dockerCommand, { signal });
          return stdout || "Sync completed successfully (Dockerized decK).";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            const fallbackDocker = `docker run --rm -v "${storagePath}:/storage" kong/deck sync -s "${dockerFilePath}" ${args.join(' ')}`;
            const { stdout } = await execAsync(fallbackDocker, { signal });
            return stdout || "Sync completed successfully (Dockerized fallback).";
          }
          throw e;
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      if (e.message.includes('docker')) {
        return `decK sync failed: Docker is not running or image 'kong/deck' could not be pulled. \n\nError: ${e.message}`;
      }
      return `decK sync failed: ${e.stderr || e.message}\n\nMake sure your kong.yml is valid and Kong is reachable at ${await this.getAdminUrl(true)}`;
    }
  }

  public async validateWithDeck(filename: string, signal?: AbortSignal): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      const filePath = path.join(storagePath, filename);
      const isHostInstalled = await this.isDeckInstalled(signal);

      if (isHostInstalled) {
        const args = await this.getDeckArgs(true);
        let command = `deck gateway validate "${filePath}" ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(command, { signal });
          return stdout || "Configuration is valid.";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            command = `deck validate -s "${filePath}" ${args.join(' ')}`;
            const { stdout } = await execAsync(command, { signal });
            return stdout || "Configuration is valid (fallback mode).";
          }
          throw e;
        }
      } else {
        const dockerFilePath = `/storage/${filename}`;
        const args = await this.getDeckArgs(false);
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck gateway validate "${dockerFilePath}" ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(dockerCommand, { signal });
          return stdout || "Configuration is valid (Dockerized decK).";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            const fallbackDocker = `docker run --rm -v "${storagePath}:/storage" kong/deck validate -s "${dockerFilePath}" ${args.join(' ')}`;
            const { stdout } = await execAsync(fallbackDocker, { signal });
            return stdout || "Configuration is valid (Dockerized fallback).";
          }
          throw e;
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `Validation failed: ${e.stderr || e.message}`;
    }
  }

  public async dumpWithDeck(filename: string, signal?: AbortSignal): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      const filePath = path.join(storagePath, filename);
      const isHostInstalled = await this.isDeckInstalled(signal);

      if (isHostInstalled) {
        const args = await this.getDeckArgs(true);
        let command = `deck gateway dump -o "${filePath}" ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(command, { signal });
          return stdout || `Exported configuration to ${filename} (Host CLI).`;
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            command = `deck dump -o "${filePath}" ${args.join(' ')}`;
            const { stdout } = await execAsync(command, { signal });
            return stdout || `Exported configuration to ${filename} (Host CLI fallback).`;
          }
          throw e;
        }
      } else {
        const args = await this.getDeckArgs(false);
        const dockerCommand = `docker run --rm kong/deck gateway dump -o - ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(dockerCommand, { signal });
          if (stdout && stdout.trim().length > 0) {
            this.storage.writeStorageFile(filename, stdout);
            return `Exported configuration to ${filename} (Dockerized decK - Volume-less).`;
          }
          throw new Error("decK dump returned empty output.");
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            const fallbackDocker = `docker run --rm kong/deck dump -o - ${args.join(' ')}`;
            const { stdout } = await execAsync(fallbackDocker, { signal });
            if (stdout && stdout.trim().length > 0) {
              this.storage.writeStorageFile(filename, stdout);
              return `Exported configuration to ${filename} (Dockerized fallback - Volume-less).`;
            }
          }
          throw e;
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `decK dump failed: ${e.stderr || e.message}`;
    }
  }

  public async resetWithDeck(signal?: AbortSignal): Promise<string> {
    try {
      const isHostInstalled = await this.isDeckInstalled(signal);

      if (isHostInstalled) {
        const args = await this.getDeckArgs(true);
        let command = `deck gateway reset --force ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(command, { signal });
          return stdout || "Kong configuration reset successfully (Host CLI).";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            command = `deck reset --force ${args.join(' ')}`;
            const { stdout } = await execAsync(command, { signal });
            return stdout || "Kong configuration reset successfully (Host CLI fallback).";
          }
          throw e;
        }
      } else {
        const storagePath = this.storage.getStoragePath();
        const args = await this.getDeckArgs(false);
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck gateway reset --force ${args.join(' ')}`;
        try {
          const { stdout } = await execAsync(dockerCommand, { signal });
          return stdout || "Kong configuration reset successfully (Dockerized decK).";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            const fallbackDocker = `docker run --rm -v "${storagePath}:/storage" kong/deck reset --force ${args.join(' ')}`;
            const { stdout } = await execAsync(fallbackDocker, { signal });
            return stdout || "Kong configuration reset successfully (Dockerized fallback).";
          }
          throw e;
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `decK reset failed: ${e.stderr || e.message}`;
    }
  }

  public async diffWithDeck(filename: string, signal?: AbortSignal): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      const filePath = path.join(storagePath, filename);
      const isHostInstalled = await this.isDeckInstalled(signal);

      if (isHostInstalled) {
        const args = await this.getDeckArgs(true);
        let command = `deck gateway diff "${filePath}" ${args.join(' ')}`;
        try {
          const { stdout, stderr } = await execAsync(command, { signal });
          const rawResult = stdout || stderr;
          return rawResult || "✅ No differences found — local config matches live Kong. Nothing to sync.";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            command = `deck diff -s "${filePath}" ${args.join(' ')}`;
            const { stdout, stderr } = await execAsync(command, { signal });
            const rawFallback = stdout || stderr;
            return rawFallback || "✅ No differences found — local config matches live Kong. Nothing to sync.";
          }
          if (e.stdout || e.stderr) {
            return e.stdout + e.stderr;
          }
          throw e;
        }
      } else {
        const dockerFilePath = `/storage/${filename}`;
        const args = await this.getDeckArgs(false);
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck gateway diff "${dockerFilePath}" ${args.join(' ')}`;
        try {
          const { stdout, stderr } = await execAsync(dockerCommand, { signal });
          const raw = stdout || stderr;
          return raw || "✅ No differences found — local config matches live Kong. Nothing to sync.";
        } catch (e: any) {
          const errorMsg = e.stderr || e.message || "";
          if (errorMsg.includes('unknown command') || errorMsg.includes('command not found')) {
            const fallbackDocker = `docker run --rm -v "${storagePath}:/storage" kong/deck diff -s "${dockerFilePath}" ${args.join(' ')}`;
            const { stdout, stderr } = await execAsync(fallbackDocker, { signal });
            const rawDockerFallback = stdout || stderr;
            return rawDockerFallback || "✅ No differences found — local config matches live Kong. Nothing to sync.";
          }
          if (e.stdout || e.stderr) {
            return e.stdout + e.stderr;
          }
          throw e;
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `decK diff failed: ${e.stderr || e.message}`;
    }
  }

  // --- APIOps / Offline Transformation Commands ---

  public async openapi2kong(input: string, output: string, signal?: AbortSignal): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      const inPath = path.join(storagePath, input);
      const outPath = path.join(storagePath, output);
      const isHostInstalled = await this.isDeckInstalled(signal);

      if (isHostInstalled) {
        const command = `deck file openapi2kong -s "${inPath}" -o "${outPath}"`;
        const { stdout } = await execAsync(command, { signal });
        return stdout || `Successfully converted ${input} to ${output}.`;
      } else {
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck file openapi2kong -s "/storage/${input}" -o "/storage/${output}"`;
        const { stdout } = await execAsync(dockerCommand, { signal });
        return stdout || `Successfully converted ${input} to ${output} (Docker).`;
      }
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `openapi2kong failed: ${e.stderr || e.message}`;
    }
  }

  public async lint(filename: string, rulesetFile?: string, signal?: AbortSignal): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      
      if (!rulesetFile) {
        const fs = require('fs');
        const defaultRulesets = ['ruleset.yml', 'ruleset.yaml', 'rules.yml', 'rules.yaml'];
        for (const candidate of defaultRulesets) {
           if (fs.existsSync(path.join(storagePath, candidate))) {
               rulesetFile = candidate;
               break;
           }
        }
      }

      if (!rulesetFile) {
        // Create a default ruleset file in the workspace
        rulesetFile = 'ruleset.yaml';
        const defaultRulesetPath = path.join(storagePath, rulesetFile);
        const defaultContent = `rules:
  service-https-check:
    description: "Ensure https usage in Kong GW Services (Default Rule)"
    given: $.services[*].protocol
    severity: warn
    then:
      function: pattern
      functionOptions:
        match: "^https$"
`;
        const fs = require('fs');
        fs.writeFileSync(defaultRulesetPath, defaultContent, 'utf8');
      }

      const filePath = path.join(storagePath, filename);
      const rulesetPath = path.join(storagePath, rulesetFile);
      const isHostInstalled = await this.isDeckInstalled(signal);

      if (isHostInstalled) {
        const command = `deck file lint -s "${filePath}" "${rulesetPath}"`;
        const { stdout } = await execAsync(command, { signal });
        return stdout || "Configuration passed linting.";
      } else {
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck file lint -s "/storage/${filename}" "/storage/${rulesetFile}"`;
        const { stdout } = await execAsync(dockerCommand, { signal });
        return stdout || "Configuration passed linting (Docker).";
      }
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `Linting failed: ${e.stderr || e.message}`;
    }
  }

  public async merge(filenames: string[], output: string, signal?: AbortSignal): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      const inputs = filenames.map(f => `"${path.join(storagePath, f)}"`).join(' ');
      const outPath = path.join(storagePath, output);
      const isHostInstalled = await this.isDeckInstalled(signal);

      if (isHostInstalled) {
        const command = `deck file merge ${inputs} -o "${outPath}"`;
        const { stdout } = await execAsync(command, { signal });
        return stdout || `Successfully merged files into ${output}.`;
      } else {
        const dockerInputs = filenames.map(f => `"/storage/${f}"`).join(' ');
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck file merge ${dockerInputs} -o "/storage/${output}"`;
        const { stdout } = await execAsync(dockerCommand, { signal });
        return stdout || `Successfully merged files into ${output} (Docker).`;
      }
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `Merge failed: ${e.stderr || e.message}`;
    }
  }

  public async patch(filename: string, patchFile: string, signal?: AbortSignal): Promise<string> {
    try {
      const storagePath = this.storage.getStoragePath();
      const statePath = path.join(storagePath, filename);
      const pPath = path.join(storagePath, patchFile);
      const isHostInstalled = await this.isDeckInstalled(signal);

      if (isHostInstalled) {
        const command = `deck file patch -s "${statePath}" -p "${pPath}"`;
        const { stdout } = await execAsync(command, { signal });
        return stdout || `Successfully patched ${filename}.`;
      } else {
        const dockerCommand = `docker run --rm -v "${storagePath}:/storage" kong/deck file patch -s "/storage/${filename}" -p "/storage/${patchFile}"`;
        const { stdout } = await execAsync(dockerCommand, { signal });
        return stdout || `Successfully patched ${filename} (Docker).`;
      }
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      return `Patch failed: ${e.stderr || e.message}`;
    }
  }
}

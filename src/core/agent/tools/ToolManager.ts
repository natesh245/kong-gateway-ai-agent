import { StorageTool } from './StorageTool';
import { DockerTool } from './DockerTool';
import { DeckTool } from './DeckTool';
import { IConfig, IAppPlatform } from '../../interfaces/ICoreInterfaces';
import { DiffUtil } from '../../utils/DiffUtil';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Interface for providing conversation context to tools
 * (e.g., history checks, user approvals, abort signals).
 */
export interface ToolExecutionContext {
  lastUserContent: () => string;
  recentHistoryHas: (keyword: string, lookback?: number) => boolean;
  recentHistoryHasToolCall: (toolName: string, lookback?: number) => boolean;
  abortSignal?: AbortSignal;
}

/**
 * ToolManager
 * Acts as a coordinator for specialized tools.
 */
export class ToolManager {
  public storage: StorageTool;
  public docker: DockerTool;
  public deck: DeckTool;

  constructor(private config: IConfig, private platform: IAppPlatform) {
    this.storage = new StorageTool(config, platform);
    this.docker = new DockerTool(this.storage, config, platform);
    this.deck = new DeckTool(this.storage, config, platform);
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
  
  public async getAdminUrl(isHost: boolean): Promise<string> { return this.deck.getAdminUrl(isHost); }
  public async syncWithDeck(filename: string, signal?: AbortSignal): Promise<string> { return this.deck.syncWithDeck(filename, signal); }
  public async validateWithDeck(filename: string, signal?: AbortSignal): Promise<string> { return this.deck.validateWithDeck(filename, signal); }
  public async dumpWithDeck(filename: string, signal?: AbortSignal): Promise<string> { return this.deck.dumpWithDeck(filename, signal); }
  public async resetWithDeck(signal?: AbortSignal): Promise<string> { return this.deck.resetWithDeck(signal); }
  public async diffWithDeck(filename: string, signal?: AbortSignal): Promise<string> { return this.deck.diffWithDeck(filename, signal); }

  // APIOps Transformation Delegates
  public async openapi2kong(input: string, output: string, signal?: AbortSignal): Promise<string> {
    return this.deck.openapi2kong(input, output, signal);
  }
  public async lint(filename: string, rulesetFile?: string, signal?: AbortSignal): Promise<string> {
    return this.deck.lint(filename, rulesetFile, signal);
  }
  public async merge(filenames: string[], output: string, signal?: AbortSignal): Promise<string> {
    return this.deck.merge(filenames, output, signal);
  }
  public async patch(filename: string, patchFile: string, signal?: AbortSignal): Promise<string> {
    return this.deck.patch(filename, patchFile, signal);
  }

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

  public async listEntities(entity: string): Promise<string> {
    return this.docker.listEntities(entity);
  }

  // --- Hardened Orchestration Methods ---

  /**
   * Hybrid tool that returns both Docker status and Kong gateway config.
   */
  public async getHybridInstanceDetails(): Promise<string> {
    const mode = this.config.get<string>('kongMode') || 'local';
    const status = mode === 'local' ? await this.status() : "Docker Status: N/A (Remote Mode)";
    const kongConfig = await this.getKongConfig();

    return `KONG MODE: ${mode.toUpperCase()}\n\n` +
      `[DOCKER STATUS]\n${status}\n\n` +
      `[ADMIN API CONFIG]\n${JSON.stringify(kongConfig, null, 2)}`;
  }

  /**
   * Hybrid connectivity check with formatted output.
   */
  public async verifyConnectivityHardened(): Promise<string> {
    const res = await this.verifyConnectivity();
    return `Admin: ${res.admin ? 'Ready' : 'Unreachable'}, Proxy: ${res.proxy ? 'Ready' : 'Unreachable'}${res.error ? ` (${res.error})` : ''}`;
  }

  /**
   * Updates Kong ports in the Agent's configuration.
   */
  public async updateKongPorts(proxy: number, admin: number, manager: number): Promise<string> {
    await this.config.update?.('proxyPort', proxy);
    await this.config.update?.('adminApiPort', admin);
    await this.config.update?.('managerGuiPort', manager);
    return "Successfully updated Kong ports in configuration.";
  }

  /**
   * Safety-gated adoption of existing containers.
   */
  public async connectWithSafetyGate(ctx: ToolExecutionContext, proxyPort?: number, adminPort?: number, managerPort?: number): Promise<string> {
    const lastUserContent = ctx.lastUserContent();
    if (/\byes\b/i.test(lastUserContent) || lastUserContent.includes('confirm') || lastUserContent.includes('proceed')) {
      const hasScanned = ctx.recentHistoryHasToolCall('check_existing_containers') ||
        ctx.recentHistoryHasToolCall('reconcile_port_settings');

      if (!hasScanned) {
        return "SAFETY_REQUIRED: I cannot connect until I've scanned the environment. Please call 'check_existing_containers' first.";
      }

      if (proxyPort !== undefined) await this.config.update?.('proxyPort', proxyPort);
      if (adminPort !== undefined) await this.config.update?.('adminApiPort', adminPort);
      if (managerPort !== undefined) await this.config.update?.('managerGuiPort', managerPort);

      return await this.docker.start(ctx.abortSignal);
    }
    return "SAFETY_REQUIRED: Adopting an existing instance requires explicit user confirmation. Explain the scan results first, then ask for confirmation with '[APPROVAL_REQUIRED]'.";
  }

  public async writeStorageFileWithDiff(filename: string, content: string): Promise<string> {
    const oldContent = this.getFileCache(filename) || "";
    const tempFilePath = await this.storage.stageStorageFile(filename, content);
    
    const storagePath = this.getStoragePath();
    if (storagePath) {
      const originalFilePath = path.join(storagePath, filename);
      if (!fs.existsSync(originalFilePath)) {
          fs.writeFileSync(originalFilePath, "", "utf8");
      }
      try {
          await this.platform.openDiffInEditor(originalFilePath, tempFilePath, `Staged Changes: ${filename}`);
      } catch (e) {}
    }

    const rawDiff = DiffUtil.generateUnifiedDiff(filename, oldContent, content);
    const chatDiff = DiffUtil.formatForChat(rawDiff);
    return `[STAGED_FILE_EDIT:${filename}]\nSuccessfully staged ${filename} for your review. Please click Accept or Reject in the UI to apply or discard these changes.\n\nDIFF:\n\`\`\`diff\n${chatDiff}\n\`\`\``;
  }

  /**
   * Safety-gated sync operation using decK.
   */
  public async syncWithSafetyGate(ctx: ToolExecutionContext, filename: string): Promise<string> {
    const lastUserContent = ctx.lastUserContent();
    const isApproved = /\byes\b/i.test(lastUserContent) || 
                       /\bproceed\b/i.test(lastUserContent) || 
                       /\bapprove\b/i.test(lastUserContent) ||
                       /\bconfirm\b/i.test(lastUserContent) ||
                       lastUserContent.includes('apply');

    if (isApproved) {
      const hasDiffed = ctx.recentHistoryHasToolCall('preview_sync_diff');

      if (!hasDiffed) {
        return "SAFETY_REQUIRED: I cannot sync without first showing you the diff. I must run 'preview_sync_diff' first.";
      }
      return await this.syncWithDeck(filename, ctx.abortSignal);
    }
    return "SAFETY_REQUIRED: I cannot execute sync yet. Please review the validation/diff above and confirm by saying 'yes' or 'confirm sync'. Use '[APPROVAL_REQUIRED]'.";
  }

  /**
   * Hybrid preview of live -> local export.
   */
  public async previewExportHardened(ctx: ToolExecutionContext, filename: string): Promise<string> {
    const targetFile = filename || "kong.yml";
    const tempFilename = `.temp_export_${Date.now()}.yml`;

    try {
      await this.dumpWithDeck(tempFilename, ctx.abortSignal);
      const remoteContent = await this.readStorageFile(tempFilename).catch(() => "");
      const localContent = await this.readStorageFile(targetFile).catch(() => "");

      const rawDiff = DiffUtil.generateUnifiedDiff(targetFile, localContent, remoteContent);
      const chatDiff = DiffUtil.formatForChat(rawDiff);

      try {
        const fs = require('fs');
        fs.unlinkSync(path.join(this.getStoragePath(), tempFilename));
      } catch (e) { }

      if (!chatDiff.trim() || rawDiff.trim() === 'No differences.') {
        return `Local file ${targetFile} is already completely in sync with the live configuration. Nothing to export.`;
      }

      return `PREVIEW EXPORT RESULTS:\n\n` +
        `The following diff shows what will happen to your LOCAL file (${targetFile}) if you approve this export:\n` +
        `\`\`\`diff\n${chatDiff}\n\`\`\``;
    } catch (e: any) {
      return `Failed to generate export preview: ${e.message}`;
    }
  }

  /**
   * Safety-gated export operation.
   */
  public async exportWithSafetyGate(ctx: ToolExecutionContext, filename: string): Promise<string> {
    const lastUserContent = ctx.lastUserContent();
    const isApproved = /\byes\b/i.test(lastUserContent) || 
                       /\bproceed\b/i.test(lastUserContent) || 
                       /\bapprove\b/i.test(lastUserContent) ||
                       /\bconfirm\b/i.test(lastUserContent) ||
                       lastUserContent.includes('apply');

    if (isApproved) {
      const hasDiffed = ctx.recentHistoryHasToolCall('preview_export_diff');
      if (!hasDiffed) {
        return "SAFETY_REQUIRED: I cannot export without first showing you the diff. I must run 'preview_export_diff' first.";
      }
      return await this.dumpWithDeck(filename, ctx.abortSignal);
    }
    return "SAFETY_REQUIRED: I cannot export without your explicit confirmation. Please review the 'preview_export_diff' results and say 'confirm export' or 'yes'. Use '[APPROVAL_REQUIRED]'.";
  }

  /**
   * Generates a detailed inventory of what will be deleted during a reset.
   * Dumps the live state and feeds it to the LLM to generate a rich summary table.
   */
  public async previewResetInventory(signal?: AbortSignal): Promise<string> {
    try {
      // 1. Capture the live state directly to memory
      const content = await this.deck.dumpToStdout(signal);
      
      if (!content.trim() || !content.includes('services:')) {
        return "The live Kong Gateway appears to be empty. There are no services or routes to delete.";
      }

      // 2. Format the response for the LLM
      return "### ⚠️ RESET PREVIEW DATA\n\n" +
             "The following is the current LIVE configuration of the gateway. " +
             "Please analyze this YAML and present it to the user as a **clean Markdown table** summarizing the Services, Routes, and Plugins that will be deleted.\n\n" +
             "**LIVE CONFIGURATION:**\n" +
             `\`\`\`yaml\n${content}\n\`\`\`\n\n` +
             "--- \n" +
             "**SAFETY REMINDER:** This is a DESTRUCTIVE operation. After showing the table, ask the user to confirm with 'yes' or 'confirm reset' if they want to proceed. Use '[APPROVAL_REQUIRED]'.";
    } catch (e: any) {
      return `Failed to generate reset inventory: ${e.message}`;
    }
  }

  /**
   * Safety-gated reset operation.
   */
  public async resetWithSafetyGate(ctx: ToolExecutionContext): Promise<string> {
    const lastUserContent = ctx.lastUserContent();
    const isApproved = /\byes\b/i.test(lastUserContent) || 
                       /\bproceed\b/i.test(lastUserContent) || 
                       /\bapprove\b/i.test(lastUserContent) ||
                       /\bconfirm\b/i.test(lastUserContent);

    if (isApproved) {
      const hasInventory = ctx.recentHistoryHasToolCall('preview_reset_inventory', 50);
      
      if (!hasInventory) {
        return "SAFETY_REQUIRED: I cannot reset without first showing you the inventory of what will be deleted. Please run 'preview_reset_inventory' first.";
      }
      return await this.resetWithDeck(ctx.abortSignal);
    }
    return "SAFETY_REQUIRED: I cannot reset without explicit confirmation. Please review the 'preview_reset_inventory' results and say 'confirm reset' or 'yes'. Use '[APPROVAL_REQUIRED]'.";
  }
}

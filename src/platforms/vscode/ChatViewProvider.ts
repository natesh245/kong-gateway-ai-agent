import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Agent } from '../../core/agent/Agent';
import { ToolManager } from '../../core/agent/tools/ToolManager';
import { DiffUtil } from '../../core/utils/DiffUtil';
import { PortUtil } from '../../core/utils/PortUtil';
import { IConfig, IAppPlatform } from '../../core/interfaces/ICoreInterfaces';
import { MessageUtils } from '../../core/utils/MessageUtils';


export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'kongAgentChat';
    private _view?: vscode.WebviewView;
    private _agent: Agent;
    private _watcher?: vscode.FileSystemWatcher;
    private _debounceTimer?: NodeJS.Timeout;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private context: vscode.ExtensionContext,
        private toolManager: ToolManager,
        private config: IConfig,
        private platform: IAppPlatform
    ) {
        this._agent = new Agent(config, toolManager, platform);
        this.toolManager.storage.setAgent(this._agent);
        this.toolManager.initializeCache();
        this._setupWatcher();
        this._loadHistory();


        // Listen for configuration changes to sync the webview automatically
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('kongAgent')) {
                this._updateWebviewConfig();
            }
        }, null, context.subscriptions);
    }

    private _setupWatcher() {
        if (this._watcher) {
            this._watcher.dispose();
        }

        try {
            const storagePath = this.toolManager.getStoragePath();

            if (storagePath && fs.existsSync(storagePath)) {
                const storageUri = vscode.Uri.file(storagePath);
                this._watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(storageUri, '**/*.{yml,yaml,json}')
                );

                this._watcher.onDidChange(uri => this._handleFileChange(uri, 'modified'));
                this._watcher.onDidCreate(uri => this._handleFileChange(uri, 'created'));
                this._watcher.onDidDelete(uri => this._handleFileChange(uri, 'deleted'));
            }
        } catch (e) {
            // Safe ignore: workspace path is not set yet, so don't watch anything
        }

    }

    private _handleFileChange(uri: vscode.Uri, changeType: 'created' | 'modified' | 'deleted') {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }

        this._debounceTimer = setTimeout(async () => {
            if (this._view) {
                const filename = path.basename(uri.fsPath);
                
                // Only track specific configuration files and ignore hidden/internal files
                if (filename.startsWith('.')) return;
                const isValidExtension = filename.endsWith('.yml') || 
                                         filename.endsWith('.yaml') || 
                                         filename.endsWith('.json') || 
                                         filename.endsWith('.conf');
                if (!isValidExtension) return;

                // Refresh the managed files list in the webview (skipping full history sync)
                await this._updateWebviewConfig(true);

                // Notify user specifically about the change ONLY if the agent didn't just write it
                if (!this.toolManager.storage.recentlyWritten.has(filename)) {
                    this._view.webview.postMessage({
                        type: 'fileChanged',
                        filename: filename,
                        changeType: changeType
                    });
                }
            }
        }, 1000);
    }


    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Push updates whenever the view becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._updateWebviewConfig();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'ready':
                    // Push the 'Instant' data first
                    this._updateWebviewConfig();
                    break;
                case 'prompt':
                    {
                        const messageId = Date.now().toString();
                        webviewView.webview.postMessage({ type: 'addMessage', role: 'user', content: data.value });
                        // Immediate feedback
                        webviewView.webview.postMessage({ type: 'toolStatus', status: 'Analyzing request...' });
                        
                        // Initialize agent message immediately to accurately track total elapsed time including TTFT
                        webviewView.webview.postMessage({ type: 'streamMessage', messageId, role: 'reasoning', content: '', startTime: data.timestamp });

                        await this._agent.processMessage(data.value, (content: string, type: string = 'agent') => {
                            this._dispatchAgentUpdate(webviewView, messageId, content, type);
                        }, data.timestamp);

                        // Finalize the message with usage stats
                        const usageTotal = this._agent.getUsageStats().lastTurnUsage;
                        webviewView.webview.postMessage({
                            type: 'finalizeStreamedMessage',
                            messageId,
                            usage: usageTotal
                        });

                        await this._saveHistory();
                        await this._updateWebviewConfig(true);
                        break;
                    }

                case 'updateConfig':
                    {
                        const toBool = (val: any) => val === true || val === 'true';
                        
                        // 1. Capture Old Config for Diffing
                        const oldConfig: Record<string, any> = {
                            provider: this.config.get('provider'),
                            model: this.config.get('model'),
                            storagePath: this.config.get('storagePath'),
                            kongMode: this.config.get('kongMode'),
                            proxyPort: this.config.get('proxyPort'),
                            adminApiPort: this.config.get('adminApiPort'),
                            managerGuiPort: this.config.get('managerGuiPort'),
                            databasePort: this.config.get('databasePort'),
                            remoteAdminApiUrl: this.config.get('remoteAdminApiUrl'),
                            remoteProxyBaseUrl: this.config.get('remoteProxyBaseUrl'),
                            remoteManagerGuiUrl: this.config.get('remoteManagerGuiUrl'),
                            maxReasoningTurns: this.config.get('maxReasoningTurns'),
                            maxToolCalls: this.config.get('maxToolCalls'),
                            maxContext: this.config.get('maxContext'),
                            maxAgentTimeout: this.config.get('maxAgentTimeout'),
                            gitRemoteUrl: this.config.get('gitRemoteUrl'),
                            skipTlsVerify: this.config.get('skipTlsVerify'),
                            autoCommit: this.config.get('autoCommit'),
                            kongWorkspace: this.config.get('kongWorkspace'),
                            showThinking: this.config.get('showThinking'),
                            openRouterApiKey: this.config.get('openRouterApiKey'),
                            geminiApiKey: this.config.get('geminiApiKey'),
                            langChainTracing: this.config.get('langChainTracing'),
                            langSmithApiKey: this.config.get('langSmithApiKey'),
                            langSmithProject: this.config.get('langSmithProject'),
                            langSmithEndpoint: this.config.get('langSmithEndpoint')
                        };

                        if (data.provider) await this.config.update?.('provider', data.provider);
                        if (data.model) await this.config.update?.('model', data.model);
                        if (data.openRouterApiKey !== undefined) await this.config.update?.('openRouterApiKey', data.openRouterApiKey);
                        if (data.geminiApiKey !== undefined) await this.config.update?.('geminiApiKey', data.geminiApiKey);
                        if (data.langChainTracing !== undefined) await this.config.update?.('langChainTracing', toBool(data.langChainTracing));
                        if (data.langSmithApiKey !== undefined) await this.config.update?.('langSmithApiKey', data.langSmithApiKey);
                        if (data.langSmithProject !== undefined) await this.config.update?.('langSmithProject', data.langSmithProject);
                        if (data.langSmithEndpoint !== undefined) await this.config.update?.('langSmithEndpoint', data.langSmithEndpoint);
                        if (data.storagePath) await this.config.update?.('storagePath', data.storagePath);
                        if (data.kongMode) await this.config.update?.('kongMode', data.kongMode);

                        const updatedLocalPorts: Record<string, number> = {};
                        const containerPorts = await this.toolManager.docker.getPortsFromRunningContainers();

                        const checkAndSavePort = async (key: string, newValueStr: string) => {
                            const newPort = parseInt(newValueStr);
                            const currentPort = this.config.get<number>(key);

                            if (newPort !== currentPort) {
                                // Whitelist: if this port is ALREADY the mapping used by Kong/Postgres for this specific service.
                                const isOwnedByKong = containerPorts[key] === newPort;

                                if (!isOwnedByKong && await PortUtil.isPortInUse(newPort)) {
                                    this._view?.webview.postMessage({ type: 'addMessage', role: 'system', content: `❌ Error saving settings: Port **${newPort}** for ${key} is already in use by another application. Reverted to ${currentPort}.` });
                                } else {
                                    await this.config.update?.(key, newPort);
                                    updatedLocalPorts[key] = newPort;
                                }
                            }
                        };


                        if (data.proxyPort) await checkAndSavePort('proxyPort', data.proxyPort);
                        if (data.adminApiPort) await checkAndSavePort('adminApiPort', data.adminApiPort);
                        if (data.managerGuiPort) await checkAndSavePort('managerGuiPort', data.managerGuiPort);
                        if (data.databasePort) await checkAndSavePort('databasePort', data.databasePort);

                        // Sync updated ports to Docker Compose if in local mode
                        const currentMode = data.kongMode || this.config.get<string>('kongMode');
                        if (currentMode === 'local' && Object.keys(updatedLocalPorts).length > 0) {
                            try {
                                const msg = await this.toolManager.docker.updatePortsInComposeFile(updatedLocalPorts);
                                if (msg) {
                                    this._view?.webview.postMessage({ type: 'addMessage', role: 'system', content: `✅ Successfully synced port changes to Docker Compose file:\n${msg}` });
                                }
                            } catch (e: any) {
                                this._view?.webview.postMessage({ type: 'addMessage', role: 'system', content: `⚠️ Settings saved, but failed to sync with Docker Compose: ${e.message}` });
                            }
                        }



                        if (data.modelCallLimit) await this.config.update?.('modelCallLimit', Number(data.modelCallLimit));
                        if (data.toolCallLimit) await this.config.update?.('toolCallLimit', Number(data.toolCallLimit));
                        if (data.recursionLimit) await this.config.update?.('recursionLimit', Number(data.recursionLimit));
                        if (data.maxContext) await this.config.update?.('maxContext', Number(data.maxContext));
                        if (data.maxAgentTimeout) await this.config.update?.('maxAgentTimeout', Number(data.maxAgentTimeout));

                        if (data.remoteAdminApiUrl) await this.config.update?.('remoteAdminApiUrl', data.remoteAdminApiUrl);
                        if (data.remoteProxyBaseUrl) await this.config.update?.('remoteProxyBaseUrl', data.remoteProxyBaseUrl);
                        if (data.remoteManagerGuiUrl) await this.config.update?.('remoteManagerGuiUrl', data.remoteManagerGuiUrl);

                        if (data.kongWorkspace) await this.config.update?.('kongWorkspace', data.kongWorkspace);
                        if (data.kongAdminToken !== undefined) await this.config.update?.('kongAdminToken', data.kongAdminToken);
                        if (data.skipTlsVerify !== undefined) await this.config.update?.('skipTlsVerify', toBool(data.skipTlsVerify));
                        if (data.showThinking !== undefined) await this.config.update?.('showThinking', toBool(data.showThinking));
                        if (data.gitRemoteUrl !== undefined) await this.config.update?.('gitRemoteUrl', data.gitRemoteUrl);
                        if (data.autoCommit !== undefined) await this.config.update?.('autoCommit', toBool(data.autoCommit));

                        // 2. Generate and Record Diff
                        const labelMap: Record<string, string> = {
                            provider: 'LLM Provider',
                            model: 'Model ID',
                            kongMode: 'Gateway Mode',
                            storagePath: 'Workspace Path',
                            adminApiPort: 'Admin API Port',
                            managerGuiPort: 'Manager GUI Port',
                            proxyPort: 'Proxy Port',
                            databasePort: 'Database Port',
                            modelCallLimit: 'Max Model Calls',
                            toolCallLimit: 'Max Tool Calls',
                            recursionLimit: 'Max Recursion Limit',
                            maxContext: 'Max Context',
                            maxAgentTimeout: 'Timeout (s)',
                            kongWorkspace: 'Workspace',
                            kongAdminToken: 'Admin Token',
                            skipTlsVerify: 'Skip TLS Verification',
                            gitRemoteUrl: 'Git Remote URL',
                            autoCommit: 'Auto-Commit',
                            showThinking: 'Show Thinking Logs',
                            remoteAdminApiUrl: 'Remote Admin URL',
                            remoteProxyBaseUrl: 'Remote Proxy URL',
                            remoteManagerGuiUrl: 'Remote Manager URL',
                            openRouterApiKey: 'OpenRouter API Key',
                            geminiApiKey: 'Gemini API Key',
                            langChainTracing: 'Enable Tracing',
                            langSmithApiKey: 'LangSmith API Key',
                            langSmithProject: 'LangSmith Project',
                            langSmithEndpoint: 'LangSmith Endpoint'
                        };

                        const changes: string[] = [];
                        const diffKeys = Object.keys(labelMap);
                        for (const key of diffKeys) {
                            const oldValRaw = oldConfig[key];
                            const newValRaw = data[key];

                            // Only diff if the key is actually present in the incoming data
                            if (newValRaw === undefined) continue;

                            let oldVal = (oldValRaw !== undefined && oldValRaw !== null) ? oldValRaw.toString().trim() : '';
                            let newVal = (newValRaw !== undefined && newValRaw !== null) ? newValRaw.toString().trim() : '';

                            if (oldVal !== newVal) {
                                const label = labelMap[key];
                                const isSensitive = key.toLowerCase().includes('key') || key.toLowerCase().includes('token') || key.toLowerCase().includes('password') || key.toLowerCase().includes('secret');

                                if (isSensitive) {
                                    oldVal = oldVal ? '[REDACTED]' : 'empty';
                                    newVal = newVal ? '[REDACTED]' : 'empty';
                                } else if (key === 'gitRemoteUrl') {
                                    const maskUrl = (url: string) => url.replace(/([^:]+):([^@]+)@/, '$1:***@').replace(/\/\/([^@]+)@/, '//***@');
                                    oldVal = oldVal ? maskUrl(oldVal) : 'empty';
                                    newVal = newVal ? maskUrl(newVal) : 'empty';
                                }
                                changes.push(`- **${label}**: \`${oldVal}\` → \`${newVal}\``);
                            }
                        }

                        if (changes.length > 0) {
                            const diffMessage = `### ⚙️ Configuration Settings Changed\n${changes.join('\n')}`;
                            const history = this._agent.getMessages();
                            history.push({ role: 'ui-diff', content: diffMessage });
                            this._agent.setMessages(history);
                        }

                        if (this.toolManager && typeof this.toolManager.initializeCache === 'function') {
                            this.toolManager.initializeCache();
                        }
                        this._setupWatcher();
                        this.platform.showInformationMessage('Kong Gateway Agent: Configuration saved successfully.');
                        this._updateWebviewConfig();
                        break;
                    }
                case 'selectFolder':
                    {
                        const result = await vscode.window.showOpenDialog({
                            canSelectFiles: false,
                            canSelectFolders: true,
                            canSelectMany: false,
                            openLabel: 'Select Storage Folder'
                        });

                        if (result && result.length > 0) {
                            const folderPath = result[0].fsPath;
                            await this.config.update?.('storagePath', folderPath);
                            this.toolManager.initializeCache();
                            this._setupWatcher();
                            await this._updateWebviewConfig();
                        }
                        break;
                    }
                case 'requestReview':
                    {
                        const filename = data.filename;
                        // Immediate feedback
                        webviewView.webview.postMessage({ type: 'toolStatus', status: ` Analyzing diffs for ${filename}...` });

                        const storagePath = this.toolManager.getStoragePath();
                        const fullPath = path.join(storagePath, filename);

                        if (fs.existsSync(fullPath)) {
                            const newContent = fs.readFileSync(fullPath, 'utf8');

                            // 1. Check for a Pre-Agent Write snapshot first
                            const snapshot = this.toolManager.storage.getPreWriteSnapshot(filename);
                            const oldContent = snapshot !== undefined ? snapshot : (this.toolManager.getFileCache(filename) || "");

                            // 2. Generate the diff
                            const diff = DiffUtil.generateUnifiedDiff(filename, oldContent, newContent);
                            const chatDiff = DiffUtil.formatForChat(diff);

                            const fileType = await this._agent.classifyFile(newContent);
                            let govInstructions = "";
                            if (fileType === 'kong') {
                                govInstructions = `, call \`lint_kong_config\` and \`validate_kong_config\` for "${filename}" to verify it, and then call \`preview_sync_diff\` for "${filename}". **DO NOT CALL SYNC TOOLS**. Stop after presenting the review, validation, linting, and preview sync diff.`;
                            } else {
                                govInstructions = ". **DO NOT call any Kong-specific validation or sync tools**. Provide only a detailed summary of the changes and stop.";
                            }

                            const prompt = `I just manually updated ${filename}. Here is the diff:\n\n\`\`\`diff\n${chatDiff}\n\`\`\`\n\nCRITICAL INSTRUCTION: The file is ALREADY saved to disk. **DO NOT call \`write_storage_file\`**. Please review it according to the DECLARATIVE WORKFLOW. Provide a detailed LLM summary of the changes${govInstructions}`;

                            const messageId = Date.now().toString();
                            webviewView.webview.postMessage({ type: 'addMessage', role: 'user', content: prompt });
                            this.toolManager.updateFileCache(filename, newContent);

                            // Initialize agent message immediately to accurately track total elapsed time including TTFT
                            webviewView.webview.postMessage({ type: 'streamMessage', messageId, role: 'reasoning', content: '', startTime: data.timestamp });

                            await this._agent.processMessage(prompt, (content: string, type: string = 'agent') => {
                                this._dispatchAgentUpdate(webviewView, messageId, content, type);
                            }, data.timestamp);

                            const usageTotal = this._agent.getUsageStats().lastTurnUsage;
                            webviewView.webview.postMessage({
                                type: 'finalizeStreamedMessage',
                                messageId,
                                usage: usageTotal
                            });
                        }
                        break;
                    }
                case 'openFile':
                    {
                        if (data.filename) this.toolManager.openFile(data.filename);
                        break;
                    }
                case 'checkPorts':
                    {
                        const { PortUtil } = require('../../core/utils/PortUtil');
                        const results: any = {};
                        const ports = [
                            { key: 'proxy', value: parseInt(data.proxyPort) },
                            { key: 'admin', value: parseInt(data.adminPort) },
                            { key: 'manager', value: parseInt(data.managerPort) },
                            { key: 'db', value: parseInt(data.databasePort) }
                        ];

                        let report = "";
                        let hasCollision = false;
                        for (const p of ports) {
                            const inUse = await PortUtil.isPortInUse(p.value);
                            if (inUse) {
                                hasCollision = true;
                                const next = await PortUtil.findNextAvailablePort(p.value);
                                results[p.key] = { inUse: true, next };
                                report += `- **${p.key.toUpperCase()}** port ${p.value} is in use. Suggested: **${next}**\n`;
                            } else {
                                results[p.key] = { inUse: false };
                            }
                        }

                        webviewView.webview.postMessage({ type: 'portCheckResults', results, report, hasCollision });
                        break;
                    }
                case 'resetInstance':
                    {
                        const prompt = "I have requested a full reset of the Kong instance configuration from the UI dashboard. Please explain the consequences and, if I confirm, perform the reset using decK.";
                        await this._handleUserMessage(prompt);
                        break;
                    }
                case 'sendMessage':
                    {
                        await this._handleUserMessage(data.text, data.timestamp);
                        break;
                    }
                case 'updateThinkingPref':
                    {
                        await this.config.update?.('showThinking', data.show);
                        break;
                    }
                case 'resetConfig':
                    {
                        const config = vscode.workspace.getConfiguration('kongAgent');
                        await config.update('provider', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('model', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('openRouterApiKey', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('geminiApiKey', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('storagePath', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('proxyPort', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('adminApiPort', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('managerGuiPort', undefined, vscode.ConfigurationTarget.Global);

                        await this.toolManager.stop();
                        await this._updateWebviewConfig();
                        vscode.window.showInformationMessage('Kong Gateway Agent configuration has been reset to defaults.');
                        break;
                    }
                case 'fetchModels':
                    {
                        const models = await this._agent.fetchAvailableModels(data.provider, data.apiKey);
                        webviewView.webview.postMessage({ type: 'modelsFetched', models });
                        break;
                    }
                case 'requestClear':
                    {
                        const result = await vscode.window.showWarningMessage(
                            'Are you sure you want to clear the entire chat history and reset the Kong Agent context?',
                            { modal: true },
                            'Clear Chat'
                        );

                        if (result === 'Clear Chat') {
                            this._agent.resetContext();
                            await this._saveHistory();
                            await this._updateWebviewConfig();
                            webviewView.webview.postMessage({ type: 'performClear' });
                            this.platform.showInformationMessage('Kong Agent: Conversation context and UI have been reset.');
                        }
                        break;
                    }
                case 'cancelAgent':
                    {
                        this._agent.cancel();
                        break;
                    }
                case 'acceptDiff':
                    {
                        if (data.filename) {
                            try {
                                await this.toolManager.storage.commitStagedFile(data.filename);
                                this.platform.showInformationMessage(`Successfully applied changes to ${data.filename}`);
                                webviewView.webview.postMessage({ type: 'diffResolved', filename: data.filename, status: 'accepted' });
                                this._updateWebviewConfig(true);
                                
                                const storagePath = this.toolManager.getStoragePath();
                                if (storagePath) {
                                    const stagedFilePath = path.join(storagePath, `.staged_${data.filename}`);
                                    await this.platform.closeDiffEditor(stagedFilePath);
                                }
                                
                                // Automatically trigger the next workflow step for the agent
                                setTimeout(async () => {
                                    const fullPath = path.join(storagePath, data.filename);
                                    let type = 'other';
                                    if (fs.existsSync(fullPath)) {
                                        const content = fs.readFileSync(fullPath, 'utf8');
                                        type = await this._agent.classifyFile(content);
                                    }

                                    let prompt = `I have accepted the changes to ${data.filename}. Please perform an LLM review and provide a detailed summary of the changes.`;
                                    if (type === 'kong') {
                                        prompt += ` After the review, use \`lint_kong_config\` and \`validate_kong_config\` to verify the configuration, and finally show me the sync preview.`;
                                    }

                                    this._handleUserMessage(prompt, data.timestamp);
                                }, 500);
                            } catch (e: any) {
                                this.platform.showErrorMessage(`Failed to apply changes: ${e.message}`);
                            }
                        }
                        break;
                    }
                case 'rejectDiff':
                    {
                        if (data.filename) {
                            try {
                                await this.toolManager.storage.discardStagedFile(data.filename);
                                this.platform.showInformationMessage(`Discarded changes for ${data.filename}`);
                                webviewView.webview.postMessage({ type: 'diffResolved', filename: data.filename, status: 'rejected' });
                                this._updateWebviewConfig(true);
                                
                                const storagePath = this.toolManager.getStoragePath();
                                if (storagePath) {
                                    const stagedFilePath = path.join(storagePath, `.staged_${data.filename}`);
                                    await this.platform.closeDiffEditor(stagedFilePath);
                                }
                            } catch (e: any) {
                                this.platform.showErrorMessage(`Failed to discard changes: ${e.message}`);
                            }
                        }
                        break;
                    }
                case 'acceptAllDiffs':
                    {
                        try {
                            const stagedFiles = this.toolManager.storage.getStagedFiles();
                            const storagePath = this.toolManager.getStoragePath();
                            
                            await this.toolManager.storage.commitAllStagedFiles();
                            this.platform.showInformationMessage(`Successfully applied all staged changes.`);
                            webviewView.webview.postMessage({ type: 'allDiffsResolved', status: 'accepted' });
                            this._updateWebviewConfig(true);
                            
                            if (storagePath) {
                                for (const filename of stagedFiles) {
                                    const stagedFilePath = path.join(storagePath, `.staged_${filename}`);
                                    await this.platform.closeDiffEditor(stagedFilePath);
                                }
                            }
                            
                            setTimeout(() => {
                                this._handleUserMessage(`I have accepted all staged changes. Please perform an LLM review and provide a detailed summary of the changes, then use \`lint_kong_config\` and \`validate_kong_config\` to verify the configuration, and finally show me the sync preview.`, data.timestamp);
                            }, 500);
                        } catch (e: any) {
                            this.platform.showErrorMessage(`Failed to apply changes: ${e.message}`);
                        }
                        break;
                    }
                case 'rejectAllDiffs':
                    {
                        try {
                            const stagedFiles = this.toolManager.storage.getStagedFiles();
                            const storagePath = this.toolManager.getStoragePath();
                            
                            await this.toolManager.storage.discardAllStagedFiles();
                            this.platform.showInformationMessage(`Discarded all staged changes.`);
                            webviewView.webview.postMessage({ type: 'allDiffsResolved', status: 'rejected' });
                            this._updateWebviewConfig(true);
                            
                            if (storagePath) {
                                for (const filename of stagedFiles) {
                                    const stagedFilePath = path.join(storagePath, `.staged_${filename}`);
                                    await this.platform.closeDiffEditor(stagedFilePath);
                                }
                            }
                        } catch (e: any) {
                            this.platform.showErrorMessage(`Failed to discard changes: ${e.message}`);
                        }
                        break;
                    }
            }
        });
    }

    private async _loadHistory() {
        // 1. Try loading from MemoryManager (disk)
        const diskHistory = await this._agent.memory.loadChatHistory();
        if (diskHistory.length > 0) {
            this._agent.setMessages(diskHistory);
            return;
        }

        // 2. Migration: Check globalState (legacy)
        const legacyHistory = this.context.globalState.get<any[]>('kongAgentChatHistory', []);
        if (legacyHistory.length > 0) {
            this._agent.setMessages(legacyHistory);
            // Save to disk immediately to complete migration
            await this._agent.memory.saveChatHistory(this._agent.getMessages());
            // Clear legacy history to avoid double migration
            await this.context.globalState.update('kongAgentChatHistory', undefined);
        }
    }

    private async _saveHistory() {
        // Now handled automatically by Agent.ts at the end of every turn
        // But we keep this for any manual state changes or UI-only updates
        await this._agent.memory.saveChatHistory(this._agent.getMessages());
    }

    private async _updateWebviewConfig(skipHistory: boolean = false) {
        if (this._view) {
            const history = this._agent.getMessages().map((msg: any) => ({
                role: msg.role === 'assistant' ? 'agent' : msg.role,
                content: msg.content,
                reasoning: msg.reasoning || '',
                toolInteractions: msg.toolInteractions || [],
                complete: true,
                startTime: msg.startTime || Date.now(),
                endTime: msg.endTime || Date.now(),
                lastUsage: msg.lastUsage
            }));

            // Phase 1: INSTANT SYNC (no blockers)
            this._view.webview.postMessage({
                type: 'setConfig',
                provider: this.config.get('provider'),
                model: this.config.get('model'),
                storagePath: this.config.get('storagePath'),
                kongMode: this.config.get('kongMode') || 'local',
                proxyPort: this.config.get('proxyPort'),
                adminApiPort: this.config.get('adminApiPort'),
                managerGuiPort: this.config.get('managerGuiPort'),
                databasePort: this.config.get('databasePort') || 5432,
                modelCallLimit: this.config.get('modelCallLimit') || 10,
                toolCallLimit: this.config.get('toolCallLimit') || 10,
                recursionLimit: this.config.get('recursionLimit') || 50,
                maxContext: this.config.get('maxContext') || 130000,
                maxAgentTimeout: this.config.get('maxAgentTimeout') || 100,
                remoteAdminApiUrl: this.config.get('remoteAdminApiUrl'),
                remoteProxyBaseUrl: this.config.get('remoteProxyBaseUrl'),
                remoteManagerGuiUrl: this.config.get('remoteManagerGuiUrl'),
                kongWorkspace: this.config.get('kongWorkspace') || 'default',
                kongAdminToken: this.config.get('kongAdminToken'),
                skipTlsVerify: this.config.get('skipTlsVerify') === true,
                gitRemoteUrl: this.config.get('gitRemoteUrl') || '',
                autoCommit: this.config.get('autoCommit') === true,
                showThinking: this.config.get('showThinking') !== false,
                trackedFiles: this._agent.activeFiles || {},
                langChainTracing: this.config.get('langChainTracing') === true,
                langSmithApiKey: this.config.get('langSmithApiKey') || '',
                langSmithProject: this.config.get('langSmithProject') || 'kong-gateway-agent',
                langSmithEndpoint: this.config.get('langSmithEndpoint') || 'https://api.smith.langchain.com',
                stagedFiles: this.toolManager.storage.getStagedFiles(),
                usageStats: this._agent.getUsageStats(),
                ...(skipHistory ? {} : { history: history })
            });

            // Phase 2: ASYNC HEAVY SYNC (non-blocking updates)
            (async () => {
                try {
                    const [models, files, detectedFiles] = await Promise.all([
                        this._agent.fetchAvailableModels(),
                        this.toolManager.listStorageFiles(),
                        this.toolManager.storage.findFilesByContent()
                    ]);

                    if (this._view) {
                        this._view.webview.postMessage({
                            type: 'setConfig',
                            models,
                            files,
                            detectedFiles
                        });
                    }
                } catch (e) {
                    console.error('Async startup update failed:', e);
                }
            })();
        }
    }


    private _dispatchAgentUpdate(webviewView: vscode.WebviewView, messageId: string, content: string, type: string) {
        if (type === 'toolStatus') {
            webviewView.webview.postMessage({ type: 'toolStatus', status: content || 'Analyzing request...' });
        } else if (type === 'error') {
            webviewView.webview.postMessage({ type: 'addMessage', role: 'system', content: `❌ ${content}` });
            webviewView.webview.postMessage({ type: 'toolStatus', status: '' });
        } else if (type === 'finish') {
            webviewView.webview.postMessage({ type: 'toolStatus', status: '' });
        } else if (type === 'toolInteraction') {
            try {
                const interactionData = JSON.parse(content);
                webviewView.webview.postMessage({
                    type: 'toolInteraction',
                    messageId,
                    toolCallId: interactionData.id,
                    interaction: interactionData.interaction
                });
            } catch (e) {
                console.error('Failed to parse tool interaction data:', e);
            }
        } else {
            // For streaming content (agent text or reasoning), use streamMessage
            webviewView.webview.postMessage({
                type: 'streamMessage',
                messageId,
                role: type,
                content
            });
        }
        // Update session total in real-time
        webviewView.webview.postMessage({ type: 'updateUsage', stats: this._agent.getUsageStats() });
    }

    private async _handleUserMessage(text: string, timestamp?: number) {
        if (!this._view) return;
        const webviewView = this._view;
        const messageId = Date.now().toString();
        webviewView.webview.postMessage({ type: 'addMessage', role: 'user', content: text });
        webviewView.webview.postMessage({ type: 'toolStatus', status: 'Thinking...' });

        // Initialize agent message immediately to accurately track total elapsed time including TTFT
        webviewView.webview.postMessage({ type: 'streamMessage', messageId, role: 'reasoning', content: '', startTime: timestamp });

        await this._agent.processMessage(text, (content: string, type: string = 'agent') => {
            this._dispatchAgentUpdate(webviewView, messageId, content, type);
        }, timestamp);

        const usageTotal = this._agent.getUsageStats().lastTurnUsage;
        webviewView.webview.postMessage({
            type: 'finalizeStreamedMessage',
            messageId,
            usage: usageTotal
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'platforms', 'vscode', 'media', 'chat.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link rel="stylesheet" href="${styleUri}">
                <link rel="stylesheet" href="${codiconsUri}">
            </head>
            <body>
                <div id="root"></div>
                <script type="module" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Agent } from '../../core/agent/Agent';
import { ToolManager } from '../../core/agent/tools/ToolManager';
import { DiffUtil } from '../../core/utils/DiffUtil';
import { IConfig, IAppPlatform } from '../../core/interfaces/ICoreInterfaces';

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
        this.toolManager.initializeCache();
        this._setupWatcher();
    }

    private _setupWatcher() {
        if (this._watcher) {
            this._watcher.dispose();
        }

        const storagePath = this.toolManager.getStoragePath();

        if (storagePath && fs.existsSync(storagePath)) {
            const storageUri = vscode.Uri.file(storagePath);
            this._watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(storageUri, '**/*.{yml,yaml,json}')
            );

            this._watcher.onDidChange(uri => this._handleFileChange(uri));
            this._watcher.onDidCreate(uri => this._handleFileChange(uri));
        }
    }

    private _handleFileChange(uri: vscode.Uri) {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }

        this._debounceTimer = setTimeout(() => {
            if (this._view) {
                const filename = path.basename(uri.fsPath);
                this._view.webview.postMessage({
                    type: 'fileChanged',
                    filename: filename
                });
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

        this._updateWebviewConfig();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'prompt':
                    {
                        webviewView.webview.postMessage({ type: 'addMessage', role: 'user', content: data.value });
                        await this._agent.processMessage(data.value, (content: string, type: string = 'agent') => {
                            if (type === 'toolStatus') {
                                webviewView.webview.postMessage({ type: 'toolStatus', status: content });
                            } else {
                                // For the final message (agent type), include usage
                                const usage = type === 'agent' ? this._agent.getUsageStats().lastTurnUsage : undefined;
                                webviewView.webview.postMessage({ type: 'addMessage', role: type, content, lastUsage: usage });
                            }
                            // Update session total in real-time
                            webviewView.webview.postMessage({ type: 'updateUsage', stats: this._agent.getUsageStats() });
                        });
                        break;
                    }
                case 'updateConfig':
                    {
                        await this.config.update?.('provider', data.provider);
                        await this.config.update?.('model', data.model);
                        await this.config.update?.('openRouterApiKey', data.apiKey);
                        await this.config.update?.('geminiApiKey', data.geminiApiKey);
                        await this.config.update?.('storagePath', data.storagePath);
                        await this.config.update?.('kongMode', data.kongMode);
                        
                        if (data.proxyPort) await this.config.update?.('proxyPort', parseInt(data.proxyPort));
                        if (data.adminPort) await this.config.update?.('adminApiPort', parseInt(data.adminPort));
                        if (data.managerPort) await this.config.update?.('managerGuiPort', parseInt(data.managerPort));
                        if (data.databasePort) await this.config.update?.('databasePort', parseInt(data.databasePort));
                        if (data.maxDepth) await this.config.update?.('maxToolDepth', parseInt(data.maxDepth));
                        if (data.maxContext) await this.config.update?.('maxContext', parseInt(data.maxContext));
                        if (data.maxAgentTimeout) await this.config.update?.('maxAgentTimeout', parseInt(data.maxAgentTimeout));
                        
                        await this.config.update?.('remoteAdminApiUrl', data.remoteAdminUrl);
                        await this.config.update?.('remoteProxyBaseUrl', data.remoteProxyUrl);
                        await this.config.update?.('remoteManagerGuiUrl', data.remoteManagerUrl);
                        
                        await this.config.update?.('kongWorkspace', data.kongWorkspace);
                        await this.config.update?.('kongAdminToken', data.kongAdminToken);
                        await this.config.update?.('skipTlsVerify', data.skipTlsVerify);
                        await this.config.update?.('gitRemoteUrl', data.gitRemoteUrl);
                        await this.config.update?.('autoCommit', data.autoCommit);

                        this.toolManager.initializeCache();
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
                        const storagePath = this.toolManager.getStoragePath();
                        const fullPath = path.join(storagePath, filename);
                        
                        if (fs.existsSync(fullPath)) {
                            const newContent = fs.readFileSync(fullPath, 'utf8');
                            const oldContent = this.toolManager.getFileCache(filename) || "";
                            const diff = DiffUtil.generateUnifiedDiff(filename, oldContent, newContent);
                            const chatDiff = DiffUtil.formatForChat(diff);
                            const prompt = `I just manually updated ${filename}. Here is the diff:\n\n\`\`\`diff\n${chatDiff}\n\`\`\`\n\nPlease review it according to the DECLARATIVE WORKFLOW. **DO NOT CALL SYNC TOOLS**. Stop after showing the preview diff.`;
                            
                            webviewView.webview.postMessage({ type: 'addMessage', role: 'user', content: prompt });
                            this.toolManager.updateFileCache(filename, newContent);

                            await this._agent.processMessage(prompt, (content: string, type: string = 'agent') => {
                                if (type === 'toolStatus') {
                                    webviewView.webview.postMessage({ type: 'toolStatus', status: content });
                                } else {
                                    const usage = type === 'agent' ? this._agent.getUsageStats().lastTurnUsage : undefined;
                                    webviewView.webview.postMessage({ type: 'addMessage', role: type, content, lastUsage: usage });
                                }
                                // Update usage stats in real-time
                                webviewView.webview.postMessage({ type: 'updateUsage', stats: this._agent.getUsageStats() });
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
                        webviewView.webview.postMessage({ type: 'addMessage', role: 'user', content: prompt });
                        await this._agent.processMessage(prompt, (content: string, type: string = 'agent') => {
                            if (type === 'toolStatus') {
                                webviewView.webview.postMessage({ type: 'toolStatus', status: content });
                            } else {
                                webviewView.webview.postMessage({ type: 'addMessage', role: type, content });
                            }
                            // Update usage stats in real-time
                            webviewView.webview.postMessage({ type: 'updateUsage', stats: this._agent.getUsageStats() });
                        });
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
            }
        });
    }

    private async _updateWebviewConfig() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'setConfig',
                provider: this.config.get('provider'),
                model: this.config.get('model'),
                apiKey: this.config.get('openRouterApiKey'),
                geminiApiKey: this.config.get('geminiApiKey'),
                storagePath: this.config.get('storagePath'),
                kongMode: this.config.get('kongMode') || 'local',
                proxyPort: this.config.get('proxyPort'),
                adminPort: this.config.get('adminApiPort'),
                managerPort: this.config.get('managerGuiPort'),
                databasePort: this.config.get('databasePort') || 5432,
                remoteAdminUrl: this.config.get('remoteAdminApiUrl'),
                remoteProxyUrl: this.config.get('remoteProxyBaseUrl'),
                remoteManagerUrl: this.config.get('remoteManagerGuiUrl'),
                kongWorkspace: this.config.get('kongWorkspace') || 'default',
                kongAdminToken: this.config.get('kongAdminToken'),
                skipTlsVerify: this.config.get('skipTlsVerify') === true,
                gitRemoteUrl: this.config.get('gitRemoteUrl') || '',
                autoCommit: this.config.get('autoCommit') === true,
                maxDepth: this.config.get('maxToolDepth') || 10,
                maxContext: this.config.get('maxContext') || 130000,
                maxAgentTimeout: this.config.get('maxAgentTimeout') || 100,
                showThinking: this.config.get('showThinking') !== false,
                models: await this._agent.fetchAvailableModels(),
                files: await this.toolManager.listStorageFiles(),
                usageStats: this._agent.getUsageStats()
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'platforms', 'vscode', 'media', 'chat.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'platforms', 'vscode', 'media', 'chat.js'));
        const htmlPath = path.join(this._extensionUri.fsPath, 'src', 'platforms', 'vscode', 'media', 'chat.html');
        
        let html = fs.readFileSync(htmlPath, 'utf8');
        
        // Replace placeholders
        html = html.replace(/\${styleUri}/g, styleUri.toString());
        html = html.replace(/\${scriptUri}/g, scriptUri.toString());
        
        return html;
    }
}

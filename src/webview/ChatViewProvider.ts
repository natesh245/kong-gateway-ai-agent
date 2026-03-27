import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Agent } from '../llm/Agent';
import { KongDockerManager } from '../docker/KongDockerManager';
import { DiffUtil } from '../utils/DiffUtil';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'kongAgentChat';
    private _view?: vscode.WebviewView;
    private _agent: Agent;
    private _watcher?: vscode.FileSystemWatcher;
    private _debounceTimer?: NodeJS.Timeout;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private context: vscode.ExtensionContext,
        private dockerManager: KongDockerManager
    ) {
        this._agent = new Agent(context, dockerManager);
        this.dockerManager.initializeCache();
        this._setupWatcher();
    }

    private _setupWatcher() {
        if (this._watcher) {
            this._watcher.dispose();
        }

        const storagePath = this.dockerManager.getStoragePath();

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
                            webviewView.webview.postMessage({ type: 'addMessage', role: type, content });
                        });
                        break;
                    }
                case 'updateConfig':
                    {
                        const config = vscode.workspace.getConfiguration('kongAgent');
                        await config.update('provider', data.provider, vscode.ConfigurationTarget.Global);
                        await config.update('model', data.model, vscode.ConfigurationTarget.Global);
                        await config.update('openRouterApiKey', data.apiKey, vscode.ConfigurationTarget.Global);
                        await config.update('storagePath', data.storagePath, vscode.ConfigurationTarget.Global);
                        await config.update('kongMode', data.kongMode, vscode.ConfigurationTarget.Global);
                        
                        if (data.proxyPort) await config.update('proxyPort', parseInt(data.proxyPort), vscode.ConfigurationTarget.Global);
                        if (data.adminPort) await config.update('adminApiPort', parseInt(data.adminPort), vscode.ConfigurationTarget.Global);
                        if (data.managerPort) await config.update('managerGuiPort', parseInt(data.managerPort), vscode.ConfigurationTarget.Global);
                        if (data.databasePort) await config.update('databasePort', parseInt(data.databasePort), vscode.ConfigurationTarget.Global);
                        if (data.maxDepth) await config.update('maxToolDepth', parseInt(data.maxDepth), vscode.ConfigurationTarget.Global);
                        
                        await config.update('remoteAdminApiUrl', data.remoteAdminUrl, vscode.ConfigurationTarget.Global);
                        await config.update('remoteProxyBaseUrl', data.remoteProxyUrl, vscode.ConfigurationTarget.Global);
                        await config.update('remoteManagerGuiUrl', data.remoteManagerUrl, vscode.ConfigurationTarget.Global);
                        
                        await config.update('kongWorkspace', data.kongWorkspace, vscode.ConfigurationTarget.Global);
                        await config.update('kongAdminToken', data.kongAdminToken, vscode.ConfigurationTarget.Global);
                        await config.update('skipTlsVerify', data.skipTlsVerify, vscode.ConfigurationTarget.Global);
                        await config.update('gitRemoteUrl', data.gitRemoteUrl, vscode.ConfigurationTarget.Global);
                        await config.update('autoCommit', data.autoCommit, vscode.ConfigurationTarget.Global);

                        this.dockerManager.initializeCache();
                        this._setupWatcher();
                        await this._updateWebviewConfig();
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
                            const config = vscode.workspace.getConfiguration('kongAgent');
                            await config.update('storagePath', folderPath, vscode.ConfigurationTarget.Global);
                            this.dockerManager.initializeCache();
                            this._setupWatcher();
                            await this._updateWebviewConfig();
                        }
                        break;
                    }
                case 'requestReview':
                    {
                        const filename = data.filename;
                        const storagePath = this.dockerManager.getStoragePath();
                        const fullPath = path.join(storagePath, filename);
                        
                        if (fs.existsSync(fullPath)) {
                            const newContent = fs.readFileSync(fullPath, 'utf8');
                            const oldContent = this.dockerManager.getFileCache(filename) || "";
                            const diff = DiffUtil.generateUnifiedDiff(filename, oldContent, newContent);
                            const chatDiff = DiffUtil.formatForChat(diff);
                            const prompt = `I just manually updated ${filename}. Here is the diff:\n\n\`\`\`diff\n${chatDiff}\n\`\`\`\n\nPlease review it according to the DECLARATIVE WORKFLOW. **DO NOT CALL SYNC TOOLS**. Stop after showing the preview diff.`;
                            
                            webviewView.webview.postMessage({ type: 'addMessage', role: 'user', content: prompt });
                            this.dockerManager.updateFileCache(filename, newContent);

                            await this._agent.processMessage(prompt, (content: string, type: string = 'agent') => {
                                webviewView.webview.postMessage({ type: 'addMessage', role: type, content });
                            });
                        }
                        break;
                    }
                case 'openFile':
                    {
                        if (data.filename) this.dockerManager.openFile(data.filename);
                        break;
                    }
                case 'checkPorts':
                    {
                        const { PortUtil } = require('../utils/PortUtil');
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
                            webviewView.webview.postMessage({ type: 'addMessage', role: type, content });
                        });
                        break;
                    }
                case 'updateThinkingPref':
                    {
                        const config = vscode.workspace.getConfiguration('kongAgent');
                        await config.update('showThinking', data.show, vscode.ConfigurationTarget.Global);
                        break;
                    }
                case 'resetConfig':
                    {
                        const config = vscode.workspace.getConfiguration('kongAgent');
                        await config.update('provider', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('model', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('openRouterApiKey', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('storagePath', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('proxyPort', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('adminApiPort', undefined, vscode.ConfigurationTarget.Global);
                        await config.update('managerGuiPort', undefined, vscode.ConfigurationTarget.Global);
                        
                        await this.dockerManager.stop();
                        await this._updateWebviewConfig();
                        vscode.window.showInformationMessage('Kong Gateway Agent configuration has been reset to defaults.');
                        break;
                    }
            }
        });
    }

    private async _updateWebviewConfig() {
        if (this._view) {
            const config = vscode.workspace.getConfiguration('kongAgent');
            this._view.webview.postMessage({
                type: 'setConfig',
                provider: config.get('provider'),
                model: config.get('model'),
                apiKey: config.get('openRouterApiKey'),
                storagePath: config.get('storagePath'),
                kongMode: config.get('kongMode') || 'local',
                proxyPort: config.get('proxyPort'),
                adminPort: config.get('adminApiPort'),
                managerPort: config.get('managerGuiPort'),
                databasePort: config.get('databasePort') || 5432,
                remoteAdminUrl: config.get('remoteAdminApiUrl'),
                remoteProxyUrl: config.get('remoteProxyBaseUrl'),
                remoteManagerUrl: config.get('remoteManagerGuiUrl'),
                kongWorkspace: config.get('kongWorkspace') || 'default',
                kongAdminToken: config.get('kongAdminToken'),
                skipTlsVerify: config.get('skipTlsVerify') === true,
                gitRemoteUrl: config.get('gitRemoteUrl') || '',
                autoCommit: config.get('autoCommit') === true,
                maxDepth: config.get('maxToolDepth') || 10,
                showThinking: config.get('showThinking') !== false,
                files: await this.dockerManager.listStorageFiles()
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&display=swap');
        
        :root {
            --accent: #F51A56;
            --accent-gradient: linear-gradient(135deg, #F51A56, #FF4D80);
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --bubble-user: rgba(46, 134, 171, 0.15);
            --bubble-agent: rgba(255, 255, 255, 0.03);
            --panel-bg: rgba(0, 0, 0, 0.2);
            --border: rgba(255, 255, 255, 0.1);
        }

        body {
            font-family: 'Outfit', sans-serif; background-color: var(--bg);
            color: var(--fg); margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden;
        }

        .header {
            padding: 20px 16px; background: linear-gradient(135deg, #0A2540, #1E3A5F); color: white;
            font-weight: 600; text-align: left; box-shadow: 0 10px 30px rgba(0,0,0,0.4);
            border-bottom: 2px solid var(--accent); position: relative; z-index: 10;
            display: flex; align-items: center; gap: 10px;
        }
        .header .logo { font-size: 24px; }

        .chat-container { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; scroll-behavior: smooth; }

        .message {
            max-width: 95%; padding: 14px 18px; border-radius: 16px; line-height: 1.6;
            animation: fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; position: relative;
            font-size: 13px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);
        }
        .message.user { 
            align-self: flex-end; background: var(--bubble-user); border: 1px solid rgba(46, 134, 171, 0.3); 
            border-bottom-right-radius: 4px;
        }
        .message.agent { 
            align-self: flex-start; background: var(--bubble-agent); border: 1px solid var(--border); 
            border-bottom-left-radius: 4px; border-left: 3px solid var(--accent);
        }
        
        .message.toolCall {
            align-self: flex-start; background: rgba(0,0,0,0.2); border: 1px dashed var(--border);
            font-size: 11px; color: #888; font-family: 'Courier New', Courier, monospace; 
            padding: 8px 12px; border-radius: 8px; margin-left: 20px;
        }
        .message.toolCall::before {
            content: ''; position: absolute; left: -14px; top: 18px; width: 8px; height: 8px;
            background: var(--accent); border-radius: 50%; box-shadow: 0 0 10px var(--accent);
        }

        .message.toolResult {
            align-self: flex-start; background: rgba(0,0,0,0.4); border: 1px solid var(--border);
            font-size: 10px; color: #777; font-family: 'Courier New', Courier, monospace;
            margin-top: -10px; margin-left: 20px; max-width: 85%; display: none; padding: 10px; border-radius: 8px;
        }

        .tool-toggle { cursor: pointer; color: #2E86AB; font-size: 10px; margin-top: 4px; text-decoration: underline; margin-left: 24px; font-weight: 500; }

        .message h1, .message h2, .message h3 { margin-top: 5px; color: #eee; }
        .message code { background: rgba(0,0,0,0.3); padding: 2px 5px; border-radius: 4px; font-family: 'Courier New', Courier, monospace; color: #F51A56; }
        .message pre { background: #1e1e1e !important; padding: 12px; border-radius: 10px; overflow-x: auto; border: 1px solid var(--border); margin: 12px 0; }
        .message pre code { background: none; padding: 0; color: inherit; font-size: 11px; }

        .diff-added { color: #4ec9b0; background: rgba(78, 201, 176, 0.1); display: block; padding-left: 4px; }
        .diff-removed { color: #f44747; background: rgba(244, 71, 71, 0.1); display: block; padding-left: 4px; }

        .notification-toast {
            background: rgba(30, 30, 30, 0.95); backdrop-filter: blur(10px);
            padding: 16px; border-radius: 12px; margin: 0 16px 10px 16px; display: none; flex-direction: column; gap: 10px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.5); border: 1px solid var(--accent); animation: slideUp 0.3s ease-out;
        }

        .input-container { 
            padding: 12px 16px; background: var(--bg); border-top: 1px solid var(--border); 
            display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; position: relative; z-index: 100;
        }
        .settings-container { margin-bottom: 2px; border: 1px solid transparent; border-radius: 8px; transition: all 0.2s; }
        .settings-container[open] { border-color: var(--border); background: rgba(0,0,0,0.1); margin-bottom: 12px; }
        
        details summary { 
            list-style: none; outline: none; cursor: pointer; padding: 10px 12px; border-radius: 8px;
            transition: all 0.2s; font-size: 11px; color: #aaa; text-transform: uppercase; letter-spacing: 0.8px;
            display: flex; justify-content: space-between; align-items: center; font-weight: 600;
            background: rgba(255,255,255,0.03);
        }
        details summary::-webkit-details-marker { display: none; }
        details summary:hover { background: rgba(255,255,255,0.08); color: white; }
        details summary .toggle-icon { transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); font-size: 10px; }
        details[open] summary .toggle-icon { transform: rotate(180deg); color: var(--accent); }
        details[open] summary { margin-bottom: 12px; background: none; }

        .settings-panel { 
            padding: 14px; background: var(--panel-bg); border-radius: 12px; 
            display: flex; flex-direction: column; gap: 10px; font-size: 11px; 
            border: 1px solid var(--border); overflow-y: auto; max-height: 250px;
        }
        .settings-panel::-webkit-scrollbar { width: 4px; }
        .settings-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
        .settings-panel::-webkit-scrollbar-thumb:hover { background: var(--accent); }
        .settings-row { display: flex; align-items: center; gap: 10px; }
        .settings-row label { width: 80px; color: var(--vscode-descriptionForeground); font-weight: 500; }
        .settings-row input, .settings-row select { 
            flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); 
            border: 1px solid var(--vscode-input-border); padding: 6px 10px; border-radius: 6px; outline: none;
        }
        
        .ports-grid { 
            display: grid; grid-template-columns: 1fr 1fr; gap: 8px; 
            margin-top: 4px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.05); 
        }
        .port-card {
            background: rgba(255,255,255,0.03); border: 1px solid var(--border);
            padding: 8px; border-radius: 8px; display: flex; flex-direction: column; gap: 4px;
        }
        .port-card label { font-size: 9px; color: #888; text-transform: uppercase; }
        .port-card input { width: 100%; border: none; background: none; font-size: 13px; font-weight: 600; padding: 0; color: white; }
        .port-card input:focus { outline: none; color: var(--accent); }

        .managed-files {
            margin-top: 8px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.05);
            display: flex; flex-direction: column; gap: 4px;
        }
        .file-item {
            display: flex; justify-content: space-between; align-items: center;
            padding: 8px 10px; background: rgba(255,255,255,0.03); border-radius: 8px;
            font-size: 11px; border: 1px solid transparent; transition: all 0.2s;
        }
        .file-item:hover { background: rgba(255,255,255,0.06); border-color: var(--border); }
        .file-item .file-name { color: #ccc; font-family: 'Courier New', Courier, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .file-item button { 
            background: none; border: none; color: var(--accent); cursor: pointer; 
            font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px;
        }
        .file-item button:hover { background: rgba(245, 26, 86, 0.1); }

        .section-header { 
            font-size: 9px; color: #666; text-transform: uppercase; 
            margin: 12px 0 6px 0; font-weight: 600; letter-spacing: 0.5px;
            display: flex; align-items: center; gap: 8px;
        }
        .section-header::after { content: ""; flex: 1; height: 1px; background: rgba(255,255,255,0.05); }

        .hidden { display: none !important; }

        .reset-btn {
            background: none; border: 1px solid rgba(255,255,255,0.1); color: #888;
            padding: 8px; border-radius: 8px; font-size: 10px; cursor: pointer;
            margin-top: 8px; transition: all 0.2s; text-align: center; width: 100%;
        }
        .reset-btn:hover { background: rgba(255,255,255,0.05); color: white; border-color: rgba(255,255,255,0.2); }
        .danger-btn {
            background: rgba(244, 71, 71, 0.1); border: 1px solid rgba(244, 71, 71, 0.2); color: #f44747;
            padding: 8px; border-radius: 8px; font-size: 10px; cursor: pointer;
            margin-top: 8px; transition: all 0.2s; text-align: center; width: 100%; font-weight: 600;
        }
        .danger-btn:hover { background: #f44747; color: white; border-color: #f44747; box-shadow: 0 0 15px rgba(244, 71, 71, 0.3); }
        
        .chat-input-row { display: flex; gap: 10px; }
        #prompt { 
            flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); 
            border: 1px solid var(--vscode-input-border); padding: 12px 16px; border-radius: 12px; outline: none;
            transition: all 0.2s; resize: none; min-height: 48px; max-height: 200px;
            font-family: inherit; line-height: 1.5;
        }
        #prompt:focus { border-color: var(--accent); }
        #send { 
            background: var(--accent-gradient); color: white; border: none; padding: 0 20px; 
            border-radius: 12px; cursor: pointer; font-weight: 600; box-shadow: 0 4px 15px rgba(245, 26, 86, 0.3);
            transition: transform 0.1s;
        }
        #send:active { transform: scale(0.95); }

        .typing { display: none; margin-left:24px; color:#888; font-size:11px; margin-bottom: 12px; font-style: italic; }
        
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

        table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12px; }
        th, td { border: 1px solid var(--border); padding: 8px; text-align: left; }
        th { background: rgba(255,255,255,0.05); }
        
        /* Thinking & Error Styles */
        .thinking { 
            font-size: 11px; color: #888; background: rgba(255,255,255,0.02); 
            border-left: 2px dashed #444; padding: 6px 12px; margin: 4px 16px; border-radius: 4px; 
        }
        .error-message { 
            background: rgba(244, 71, 71, 0.1) !important; color: #f44747 !important; 
            border: 1px solid rgba(244, 71, 71, 0.3) !important; padding: 12px !important; border-radius: 8px !important;
            font-weight: 500; font-family: monospace;
        }
        .hidden-thinking { display: none !important; }

        /* Approval Buttons */
        .approval-container {
            display: flex; gap: 10px; margin-top: 12px; padding-top: 12px;
            border-top: 1px solid var(--border);
        }
        .approval-btn {
            flex: 1; padding: 10px; border-radius: 8px; cursor: pointer;
            font-size: 11px; font-weight: 600; text-align: center;
            transition: all 0.2s; border: none;
        }
        .approval-btn.yes {
            background: var(--accent-gradient); color: white;
            box-shadow: 0 4px 12px rgba(245, 26, 86, 0.2);
        }
        .approval-btn.no {
            background: rgba(255, 255, 255, 0.05); color: #ccc;
            border: 1px solid var(--border);
        }
        .approval-btn:hover { transform: translateY(-2px); filter: brightness(1.1); }
        .approval-btn:active { transform: translateY(0); }
        .approval-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    </style>
</head>
<body>
    <div class="header">
        <span class="logo">🦍</span>
        <span>Kong Gateway Agent</span>
    </div>
    <div id="notification" class="notification-toast">
        <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:12px;font-weight:500;">Detected change in <b id="changed-filename" style="color:var(--accent);">file.yml</b></span>
            <button id="dismiss-btn" style="background:none;border:none;color:inherit;cursor:pointer;font-size:20px;line-height:1;">&times;</button>
        </div>
        <button id="review-btn" style="background:var(--accent);color:white;border:none;padding:8px;border-radius:8px;font-size:11px;cursor:pointer;font-weight:600;">🔍 Review & Analyze Diffs</button>
    </div>
    <div class="chat-container" id="chat">
        <div class="message agent">Hello! I am your **Kong Gateway Agent**. \n\nI can help you manage your local Kong setup:
- 🚀 **Start/Stop** Kong via Docker
- 🛠️ **Configure** Services, Routes, and Consumers
- 🔍 **Review** your edits
- ⚡ **Verify** connectivity

What can I do for you today?</div>
    </div>
    <div class="typing" id="typing">Agent is processing...</div>
    <div class="input-container">
        <details class="settings-container">
            <summary>
                <span>Configuration Settings</span>
                <span class="toggle-icon">▼</span>
            </summary>
            <div class="settings-panel">
                <div class="settings-row"><label>LLM AI</label><select id="provider-select"><option value="openrouter">OpenRouter</option><option value="local">Ollama</option></select></div>
                <div class="settings-row"><label>Model</label><input type="text" id="model-input" placeholder="e.g. openai/gpt-4o"/></div>
                <div class="settings-row" id="api-key-row"><label>API Key</label><input type="password" id="api-key-input"/></div>
                <div class="settings-row" style="margin-top:8px; background:rgba(255,255,255,0.03); padding:8px; border-radius:8px;">
                    <label style="color:var(--accent); font-weight:600; cursor:pointer; display:flex; align-items:center; gap:8px;">
                        <input type="checkbox" id="show-thinking-toggle" checked /> 
                        🧠 Show Agent Thinking
                    </label>
                </div>
                <div class="settings-row"><label>Max Depth</label><input type="number" id="max-depth-input" value="10" title="Max Tool Depth"/></div>
                
                <div class="section-header">GitOps & Storage</div>
                <div class="settings-row"><label>Storage</label><div style="display:flex;gap:4px;flex:1;"><input type="text" id="storage-input" readonly/><button id="browse-btn" style="background:var(--vscode-button-secondaryBackground);padding:4px 8px;font-size:10px;border:none;border-radius:4px;cursor:pointer;">Browse</button></div></div>
                
                <div class="section-header">Kong Instance</div>
                <div class="settings-row"><label>Mode</label><select id="kong-mode-select"><option value="local">Local (Docker)</option><option value="remote">Remote (URL)</option></select></div>

                <div id="local-settings">
                    <div class="ports-grid">
                        <div class="port-card" id="proxy-card"><label>Proxy Port</label><input type="number" id="proxy-port-input" value="8000"/></div>
                        <div class="port-card" id="admin-card"><label>Admin Port</label><input type="number" id="admin-port-input" value="8001"/></div>
                        <div class="port-card" id="manager-card"><label>Manager Port</label><input type="number" id="manager-port-input" value="8002"/></div>
                        <div class="port-card" id="db-card"><label>Postgres Port</label><input type="number" id="db-port-input" value="5432"/></div>
                    </div>
                </div>

                <div id="remote-settings" class="hidden">
                    <div style="display:flex; flex-direction:column; gap:6px; margin-top:4px;">
                        <div class="settings-row"><label title="Admin API">Admin URL</label><input type="text" id="remote-admin-input" placeholder="http://kong:8001"/></div>
                        <div class="settings-row"><label title="Proxy URL">Proxy URL</label><input type="text" id="remote-proxy-input" placeholder="http://kong:8000"/></div>
                        <div class="settings-row"><label title="Manager URL">Manager URL</label><input type="text" id="remote-manager-input" placeholder="http://kong:8002"/></div>
                    </div>
                </div>

                <div class="section-header">Auth & Advanced</div>
                <div class="settings-row"><label>Workspace</label><input type="text" id="workspace-input" placeholder="default"/></div>
                <div class="settings-row"><label>Admin Token</label><input type="password" id="admin-token-input" placeholder="RBAC Token"/></div>
                <div class="settings-row">
                    <label style="cursor:pointer; display:flex; align-items:center; gap:8px; font-size:11px;">
                        <input type="checkbox" id="skip-tls-input" /> 🛡️ Skip TLS Verification
                    </label>
                </div>

                <div class="section-header">GitOps Sync</div>
                <div class="settings-row"><label>Remote URL</label><input type="text" id="git-remote-input" placeholder="https://github.com/user/repo.git"/></div>
                <div class="settings-row">
                    <label style="cursor:pointer; display:flex; align-items:center; gap:8px; font-size:11px;">
                        <input type="checkbox" id="auto-commit-input" /> 🔄 Auto-Commit Changes
                    </label>
                </div>

                <div class="managed-files" id="file-list-container">
                    <div class="section-header">Managed Files</div>
                    <div id="file-list"></div>
                </div>

                <div style="display:flex; gap:6px; margin-top:12px;">
                    <button id="check-ports-btn" style="flex:1; background:var(--vscode-button-secondaryBackground); color:white; border:none; border-radius:8px; padding:8px; cursor:pointer; font-size:10px;">🔍 Check Local</button>
                    <button id="save-config-btn" style="flex:2; background:var(--accent); color:white; border:none; border-radius:8px; padding:8px; cursor:pointer; font-size:11px; font-weight:600;">Save Configuration</button>
                </div>
                <button class="danger-btn" id="reset-instance-btn">🗑️ Reset Kong Instance (Deletes All Config)</button>
                <button class="reset-btn" id="reset-config-btn">Reset UI Settings to Default</button>
            </div>
        </details>
        <div class="chat-input-row"><textarea id="prompt" placeholder="Message Kong Agent..." rows="1"></textarea><button id="send">Send</button></div>
    </div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/11.1.1/marked.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            const chat = document.getElementById('chat');
            const input = document.getElementById('prompt');
            const sendBtn = document.getElementById('send');
            const typing = document.getElementById('typing');
            
            window.onerror = function(m, u, l) {
                const e = document.createElement('div');
                e.style.color = 'red'; e.style.fontSize = '10px'; e.style.padding = '10px';
                e.innerText = 'Script Error: ' + m + ' (Line: ' + l + ')';
                chat.appendChild(e);
            };

            function appendMessage(role, content) {
                const div = document.createElement('div');
                div.className = 'message ' + role;
                
                // Classify "Thinking" process (tool calls and results)
                const isThinking = (role === 'toolCall' || role === 'toolResult');
                if (isThinking) {
                    div.classList.add('thinking');
                    const showThinking = document.getElementById('show-thinking-toggle').checked;
                    if (!showThinking) div.classList.add('hidden-thinking');
                }

                // Highlight Errors
                if (content && (content.toLowerCase().startsWith('error') || content.toLowerCase().includes('failed:'))) {
                    div.classList.add('error-message');
                }
                
                if (content.includes('\x60\x60\x60diff') || content.includes('\x60\x60\x60yaml')) {
                    const type = content.includes('\x60\x60\x60diff') ? 'diff' : 'yaml';
                    const parts = content.split('\x60\x60\x60' + type);
                    const textBefore = (typeof marked !== 'undefined') ? marked.parse(parts[0]) : parts[0];
                    const rest = parts[1].split('\x60\x60\x60');
                    
                    let highlightedLines = rest[0].split('\\n').map(line => {
                        const trimmed = line.trim();
                        if (line.startsWith('+') || line.startsWith('  +') || trimmed.startsWith('creating')) return '<span class="diff-added">' + line + '</span>';
                        if (line.startsWith('-') || line.startsWith('  -') || trimmed.startsWith('deleting')) return '<span class="diff-removed">' + line + '</span>';
                        return line;
                    }).join('\\n');
                    
                    const textAfter = (rest[1] && typeof marked !== 'undefined') ? marked.parse(rest[1]) : (rest[1] || "");
                    div.innerHTML = textBefore + '<pre><code class="language-' + type + '">' + highlightedLines + '</code></pre>' + textAfter;
                } else if (role === 'toolCall' || role === 'toolResult') {
                    div.innerText = content;
                } else {
                    let processedContent = content;
                    let hasApproval = false;
                    
                    if (content.includes('[APPROVAL_REQUIRED]')) {
                        hasApproval = true;
                        processedContent = content.replace('[APPROVAL_REQUIRED]', '').trim();
                    }
                    
                    div.innerHTML = (typeof marked !== 'undefined') ? marked.parse(processedContent) : processedContent;
                    
                    if (hasApproval) {
                        const approvalDiv = document.createElement('div');
                        approvalDiv.className = 'approval-container';
                        
                        const yesBtn = document.createElement('button');
                        yesBtn.className = 'approval-btn yes';
                        yesBtn.innerText = '✅ Yes, Proceed';
                        yesBtn.onclick = () => {
                            vscode.postMessage({ type: 'prompt', value: 'Yes' });
                            approvalDiv.querySelectorAll('button').forEach(b => b.disabled = true);
                        };
                        
                        const noBtn = document.createElement('button');
                        noBtn.className = 'approval-btn no';
                        noBtn.innerText = '❌ No, Cancel';
                        noBtn.onclick = () => {
                            vscode.postMessage({ type: 'prompt', value: 'No, cancel this change.' });
                            approvalDiv.querySelectorAll('button').forEach(b => b.disabled = true);
                        };
                        
                        approvalDiv.appendChild(yesBtn);
                        approvalDiv.appendChild(noBtn);
                        div.appendChild(approvalDiv);
                    }
                }

                chat.appendChild(div);
                if (typeof hljs !== 'undefined') {
                    div.querySelectorAll('pre code').forEach((b) => { hljs.highlightElement(b); });
                }
                chat.scrollTop = chat.scrollHeight;
            }

            const thinkingToggle = document.getElementById('show-thinking-toggle');
            if (thinkingToggle) {
                thinkingToggle.onchange = (e) => {
                    const show = e.target.checked;
                    document.querySelectorAll('.thinking').forEach(el => {
                        el.classList.toggle('hidden-thinking', !show);
                    });
                    // Save to config via extension post message
                    vscode.postMessage({ type: 'updateThinkingPref', show: show });
                };
            }

            if (sendBtn) {
                sendBtn.onclick = () => {
                    const val = input.value.trim();
                    if (val) {
                        vscode.postMessage({ type: 'prompt', value: val });
                        input.value = '';
                        typing.style.display = 'block';
                    }
                };
                input.oninput = () => {
                    input.style.height = 'auto';
                    input.style.height = (input.scrollHeight) + 'px';
                };
                input.onkeydown = (e) => { 
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendBtn.click();
                        input.style.height = 'auto';
                    }
                };
            }

            const providerSelect = document.getElementById('provider-select');
            if (providerSelect) {
                providerSelect.onchange = (e) => {
                    const apiKeyRow = document.getElementById('api-key-row');
                    if (apiKeyRow) apiKeyRow.style.display = e.target.value === 'local' ? 'none' : 'flex';
                };
            }

            const kongModeSelect = document.getElementById('kong-mode-select');
            if (kongModeSelect) {
                kongModeSelect.onchange = (e) => {
                    const isLocal = e.target.value === 'local';
                    document.getElementById('local-settings').classList.toggle('hidden', !isLocal);
                    document.getElementById('remote-settings').classList.toggle('hidden', isLocal);
                    document.getElementById('check-ports-btn').classList.toggle('hidden', !isLocal);
                };
            }

            const browseBtn = document.getElementById('browse-btn');
            if (browseBtn) browseBtn.onclick = () => vscode.postMessage({ type: 'selectFolder' });

            const saveBtn = document.getElementById('save-config-btn');
            if (saveBtn) saveBtn.onclick = () => {
                vscode.postMessage({
                    type: 'updateConfig',
                    provider: document.getElementById('provider-select').value,
                    model: document.getElementById('model-input').value,
                    apiKey: document.getElementById('api-key-input').value,
                    maxDepth: document.getElementById('max-depth-input').value,
                    storagePath: document.getElementById('storage-input').value,
                    kongMode: document.getElementById('kong-mode-select').value,
                    proxyPort: document.getElementById('proxy-port-input').value,
                    adminPort: document.getElementById('admin-port-input').value,
                    managerPort: document.getElementById('manager-port-input').value,
                    databasePort: document.getElementById('db-port-input').value,
                    remoteAdminUrl: document.getElementById('remote-admin-input').value,
                    remoteProxyUrl: document.getElementById('remote-proxy-input').value,
                    remoteManagerUrl: document.getElementById('remote-manager-input').value,
                    kongWorkspace: document.getElementById('workspace-input').value,
                    kongAdminToken: document.getElementById('admin-token-input').value,
                    skipTlsVerify: document.getElementById('skip-tls-input').checked,
                    gitRemoteUrl: document.getElementById('git-remote-input').value,
                    autoCommit: document.getElementById('auto-commit-input').checked
                });
            };

            const resetInstBtn = document.getElementById('reset-instance-btn');
            if (resetInstBtn) resetInstBtn.onclick = () => {
                if (confirm('Are you SURE you want to delete ALL configuration from your Kong instance? This action cannot be undone.')) {
                    vscode.postMessage({ type: 'resetInstance' });
                }
            };

            const checkBtn = document.getElementById('check-ports-btn');
            if (checkBtn) checkBtn.onclick = (e) => {
                e.stopPropagation();
                vscode.postMessage({
                    type: 'checkPorts',
                    proxyPort: document.getElementById('proxy-port-input').value,
                    adminPort: document.getElementById('admin-port-input').value,
                    managerPort: document.getElementById('manager-port-input').value,
                    databasePort: document.getElementById('db-port-input').value
                });
            };

            window.addEventListener('message', (event) => {
                const m = event.data;
                if (m.type === 'addMessage') {
                    if (m.role === 'agent') typing.style.display = 'none';
                    appendMessage(m.role, m.content);
                } else if (m.type === 'setConfig') {
                    document.getElementById('provider-select').value = m.provider || 'openrouter';
                    document.getElementById('model-input').value = m.model || 'openai/gpt-4o';
                    document.getElementById('api-key-input').value = m.apiKey || '';
                    document.getElementById('max-depth-input').value = m.maxDepth || 10;
                    document.getElementById('storage-input').value = m.storagePath || 'Default';
                    
                    const kongMode = m.kongMode || 'local';
                    document.getElementById('kong-mode-select').value = kongMode;
                    document.getElementById('local-settings').classList.toggle('hidden', kongMode !== 'local');
                    document.getElementById('remote-settings').classList.toggle('hidden', kongMode === 'local');
                    document.getElementById('check-ports-btn').classList.toggle('hidden', kongMode !== 'local');

                    document.getElementById('proxy-port-input').value = m.proxyPort || 8000;
                    document.getElementById('admin-port-input').value = m.adminPort || 8001;
                    document.getElementById('manager-port-input').value = m.managerPort || 8002;
                    document.getElementById('db-port-input').value = m.databasePort || 5432;

                    document.getElementById('remote-admin-input').value = m.remoteAdminUrl || '';
                    document.getElementById('remote-proxy-input').value = m.remoteProxyUrl || '';
                    document.getElementById('remote-manager-input').value = m.remoteManagerUrl || '';
                    
                    document.getElementById('workspace-input').value = m.kongWorkspace || 'default';
                    document.getElementById('admin-token-input').value = m.kongAdminToken || '';
                    document.getElementById('skip-tls-input').checked = m.skipTlsVerify === true;
                    document.getElementById('git-remote-input').value = m.gitRemoteUrl || '';
                    document.getElementById('auto-commit-input').checked = m.autoCommit === true;
                    
                    const showThinking = m.showThinking !== false;
                    document.getElementById('show-thinking-toggle').checked = showThinking;
                    document.querySelectorAll('.thinking').forEach(el => {
                        el.classList.toggle('hidden-thinking', !showThinking);
                    });
                    
                    if (m.files) {
                        const list = document.getElementById('file-list');
                        list.innerHTML = '';
                        m.files.forEach(f => {
                            const item = document.createElement('div');
                            item.className = 'file-item';
                            item.innerHTML = '<span class="file-name">' + f + '</span><button class="open-file-btn">Open</button>';
                            item.querySelector('.open-file-btn').onclick = () => vscode.postMessage({ type: 'openFile', filename: f });
                            list.appendChild(item);
                        });
                    }
                } else if (m.type === 'fileChanged') {
                    const toast = document.getElementById('notification');
                    const fileNameSpan = document.getElementById('changed-filename');
                    const reviewBtn = document.getElementById('review-btn');
                    const dismissBtn = document.getElementById('dismiss-btn');

                    if (toast && fileNameSpan) {
                        fileNameSpan.innerText = m.filename;
                        toast.style.display = 'flex';
                        
                        reviewBtn.onclick = () => {
                            vscode.postMessage({ type: 'requestReview', filename: m.filename });
                            toast.style.display = 'none';
                        };
                        dismissBtn.onclick = () => {
                            toast.style.display = 'none';
                        };
                    }
                } else if (m.type === 'portCheckResults') {
                    for (const [key, res] of Object.entries(m.results)) {
                        const el = document.getElementById(key + '-card');
                        if (el) {
                            el.style.borderColor = res.inUse ? '#f44747' : '';
                            el.style.background = res.inUse ? 'rgba(244, 71, 71, 0.05)' : '';
                        }
                    }
                    if (m.hasCollision) appendMessage('agent', '⚠️ **Port Issues**:\\n\\n' + m.report);
                    else appendMessage('agent', '✅ All ports are available!');
                }
            });
        })();
    </script>
</body>
</html>`;
    }
}

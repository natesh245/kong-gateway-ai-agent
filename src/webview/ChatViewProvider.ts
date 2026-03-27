import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Agent } from '../llm/Agent';
import { KongDockerManager } from '../docker/KongDockerManager';

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
        this._setupWatcher();
    }

    private _setupWatcher() {
        if (this._watcher) {
            this._watcher.dispose();
        }

        const config = vscode.workspace.getConfiguration('kongAgent');
        const storagePath = config.get<string>('storagePath');

        if (storagePath && fs.existsSync(storagePath)) {
            // Watch for .yml, .yaml, .json files
            this._watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(storagePath, '**/*.{yml,yaml,json}')
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
        }, 2000); // 2 second debounce
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Send initial configuration to the webview
        this._updateWebviewConfig();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'prompt':
                    {
                        webviewView.webview.postMessage({ type: 'addMessage', role: 'user', content: data.value });
                        await this._agent.processMessage(data.value, (content: string) => {
                            webviewView.webview.postMessage({ type: 'addMessage', role: 'agent', content });
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
                        this._setupWatcher(); // Refresh watcher on new path
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
                            this._setupWatcher(); // Refresh watcher
                            // Notify webview to update UI
                            this._updateWebviewConfig();
                        }
                        break;
                    }
            }
        });
    }

    private _updateWebviewConfig() {
        if (this._view) {
            const config = vscode.workspace.getConfiguration('kongAgent');
            this._view.webview.postMessage({
                type: 'setConfig',
                provider: config.get('provider'),
                model: config.get('model'),
                apiKey: config.get('openRouterApiKey'),
                storagePath: config.get('storagePath')
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kong Agent</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
        
        body {
            font-family: 'Inter', sans-serif;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        .header {
            padding: 16px;
            background: linear-gradient(135deg, #0A2540, #2E86AB);
            color: white;
            font-weight: 600;
            text-align: center;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
            border-bottom-left-radius: 12px;
            border-bottom-right-radius: 12px;
            margin-bottom: 10px;
        }

        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .message {
            max-width: 85%;
            padding: 12px 16px;
            border-radius: 12px;
            line-height: 1.4;
            animation: fadeIn 0.3s ease-out forwards;
            word-wrap: break-word;
            white-space: pre-wrap;
        }

        .message.user {
            align-self: flex-end;
            background: rgba(46, 134, 171, 0.2);
            border: 1px solid rgba(46, 134, 171, 0.4);
            backdrop-filter: blur(10px);
        }

        .message.agent {
            align-self: flex-start;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-left: 4px solid #F51A56; /* Kong Red */
        }

        .notification-toast {
            background: var(--vscode-notifications-background);
            color: var(--vscode-notifications-foreground);
            padding: 12px;
            border-radius: 8px;
            margin: 8px 16px;
            display: none;
            flex-direction: column;
            gap: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            border: 1px solid var(--vscode-widget-border);
        }

        .notification-toast b { font-size: 12px; }
        .notification-toast button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px;
            cursor: pointer;
            border-radius: 4px;
            font-size: 11px;
            width: 100%;
        }

        .input-container {
            padding: 16px;
            background: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-widget-border);
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .settings-panel {
            padding: 12px;
            background: rgba(0, 0, 0, 0.1);
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            font-size: 11px;
            border: 1px solid var(--vscode-widget-border);
        }

        .settings-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .settings-row label {
            width: 60px;
            color: var(--vscode-descriptionForeground);
        }

        .settings-row select, .settings-row input {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
        }

        .chat-input-row {
            display: flex;
            gap: 8px;
        }

        input {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 10px 14px;
            border-radius: 8px;
            outline: none;
            font-family: 'Inter', sans-serif;
            transition: all 0.2s ease;
            font-size: 13px;
        }

        input:focus {
            border-color: #2E86AB;
            box-shadow: 0 0 0 2px rgba(46, 134, 171, 0.3);
        }

        #send {
            background: linear-gradient(135deg, #F51A56, #d90f46);
            color: white;
            border: none;
            padding: 12px 16px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            transition: transform 0.1s ease, box-shadow 0.1s ease;
        }

        #send:active { transform: scale(0.95); }
        #send:hover { box-shadow: 0 4px 10px rgba(245, 26, 86, 0.4); }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .typing { display: none; align-self: flex-start; margin-left: 16px; color: #888; font-style: italic; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 10px; }
    </style>
</head>
<body>
    <div class="header">🦍 Kong Agent</div>
    
    <div id="notification" class="notification-toast">
        <span>Detected manual changes in <b id="changed-filename">file.yml</b></span>
        <button id="review-btn">🔍 Review Changes</button>
    </div>

    <div class="chat-container" id="chat">
        <div class="message agent">Hello! I am your Kong Gateway Agent. I can start your local Kong via Docker, create routes, and configure services. How can I assist you today?</div>
    </div>
    
    <div class="typing" id="typing">Kong Agent is thinking...</div>
    
    <div class="input-container">
        <div class="settings-panel">
            <div class="settings-row">
                <label>Provider</label>
                <select id="provider-select">
                    <option value="openrouter">OpenRouter</option>
                    <option value="local">Local (Ollama)</option>
                </select>
            </div>
            <div class="settings-row" id="api-key-row">
                <label>API Key</label>
                <input type="password" id="api-key-input" placeholder="OpenRouter API key" />
            </div>
            <div class="settings-row">
                <label>Model</label>
                <input type="text" id="model-input" placeholder="e.g. openai/gpt-4o" />
            </div>
            <div class="settings-row">
                <label>Storage</label>
                <div style="display: flex; gap: 4px; flex: 1;">
                    <input type="text" id="storage-input" placeholder="Default storage" readonly style="flex: 1; cursor: default;" />
                    <button id="browse-btn" style="padding: 4px 8px; font-size: 10px; background: var(--vscode-button-secondaryBackground);">Browse</button>
                </div>
            </div>
        </div>
        <div class="chat-input-row">
            <input type="text" id="prompt" placeholder="Ask me to start Kong..." />
            <button id="send">Send</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chat = document.getElementById('chat');
        const input = document.getElementById('prompt');
        const sendBtn = document.getElementById('send');
        const typing = document.getElementById('typing');

        const providerSelect = document.getElementById('provider-select');
        const apiKeyInput = document.getElementById('api-key-input');
        const modelInput = document.getElementById('model-input');
        const storageInput = document.getElementById('storage-input');
        const browseBtn = document.getElementById('browse-btn');
        const apiKeyRow = document.getElementById('api-key-row');
        
        const notification = document.getElementById('notification');
        const changedFilenameDisplay = document.getElementById('changed-filename');
        const reviewBtn = document.getElementById('review-btn');

        function updateConfig() {
            vscode.postMessage({
                type: 'updateConfig',
                provider: providerSelect.value,
                apiKey: apiKeyInput.value,
                model: modelInput.value,
                storagePath: storageInput.value
            });
            apiKeyRow.style.display = providerSelect.value === 'local' ? 'none' : 'flex';
        }

        providerSelect.addEventListener('change', updateConfig);
        apiKeyInput.addEventListener('input', updateConfig);
        modelInput.addEventListener('input', updateConfig);
        
        browseBtn.addEventListener('click', () => {
             vscode.postMessage({ type: 'selectFolder' });
        });

        reviewBtn.addEventListener('click', () => {
            const filename = changedFilenameDisplay.innerText;
            vscode.postMessage({ 
                type: 'prompt', 
                value: "I just manually updated " + filename + ". Please read it, review my changes, and let me know if I should fix anything."
            });
            notification.style.display = 'none';
        });

        function appendMessage(role, content) {
            const div = document.createElement('div');
            div.className = 'message ' + role;
            div.innerText = content;
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
        }

        sendBtn.addEventListener('click', () => {
            const text = input.value.trim();
            if (text) {
                vscode.postMessage({ type: 'prompt', value: text });
                input.value = '';
                typing.style.display = 'block';
            }
        });

        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendBtn.click();
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'addMessage':
                    typing.style.display = 'none';
                    appendMessage(message.role, message.content);
                    break;
                case 'setConfig':
                    providerSelect.value = message.provider || 'openrouter';
                    apiKeyInput.value = message.apiKey || '';
                    modelInput.value = message.model || 'openai/gpt-4o';
                    storageInput.value = message.storagePath || 'Using Default Global Storage';
                    apiKeyRow.style.display = providerSelect.value === 'local' ? 'none' : 'flex';
                    break;
                case 'fileChanged':
                    notification.style.display = 'flex';
                    changedFilenameDisplay.innerText = message.filename;
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}

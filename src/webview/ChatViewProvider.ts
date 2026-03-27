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

        const config = vscode.workspace.getConfiguration('kongAgent');
        const storagePath = config.get<string>('storagePath');

        if (storagePath && fs.existsSync(storagePath)) {
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
        }, 2000);
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
                        this.dockerManager.initializeCache();
                        this._setupWatcher();
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
                            this._updateWebviewConfig();
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
                            const prompt = `I just manually updated ${filename}. Here is the diff:\n\n\`\`\`diff\n${chatDiff}\n\`\`\`\n\nPlease review it.`;
                            
                            webviewView.webview.postMessage({ type: 'addMessage', role: 'user', content: prompt });
                            this.dockerManager.updateFileCache(filename, newContent);

                            await this._agent.processMessage(prompt, (content: string, type: string = 'agent') => {
                                webviewView.webview.postMessage({ type: 'addMessage', role: type, content });
                            });
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
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
        
        body {
            font-family: 'Inter', sans-serif; background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground); margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden;
        }

        .header {
            padding: 16px; background: linear-gradient(135deg, #0A2540, #2E86AB); color: white;
            font-weight: 600; text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.3);
            border-bottom-left-radius: 12px; border-bottom-right-radius: 12px; margin-bottom: 10px;
        }

        .chat-container { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }

        .message {
            max-width: 90%; padding: 12px 16px; border-radius: 12px; line-height: 1.4;
            animation: fadeIn 0.3s ease-out forwards; word-wrap: break-word;
        }
        .message.user { align-self: flex-end; background: rgba(46, 134, 171, 0.2); border: 1px solid rgba(46, 134, 171, 0.4); }
        .message.agent { align-self: flex-start; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-left: 4px solid #F51A56; }
        
        .message.toolCall {
            align-self: flex-start; background: rgba(43, 43, 43, 0.4); border: 1px dashed rgba(255,255,255,0.2);
            font-size: 11px; color: #aaa; font-family: 'Courier New', Courier, monospace; padding: 8px; border-radius: 8px;
        }
        .message.toolResult {
            align-self: flex-start; background: rgba(30, 30, 30, 0.6); border: 1px solid rgba(255,255,255,0.1);
            font-size: 10px; color: #888; font-family: 'Courier New', Courier, monospace;
            margin-top: -8px; max-width: 95%; display: none; padding: 8px; border-radius: 8px;
        }
        .tool-toggle { cursor: pointer; color: #2E86AB; font-size: 10px; margin-top: 4px; text-decoration: underline; margin-left: 4px; }

        .message pre { background: rgba(0,0,0,0.4); padding: 10px; border-radius: 8px; overflow-x: auto; font-size: 11px; margin: 8px 0; }
        .message code { font-family: 'Courier New', Courier, monospace; }
        .diff-added { color: #4ec9b0; display: block; }
        .diff-removed { color: #f44747; display: block; }

        .notification-toast {
            background: var(--vscode-notifications-background); color: var(--vscode-notifications-foreground);
            padding: 12px; border-radius: 8px; margin: 8px 16px; display: none; flex-direction: column; gap: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2); border: 1px solid var(--vscode-widget-border);
        }
        .input-container { padding: 16px; background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-widget-border); display: flex; flex-direction: column; gap: 12px; }
        .settings-panel { padding: 12px; background: rgba(0, 0, 0, 0.1); border-radius: 8px; display: flex; flex-direction: column; gap: 6px; font-size: 11px; }
        .settings-row { display: flex; align-items: center; gap: 8px; }
        .settings-row label { width: 60px; color: var(--vscode-descriptionForeground); }
        .settings-row input, .settings-row select { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; border-radius: 4px; }
        .chat-input-row { display: flex; gap: 8px; }
        #prompt { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 10px; border-radius: 8px; outline: none; }
        #send { background: #F51A56; color: white; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-weight: 600; }
        .typing { display: none; margin-left:16px; color:#888; font-size:11px; margin-bottom: 8px; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    </style>
</head>
<body>
    <div class="header">🦍 Kong Agent</div>
    <div id="notification" class="notification-toast">
        <div style="display:flex;justify-content:space-between;align-items:center;">
            <span>Changes detected in <b id="changed-filename">file.yml</b></span>
            <button id="dismiss-btn" style="background:none;border:none;color:inherit;cursor:pointer;font-size:16px;">&times;</button>
        </div>
        <button id="review-btn" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px;border-radius:4px;font-size:11px;cursor:pointer;">🔍 Review Changes</button>
    </div>
    <div class="chat-container" id="chat"></div>
    <div class="typing" id="typing">Kong Agent is thinking...</div>
    <div class="input-container">
        <div class="settings-panel">
            <div class="settings-row"><label>Provider</label><select id="provider-select"><option value="openrouter">OpenRouter</option><option value="local">Ollama</option></select></div>
            <div class="settings-row" id="api-key-row"><label>API Key</label><input type="password" id="api-key-input"/></div>
            <div class="settings-row"><label>Model</label><input type="text" id="model-input"/></div>
            <div class="settings-row"><label>Storage</label><div style="display:flex;gap:4px;flex:1;"><input type="text" id="storage-input" readonly/><button id="browse-btn" style="background:var(--vscode-button-secondaryBackground);padding:2px 6px;font-size:10px;">Browse</button></div></div>
        </div>
        <div class="chat-input-row"><input type="text" id="prompt" placeholder="Ask anything..."/><button id="send">Send</button></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chat = document.getElementById('chat');
        const input = document.getElementById('prompt');
        const sendBtn = document.getElementById('send');
        const typing = document.getElementById('typing');
        const notification = document.getElementById('notification');
        const filenameDisplay = document.getElementById('changed-filename');

        function appendMessage(role, content) {
            const div = document.createElement('div');
            div.className = 'message ' + role;
            
            if (role === 'toolResult') {
                const toggle = document.createElement('div');
                toggle.className = 'tool-toggle';
                toggle.innerText = 'Show Command Result [+]';
                toggle.onclick = () => {
                   const isHidden = div.style.display === 'none' || div.style.display === '';
                   div.style.display = isHidden ? 'block' : 'none';
                   toggle.innerText = isHidden ? 'Hide Result [-]' : 'Show Result [+]';
                };
                chat.appendChild(toggle);
            }

            if (content.includes('\`\`\`diff')) {
                const parts = content.split('\`\`\`diff');
                const textBefore = parts[0];
                const rest = parts[1].split('\`\`\`');
                const diffBody = rest[0];
                const textAfter = rest[1] || "";
                
                div.innerHTML = textBefore.replace(/\\n/g, '<br>') + 
                    '<pre><code>' + 
                    diffBody.split('\\n').map(line => {
                        if (line.startsWith('+')) return '<span class="diff-added">' + line + '</span>';
                        if (line.startsWith('-')) return '<span class="diff-removed">' + line + '</span>';
                        return line;
                    }).join('\\n') + 
                    '</code></pre>' + textAfter.replace(/\\n/g, '<br>');
            } else {
                div.innerHTML = content.replace(/\\n/g, '<br>');
            }
            chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
        }

        sendBtn.onclick = () => {
            const val = input.value.trim();
            if (val) { vscode.postMessage({ type: 'prompt', value: val }); input.value = ''; typing.style.display = 'block'; }
        };
        input.onkeypress = (e) => { if(e.key === 'Enter') sendBtn.click(); };

        document.getElementById('review-btn').onclick = () => {
             vscode.postMessage({ type: 'requestReview', filename: filenameDisplay.innerText });
             notification.style.display = 'none';
        };
        document.getElementById('dismiss-btn').onclick = () => { notification.style.display = 'none'; };
        document.getElementById('browse-btn').onclick = () => { vscode.postMessage({ type: 'selectFolder' }); };

        window.addEventListener('message', event => {
            const m = event.data;
            if (m.type === 'addMessage') { 
                if (m.role === 'agent') typing.style.display = 'none'; 
                appendMessage(m.role, m.content); 
            }
            else if (m.type === 'setConfig') {
                document.getElementById('provider-select').value = m.provider;
                document.getElementById('api-key-input').value = m.apiKey || '';
                document.getElementById('model-input').value = m.model;
                document.getElementById('storage-input').value = m.storagePath || 'Default';
                document.getElementById('api-key-row').style.display = m.provider === 'local' ? 'none' : 'flex';
            }
            else if (m.type === 'fileChanged') {
                notification.style.display = 'flex';
                filenameDisplay.innerText = m.filename;
            }
        });
    </script>
</body>
</html>`;
    }
}

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
        
        /* Timeline styling for tools */
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

        /* Markdown Overrides */
        .message h1, .message h2, .message h3 { margin-top: 5px; color: #eee; }
        .message p { margin: 8px 0; }
        .message ul, .message ol { padding-left: 20px; }
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

        .input-container { padding: 20px; background: var(--vscode-sideBar-background); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 14px; }
        .settings-panel { padding: 14px; background: var(--panel-bg); border-radius: 12px; display: flex; flex-direction: column; gap: 8px; font-size: 11px; border: 1px solid var(--border); }
        .settings-row { display: flex; align-items: center; gap: 10px; }
        .settings-row label { width: 70px; color: var(--vscode-descriptionForeground); font-weight: 500; }
        .settings-row input, .settings-row select { 
            flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); 
            border: 1px solid var(--vscode-input-border); padding: 6px 10px; border-radius: 6px; outline: none;
        }
        
        .chat-input-row { display: flex; gap: 10px; }
        #prompt { 
            flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); 
            border: 1px solid var(--vscode-input-border); padding: 12px 16px; border-radius: 12px; outline: none;
            transition: border-color 0.2s;
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

        /* Table Styling */
        table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12px; }
        th, td { border: 1px solid var(--border); padding: 8px; text-align: left; }
        th { background: rgba(255,255,255,0.05); }
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
        <div class="message agent">Hello! I am your **Kong Gateway Agent**. \n\nI can help you manage your local Kong setup with professional precision:
- 🚀 **Start/Stop** Kong via Docker
- 🛠️ **Configure** Services, Routes, and Consumers
- 🔍 **Review** your manual configuration edits
- ⚡ **Verify** connectivity and health

What can I do for you today?</div>
    </div>
    <div class="typing" id="typing">Agent is processing...</div>
    <div class="input-container">
        <div class="settings-panel">
            <div class="settings-row"><label>Provider</label><select id="provider-select"><option value="openrouter">OpenRouter</option><option value="local">Ollama</option></select></div>
            <div class="settings-row" id="api-key-row"><label>API Key</label><input type="password" id="api-key-input"/></div>
            <div class="settings-row"><label>Model</label><input type="text" id="model-input"/></div>
            <div class="settings-row"><label>Storage</label><div style="display:flex;gap:4px;flex:1;"><input type="text" id="storage-input" readonly/><button id="browse-btn" style="background:var(--vscode-button-secondaryBackground);padding:4px 8px;font-size:10px;border:none;border-radius:4px;cursor:pointer;">Browse</button></div></div>
        </div>
        <div class="chat-input-row"><input type="text" id="prompt" placeholder="Message Kong Agent..."/><button id="send">Send</button></div>
    </div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/11.1.1/marked.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <script>
        const vscode = acquireVsCodeApi();
        const chat = document.getElementById('chat');
        const input = document.getElementById('prompt');
        const sendBtn = document.getElementById('send');
        const typing = document.getElementById('typing');
        const notification = document.getElementById('notification');
        const filenameDisplay = document.getElementById('changed-filename');

        // Configure marked to use highlight.js
        marked.setOptions({
            highlight: function(code, lang) {
                if (lang && hljs.getLanguage(lang)) {
                    return hljs.highlight(code, { language: lang }).value;
                }
                return hljs.highlightAuto(code).value;
            },
            breaks: true,
            gfm: true
        });

        function appendMessage(role, content) {
            const div = document.createElement('div');
            div.className = 'message ' + role;
            
            if (role === 'toolResult') {
                const toggle = document.createElement('div');
                toggle.className = 'tool-toggle';
                toggle.innerText = 'Show System Output [+]';
                toggle.onclick = () => {
                   const isHidden = div.style.display === 'none' || div.style.display === '';
                   div.style.display = isHidden ? 'block' : 'none';
                   toggle.innerText = isHidden ? 'Hide System Output [-]' : 'Show System Output [+]';
                };
                chat.appendChild(toggle);
            }

            // Handle diff blocks within markdown or as standalone
            let htmlContent = content;
            if (content.includes('\`\`\`diff')) {
                const parts = content.split('\`\`\`diff');
                const textBefore = marked.parse(parts[0]);
                const rest = parts[1].split('\`\`\`');
                const diffLines = rest[0].split('\\n').map(line => {
                    if (line.startsWith('+')) return '<span class="diff-added">' + line + '</span>';
                    if (line.startsWith('-')) return '<span class="diff-removed">' + line + '</span>';
                    return line;
                }).join('\\n');
                const textAfter = marked.parse(rest[1] || "");
                
                div.innerHTML = textBefore + '<pre><code>' + diffLines + '</code></pre>' + textAfter;
            } else if (role === 'toolCall' || role === 'toolResult') {
                // Tool calls/results are kept simple Mono
                div.innerText = content;
            } else {
                div.innerHTML = marked.parse(content);
            }

            chat.appendChild(div);
            // Apply highlighting to all new code blocks
            div.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
            
            chat.scrollTop = chat.scrollHeight;
        }

        // Initialize welcome message with markdown
        const welcomeMsg = document.querySelector('.message.agent');
        welcomeMsg.innerHTML = marked.parse(welcomeMsg.innerText);

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

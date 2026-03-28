(function() {
    const vscode = acquireVsCodeApi();
    const chat = document.getElementById('chat');
    const input = document.getElementById('prompt');
    const sendBtn = document.getElementById('send');
    const typing = document.getElementById('typing');
    const statusText = document.getElementById('status-text');
    
    function showToast(message, duration = 3000) {
        const toast = document.getElementById('toast');
        const msg = document.getElementById('toast-message');
        if (toast && msg) {
            msg.innerText = message;
            toast.style.display = 'flex';
            setTimeout(() => { toast.style.display = 'none'; }, duration);
        }
    }

    window.onerror = function(m, u, l) {
        const e = document.createElement('div');
        e.style.color = 'red'; e.style.fontSize = '10px'; e.style.padding = '10px';
        e.innerText = 'Script Error: ' + m + ' (Line: ' + l + ')';
        chat.appendChild(e);
    };

    let currentSession = null;
    let sessionStartTime = null;

    function startThinkingSession() {
        if (currentSession) return currentSession;
        
        sessionStartTime = Date.now();
        const container = document.createElement('div');
        container.className = 'thinking-session forced-visible';
        
        const details = document.createElement('details');
        details.className = 'thinking-details';
        details.open = true;
        
        const summary = document.createElement('summary');
        summary.className = 'thinking-summary';
        
        const icon = document.createElement('div');
        icon.className = 'status-icon';
        
        const info = document.createElement('div');
        info.className = 'session-info';
        
        const label = document.createElement('span');
        label.className = 'session-label';
        label.innerText = 'Agent Thinking...';
        
        const counter = document.createElement('span');
        counter.className = 'tool-count';
        counter.innerText = '[Tools: 0]';
        
        info.appendChild(label);
        info.appendChild(counter);
        
        const timer = document.createElement('span');
        timer.className = 'thought-timer';
        timer.innerText = '0.0s';
        
        summary.appendChild(icon);
        summary.appendChild(info);
        summary.appendChild(timer);
        
        const steps = document.createElement('div');
        steps.className = 'thinking-steps';
        
        const placeholder = document.createElement('div');
        placeholder.className = 'step-placeholder';
        placeholder.innerText = '🔬 Diagnostic: Data-link initialized. Waiting for reasoning...';
        steps.appendChild(placeholder);
        
        details.appendChild(summary);
        details.appendChild(steps);
        container.appendChild(details);
        
        chat.appendChild(container);
        
        // Hard-wire the references
        currentSession = container;
        currentSession.stepsRef = steps;
        currentSession.countRef = counter;
        currentSession.toolCount = 0;
        
        chat.scrollTop = chat.scrollHeight;

        // Start timer and heartbeat
        const timerEl = timer;
        const labelEl = label;
        const timerInterval = setInterval(() => {
            if (!currentSession || currentSession !== container || currentSession.classList.contains('complete')) {
                clearInterval(timerInterval);
                return;
            }
            const elapsed = ((Date.now() - sessionStartTime) / 1000).toFixed(1);
            timerEl.innerText = elapsed + 's';
            const dots = '.'.repeat(Math.floor(Date.now() / 500) % 4);
            labelEl.innerText = 'Agent Thinking' + dots;
        }, 100);

        return currentSession;
    }

    function stopThinkingSession() {
        if (!currentSession) return;
        
        const elapsed = ((Date.now() - sessionStartTime) / 1000).toFixed(1);
        const sessionToClose = currentSession;
        
        sessionToClose.classList.add('complete');
        sessionToClose.querySelector('.session-label').innerText = 'Thought for ' + elapsed + 's';
        sessionToClose.querySelector('.thought-timer').innerText = elapsed + 's';
        
        // Explicitly clear placeholder one last time if it's still there
        const placeholder = sessionToClose.stepsRef?.querySelector('.step-placeholder');
        if (placeholder) placeholder.remove();
        
        // Auto-collapse logic
        setTimeout(() => {
            const details = sessionToClose.querySelector('details');
            if (details) details.open = false;
        }, 3000);
        
        currentSession = null;
        sessionStartTime = null;
    }

    function appendMessage(role, content, className) {
        // TRACE LOG
        vscode.postMessage({ type: 'log', message: `Incoming message: ${role}` });

        const isThinking = (role === 'toolCall' || role === 'toolResult');

        if (role === 'user') {
            stopThinkingSession();
            const div = document.createElement('div');
            div.className = 'message user';
            div.innerText = content;
            chat.appendChild(div);
            startThinkingSession(); 
            return;
        }

        let messageEl = null;

        if (isThinking) {
            const session = startThinkingSession();
            const stepsContainer = session.stepsRef || session.querySelector('.thinking-steps');
            
            // NUCLEAR FLUSH: Wipe placeholder on the very first tool call of this session
            if (session.toolCount === 0 && stepsContainer) {
                stepsContainer.innerHTML = ''; 
            }

            // Update counter
            if (role === 'toolCall' && session.countRef) {
                session.toolCount++;
                session.countRef.innerText = `[Tools: ${session.toolCount}]`;
            }

            const div = document.createElement('div');
            div.className = 'message ' + role;
            
            const header = document.createElement('div');
            header.className = 'tool-header';
            header.style.color = role === 'toolCall' ? '#f51a56' : '#4ec9b0';
            header.style.fontWeight = 'bold';
            header.style.fontSize = '11px';
            
            if (role === 'toolCall') {
                const toolName = content.split('(')[0] || 'Tool';
                header.innerText = `⚒️ Calling ${toolName}... [LOGGING]`;
            } else {
                header.innerText = `✅ Result Received [LOGGING]`;
            }
            
            const payload = document.createElement('div');
            payload.className = 'thinking-payload';
            payload.style.marginTop = '4px';
            payload.style.fontSize = '10px';
            payload.style.opacity = '0.8';
            payload.style.fontFamily = 'monospace';
            payload.style.whiteSpace = 'pre-wrap';
            payload.textContent = content; // SAFE INJECTION
            
            div.appendChild(header);
            div.appendChild(payload);
            stepsContainer.appendChild(div);
            
            messageEl = div;
            chat.scrollTop = chat.scrollHeight;
        } else {
            stopThinkingSession(); // Close thinking session before showing final answer
            
            const div = document.createElement('div');
            div.className = 'message ' + role;
            if (className) div.classList.add(className);

            // Highlight Errors
            if (content && (content.toLowerCase().startsWith('error') || content.toLowerCase().includes('failed:'))) {
                div.classList.add('error-message');
            }
            
            if (content.includes('```diff') || content.includes('```yaml')) {
                const type = content.includes('```diff') ? 'diff' : 'yaml';
                const parts = content.split('```' + type);
                const textBefore = (typeof marked !== 'undefined') ? marked.parse(parts[0]) : parts[0];
                const rest = parts[1].split('```');
                
                let highlightedLines = rest[0].split('\n').map(line => {
                    const trimmed = line.trim();
                    if (line.startsWith('+') || line.startsWith('  +') || trimmed.startsWith('creating')) return '<span class="diff-added">' + line + '</span>';
                    if (line.startsWith('-') || line.startsWith('  -') || trimmed.startsWith('deleting')) return '<span class="diff-removed">' + line + '</span>';
                    return line;
                }).join('\n');
                
                const textAfter = (rest[1] && typeof marked !== 'undefined') ? marked.parse(rest[1]) : (rest[1] || "");
                div.innerHTML = textBefore + '<pre><code class="language-' + type + '">' + highlightedLines + '</code></pre>' + textAfter;
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
            messageEl = div;
        }

        if (messageEl && (role === 'agent' || className === 'welcome-message')) {
            messageEl.querySelectorAll('li').forEach(li => {
                li.onclick = () => {
                    const boldPart = li.querySelector('strong');
                    const prompt = boldPart ? boldPart.innerText : li.innerText.split(':')[0];
                    vscode.postMessage({ type: 'prompt', value: prompt.trim() });
                    input.focus();
                };
            });
        }

        if (messageEl && typeof hljs !== 'undefined') {
            messageEl.querySelectorAll('pre code').forEach((b) => { hljs.highlightElement(b); });
        }
        chat.scrollTop = chat.scrollHeight;
    }

    function setToolStatus(status) {
        if (status) {
            statusText.innerText = status;
            typing.style.display = 'block';
            startThinkingSession(); // Ensure session is visible when activity starts
        } else {
            typing.style.display = 'none';
            statusText.innerText = 'Agent is processing...';
        }
        chat.scrollTop = chat.scrollHeight;
    }

    const thinkingToggle = document.getElementById('show-thinking-toggle');
    if (thinkingToggle) {
        thinkingToggle.onchange = (e) => {
            const show = e.target.checked;
            document.querySelectorAll('.thinking-session').forEach(el => {
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
            const geminiKeyRow = document.getElementById('gemini-api-key-row');
            const modelSelect = document.getElementById('model-input');
            const provider = e.target.value;
            
            if (apiKeyRow) apiKeyRow.style.display = provider === 'openrouter' ? 'flex' : 'none';
            if (geminiKeyRow) geminiKeyRow.style.display = provider === 'gemini' ? 'flex' : 'none';

            // Clear model input for the new provider
            if (modelInput) {
                modelInput.value = '';
                modelInput.placeholder = 'Loading models...';
            }

            const apiKey = (provider === 'openrouter') ? 
                document.getElementById('api-key-input').value : 
                document.getElementById('gemini-api-key-input').value;

            vscode.postMessage({ type: 'fetchModels', provider, apiKey });
        };
    }

    const refreshModelsBtn = document.getElementById('refresh-models-btn');
    if (refreshModelsBtn) {
        refreshModelsBtn.onclick = () => {
            refreshModelsBtn.innerText = '⌛';
            const provider = document.getElementById('provider-select').value;
            const apiKey = (provider === 'openrouter') ? 
                document.getElementById('api-key-input').value : 
                document.getElementById('gemini-api-key-input').value;

            vscode.postMessage({ type: 'fetchModels', provider, apiKey });
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

    // Custom Model Dropdown Logic
    const modelInput = document.getElementById('model-input');
    const modelDropdown = document.getElementById('model-dropdown');

    function showDropdown() {
        const state = vscode.getState() || {};
        const models = state.availableModels || [];
        const term = modelInput.value.toLowerCase();
        const filtered = models.filter(m => m.toLowerCase().includes(term));
        
        if (filtered.length > 0) {
            modelDropdown.innerHTML = '';
            filtered.forEach(mId => {
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                item.innerText = mId;
                item.onclick = () => {
                    modelInput.value = mId;
                    modelDropdown.style.display = 'none';
                };
                modelDropdown.appendChild(item);
            });
            modelDropdown.style.display = 'block';
        } else {
            modelDropdown.style.display = 'none';
        }
    }

    if (modelInput) {
        modelInput.oninput = () => showDropdown();
        modelInput.onfocus = () => showDropdown();
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (e.target !== modelInput && !modelDropdown.contains(e.target)) {
                modelDropdown.style.display = 'none';
            }
        });
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
            geminiApiKey: document.getElementById('gemini-api-key-input').value,
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
        // Minimize settings panel
        const settingsContainer = document.querySelector('.settings-container');
        if (settingsContainer) {
            settingsContainer.open = false;
        }
        showToast('✅ Configuration saved successfully!');
        const currentProvider = document.getElementById('provider-select').value;
        const currentModel = document.getElementById('model-input').value;
        const currentMode = document.getElementById('kong-mode-select').value;

        appendMessage('agent', `### Configuration Saved! 🚀\n\nThe **Kong Gateway Agent** has been updated with your new settings:\n\n- 🤖 **Provider**: ${currentProvider}\n- 🧠 **Model**: ${currentModel}\n- 🌐 **Mode**: ${currentMode}\n\nI'm ready to continue. How can I help you today?`);
        
        // Auto-refresh models when saving if provider or key is new
        const provider = document.getElementById('provider-select').value;
        const apiKey = (provider === 'openrouter') ? 
            document.getElementById('api-key-input').value : 
            document.getElementById('gemini-api-key-input').value;

        vscode.postMessage({ type: 'fetchModels', provider, apiKey });
    };

    // Initial Welcome Message
    const welcomeTemplate = document.getElementById('welcome-template');
    if (welcomeTemplate) {
        appendMessage('agent', welcomeTemplate.innerHTML.trim(), 'welcome-message');
    }

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
            const provider = m.provider || 'openrouter';
            document.getElementById('provider-select').value = provider;
            
            const modelInput = document.getElementById('model-input');
            const currentModel = m.model || '';
            
            if (m.models) {
                populateModelSelect(m.models, currentModel);
            } else {
                vscode.postMessage({ type: 'fetchModels' });
            }

            document.getElementById('api-key-input').value = m.apiKey || '';
            document.getElementById('gemini-api-key-input').value = m.geminiApiKey || '';
            document.getElementById('max-depth-input').value = m.maxDepth || 10;

            // Trigger visibility toggle
            document.getElementById('api-key-row').style.display = provider === 'openrouter' ? 'flex' : 'none';
            document.getElementById('gemini-api-key-row').style.display = provider === 'gemini' ? 'flex' : 'none';
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
            document.querySelectorAll('.thinking-session').forEach(el => {
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
        } else if (m.type === 'toolStatus') {
            setToolStatus(m.status);
        } else if (m.type === 'portCheckResults') {
            for (const [key, res] of Object.entries(m.results)) {
                const el = document.getElementById(key + '-card');
                if (el) {
                    el.style.borderColor = res.inUse ? '#f44747' : '';
                    el.style.background = res.inUse ? 'rgba(244, 71, 71, 0.05)' : '';
                }
            }
            if (m.hasCollision) appendMessage('agent', '⚠️ **Port Issues**:\n\n' + m.report);
            else appendMessage('agent', '✅ All ports are available!');
        } else if (m.type === 'modelsFetched') {
            const refreshBtn = document.getElementById('refresh-models-btn');
            if (refreshBtn) refreshBtn.innerText = '🔄';
            
            // Store available models in webview state
            const state = vscode.getState() || {};
            state.availableModels = m.models;
            vscode.setState(state);
            
            const currentModelValue = document.getElementById('model-input').value;
            populateModelSelect(m.models, currentModelValue);
        }
    });

    function populateModelSelect(models, selectedValue) {
        const input = document.getElementById('model-input');
        if (!input) return;
        
        input.placeholder = 'Search or type model ID...';
        
        // If a value was passed (e.g. from config load), set it to the input
        if (selectedValue) {
            input.value = selectedValue;
        }
    }
})();

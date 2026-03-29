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
        label.innerText = '🧠 Analyzing request...';
        
        const counter = document.createElement('span');
        counter.className = 'tool-count';
        counter.innerText = ''; // Start empty
        
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
        placeholder.innerText = '🧠 Thinking about your request...';
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
            labelEl.innerText = '🧠 Analyzing' + dots;
        }, 100);

        return currentSession;
    }

    function stopThinkingSession() {
        if (!currentSession) return;
        
        const elapsed = ((Date.now() - sessionStartTime) / 1000).toFixed(1);
        const sessionToClose = currentSession;
        
        // Always keep the session box now, as requested.
        sessionToClose.classList.add('complete');
        sessionToClose.querySelector('.session-label').innerText = '🧠 Analysed in ' + elapsed + 's';
        sessionToClose.querySelector('.thought-timer').innerText = elapsed + 's';
        
        // Nuclear cleanup of placeholders
        const placeholder = sessionToClose.stepsRef?.querySelector('.step-placeholder');
        if (placeholder && sessionToClose.toolCount > 0) placeholder.remove();
        else if (placeholder) placeholder.innerText = '🧠 Reasoning complete.';
        
        // Auto-collapse logic
        setTimeout(() => {
            const details = sessionToClose.querySelector('details');
            if (details) details.open = false;
        }, 3000);
        
        currentSession = null;
        sessionStartTime = null;
    }

    const stopBtn = document.getElementById('stop-agent-btn');
    const clearBtn = document.getElementById('clear-chat-btn');

    if (stopBtn) {
        stopBtn.onclick = () => {
            vscode.postMessage({ type: 'cancelAgent' });
            typing.style.display = 'none';
            stopThinkingSession();
        };
    }

    if (clearBtn) {
        clearBtn.onclick = () => {
            vscode.postMessage({ type: 'requestClear' });
        };
    }

    function appendMessage(role, content, className) {
        console.log(`[UI Trace]: Message Role=${role}, Content Length=${content?.length || 0}`);
        const isThinking = (role === 'toolCall' || role === 'toolResult' || role === 'thought');

        if (role === 'user') {
            stopThinkingSession();
            const div = document.createElement('div');
            div.className = 'message user';
            div.innerText = content;
            chat.appendChild(div);
            
            // Proactive Thinking Start
            startThinkingSession(); 
            return;
        }

        let messageEl = null;

        if (isThinking) {
            const session = startThinkingSession();
            const stepsContainer = session.stepsRef || session.querySelector('.thinking-steps');
            
            // Remove placeholder if it exists to avoid clearing thoughts
            if (stepsContainer) {
                const placeholder = stepsContainer.querySelector('.step-placeholder');
                if (placeholder) placeholder.remove();
            }

            // Update tool counter
            if (role === 'toolCall' && session.countRef) {
                session.toolCount++;
                session.countRef.innerText = `[Tools: ${session.toolCount}]`;
            }

            if (role === 'thought') {
                const displayContent = content.match(/<thought>([\s\S]*?)<\/thought>/)?.[1] || content;
                const thoughtDiv = document.createElement('div');
                thoughtDiv.className = 'thought-block';
                thoughtDiv.style.borderLeft = '2px solid #f51a56';
                thoughtDiv.style.paddingLeft = '10px';
                thoughtDiv.style.marginBottom = '12px';
                thoughtDiv.style.fontSize = '11px';
                thoughtDiv.style.fontStyle = 'italic';
                thoughtDiv.style.color = '#ccc';
                thoughtDiv.innerText = displayContent.trim();
                stepsContainer.appendChild(thoughtDiv);
                messageEl = thoughtDiv;
            } else {
                const div = document.createElement('div');
                div.className = 'message ' + role;
                
                const header = document.createElement('div');
                header.className = 'tool-header';
                header.style.color = role === 'toolCall' ? '#f51a56' : '#4ec9b0';
                header.style.fontWeight = 'bold';
                header.style.fontSize = '11px';
                header.innerText = role === 'toolCall' ? `⚒️ Executing tool...` : `✅ Result received`;
                
                const payload = document.createElement('div');
                payload.className = 'thinking-payload';
                payload.textContent = content; 
                
                div.appendChild(header);
                div.appendChild(payload);
                stepsContainer.appendChild(div);
                
                messageEl = div;
            }
        } else {
            const session = currentSession;
            let displayContent = content;
            let hasApproval = false;

            // Extract Approval Requirement
            if (content.includes('[APPROVAL_REQUIRED]')) {
                hasApproval = true;
                displayContent = content.replace('[APPROVAL_REQUIRED]', '').trim();
            }

            // Extract <thought> blocks — always strip them regardless of session state
            if (role === 'agent' && /<thought>([\s\S]*?)<\/thought>/gi.test(displayContent)) {
                const thoughtMatches = displayContent.matchAll(/<thought>([\s\S]*?)<\/thought>/gi);
                const stepsContainer = currentSession ? (currentSession.stepsRef || currentSession.querySelector('.thinking-steps')) : null;

                for (const match of thoughtMatches) {
                    if (stepsContainer) {
                        const placeholder = stepsContainer.querySelector('.step-placeholder');
                        if (placeholder) placeholder.remove();
                        const thoughtDiv = document.createElement('div');
                        thoughtDiv.className = 'thought-block';
                        thoughtDiv.style.borderLeft = '2px solid #f51a56';
                        thoughtDiv.style.paddingLeft = '10px';
                        thoughtDiv.style.marginBottom = '12px';
                        thoughtDiv.style.fontSize = '11px';
                        thoughtDiv.style.fontStyle = 'italic';
                        thoughtDiv.style.color = '#ccc';
                        thoughtDiv.innerText = match[1].trim();
                        stepsContainer.appendChild(thoughtDiv);
                    }
                }
                // Always remove the thought tags from the visible bubble content
                displayContent = displayContent.replace(/<thought>([\s\S]*?)<\/thought>/gi, '').trim();
            }
            // If no content is left after extracting thoughts and no approval is required, skip bubble creation
            if (!displayContent.trim() && !hasApproval) {
                stopThinkingSession();
                return;
            }

            stopThinkingSession(); 
            
            const div = document.createElement('div');
            div.className = 'message ' + role;
            if (className) div.classList.add(className);

            // Error Styling
            if (displayContent && (displayContent.toLowerCase().startsWith('error') || displayContent.toLowerCase().includes('failed:'))) {
                div.classList.add('error-message');
            }
            
            // Handle Diff/YAML Highlighting
            if (displayContent.includes('```diff') || displayContent.includes('```yaml')) {
                const type = displayContent.includes('```diff') ? 'diff' : 'yaml';
                const parts = displayContent.split('```' + type);
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
                div.innerHTML = (typeof marked !== 'undefined') ? marked.parse(displayContent) : displayContent;
            }

            // Approval Buttons
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

            chat.appendChild(div);
            messageEl = div;
        }

        // Interactive "Next Steps" Handlers
        if (messageEl && (role === 'agent' || (className && className.includes('welcome')))) {
            messageEl.querySelectorAll('li').forEach(li => {
                li.onclick = () => {
                    const boldPart = li.querySelector('strong');
                    const promptText = boldPart ? boldPart.innerText : li.innerText.split(':')[0];
                    vscode.postMessage({ type: 'prompt', value: promptText.trim() });
                    input.focus();
                };
            });
        }

        // Highlight Code
        if (messageEl && typeof hljs !== 'undefined') {
            messageEl.querySelectorAll('pre code').forEach((b) => { hljs.highlightElement(b); });
        }

        chat.scrollTop = chat.scrollHeight;
    }

    function setToolStatus(status) {
        if (status) {
            statusText.innerText = status;
            typing.style.cssText = 'display: flex !important'; 
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
        } else if (m.type === 'performClear') {
            // Aggressive UI Clear triggered from Extension
            stopThinkingSession();
            while (chat.firstChild) {
                chat.removeChild(chat.firstChild);
            }
            typing.style.display = 'none';
            
            // Clear State
            vscode.setState({});
            
            const welcomeTemplate = document.getElementById('welcome-template');
            const welcome = welcomeTemplate ? welcomeTemplate.innerHTML : 'Welcome to Kong Gateway Agent!';
            
            appendMessage('agent', welcome, 'welcome-message');
            showToast('🧹 Chat history and UI refreshed');
            chat.scrollTop = 0;
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

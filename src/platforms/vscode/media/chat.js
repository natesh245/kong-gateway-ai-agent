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

    function appendMessage(role, content, className, usage) {
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

            // 1. Extract and strip <thought> blocks first (they should never trigger UI buttons)
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
                displayContent = displayContent.replace(/<thought>([\s\S]*?)<\/thought>/gi, '').trim();
            }

            // 2. Extract Approval Requirement from the remaining CLEAN content
            if (displayContent.includes('[APPROVAL_REQUIRED]')) {
                hasApproval = true;
                displayContent = displayContent.replace('[APPROVAL_REQUIRED]', '').trim();
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
            
            if (usage && role === 'agent') {
                const usageDiv = document.createElement('div');
                usageDiv.className = 'message-usage-container';
                const usageBadge = document.createElement('span');
                usageBadge.className = 'message-usage-badge';
                usageBadge.innerHTML = `⚡ ${usage.inputTokens} IN / ${usage.outputTokens} OUT`;
                usageDiv.appendChild(usageBadge);
                div.appendChild(usageDiv);
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
            const provider = e.target.value;
            const apiKeyRow = document.getElementById('api-key-row');
            const geminiKeyRow = document.getElementById('gemini-api-key-row');
            const modelSelect = document.getElementById('model-input');
            
            if (apiKeyRow) apiKeyRow.classList.toggle('hidden', provider !== 'openrouter');
            if (geminiKeyRow) geminiKeyRow.classList.toggle('hidden', provider !== 'gemini');

            // Clear model input for the new provider
            if (modelSelect) {
                modelSelect.value = '';
                modelSelect.placeholder = 'Loading models...';
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
            checkConfigChanges();
        };
    }

    // Bulletproof Model Dropdown Logic
    function getModelInput() { return document.getElementById('model-input'); }
    function getModelDropdown() { return document.getElementById('model-dropdown'); }

    function showDropdown() {
        const input = getModelInput();
        const dropdown = getModelDropdown();
        if (!input || !dropdown) return;

        const state = vscode.getState() || {};
        const models = state.availableModels || [];
        const term = (input.value || '').toLowerCase();
        
        // If no models in state, maybe they were just fetched
        const filtered = models.length > 0 ? 
            models.filter(m => m.toLowerCase().includes(term)) : [];
        
        if (filtered.length > 0) {
            dropdown.innerHTML = '';
            
            // Calculate Position for Fixed Dropdown
            const rect = input.getBoundingClientRect();
            dropdown.style.top = (rect.bottom + 4) + 'px';
            dropdown.style.left = rect.left + 'px';
            dropdown.style.width = rect.width + 'px';
            
            filtered.forEach(mId => {
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                item.innerText = mId;
                item.onmousedown = (e) => { // Use mousedown to beat the blur
                    e.preventDefault(); 
                    e.stopPropagation();
                    const inp = getModelInput();
                    const dd = getModelDropdown();
                    if (inp) {
                        inp.value = mId;
                        inp.dispatchEvent(new Event('change')); // Trigger any other listeners
                    }
                    if (dd) dd.style.display = 'none';
                    
                    // Update the quick info bar too
                    const info = document.getElementById('current-model-info');
                    if (info) info.innerText = mId;
                };
                dropdown.appendChild(item);
            });
            dropdown.style.display = 'block';
        } else {
            dropdown.style.display = 'none';
        }
    }

    // Close dropdown on scroll
    const settingsPanel = document.querySelector('.settings-panel');
    if (settingsPanel) {
        settingsPanel.onscroll = () => {
            const dd = getModelDropdown();
            if (dd) dd.style.display = 'none';
        };
    }

    // Console-logged initialization to track logic
    const modelSearchInited = false;
    function initializeModelSearch() {
        const mInput = getModelInput();
        if (mInput && !mInput.hasAttribute('data-hooked')) {
            mInput.oninput = () => showDropdown();
            mInput.onfocus = () => showDropdown();
            mInput.setAttribute('data-hooked', 'true');
        }
    }
    initializeModelSearch();

    // Global click listener to close dropdown
    document.addEventListener('click', (e) => {
        const input = getModelInput();
        const dropdown = getModelDropdown();
        if (input && dropdown && e.target !== input && !dropdown.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });

    const browseBtn = document.getElementById('browse-btn');
    if (browseBtn) browseBtn.onclick = () => vscode.postMessage({ type: 'selectFolder' });

    const saveBtn = document.getElementById('save-config-btn');

    function getUIConfig() {
        return {
            provider: document.getElementById('provider-select')?.value,
            model: document.getElementById('model-input')?.value,
            kongMode: document.getElementById('kong-mode-select')?.value,
            storagePath: document.getElementById('storage-input')?.value,
            proxyPort: document.getElementById('proxy-port-input')?.value?.toString(),
            adminApiPort: document.getElementById('admin-port-input')?.value?.toString(),
            managerGuiPort: document.getElementById('manager-port-input')?.value?.toString(),
            databasePort: document.getElementById('db-port-input')?.value?.toString(),
            maxReasoningTurns: document.getElementById('max-reasoning-turns-input')?.value?.toString(),
            maxToolCalls: document.getElementById('max-tool-calls-input')?.value?.toString(),
            maxContext: document.getElementById('max-context-input')?.value?.toString(),
            maxAgentTimeout: document.getElementById('max-timeout-input')?.value?.toString(),
            kongWorkspace: document.getElementById('workspace-input')?.value,
            openRouterApiKey: document.getElementById('api-key-input')?.value,
            geminiApiKey: document.getElementById('gemini-api-key-input')?.value,
            remoteAdminApiUrl: document.getElementById('remote-admin-input')?.value,
            remoteProxyBaseUrl: document.getElementById('remote-proxy-input')?.value,
            remoteManagerGuiUrl: document.getElementById('remote-manager-input')?.value,
            kongAdminToken: document.getElementById('admin-token-input')?.value,
            skipTlsVerify: document.getElementById('skip-tls-input')?.checked ? 'true' : 'false',
            showThinking: document.getElementById('show-thinking-toggle')?.checked ? 'true' : 'false',
            gitRemoteUrl: document.getElementById('git-remote-input')?.value,
            autoCommit: document.getElementById('auto-commit-input')?.checked ? 'true' : 'false'
        };
    }

    function checkConfigChanges() {
        if (!saveBtn) return;
        const state = vscode.getState() || {};
        const oldConfig = state.config || {};

        const currentConfig = getUIConfig();

        let hasChanges = false;
        // Compare all keys in the current UI config against the baseline
        for (const [key, val] of Object.entries(currentConfig)) {
            const oldVal = (oldConfig[key] !== undefined && oldConfig[key] !== null) ? oldConfig[key].toString().trim() : '';
            const newVal = (val !== undefined && val !== null) ? val.toString().trim() : '';
            
            if (oldVal !== newVal) {
                hasChanges = true;
                break;
            }
        }

        saveBtn.disabled = !hasChanges;
        if (!hasChanges) {
            saveBtn.style.opacity = '0.5';
            saveBtn.style.cursor = 'not-allowed';
            saveBtn.innerText = 'No Changes to Save';
        } else {
            saveBtn.style.opacity = '1';
            saveBtn.style.cursor = 'pointer';
            saveBtn.innerText = 'Save Configuration';
        }
    }

    // Bind this checking function to all relevant inputs
    document.querySelectorAll('.settings-panel input, .settings-panel select').forEach(el => {
        el.addEventListener('input', checkConfigChanges);
        el.addEventListener('change', checkConfigChanges);
    });

    if (saveBtn) saveBtn.onclick = () => {
        const oldState = vscode.getState() || {};
        const oldConfig = oldState.config || {};
        
        const newConfig = getUIConfig();

        const changes = [];
        const detect = (key, label) => {
            const oldVal = (oldConfig[key] !== undefined && oldConfig[key] !== null) ? oldConfig[key].toString().trim() : '';
            const newVal = (newConfig[key] !== undefined && newConfig[key] !== null) ? newConfig[key].toString().trim() : '';
            
            if (newVal !== oldVal) {
                const sensitiveKeys = ['openRouterApiKey', 'geminiApiKey', 'kongAdminToken'];
                const isSensitive = sensitiveKeys.includes(key);
                
                const displayOld = (isSensitive && oldVal) ? '[REDACTED]' : (oldVal || 'None');
                const displayNew = (isSensitive && newVal) ? '[REDACTED]' : (newVal || 'None');
                
                changes.push(`| **${label}** | \`${displayOld}\` → \`${displayNew}\` |`);
            }
        };

        detect('provider', 'AI Provider');
        detect('model', 'Model ID');
        detect('kongMode', 'Execution Mode');
        detect('storagePath', 'Storage Path');
        detect('proxyPort', 'Proxy Port');
        detect('adminApiPort', 'Admin Port');
        detect('managerGuiPort', 'Manager Port');
        detect('databasePort', 'Database Port');
        detect('maxReasoningTurns', 'Reasoning Turns');
        detect('maxToolCalls', 'Tool Limit');
        detect('maxContext', 'Max Context');
        detect('maxAgentTimeout', 'Agent Timeout');
        detect('kongWorkspace', 'Workspace');
        detect('openRouterApiKey', 'OpenRouter Key');
        detect('geminiApiKey', 'Gemini Key');
        detect('remoteAdminApiUrl', 'Remote Admin URL');
        detect('remoteProxyBaseUrl', 'Remote Proxy URL');
        detect('remoteManagerGuiUrl', 'Remote Manager URL');
        detect('kongAdminToken', 'Admin Token');
        detect('skipTlsVerify', 'Skip TLS');
        detect('showThinking', 'Show Thinking');
        detect('gitRemoteUrl', 'Git URL');
        detect('autoCommit', 'Auto Commit');

        const messageData = {
            type: 'updateConfig',
            ...newConfig
        };
        vscode.postMessage(messageData);

        // Save current to state for next diff
        oldState.config = { ...newConfig };
        vscode.setState(oldState);

        if (changes.length > 0) {
            const summary = `### ✅ Configuration Saved\n\n| Setting | Change |\n| :--- | :--- |\n${changes.join('\n')}`;
            appendMessage('agent', summary);
        } else {
            showToast('✅ Configuration saved successfully!');
        }
        
        saveBtn.disabled = true;
        saveBtn.innerText = 'No Changes to Save';
        saveBtn.style.opacity = '0.5';
    };

    // Initial Welcome Message
    const welcomeTemplate = document.getElementById('welcome-template');
    if (welcomeTemplate) {
        appendMessage('agent', welcomeTemplate.innerHTML.trim(), 'welcome-message');
    }


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
            appendMessage(m.role, m.content, undefined, m.lastUsage);
        } else if (m.type === 'setConfig') {
            syncUIWithConfig(m);
            if (m.usageStats) {
                updateUsageUI(m.usageStats);
            }
            if (m.files) {
                const list = document.getElementById('file-list');
                if (list) {
                    list.innerHTML = '';
                    m.files.forEach(f => {
                        const item = document.createElement('div');
                        item.className = 'file-item';
                        item.innerHTML = '<span class="file-name">' + f + '</span><button class="open-file-btn">Open</button>';
                        item.querySelector('.open-file-btn').onclick = () => vscode.postMessage({ type: 'openFile', filename: f });
                        list.appendChild(item);
                    });
                }
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
        } else if (m.type === 'updateUsage') {
            updateUsageUI(m.stats);
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
            
            const modelInput = document.getElementById('model-input');
            const currentModelValue = modelInput ? modelInput.value : '';
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

    // --- State Restoration ---
    const previousState = vscode.getState();
    if (previousState && previousState.config) {
        syncUIWithConfig(previousState.config);
    }

    function syncUIWithConfig(config) {
        if (!config) return;

        const provider = config.provider || config.openRouterApiKey ? 'openrouter' : 'gemini'; // fallback detection
        if (config.provider) {
            document.getElementById('provider-select').value = config.provider;
        }
        
        const currentModel = config.model || '';
        
        // Sync available models to state immediately if provided
        if (config.models) {
            const state = vscode.getState() || {};
            state.availableModels = config.models;
            vscode.setState(state);
            populateModelSelect(config.models, currentModel);
        } else {
            // Check if we have models in our state already
            const savedState = vscode.getState() || {};
            if (savedState.availableModels) {
                populateModelSelect(savedState.availableModels, currentModel);
            } else {
                vscode.postMessage({ type: 'fetchModels' });
            }
        }

        initializeModelSearch();

        // Populate fields with reasonable defaults if missing
        const setVal = (id, val, def = '') => {
            const el = document.getElementById(id);
            if (el) el.value = (val !== undefined && val !== null) ? val : def;
        };

        setVal('proxy-port-input', config.proxyPort, '8000');
        setVal('admin-port-input', config.adminApiPort, '8001');
        setVal('manager-port-input', config.managerGuiPort, '8002');
        setVal('db-port-input', config.databasePort, '5432');
        setVal('workspace-input', config.kongWorkspace, 'default');
        setVal('api-key-input', config.openRouterApiKey);
        setVal('gemini-api-key-input', config.geminiApiKey);
        setVal('max-reasoning-turns-input', config.maxReasoningTurns, '10');
        setVal('max-tool-calls-input', config.maxToolCalls, '10');
        setVal('max-context-input', config.maxContext, '130000');
        setVal('max-timeout-input', config.maxAgentTimeout, '100');
        setVal('admin-token-input', config.kongAdminToken);
        setVal('remote-admin-input', config.remoteAdminApiUrl);
        setVal('remote-proxy-input', config.remoteProxyBaseUrl);
        setVal('remote-manager-input', config.remoteManagerGuiUrl);
        setVal('storage-input', config.storagePath);
        setVal('git-remote-input', config.gitRemoteUrl);

        if (document.getElementById('skip-tls-input')) 
            document.getElementById('skip-tls-input').checked = config.skipTlsVerify === true || config.skipTlsVerify === 'true';
        if (document.getElementById('show-thinking-toggle'))
            document.getElementById('show-thinking-toggle').checked = config.showThinking !== false && config.showThinking !== 'false';
        if (document.getElementById('auto-commit-input'))
            document.getElementById('auto-commit-input').checked = config.autoCommit === true || config.autoCommit === 'true';

        const kongMode = config.kongMode || 'local';
        const modeSelect = document.getElementById('kong-mode-select');
        if (modeSelect) {
            modeSelect.value = kongMode;
            document.getElementById('local-settings').classList.toggle('hidden', kongMode !== 'local');
            document.getElementById('remote-settings').classList.toggle('hidden', kongMode === 'local');
            document.getElementById('check-ports-btn').classList.toggle('hidden', kongMode !== 'local');
        }

        // Update Quick Bar
        const activeProvider = config.provider || (config.openRouterApiKey ? 'openrouter' : 'gemini');
        const badge = document.getElementById('current-provider-badge');
        const modelInfo = document.getElementById('current-model-info');
        if (badge) {
            badge.innerText = activeProvider === 'openrouter' ? 'OpenRouter' : 'Gemini';
            badge.style.background = activeProvider === 'openrouter' ? 'var(--accent)' : '#4ec9b0';
        }
        if (modelInfo) modelInfo.innerText = currentModel;
        
        // Toggle API key row visibility
        const apiKeyRow = document.getElementById('api-key-row');
        const geminiApiKeyRow = document.getElementById('gemini-api-key-row');
        if (apiKeyRow) apiKeyRow.classList.toggle('hidden', activeProvider !== 'openrouter');
        if (geminiApiKeyRow) geminiApiKeyRow.classList.toggle('hidden', activeProvider !== 'gemini');

        // Seed state baseline AFTER all DOM updates are complete
        const state = vscode.getState() || {};
        state.config = getUIConfig();
        vscode.setState(state);
        
        checkConfigChanges();
    }

    function populateModelSelect(models, selectedValue) {
        const input = document.getElementById('model-input');
        const modelInfo = document.getElementById('current-model-info');
        
        if (input) {
            input.placeholder = 'Search or type model ID...';
            if (selectedValue) input.value = selectedValue;
        }
        
        if (modelInfo && selectedValue) {
            modelInfo.innerText = selectedValue;
        }
    }

    function updateUsageUI(stats) {
        if (!stats) return;

        const statIn = document.getElementById('stat-in');
        const statOut = document.getElementById('stat-out');
        const statContext = document.getElementById('stat-context');

        if (statIn) statIn.innerText = formatTokens(stats.inputTokens);
        if (statOut) statOut.innerText = formatTokens(stats.outputTokens);
        
        if (statContext && stats.contextLimit) {
            const usagePercent = Math.min(100, Math.max(0, (stats.totalTokens / stats.contextLimit) * 100));
            statContext.innerText = usagePercent.toFixed(usagePercent < 1 ? 1 : 0);
            
            // Visual warning for high context usage
            const pill = statContext.parentElement;
            if (pill) {
                if (usagePercent > 90) pill.style.borderColor = '#f44747';
                else if (usagePercent > 70) pill.style.borderColor = '#d7ba7d';
                else pill.style.borderColor = 'rgba(255, 255, 255, 0.05)';
            }

            if (usagePercent >= 100 && !window._contextWarningTriggered) {
                window._contextWarningTriggered = true;
                setTimeout(() => {
                    const messagesContainer = document.getElementById('chat');
                    const warningHtml = `
                        <div class="message system error">
                            <div class="message-content">
                                <h3>⚠️ Context Limit Exceeded</h3>
                                <p>You have reached <b>100%</b> of your configured maximum context limit (${formatTokens(stats.contextLimit)} tokens).</p>
                                <p>Continuing might result in truncated details or memory overflow. Please click the <b>Clear Chat</b> button to reset the context and start fresh.</p>
                            </div>
                        </div>
                    `;
                    messagesContainer.insertAdjacentHTML('beforeend', warningHtml);
                    messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
                }, 100);
            }
        }
    }

    function formatTokens(num) {
        if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
        return num;
    }
})();

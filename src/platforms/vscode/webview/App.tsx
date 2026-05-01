import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getVsCodeApi } from './vscode-api';
import { ChatContainer } from './components/ChatContainer';
import { SettingsPanel } from './components/SettingsPanel';
import { InputBar } from './components/InputBar';
import { StatsBar } from './components/StatsBar';
import { Notification, Toast } from './components/Notification';

// Types
export interface Message {
    role: string;
    content: string;
    complete?: boolean;
    startTime?: number;
    endTime?: number;
    lastUsage?: any;
    reasoning?: string;
    toolInteractions?: any[];
    className?: string;
    cancelled?: boolean;
}

interface Config {
    provider?: string;
    model?: string;
    openRouterApiKey?: string;
    geminiApiKey?: string;
    storagePath?: string;
    kongMode?: 'local' | 'remote';
    proxyPort?: number;
    adminApiPort?: number;
    managerGuiPort?: number;
    databasePort?: number;
    remoteAdminApiUrl?: string;
    remoteProxyBaseUrl?: string;
    remoteManagerGuiUrl?: string;
    kongWorkspace?: string;
    kongAdminToken?: string;
    skipTlsVerify?: boolean;
    showThinking?: boolean;
    gitRemoteUrl?: string;
    autoCommit?: boolean;
    maxReasoningTurns?: number;
    maxToolCalls?: number;
    maxContext?: number;
    maxAgentTimeout?: number;
    stagedFiles?: string[];
    [key: string]: any;
}

interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextLimit?: number;
}

export const App: React.FC = () => {
    const vscode = getVsCodeApi();
    const savedState = vscode.getState() || {};

    // State
    const [messages, setMessages] = useState<Message[]>(savedState.messages || []);
    const [config, setConfig] = useState<Config>(savedState.config || {});
    const [usageStats, setUsageStats] = useState<UsageStats>(savedState.usageStats || { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const [availableModels, setAvailableModels] = useState<string[]>(savedState.models || []);
    const [managedFiles, setManagedFiles] = useState<string[]>(savedState.files || []);
    const [detectedFiles, setDetectedFiles] = useState<{ compose?: string, config?: string, gateway_config?: string, ruleset?: string }>(savedState.detectedFiles || {});
    
    // Lifecycle Tracking
    const [isInitialLoad, setIsInitialLoad] = useState(!savedState.config);
    const [isTyping, setIsTyping] = useState(false);
    const isTypingRef = useRef(isTyping);
    useEffect(() => { isTypingRef.current = isTyping; }, [isTyping]);

    const [statusText, setStatusText] = useState('');
    const [notification, setNotification] = useState<{ filename: string, changeType: string } | null>(null);
    const [toast, setToast] = useState<string | null>(null);

    // Message Handler
    useEffect(() => {
        const messageHandler = (event: MessageEvent) => {
            const m = event.data;
            if (!m || !m.type) return;

            switch (m.type) {
                case 'streamMessage':
                    setMessages(prev => {
                        const existingIdx = prev.findIndex(msg => (msg as any).id === m.messageId);
                        if (existingIdx !== -1) {
                            const newMessages = [...prev];
                            const current = newMessages[existingIdx];
                            
                            if (m.role === 'reasoning') {
                                newMessages[existingIdx] = {
                                    ...current,
                                    reasoning: (current.reasoning || '') + (m.content || '')
                                };
                            } else {
                                newMessages[existingIdx] = {
                                    ...current,
                                    content: current.content + (m.content || '')
                                };
                            }
                            return newMessages;
                        } else {
                            // Defensive: Do not allow technical roles to leak into the chat content
                            if (m.role === 'toolInteraction' || m.role === 'toolStatus') return prev;

                            return [...prev, {
                                id: m.messageId,
                                role: 'agent',
                                content: m.role === 'reasoning' ? '' : (m.content || ''),
                                reasoning: m.role === 'reasoning' ? (m.content || '') : '',
                                toolInteractions: [],
                                showThinking: true,
                                complete: false,
                                startTime: m.startTime || Date.now()
                            } as any];
                        }
                    });
                    setIsTyping(true);
                    // Only clear status text if we are streaming actual content, 
                    // not just reasoning, to avoid a 'blank' activity bar.
                    if (m.role !== 'reasoning') {
                        setStatusText(''); 
                    }
                    break;

                case 'toolInteraction':
                    // Dynamically update the current message with tool interaction details (during stream)
                    setMessages(prev => {
                        const existingIdx = prev.findIndex(msg => (msg as any).id === m.messageId);
                        if (existingIdx === -1) return prev;
                        
                        const newMessages = [...prev];
                        const current = newMessages[existingIdx];
                        const interactions = [...(current.toolInteractions || [])];
                        
                        // Update or add the interaction
                        const interactionIdx = interactions.findIndex(i => i.id === m.toolCallId);
                        if (interactionIdx !== -1) {
                            // Harden: Never overwrite an existing name with undefined/empty
                            const updatedInteraction = { ...interactions[interactionIdx], ...m.interaction };
                            if (!m.interaction.name) {
                                updatedInteraction.name = interactions[interactionIdx].name;
                            }
                            interactions[interactionIdx] = updatedInteraction;
                        } else {
                            interactions.push({ id: m.toolCallId, ...m.interaction });
                        }
                        
                        newMessages[existingIdx] = { ...current, toolInteractions: interactions };
                        return newMessages;
                    });
                    break;

                case 'finalizeStreamedMessage':
                    setMessages(prev => {
                        const existingIdx = prev.findIndex(msg => (msg as any).id === m.messageId);
                        if (existingIdx !== -1) {
                            const newMessages = [...prev];
                            // NO MORE STRIPPING: We want to preserve the full content for ChatMessage to parse
                            newMessages[existingIdx] = {
                                ...newMessages[existingIdx],
                                complete: true,
                                endTime: Date.now(),
                                lastUsage: m.usage
                            };
                            return newMessages;
                        }
                        return prev;
                    });
                    setIsTyping(false);
                    setStatusText('');
                    break;

                case 'addMessage':
                    const validRoles = ['user', 'agent', 'assistant', 'ui-diff'];
                    if (!validRoles.includes(m.role)) {
                        console.log(`[UI] Ignoring internal message role: ${m.role}`);
                        return;
                    }

                    if (m.role === 'user') {
                        setMessages(prev => [...prev, {
                            id: Date.now().toString(),
                            role: 'user',
                            content: m.content || '',
                            className: m.className
                        } as any]);
                        return;
                    }

                    if (m.role === 'agent' || m.role === 'assistant') {
                        setIsTyping(false);
                        setStatusText('');
                        
                        setMessages(prev => {
                            const content = m.content || '';
                            const cleanContent = content
                                .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
                                .replace(/SYSTEM_WARNING:.*?(?:\n\n|$)/gi, '')
                                .trim();

                            if (cleanContent) {
                                return [...prev, {
                                    id: Date.now().toString(),
                                    role: 'agent',
                                    content: cleanContent,
                                    className: m.className,
                                    lastUsage: m.lastUsage,
                                    complete: true
                                } as any];
                            }
                            return prev;
                        });
                        return;
                    }
                    break;

                case 'toolStatus':
                    setIsTyping(true);
                    setStatusText(m.status || '');
                    break;

                case 'setConfig':
                    const updateData = { ...m };
                    delete (updateData as any).type;
                    
                    setIsInitialLoad(false); 

                    setConfig(prev => ({ ...prev, ...updateData }));
                    
                    if (m.usageStats) setUsageStats(m.usageStats);
                    if (m.models) setAvailableModels(m.models);
                    if (m.files) setManagedFiles(m.files);
                    if (m.detectedFiles) setDetectedFiles(m.detectedFiles);
                    
                    if (m.history && Array.isArray(m.history)) {
                        // CRITICAL: Protect active streaming sessions from being overwritten
                        if (isTypingRef.current) {
                            console.log('[UI] Skipping history sync: Agent is currently active.');
                        } else {
                            const validRoles = ['user', 'agent', 'assistant', 'ui-diff'];
                            
                            const processedHistory = m.history
                                .filter((msg: any) => {
                                    const role = msg?.role;
                                    const content = typeof msg.content === 'string' ? msg.content : '';
                                    
                                    if (!validRoles.includes(role)) return false;
                                    
                                    // Detect stringified JSON logs stored in content
                                    if (content.trim().startsWith('[') || content.trim().startsWith('{')) {
                                        if (content.includes('"role":"') || 
                                            content.includes('"toolCall"') || 
                                            content.includes('"interaction":') ||
                                            content.includes('"tool_call_id"')) {
                                            return false;
                                        }
                                    }

                                    if (!content.trim() && !msg.reasoning?.trim() && (!msg.toolInteractions || msg.toolInteractions.length === 0)) return false;
                                    return true;
                                })
                                .map((msg: any) => ({
                                    role: msg.role === 'assistant' ? 'agent' : msg.role,
                                    content: msg.content,
                                    reasoning: msg.reasoning || "",
                                    toolInteractions: msg.toolInteractions || [],
                                    showThinking: true,
                                    complete: true,
                                    startTime: msg.startTime || Date.now(),
                                    endTime: msg.endTime || Date.now(),
                                    lastUsage: msg.lastUsage
                                }));

                            // Post-process to merge consecutive agent messages into a single turn
                            const mergedHistory: any[] = [];
                            let currentTurnAgentMsg: any = null;

                            for (const msg of processedHistory) {
                                if (msg.role === 'user') {
                                    if (currentTurnAgentMsg) {
                                        mergedHistory.push(currentTurnAgentMsg);
                                        currentTurnAgentMsg = null;
                                    }
                                    mergedHistory.push(msg);
                                } else if (msg.role === 'agent') {
                                    if (!currentTurnAgentMsg) {
                                        // Clone the array to avoid mutating the original
                                        currentTurnAgentMsg = { ...msg, toolInteractions: [...msg.toolInteractions] };
                                    } else {
                                        // Merge intermediate into current
                                        // The previous content (if any) was intermediate, so shift it to reasoning
                                        if (msg.content) {
                                            if (currentTurnAgentMsg.content) {
                                                currentTurnAgentMsg.reasoning = currentTurnAgentMsg.reasoning 
                                                    ? currentTurnAgentMsg.reasoning + "\n\n" + currentTurnAgentMsg.content 
                                                    : currentTurnAgentMsg.content;
                                            }
                                            // Add the new content
                                            currentTurnAgentMsg.content = msg.content;
                                        }

                                        // Append reasoning
                                        if (msg.reasoning) {
                                            currentTurnAgentMsg.reasoning = currentTurnAgentMsg.reasoning
                                                ? currentTurnAgentMsg.reasoning + "\n\n" + msg.reasoning
                                                : msg.reasoning;
                                        }

                                        // Append tool interactions
                                        if (msg.toolInteractions) {
                                            currentTurnAgentMsg.toolInteractions.push(...msg.toolInteractions);
                                        }

                                        // Update usage and timing
                                        if (msg.lastUsage) currentTurnAgentMsg.lastUsage = msg.lastUsage;
                                        if (msg.endTime) currentTurnAgentMsg.endTime = msg.endTime;
                                    }
                                } else {
                                    if (currentTurnAgentMsg) {
                                        mergedHistory.push(currentTurnAgentMsg);
                                        currentTurnAgentMsg = null;
                                    }
                                    mergedHistory.push(msg);
                                }
                            }
                            if (currentTurnAgentMsg) {
                                mergedHistory.push(currentTurnAgentMsg);
                            }
                            
                            setMessages(mergedHistory);
                        }
                    }
                    break;

                case 'fileChanged':
                    setNotification({ filename: m.filename, changeType: m.changeType });
                    break;

                case 'updateUsage':
                    if (m.stats) setUsageStats(m.stats);
                    break;

                case 'performClear':
                    setMessages([]);
                    setIsTyping(false);
                    setStatusText('');
                    setToast('🧹 Chat history refreshed');
                    break;
                case 'diffResolved':
                    // We can just show a toast or hide the buttons. The actual text stays.
                    if (m.status === 'accepted') {
                        setToast(`✅ Applied changes to ${m.filename}`);
                    } else {
                        setToast(`❌ Discarded changes to ${m.filename}`);
                    }
                    break;
            }
        };

        window.addEventListener('message', messageHandler);
        vscode.postMessage({ type: 'ready' });

        return () => window.removeEventListener('message', messageHandler);
    }, [vscode]);

    const handleSaveConfig = (newConfig: any) => {
        vscode.postMessage({ type: 'updateConfig', ...newConfig });
        setConfig(newConfig);
    };

    const handleSendAction = useCallback((text: string) => {
        setIsTyping(true);
        setStatusText('Agent is analyzing request...');
        vscode.postMessage({ type: 'prompt', value: text, timestamp: Date.now() });
    }, [vscode]);

    const handleRequestReview = useCallback((filename: string) => {
        setIsTyping(true);
        setStatusText(`Agent is analyzing diffs for ${filename}...`);
        vscode.postMessage({ type: 'requestReview', filename, timestamp: Date.now() });
    }, [vscode]);

    const handleDiffAction = useCallback((action: 'accept' | 'reject', filename: string) => {
        if (action === 'accept') {
            vscode.postMessage({ type: 'acceptDiff', filename, timestamp: Date.now() });
        } else {
            vscode.postMessage({ type: 'rejectDiff', filename });
        }
    }, [vscode]);

    const handleCancel = useCallback(() => {
        vscode.postMessage({ type: 'cancelAgent' });
        setIsTyping(false);
    }, [vscode]);

    const handleClear = useCallback(() => {
        vscode.postMessage({ type: 'requestClear' });
    }, [vscode]);

    // Persistence Effect
    useEffect(() => {
        vscode.setState({
            config,
            messages,
            usageStats,
            models: availableModels,
            files: managedFiles,
            detectedFiles
        });
    }, [config, messages, usageStats, availableModels, managedFiles, detectedFiles, vscode]);

    return (
        <>
            {isInitialLoad && (
                <div className="loading-overlay">
                    <div className="loading-content">
                        <span className="loading-logo">🦍</span>
                        <div className="loading-spinner"></div>
                        <span className="loading-text">Initializing Kong Agent...</span>
                    </div>
                </div>
            )}

            <div className={`app-container ${isInitialLoad ? 'loading' : ''}`}>
                {toast && <Toast message={toast} onClose={() => setToast(null)} />}

                <div className="header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="logo">🦍</span>
                        <span>Kong Gateway Agent</span>
                    </div>
                    <button id="clear-chat-btn" title="Clear Chat History" onClick={handleClear}>🧹 Clear Chat</button>
                </div>

                {notification && (
                    <Notification
                        filename={notification.filename}
                        changeType={notification.changeType}
                        onClose={() => setNotification(null)}
                        onReview={handleRequestReview}
                    />
                )}

                {config.stagedFiles && config.stagedFiles.length > 0 && (
                    <div className="global-diff-banner" style={{ background: 'var(--vscode-editorWarning-background)', padding: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '10px', borderRadius: '4px' }}>
                        <div>
                            <span style={{ fontWeight: 'bold' }}>{config.stagedFiles.length} file{config.stagedFiles.length > 1 ? 's' : ''} staged for review</span>
                        </div>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button className="approval-btn yes" onClick={() => vscode.postMessage({ type: 'acceptAllDiffs', timestamp: Date.now() })}>✅ Accept All</button>
                            <button className="approval-btn no" onClick={() => vscode.postMessage({ type: 'rejectAllDiffs' })}>❌ Reject All</button>
                        </div>
                    </div>
                )}

                <ChatContainer 
                    messages={messages} 
                    isTyping={isTyping}
                    statusText={statusText}
                    showThinking={config.showThinking !== false}
                    onStop={handleCancel}
                    onAction={handleSendAction}
                    onDiffAction={handleDiffAction}
                />

                {isTyping && (
                    <div className="activity-status-bar">
                        <div className="activity-status-left">
                            <span className="activity-status-label">🧬 Activity:</span>
                            <span className="activity-status-text">{statusText}</span>
                        </div>
                        <button className="cancel-btn" onClick={handleCancel}>Cancel</button>
                    </div>
                )}

                <div className="input-container">
                    <SettingsPanel
                        config={config}
                        setConfig={setConfig}
                        availableModels={availableModels}
                        managedFiles={managedFiles}
                        detectedFiles={detectedFiles}
                        onSave={handleSaveConfig}
                        disabled={isInitialLoad}
                    />
                    <StatsBar
                        provider={config.provider || 'openrouter'}
                        model={config.model || ''}
                        inputTokens={usageStats.inputTokens}
                        outputTokens={usageStats.outputTokens}
                        totalTokens={usageStats.totalTokens}
                        contextLimit={usageStats.contextLimit}
                        isTyping={isTyping}
                    />
                    <InputBar onSend={handleSendAction} isTyping={isTyping} disabled={isInitialLoad} />
                </div>
            </div>
        </>
    );
};

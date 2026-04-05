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
    const [detectedFiles, setDetectedFiles] = useState<{ compose?: string, config?: string }>(savedState.detectedFiles || {});
    
    // Lifecycle Tracking
    const [isInitialLoad, setIsInitialLoad] = useState(!savedState.config);
    const [isTyping, setIsTyping] = useState(false);
    const [statusText, setStatusText] = useState('');
    const [notification, setNotification] = useState<{ filename: string, changeType: string } | null>(null);
    const [toast, setToast] = useState<string | null>(null);

    // Message Handler
    useEffect(() => {
        const messageHandler = (event: MessageEvent) => {
            const m = event.data;
            if (!m || !m.type) return;

            switch (m.type) {
                case 'addMessage':
                    const validRoles = ['user', 'agent', 'assistant', 'ui-diff'];
                    if (!validRoles.includes(m.role)) {
                        console.log(`[UI] Ignoring internal message role: ${m.role}`);
                        return;
                    }

                    if (m.role === 'user') {
                        setMessages(prev => [...prev, {
                            role: 'user',
                            content: m.content || '',
                            className: m.className
                        }]);
                        return;
                    }

                    if (m.role === 'agent' || m.role === 'assistant') {
                        setIsTyping(false);
                        setStatusText('');
                        
                        setMessages(prev => {
                            const content = m.content || '';
                            const cleanContent = content.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();

                            if (cleanContent) {
                                return [...prev, {
                                    role: 'agent',
                                    content: cleanContent,
                                    className: m.className,
                                    lastUsage: m.lastUsage
                                }];
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
                        const validRoles = ['user', 'agent', 'assistant', 'ui-diff'];
                        
                        setMessages(m.history
                            .filter((msg: any) => {
                                const role = msg?.role;
                                const content = typeof msg.content === 'string' ? msg.content : '';
                                
                                if (!validRoles.includes(role)) return false;
                                
                                // Detect stringified JSON logs stored in content
                                if (content.trim().startsWith('[') || content.trim().startsWith('{')) {
                                    if (content.includes('"role":"') || content.includes('"toolCall"')) {
                                        return false;
                                    }
                                }

                                if (!content.trim()) return false;
                                return true;
                            })
                            .map((msg: any) => ({
                                role: msg.role === 'assistant' ? 'agent' : msg.role,
                                content: msg.content,
                                complete: true,
                                startTime: msg.startTime || Date.now(),
                                endTime: msg.endTime || Date.now(),
                                lastUsage: msg.lastUsage
                            }))
                        );
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
        vscode.postMessage({ type: 'prompt', value: text });
    }, [vscode]);

    const handleRequestReview = useCallback((filename: string) => {
        setIsTyping(true);
        setStatusText(`Agent is analyzing diffs for ${filename}...`);
        vscode.postMessage({ type: 'requestReview', filename });
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

                <ChatContainer 
                    messages={messages} 
                    isTyping={isTyping}
                    statusText={statusText}
                    onStop={handleCancel}
                    onAction={handleSendAction}
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

import React, { useEffect, useRef, useState } from 'react';
import { getVsCodeApi } from '../vscode-api';

interface SettingsPanelProps {
    config: any;
    setConfig: (c: any) => void;
    availableModels: string[];
    managedFiles: string[];
    detectedFiles: any;
    onSave: (config: any) => void;
    disabled?: boolean;
}

// Static section separator - always visible
const Section: React.FC<{ title: string; icon: string; children: React.ReactNode }> = ({
    title, icon, children
}) => (
    <div style={{
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '8px',
        overflow: 'hidden',
        marginBottom: '6px',
        background: 'rgba(255,255,255,0.01)',
        flexShrink: 0
    }}>
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '9px 12px',
            background: 'rgba(255,255,255,0.03)',
            fontSize: '11px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            color: '#ccc'
        }}>
            <span>{icon}</span>
            <span>{title}</span>
        </div>
        <div style={{
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            borderTop: '1px solid rgba(255,255,255,0.04)'
        }}>
            {children}
        </div>
    </div>
);

const SubLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{
        fontSize: '9px',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.7px',
        color: '#F51A56',
        marginTop: '4px',
        marginBottom: '2px',
        paddingBottom: '4px',
        borderBottom: '1px solid rgba(245,26,86,0.15)'
    }}>{children}</div>
);

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ 
    config, 
    setConfig, 
    availableModels, 
    managedFiles, 
    detectedFiles,
    onSave,
    disabled
}) => {
    const vscode = getVsCodeApi();
    const [localConfig, setLocalConfig] = useState({ showThinking: true, ...config });
    const [hasChanges, setHasChanges] = useState(false);
    const [showModelDropdown, setShowModelDropdown] = useState(false);
    const [modelSearch, setModelSearch] = useState('');
    const [isOpen, setIsOpen] = useState(false);
    const modelInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { setLocalConfig(config); }, [config]);

    useEffect(() => {
        const changed = Object.keys(localConfig).some(key =>
            String(localConfig[key]) !== String(config[key])
        );
        setHasChanges(changed);
    }, [localConfig, config]);

    const handleChange = (key: string, value: any) =>
        setLocalConfig((prev: any) => ({ ...prev, [key]: value }));

    const handleModelSelect = (mId: string) => {
        handleChange('model', mId);
        setModelSearch(mId);
        setShowModelDropdown(false);
    };

    const filteredModels = availableModels.filter(m =>
        m.toLowerCase().includes(modelSearch.toLowerCase())
    );

    const row = (label: string, el: React.ReactNode) => (
        <div className="settings-row">
            <label>{label}</label>
            {el}
        </div>
    );

    return (
        <details 
            className={`settings-container ${disabled ? 'disabled' : ''}`} 
            open={isOpen}
            onToggle={(e) => setIsOpen((e.target as HTMLDetailsElement).open)}
        >
            <summary style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
                <span>Configuration Settings</span>
                <span className="toggle-icon">▼</span>
            </summary>
            <div className="settings-panel">

                {/* ── 1. AGENT SETTINGS ── */}
                <Section title="Agent Settings" icon="🤖">
                    {row('LLM Provider',
                        <select value={localConfig.provider || 'openrouter'} disabled={disabled}
                            onChange={e => { handleChange('provider', e.target.value); vscode.postMessage({ type: 'fetchModels', provider: e.target.value }); }}>
                            <option value="openrouter">OpenRouter</option>
                            <option value="gemini">Gemini</option>
                        </select>
                    )}

                    <div className="settings-row">
                        <label>Model</label>
                        <div style={{ display: 'flex', gap: '4px', flex: 1, position: 'relative' }}>
                            <input
                                ref={modelInputRef}
                                type="text"
                                value={modelSearch || localConfig.model || ''}
                                placeholder="Search or type model ID..."
                                style={{ flex: 1 }}
                                disabled={disabled}
                                onChange={e => { setModelSearch(e.target.value); handleChange('model', e.target.value); setShowModelDropdown(true); }}
                                onFocus={() => setShowModelDropdown(true)}
                                onBlur={() => setTimeout(() => setShowModelDropdown(false), 200)}
                            />
                            {showModelDropdown && filteredModels.length > 0 && (
                                <div style={{ position: 'absolute', top: '100%', left: 0, width: '100%', zIndex: 1000, background: 'var(--vscode-dropdown-background)', border: '1px solid var(--vscode-dropdown-border)', borderRadius: '4px', maxHeight: '160px', overflowY: 'auto' }}>
                                    {filteredModels.slice(0, 50).map(mId => (
                                        <div key={mId} style={{ padding: '5px 10px', cursor: 'pointer', fontSize: '11px' }}
                                            onMouseDown={() => handleModelSelect(mId)}>{mId}</div>
                                    ))}
                                </div>
                            )}
                            <button disabled={disabled} title="Refresh Models"
                                style={{ background: 'var(--vscode-button-secondaryBackground)', padding: '4px 8px', fontSize: '10px', border: 'none', borderRadius: '4px', cursor: disabled ? 'not-allowed' : 'pointer' }}
                                onClick={() => vscode.postMessage({ type: 'fetchModels', provider: localConfig.provider })}>🔄</button>
                        </div>
                    </div>

                    {(localConfig.provider === 'openrouter' || !localConfig.provider) && row('OpenRouter Key',
                        <input disabled={disabled} type="password" value={localConfig.openRouterApiKey || ''}
                            onChange={e => handleChange('openRouterApiKey', e.target.value)} />
                    )}
                    {localConfig.provider === 'gemini' && row('Gemini Key',
                        <input disabled={disabled} type="password" value={localConfig.geminiApiKey || ''}
                            onChange={e => handleChange('geminiApiKey', e.target.value)} />
                    )}

                    <SubLabel>Agent Limits</SubLabel>
                    {row('Max Model Calls', <input type="number" value={localConfig.modelCallLimit || 10} disabled={disabled} onChange={e => handleChange('modelCallLimit', parseInt(e.target.value))} />)}
                    {row('Max Tool Calls', <input type="number" value={localConfig.toolCallLimit || 10} disabled={disabled} onChange={e => handleChange('toolCallLimit', parseInt(e.target.value))} />)}
                    {row('Max Recursion Limit', <input type="number" value={localConfig.recursionLimit || 50} disabled={disabled} onChange={e => handleChange('recursionLimit', parseInt(e.target.value))} />)}
                    {row('Max Context', <input type="number" value={localConfig.maxContext || 130000} disabled={disabled} onChange={e => handleChange('maxContext', parseInt(e.target.value))} />)}
                    {row('Timeout (s)', <input type="number" value={localConfig.maxAgentTimeout || 100} disabled={disabled} onChange={e => handleChange('maxAgentTimeout', parseInt(e.target.value))} />)}
                    
                    <div className="settings-row">
                        <label style={{ width: '80px' }}></label>
                        <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', flex: 1 }}>
                            <input type="checkbox" checked={localConfig.showThinking !== false} onChange={e => handleChange('showThinking', e.target.checked)} disabled={disabled} />
                            🧠 Show Thinking Logs
                        </label>
                    </div>
                </Section>

                {/* ── 1.5 OBSERVABILITY ── */}
                <Section title="Observability" icon="🔭">
                    <div className="settings-row">
                        <label style={{ width: '80px' }}></label>
                        <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', flex: 1 }}>
                            <input type="checkbox" checked={localConfig.langChainTracing === true} onChange={e => handleChange('langChainTracing', e.target.checked)} disabled={disabled} />
                            🚀 Enable LangSmith Tracing
                        </label>
                    </div>
                    {row('Smith API Key',
                        <input disabled={disabled || !localConfig.langChainTracing} type="password" value={localConfig.langSmithApiKey || ''}
                            placeholder={localConfig.langChainTracing ? "Paste API Key..." : "Tracing Disabled"}
                            onChange={e => handleChange('langSmithApiKey', e.target.value)} />
                    )}
                    {row('Project Name',
                        <input disabled={disabled || !localConfig.langChainTracing} type="text" value={localConfig.langSmithProject || 'kong-gateway-agent'}
                            onChange={e => handleChange('langSmithProject', e.target.value)} />
                    )}
                    {row('Endpoint',
                        <input disabled={disabled || !localConfig.langChainTracing} type="text" value={localConfig.langSmithEndpoint || 'https://api.smith.langchain.com'}
                            onChange={e => handleChange('langSmithEndpoint', e.target.value)} />
                    )}
                </Section>

                {/* ── 2. KONG GATEWAY SETTINGS ── */}
                <Section title="Kong Gateway" icon="🦍">
                    {row('Mode',
                        <select disabled={disabled} value={localConfig.kongMode || 'local'} onChange={e => handleChange('kongMode', e.target.value)}>
                            <option value="local">Local (Docker)</option>
                            <option value="remote">Remote (URL)</option>
                        </select>
                    )}

                    {(localConfig.kongMode === 'local' || !localConfig.kongMode) ? (
                        <div className="ports-grid">
                            <div className="port-card"><label>Admin Port</label><input type="number" value={localConfig.adminApiPort || 8001} onChange={e => handleChange('adminApiPort', parseInt(e.target.value))} disabled={disabled} /></div>
                            <div className="port-card"><label>Manager Port</label><input type="number" value={localConfig.managerGuiPort || 8002} onChange={e => handleChange('managerGuiPort', parseInt(e.target.value))} disabled={disabled} /></div>
                            <div className="port-card"><label>Proxy Port</label><input type="number" value={localConfig.proxyPort || 8000} onChange={e => handleChange('proxyPort', parseInt(e.target.value))} disabled={disabled} /></div>
                            <div className="port-card"><label>Postgres Port</label><input type="number" value={localConfig.databasePort || 5432} onChange={e => handleChange('databasePort', parseInt(e.target.value))} disabled={disabled} /></div>
                        </div>
                    ) : (
                        <>
                            {row('Admin URL', <input type="text" value={localConfig.remoteAdminApiUrl || ''} onChange={e => handleChange('remoteAdminApiUrl', e.target.value)} disabled={disabled} />)}
                            {row('Proxy URL', <input type="text" value={localConfig.remoteProxyBaseUrl || ''} onChange={e => handleChange('remoteProxyBaseUrl', e.target.value)} disabled={disabled} />)}
                            {row('Manager URL', <input type="text" value={localConfig.remoteManagerGuiUrl || ''} onChange={e => handleChange('remoteManagerGuiUrl', e.target.value)} disabled={disabled} />)}
                        </>
                    )}

                    <SubLabel>Auth & Security</SubLabel>
                    {row('Workspace', <input type="text" value={localConfig.kongWorkspace || 'default'} onChange={e => handleChange('kongWorkspace', e.target.value)} disabled={disabled} />)}
                    {row('Admin Token', <input type="password" value={localConfig.kongAdminToken || ''} onChange={e => handleChange('kongAdminToken', e.target.value)} disabled={disabled} />)}
                    <div className="settings-row">
                        <label style={{ width: '80px' }}></label>
                        <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', flex: 1 }}>
                            <input type="checkbox" checked={localConfig.skipTlsVerify === true} onChange={e => handleChange('skipTlsVerify', e.target.checked)} disabled={disabled} />
                            🛡️ Skip TLS Verification
                        </label>
                    </div>

                    <button style={{ background: 'var(--vscode-button-secondaryBackground)', color: 'white', border: 'none', borderRadius: '6px', padding: '6px', cursor: 'pointer', fontSize: '10px', marginTop: '4px' }}
                        onClick={() => vscode.postMessage({ type: 'checkPorts', ...localConfig })}>
                        🔍 Check Local Ports
                    </button>
                </Section>

                {/* ── 3. LOCAL WORKSPACE ── */}
                <Section title="Local Workspace" icon="📁">
                    <div className="settings-row">
                        <label>Workspace Path</label>
                        <div style={{ display: 'flex', gap: '4px', flex: 1 }}>
                            <input type="text" value={localConfig.storagePath || ''} readOnly style={{ flex: 1 }} />
                            <button disabled={disabled}
                                style={{ background: 'var(--vscode-button-secondaryBackground)', padding: '4px 8px', fontSize: '10px', border: 'none', borderRadius: '4px', cursor: disabled ? 'not-allowed' : 'pointer' }}
                                onClick={() => vscode.postMessage({ type: 'selectFolder' })}>Browse</button>
                        </div>
                    </div>

                    <SubLabel>Managed Files</SubLabel>
                    <div id="file-list">
                        {managedFiles.length > 0 ? managedFiles.map(f => (
                            <div key={f} className="file-item">
                                <span className="file-name">{f}</span>
                                {detectedFiles?.compose === f && <span className="file-tag tag-compose">Docker Compose</span>}
                                {detectedFiles?.config === f && <span className="file-tag tag-config">Kong Config</span>}
                                {detectedFiles?.ruleset === f && <span className="file-tag tag-ruleset">Ruleset</span>}
                                <button className="open-file-btn" onClick={() => vscode.postMessage({ type: 'openFile', filename: f })}>Open</button>
                            </div>
                        )) : (
                            <div style={{ padding: '10px', textAlign: 'center', color: 'var(--vscode-descriptionForeground)', fontSize: '11px' }}>
                                No configuration files found in storage path.
                            </div>
                        )}
                    </div>
                </Section>

                {/* ── 4. GITOPS ── */}
                <Section title="GitOps" icon="🔀">
                    {row('Remote URL', <input type="password" value={localConfig.gitRemoteUrl || ''} onChange={e => handleChange('gitRemoteUrl', e.target.value)} disabled={disabled} />)}
                    <div className="settings-row">
                        <label style={{ width: '80px' }}></label>
                        <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', flex: 1 }}>
                            <input type="checkbox" checked={localConfig.autoCommit === true} onChange={e => handleChange('autoCommit', e.target.checked)} disabled={disabled} />
                            🔄 Auto-Commit Changes
                        </label>
                    </div>
                </Section>

                {/* Save / Reset */}
                <button
                    disabled={!hasChanges}
                    style={{ width: '100%', background: 'var(--accent)', color: 'white', border: 'none', borderRadius: '8px', padding: '8px', cursor: hasChanges ? 'pointer' : 'not-allowed', fontSize: '11px', fontWeight: 600, opacity: hasChanges ? 1 : 0.5, marginTop: '4px' }}
                    onClick={() => { onSave(localConfig); setHasChanges(false); setIsOpen(false); }}
                >
                    {hasChanges ? 'Save Configuration' : 'No Changes to Save'}
                </button>
                <button className="reset-btn" onClick={() => vscode.postMessage({ type: 'resetConfig' })}>Reset Settings to Default</button>
            </div>
        </details>
    );
};

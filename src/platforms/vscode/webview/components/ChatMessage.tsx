import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { getVsCodeApi } from '../vscode-api';

interface Message {
    role: string;
    content: string;
    reasoning?: string;
    className?: string;
    lastUsage?: any;
    complete?: boolean;
    cancelled?: boolean;
    startTime?: number;
    endTime?: number;
    showThinking?: boolean;
}

interface ChatMessageProps extends Message {
    onAction: (text: string) => void;
    onDiffAction: (action: 'accept' | 'reject', filename: string) => void;
    toolInteractions?: any[];
}

const ToolInteraction: React.FC<{ interaction: any }> = ({ interaction }) => {
    const [isExpanded, setIsExpanded] = React.useState(false);
    const resultStr = interaction.result?.toLowerCase() || '';
    const isSafetyGated = resultStr.includes('safety_required');
    const isError = resultStr.includes('error') || resultStr.includes('failed');
    const isSuccess = !isError && !isSafetyGated && interaction.status === 'completed';

    return (
        <div className={`tool-interaction ${interaction.status} ${isExpanded ? 'expanded' : ''} ${isSafetyGated ? 'gated' : ''}`}>
            <div className="tool-interaction-header" onClick={() => setIsExpanded(!isExpanded)} title="Click to view arguments and result">
                <i className={`codicon codicon-${isSafetyGated ? 'shield' : isSuccess ? 'pass' : isError ? 'error' : 'sync'}`}></i>
                <div className="tool-info">
                    <span className="tool-name">{interaction.name || 'Executing Tool...'}</span>
                    <span className={`tool-status-badge ${isSafetyGated ? 'gated' : isSuccess ? 'success' : isError ? 'error' : interaction.status}`}>
                        {interaction.status === 'started' ? 'RUNNING' : isSafetyGated ? 'BLOCKED' : isSuccess ? 'SUCCESS' : 'FAILED'}
                    </span>
                </div>
                <i className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} style={{ marginLeft: 'auto', fontSize: '10px' }}></i>
            </div>
            {isExpanded && (
                <div className="tool-interaction-details">
                    {interaction.args && Object.keys(interaction.args).length > 0 && (
                        <div className="tool-args">
                            <div className="tool-detail-label">Arguments</div>
                            <pre>{JSON.stringify(interaction.args, null, 2)}</pre>
                        </div>
                    )}
                    {interaction.result && (
                        <div className="tool-result">
                            <div className="tool-detail-label">Result</div>
                            <pre>{interaction.result}</pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export const ChatMessage: React.FC<ChatMessageProps> = ({ role, content, reasoning, toolInteractions, className, lastUsage, complete, cancelled, startTime, endTime, showThinking, onAction, onDiffAction }) => {
    const vscode = getVsCodeApi();
    const [isReasoningExpanded, setIsReasoningExpanded] = React.useState(true);

    let displayContent = content;
    let displayReasoning = reasoning || "";

    // Fallback: Extract from content if not explicitly separated
    if (displayContent.includes('<thought>')) {
        const parts = displayContent.split(/<thought>|<\/thought>/);
        if (parts.length >= 2) {
            // parts[0] = before, parts[1] = reasoning, parts[2] = after
            displayReasoning = parts[1].trim();
            // Collect everything else as main content
            const before = parts[0] || "";
            const after = parts.slice(2).join(" ") || "";
            displayContent = (before + after).trim();
        }
    } else if (toolInteractions && toolInteractions.length > 0 && !displayReasoning.trim() && displayContent.trim()) {
        // Fallback: If this is a tool-call turn with no explicit reasoning, but it has content,
        // assume the content is actually preamble/reasoning that leaked.
        displayReasoning = displayContent;
        displayContent = "";
    }

    // Logic to detect approval requirements
    let hasApproval = false;
    if (displayContent.includes('[APPROVAL_REQUIRED]')) {
        hasApproval = true;
        displayContent = displayContent.replace('[APPROVAL_REQUIRED]', '').trim();
    }
    
    // Prevent reasoning box leakage for strict tool interactions
    if (toolInteractions && toolInteractions.length > 0 && !displayReasoning.trim() && !displayContent.trim()) {
        hasApproval = false;
    }

    const stagedFilenames: string[] = [];
    
    // First try extracting from the agent's content if it echoed it
    const stagedMatches = displayContent.matchAll(/\[STAGED_FILE_EDIT:([^\]]+)\]/g);
    for (const match of stagedMatches) {
        if (!stagedFilenames.includes(match[1])) stagedFilenames.push(match[1]);
        displayContent = displayContent.replace(match[0], '').trim();
    }

    // If not found in content, check the tool interactions directly
    if (toolInteractions) {
        for (const ti of toolInteractions) {
            if (ti.name === 'write_storage_file' && ti.result && ti.result.includes('[STAGED_FILE_EDIT:')) {
                const matches = ti.result.matchAll(/\[STAGED_FILE_EDIT:([^\]]+)\]/g);
                for (const match of matches) {
                    if (!stagedFilenames.includes(match[1])) stagedFilenames.push(match[1]);
                }
            }
        }
    }

    // Interactive "Next Steps" Handlers from legacy
    const handleActionClick = (e: React.MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'LI' || target.parentElement?.tagName === 'LI') {
            const li = target.tagName === 'LI' ? target : target.parentElement!;
            const boldPart = li.querySelector('strong');
            const promptText = boldPart ? boldPart.innerText : li.innerText.split(':')[0];
            onAction(promptText.trim());
        }
    };

    const elapsedTime = startTime && endTime ? ((endTime - startTime) / 1000).toFixed(1) : null;
    const toolCount = toolInteractions?.length || lastUsage?.toolCalls || 0;

    if (!displayContent.trim() && !displayReasoning.trim() && !hasApproval && (!toolInteractions || toolInteractions.length === 0) && role === 'agent') return null;

    const isSystemError = displayContent.toLowerCase().startsWith('error') || displayContent.toLowerCase().includes('failed:');

    return (
        <div className={`message ${role} ${className || ''} ${isSystemError ? 'error-message' : ''}`} onClick={handleActionClick}>
            
            {showThinking && (displayReasoning || (toolInteractions && toolInteractions.length > 0) || (!complete && role === 'agent')) && (
                <div className={`reasoning-container ${!complete && role === 'agent' ? 'thinking' : ''}`}>
                    <div className="reasoning-header" onClick={() => setIsReasoningExpanded(!isReasoningExpanded)}>
                        <div className="reasoning-title">
                            <i className="codicon codicon-beaker"></i>
                            {(!displayReasoning && toolInteractions && toolInteractions.length > 0) ? 'Diagnostic Activity' : (complete ? 'Reasoning' : 'Thinking...')}
                            {elapsedTime && (
                                <span className="performance-stats">
                                    {elapsedTime}s | {toolCount} tool{toolCount !== 1 ? 's' : ''}
                                </span>
                            )}
                        </div>
                        <i className={`codicon codicon-chevron-${isReasoningExpanded ? 'down' : 'right'}`} style={{ marginLeft: 'auto', fontSize: '10px' }}></i>
                    </div>
                    {isReasoningExpanded && (
                        <div className="reasoning-content">
                            {displayReasoning && (
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {displayReasoning}
                                </ReactMarkdown>
                            )}
                            {!complete && !displayContent && (
                                <span className="typing-cursor"></span>
                            )}
                            {toolInteractions && toolInteractions.length > 0 && (
                                <div className="tool-interactions-list">
                                    {toolInteractions.map((ti, idx) => (
                                        <ToolInteraction key={ti.id || idx} interaction={ti} />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    code({ node, inline, className, children, ...props }: any) {
                        const match = /language-(\w+)/.exec(className || '');
                        const lang = match ? match[1] : '';

                        if (!inline && lang) {
                            return (
                                <SyntaxHighlighter
                                    style={vscDarkPlus}
                                    language={lang}
                                    PreTag="div"
                                    {...props}
                                >
                                    {children ? String(children).replace(/\n$/, '') : ''}
                                </SyntaxHighlighter>
                            );
                        }

                        return (
                            <code className={className} {...props}>
                                {children}
                            </code>
                        );
                    }
                }}
            >
                {displayContent}
            </ReactMarkdown>
            
            {!complete && role === 'agent' && (displayContent || !displayReasoning) && (
                <span className="typing-cursor"></span>
            )}

            {hasApproval && (
                <div className="approval-container">
                    <button className="approval-btn yes" onClick={() => onAction('Yes')}>
                        ✅ Yes, Proceed
                    </button>
                    <button className="approval-btn no" onClick={() => onAction('No, cancel this change.')}>
                        ❌ No, Cancel
                    </button>
                </div>
            )}

            {stagedFilenames.map(filename => (
                <div key={filename} className="approval-container staged-diff">
                    <button className="approval-btn yes" onClick={() => onDiffAction('accept', filename)}>
                        ✅ Accept {filename}
                    </button>
                    <button className="approval-btn no" onClick={() => onDiffAction('reject', filename)}>
                        ❌ Reject
                    </button>
                </div>
            ))}

            {lastUsage && (role === 'agent' || role === 'assistant') && (
                <span className="message-usage-badge" title="Turn activity & token cost">
                    <span className="usage-item">{toolCount} TC</span>
                    <span className="usage-divider">|</span>
                    <span className="usage-item"> {lastUsage?.inputTokens || 0} IN</span>
                    <span className="usage-divider">|</span>
                    <span className="usage-item">{lastUsage?.outputTokens || 0} OUT</span>
                </span>
            )}
        </div>
    );
};

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { getVsCodeApi } from '../vscode-api';

interface Message {
    role: string;
    content: string;
    className?: string;
    lastUsage?: any;
    complete?: boolean;
    cancelled?: boolean;
    startTime?: number;
    endTime?: number;
}

interface ChatMessageProps extends Message {
    onAction: (text: string) => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ role, content, className, lastUsage, complete, cancelled, startTime, endTime, onAction }) => {
    const vscode = getVsCodeApi();

    let displayContent = content;

    // Logic to detect approval requirements
    let hasApproval = false;
    if (displayContent.includes('[APPROVAL_REQUIRED]')) {
        hasApproval = true;
        displayContent = displayContent.replace('[APPROVAL_REQUIRED]', '').trim();
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

    if (!displayContent.trim() && !hasApproval && role === 'agent') return null;

    const isSystemError = displayContent.toLowerCase().startsWith('error') || displayContent.toLowerCase().includes('failed:');

    return (
        <div className={`message ${role} ${className || ''} ${isSystemError ? 'error-message' : ''}`} onClick={handleActionClick}>

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

            {lastUsage && (role === 'agent' || role === 'assistant') && (
                <span className="message-usage-badge" title="Turn activity & token cost">
                    <span className="usage-item">{lastUsage?.toolCalls || 0} TC</span>
                    <span className="usage-divider">|</span>
                    <span className="usage-item"> {lastUsage?.inputTokens || 0} IN</span>
                    <span className="usage-divider">|</span>
                    <span className="usage-item">{lastUsage?.outputTokens || 0} OUT</span>
                </span>
            )}
        </div>
    );
};

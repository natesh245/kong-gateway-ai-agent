import React from 'react';

interface StatsBarProps {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextLimit?: number;
    isTyping: boolean;
}

export const StatsBar: React.FC<StatsBarProps> = ({ 
    provider, 
    model, 
    inputTokens, 
    outputTokens, 
    totalTokens,
    contextLimit,
    isTyping
}) => {
    
    const formatTokens = (num: number) => {
        if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
        return num.toString();
    };

    const usagePercent = contextLimit ? Math.min(100, Math.max(0, (totalTokens / contextLimit) * 100)) : 0;
    
    const getContextPillStyle = () => {
        if (usagePercent > 90) return { borderColor: '#f44747' };
        if (usagePercent > 70) return { borderColor: '#d7ba7d' };
        return { borderColor: 'rgba(255, 255, 255, 0.05)' };
    };

    return (
        <div className="model-selector-bar" id="quick-model-bar">
            <div 
                className="provider-badge" 
                style={{ background: provider === 'openrouter' ? 'var(--accent)' : '#4ec9b0' }}
            >
                {provider === 'openrouter' ? 'OpenRouter' : 'Gemini'}
            </div>
            <span className="model-info">{model || 'No Model Selected'}</span>
            <div className="stats-container">
                <span title="Prompt Tokens">In: <span>{formatTokens(inputTokens)}</span></span>
                <span title="Completion Tokens">Out: <span>{formatTokens(outputTokens)}</span></span>
                {contextLimit && (
                    <span title="Context Usage" className="context-pill" style={getContextPillStyle()}>
                        Context: <span>{usagePercent.toFixed(usagePercent < 1 ? 1 : 0)}</span>%
                    </span>
                )}
            </div>
            <div className={`status-indicator ${isTyping ? 'thinking' : ''}`} title={isTyping ? 'Agent Thinking...' : 'Agent Ready'}>
                ●
            </div>
        </div>
    );
};

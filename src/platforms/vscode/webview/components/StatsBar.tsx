import React from 'react';

interface StatsBarProps {
    provider: string;
    model: string;
    usage: {
        session: {
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
        };
        context: {
            occupied: number;
            limit: number;
            percent: number;
        };
    };
    isTyping: boolean;
}

export const StatsBar: React.FC<StatsBarProps> = ({ 
    provider, 
    model, 
    usage,
    isTyping
}) => {
    
    const formatTokens = (num: number) => {
        if (!num || num < 0) return '0';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
        return num.toString();
    };

    const usagePercent = usage?.context?.percent || 0;
    
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
                <span title="Cumulative Session Input">Session In: <span>{formatTokens(usage?.session?.inputTokens)}</span></span>
                <span title="Cumulative Session Output">Session Out: <span>{formatTokens(usage?.session?.outputTokens)}</span></span>
                {usage?.context?.limit > 0 && (
                    <span title={`Context Usage: ${usage?.context?.occupied || 0} / ${usage?.context?.limit} tokens`} className="context-pill" style={getContextPillStyle()}>
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

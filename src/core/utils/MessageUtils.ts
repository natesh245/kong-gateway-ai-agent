import { IMessage } from '../interfaces/ICoreInterfaces';

/**
 * Shared utility for processing and cleaning chat messages.
 */
export class MessageUtils {
    /**
     * Filters and cleans message history for the LLM or UI.
     * Removes the internal 'thinking' role and strips thought tags.
     */
    static processHistory(history: any[]): IMessage[] {
        if (!history || !Array.isArray(history)) return [];
        
        return history
            .filter((msg: any) => {
                const role = msg?.role;
                if (!role || role === 'system' || role === 'thinking' || role === 'thought' || role === 'tool' || role === 'toolStatus' || role === 'toolCall' || role === 'toolResult' || role === 'ui-diff') {
                    // Allow our special internal UI role
                    if (role !== 'off-topic') return false;
                }
                
                const content = typeof msg.content === 'string' ? msg.content : '';
                
                // New: Detect and filter stringified internal log JSONs in content
                if (this.isInternalJson(content)) {
                    return false;
                }

                // Skip assistant messages with no content (they usually only contain tool calls)
                if ((role === 'assistant' || role === 'agent') && !content.trim()) {
                    return false;
                }
                return true;
            })
            .map((msg: any) => {
                let content = typeof msg.content === 'string' ? msg.content : '';
                
                // 1. Strip internal context from user/agent messages
                content = content.replace(/\[ENVIRONMENT CONTEXT:[\s\S]*?\]\n\n?/gi, '').trim();
                
                // 2. Wrap/Strip any remaining thought tags
                content = this.stripThoughts(content);

                return {
                    role: (msg.role === 'assistant') ? 'agent' : (msg.role === 'off-topic' ? 'agent' : msg.role),
                    content,
                    lastUsage: msg.lastUsage
                };
            });
    }

    /**
     * Detects if a string is a JSON representation of an internal message/log.
     */
    private static isInternalJson(content: string): boolean {
        if (!content || !content.trim().startsWith('[') && !content.trim().startsWith('{')) return false;
        
        const trimmed = content.trim();
        // Look for characteristic patterns of internal role structures in the stringified content
        return (
            trimmed.includes('"role":"thought"') || 
            trimmed.includes('"role":"toolCall"') || 
            trimmed.includes('"role":"toolResult"') ||
            trimmed.includes('"role":"tool"') ||
            trimmed.includes('"role":"thinking"')
        );
    }

    /**
     * Removes <thought> tags from content strings.
     */
    static stripThoughts(content: string): string {
        if (typeof content !== 'string') return content;
        return content.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
    }
}

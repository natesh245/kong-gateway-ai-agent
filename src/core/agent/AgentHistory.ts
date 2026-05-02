import {
    BaseMessage,
    HumanMessage,
    AIMessage,
    SystemMessage,
    ToolMessage,
} from "@langchain/core/messages";
import { SanitizationUtil } from "../utils/SanitizationUtil";

export class AgentHistory {
    /**
     * Converts LangChain BaseMessages into the simplified JSON format used by the UI.
     */
    public static toUI(messages: BaseMessage[]): any[] {
        const result: any[] = [];

        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];

            if (m instanceof SystemMessage) {
                result.push({ role: 'system', content: m.content });
            } else if (m instanceof HumanMessage) {
                result.push({ role: 'user', content: m.content });
            } else if (m instanceof AIMessage) {
                // Sanitization: Strip any JSON chunks that accidentally leaked into the content string
                let cleanContent = typeof m.content === 'string' ? m.content : "";
                if (cleanContent.includes('[{"') || cleanContent.includes('{"id":')) {
                    cleanContent = cleanContent.replace(/\[\s*{\s*"id":[\s\S]*\]\s*$/, '').trim();
                }

                const res: any = {
                    role: 'assistant',
                    content: cleanContent,
                    reasoning: (m.additional_kwargs as any)?.reasoning || (m.additional_kwargs as any)?.reasoning_content || (m as any).reasoning || "",
                    lastUsage: (m.additional_kwargs as any)?.lastUsage || null,
                    startTime: (m.additional_kwargs as any)?.startTime || null,
                    endTime: (m.additional_kwargs as any)?.endTime || null,
                    toolInteractions: []
                };

                // Look ahead for tool messages belonging to this assistant turn
                if (m.tool_calls && m.tool_calls.length > 0) {
                    res.tool_calls = m.tool_calls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: JSON.stringify(tc.args) }
                    }));

                    const remainingIds = new Set(m.tool_calls.map(tc => tc.id));
                    for (let j = i + 1; j < messages.length && remainingIds.size > 0; j++) {
                        const nextMsg = messages[j];
                        if (nextMsg instanceof ToolMessage) {
                            const matchingCall = m.tool_calls.find(tc => tc.id === nextMsg.tool_call_id);
                            if (matchingCall && remainingIds.has(nextMsg.tool_call_id)) {
                                res.toolInteractions.push({
                                    id: nextMsg.tool_call_id,
                                    name: matchingCall.name,
                                    args: matchingCall.args,
                                    result: nextMsg.content,
                                    status: 'completed'
                                });
                                remainingIds.delete(nextMsg.tool_call_id);
                            }
                        } else if (nextMsg instanceof AIMessage || nextMsg instanceof HumanMessage) {
                            break;
                        }
                    }
                }
                result.push(res);
            }
        }
        return result;
    }

    /**
     * Converts UI message history back into LangChain BaseMessages.
     */
    public static fromUI(messages: any[], systemPrompt: string): BaseMessage[] {
        const lcMessages: BaseMessage[] = [new SystemMessage(systemPrompt)];

        for (const m of messages) {
            if (m.role === 'system') continue;

            if (m.role === 'user') {
                lcMessages.push(new HumanMessage(m.content));
            } else if (m.role === 'assistant' || m.role === 'agent') {
                let cleanContent = m.content || "";
                
                if (cleanContent.includes("SAFETY_REQUIRED:")) {
                    cleanContent = "";
                }

                const aiMsg = new AIMessage({
                    content: cleanContent,
                    additional_kwargs: {
                        reasoning: m.reasoning || "",
                        lastUsage: m.lastUsage,
                        startTime: m.startTime,
                        endTime: m.endTime
                    },
                    tool_calls: m.tool_calls?.map((tc: any) => ({
                        id: tc.id,
                        name: tc.name || (tc.function?.name),
                        args: tc.args || (tc.function?.arguments ? JSON.parse(tc.function.arguments) : {})
                    }))
                });
                lcMessages.push(aiMsg);

                if (m.toolInteractions && Array.isArray(m.toolInteractions)) {
                    for (const interaction of m.toolInteractions) {
                        if (!interaction.id) continue;
                        
                        lcMessages.push(new ToolMessage({
                            id: interaction.id,
                            name: interaction.name || interaction.toolName || "unknown_tool",
                            content: String(interaction.result || ""),
                            tool_call_id: interaction.id
                        }));
                    }
                }
            }
        }
        return lcMessages;
    }

    /**
     * Gets the content of the last user message, stripped of injected context.
     */
    public static getLastUserContent(messages: BaseMessage[]): string {
        const lastHumanIndex = [...messages].reverse().findIndex(m => m instanceof HumanMessage);

        if (lastHumanIndex === -1 || lastHumanIndex > 2) {
            // If the last human interaction is too far back (more than 2 messages ago), 
            // it's likely "consumed" or stale.
            return "";
        }

        const lastUser = [...messages].reverse()[lastHumanIndex];
        return SanitizationUtil.stripContext(lastUser?.content as string || "").toLowerCase();
    }

    /**
     * Checks if the recent history contains a specific keyword.
     */
    public static recentHistoryHas(messages: BaseMessage[], keyword: string, lookback = 50): boolean {
        const history = messages.slice(-lookback);
        return history.some((m: any) => {
            const content = typeof m.content === 'string' ? m.content : "";
            return content.toLowerCase().includes(keyword.toLowerCase());
        });
    }

    /**
     * Checks if the recent history contains a specific tool call.
     */
    public static recentHistoryHasToolCall(messages: BaseMessage[], toolName: string, lookback = 50): boolean {
        const history = messages.slice(-lookback);
        
        // Robustness: For sync/preview, also check if the result marker exists in history
        // This handles cases where the model might have hallucinated the output format
        // or where tool execution was recorded differently.
        if (toolName === 'preview_sync_diff' && (this.recentHistoryHas(messages, '[SYNC_PREVIEW]', lookback) || this.recentHistoryHas(messages, 'Sync Preview Summary', lookback))) return true;
        if (toolName === 'preview_export_diff' && (this.recentHistoryHas(messages, 'PREVIEW EXPORT RESULTS', lookback) || this.recentHistoryHas(messages, 'Export Preview Summary', lookback))) return true;
        if (toolName === 'preview_reset_inventory' && (this.recentHistoryHas(messages, 'RESET PREVIEW DATA', lookback) || this.recentHistoryHas(messages, 'Reset Inventory Summary', lookback))) return true;

        return history.some((m: any) =>
            // 1. Check ToolMessage name (LangChain property)
            (m.name === toolName) ||
            // 2. Check AIMessage tool_calls (standard LangChain)
            (m.tool_calls && m.tool_calls.some((tc: any) => (tc.name === toolName) || (tc.function && tc.function.name === toolName))) ||
            // 3. Check our custom toolInteractions property (from globalState)
            ((m as any).toolInteractions && (m as any).toolInteractions.some((ti: any) => ti.name === toolName)) ||
            // 4. Check additional_kwargs for namespaced tool names (OpenRouter/Gemini quirk)
            (m.additional_kwargs?.name === toolName)
        );
    }
}

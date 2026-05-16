import { BaseMessage } from "@langchain/core/messages";
import { getEncoding } from "js-tiktoken";

/**
 * Utility for accurate token counting using the OpenAI tiktoken library.
 */
export class TokenCounter {
    private static encoding = getEncoding("cl100k_base"); // Standard for GPT-4/GPT-4o

    /**
     * Calculates the exact token count for a list of LangChain messages.
     */
    public static countMessages(messages: BaseMessage[]): number {
        let totalTokens = 0;

        for (const msg of messages) {
            // 1. Core Content
            if (msg.content) {
                const contentStr = typeof msg.content === 'string' 
                    ? msg.content 
                    : JSON.stringify(msg.content);
                totalTokens += this.encoding.encode(contentStr).length;
            }

            // 2. Reasoning / Thinking Blocks
            const reasoning = (msg.additional_kwargs as any)?.reasoning || (msg as any).reasoning;
            if (reasoning && typeof reasoning === 'string') {
                totalTokens += this.encoding.encode(reasoning).length;
            }

            // 3. Tool Calls (Metadata Weight)
            if ((msg as any).tool_calls && Array.isArray((msg as any).tool_calls)) {
                for (const tc of (msg as any).tool_calls) {
                    totalTokens += this.encoding.encode(tc.name).length;
                    totalTokens += this.encoding.encode(JSON.stringify(tc.args)).length;
                }
            }

            // 4. Message Overhead (approx 3 tokens per message for start/end tags)
            totalTokens += 3;
        }

        return totalTokens;
    }

    /**
     * Accurate string token counter.
     */
    public static countString(text: string): number {
        if (!text) return 0;
        return this.encoding.encode(text).length;
    }
}

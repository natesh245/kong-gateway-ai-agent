import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { TokenCounter } from "./TokenCounter";
import * as assert from 'assert';

describe('TokenCounter Utility', () => {
    it('should correctly count simple strings', () => {
        const text = "Hello world";
        const count = TokenCounter.countString(text);
        // "Hello world" is typically 2 tokens in cl100k_base
        assert.ok(count > 0);
        assert.strictEqual(count, 2); 
    });

    it('should handle empty strings', () => {
        assert.strictEqual(TokenCounter.countString(""), 0);
    });

    it('should count a list of messages accurately', () => {
        const messages = [
            new HumanMessage("What is Kong?"),
            new AIMessage({
                content: "Kong is a gateway.",
                additional_kwargs: { reasoning: "The user is asking for a definition." }
            })
        ];

        const total = TokenCounter.countMessages(messages);
        
        // Human: "What is Kong?" (~4 tokens) + 3 overhead
        // AI: "Kong is a gateway." (~5 tokens) + Reasoning (~7 tokens) + 3 overhead
        // Total should be around 22 tokens
        assert.ok(total > 15 && total < 30);
    });

    it('should account for tool calls', () => {
        const toolMsg = new AIMessage({
            content: "",
            tool_calls: [{
                id: "123",
                name: "read_storage_file",
                args: { filename: "kong.yml" }
            }]
        });

        const count = TokenCounter.countMessages([toolMsg]);
        assert.ok(count > 10, "Should account for tool name and arguments");
    });
});

import * as assert from 'assert';
import { AgentHistory } from './AgentHistory';
import {
    HumanMessage,
    AIMessage,
    SystemMessage,
    ToolMessage,
} from "@langchain/core/messages";

describe('AgentHistory', () => {
    const systemPrompt = "You are a Kong Specialist.";

    it('should convert LangChain messages to UI format', () => {
        const messages = [
            new SystemMessage(systemPrompt),
            new HumanMessage("Hello"),
            new AIMessage({
                content: "Hi there!",
                additional_kwargs: { reasoning: "Greeting the user." },
                tool_calls: [{ id: "call1", name: "test_tool", args: {} }]
            }),
            new ToolMessage({
                content: "Tool result",
                tool_call_id: "call1"
            })
        ];

        const uiMessages = AgentHistory.toUI(messages);
        assert.strictEqual(uiMessages.length, 3); // System, User, Assistant (Tool results are nested in assistant)
        assert.strictEqual(uiMessages[0].role, 'system');
        assert.strictEqual(uiMessages[1].role, 'user');
        assert.strictEqual(uiMessages[2].role, 'assistant');
        assert.strictEqual(uiMessages[2].content, "Hi there!");
        assert.strictEqual(uiMessages[2].reasoning, "Greeting the user.");
        assert.strictEqual(uiMessages[2].toolInteractions.length, 1);
        assert.strictEqual(uiMessages[2].toolInteractions[0].id, "call1");
        assert.strictEqual(uiMessages[2].toolInteractions[0].result, "Tool result");
    });

    it('should convert UI messages to LangChain format', () => {
        const uiMessages = [
            { role: 'user', content: 'Hello' },
            {
                role: 'assistant',
                content: 'Hi!',
                reasoning: 'Reasoning',
                toolInteractions: [
                    { id: 'call1', name: 'test_tool', result: 'Success' }
                ],
                tool_calls: [{ id: 'call1', name: 'test_tool', args: {} }]
            }
        ];

        const lcMessages = AgentHistory.fromUI(uiMessages, systemPrompt);
        assert.strictEqual(lcMessages.length, 4); // System + User + AI + Tool
        assert.ok(lcMessages[0] instanceof SystemMessage);
        assert.ok(lcMessages[1] instanceof HumanMessage);
        assert.ok(lcMessages[2] instanceof AIMessage);
        assert.ok(lcMessages[3] instanceof ToolMessage);
        
        const aiMsg = lcMessages[2] as AIMessage;
        assert.strictEqual(aiMsg.content, "Hi!");
        assert.strictEqual(aiMsg.additional_kwargs.reasoning, "Reasoning");
        assert.strictEqual(aiMsg.tool_calls?.length, 1);
        
        const toolMsg = lcMessages[3] as ToolMessage;
        assert.strictEqual(toolMsg.tool_call_id, 'call1');
        assert.strictEqual(toolMsg.content, 'Success');
    });

    it('should sanitize AI content when converting to UI', () => {
        const messages = [
            new AIMessage({
                content: 'Some text [{"id": "leaked"}]',
            })
        ];
        const uiMessages = AgentHistory.toUI(messages);
        assert.strictEqual(uiMessages[0].content, "Some text");
    });
});

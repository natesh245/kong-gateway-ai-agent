import * as assert from 'assert';
import { AgentStream, StreamProcessorState } from './AgentStream';

describe('AgentStream', () => {
    let state: StreamProcessorState;
    const updates: { content: string, type?: string }[] = [];
    const onUpdate = (content: string, type?: string) => {
        updates.push({ content, type });
    };

    beforeEach(() => {
        state = {
            isInsideThought: false,
            streamBuffer: "",
            fullContent: "",
            fullReasoning: ""
        };
        updates.length = 0;
    });

    it('should process simple text', () => {
        AgentStream.processChunk("Hello world", onUpdate, state);
        assert.strictEqual(state.fullContent, "Hello world");
        assert.strictEqual(updates[0].content, "Hello world");
        assert.strictEqual(updates[0].type, "agent");
    });

    it('should extract thought tags', () => {
        AgentStream.processChunk("Normal text <thought>Internal reasoning</thought> more text", onUpdate, state);
        assert.strictEqual(state.fullContent, "Normal text  more text");
        assert.strictEqual(state.fullReasoning, "Internal reasoning");
        
        // Check updates sequence
        assert.strictEqual(updates[0].content, "Normal text ");
        assert.strictEqual(updates[0].type, "agent");
        assert.strictEqual(updates[1].content, "Internal reasoning");
        assert.strictEqual(updates[1].type, "reasoning");
        assert.strictEqual(updates[2].content, " more text");
        assert.strictEqual(updates[2].type, "agent");
    });

    it('should handle partial tags across chunks', () => {
        AgentStream.processChunk("Text <tho", onUpdate, state);
        assert.strictEqual(state.fullContent, "Text ");
        assert.strictEqual(state.streamBuffer, "<tho");

        AgentStream.processChunk("ught>Reasoning</thought>End", onUpdate, state);
        assert.strictEqual(state.fullReasoning, "Reasoning");
        assert.strictEqual(state.fullContent, "Text End");
        assert.strictEqual(state.streamBuffer, "");
    });

    it('should handle nested-like characters that are not tags', () => {
        AgentStream.processChunk("Port < 8000", onUpdate, state);
        assert.strictEqual(state.fullContent, "Port < 8000");
        assert.strictEqual(state.isInsideThought, false);
    });
});

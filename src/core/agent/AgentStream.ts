export interface StreamProcessorState {
    isInsideThought: boolean;
    streamBuffer: string;
    fullContent: string;
    fullReasoning: string;
}

export class AgentStream {
    /**
     * Processes streaming content, parsing <thought> tags for reasoning extraction.
     */
    public static processChunk(
        chunk: string,
        onUpdate: (content: string, type?: string) => void,
        state: StreamProcessorState,
        targetType: string = 'agent'
    ) {
        state.streamBuffer += chunk;

        while (state.streamBuffer.length > 0) {
            if (!state.isInsideThought) {
                const thoughtStartIdx = state.streamBuffer.indexOf('<thought>');
                if (thoughtStartIdx !== -1) {
                    const before = state.streamBuffer.substring(0, thoughtStartIdx);
                    if (before) {
                        state.fullContent += before;
                        onUpdate(before, targetType);
                    }
                    state.isInsideThought = true;
                    state.streamBuffer = state.streamBuffer.substring(thoughtStartIdx + '<thought>'.length);
                } else {
                    const potentialTagStart = state.streamBuffer.lastIndexOf('<');
                    if (potentialTagStart !== -1 && potentialTagStart > state.streamBuffer.length - 10) {
                        const nextChar = state.streamBuffer[potentialTagStart + 1];
                        if (!nextChar || nextChar === 't') {
                            const processable = state.streamBuffer.substring(0, potentialTagStart);
                            if (processable) {
                                state.fullContent += processable;
                                onUpdate(processable, targetType);
                                state.streamBuffer = state.streamBuffer.substring(potentialTagStart);
                            }
                            break;
                        } else {
                            state.fullContent += state.streamBuffer;
                            onUpdate(state.streamBuffer, targetType);
                            state.streamBuffer = "";
                        }
                    } else {
                        state.fullContent += state.streamBuffer;
                        onUpdate(state.streamBuffer, targetType);
                        state.streamBuffer = "";
                    }
                }
            } else {
                const thoughtEndIdx = state.streamBuffer.indexOf('</thought>');
                if (thoughtEndIdx !== -1) {
                    const thought = state.streamBuffer.substring(0, thoughtEndIdx);
                    if (thought) {
                        state.fullReasoning += thought;
                        onUpdate(thought, 'reasoning');
                    }
                    state.isInsideThought = false;
                    state.streamBuffer = state.streamBuffer.substring(thoughtEndIdx + '</thought>'.length);
                } else {
                    const potentialTagEnd = state.streamBuffer.lastIndexOf('<');
                    if (potentialTagEnd !== -1 && potentialTagEnd > state.streamBuffer.length - 11) {
                        const processable = state.streamBuffer.substring(0, potentialTagEnd);
                        if (processable) {
                            state.fullReasoning += processable;
                            onUpdate(processable, 'reasoning');
                            state.streamBuffer = state.streamBuffer.substring(potentialTagEnd);
                        }
                        break;
                    } else {
                        state.fullReasoning += state.streamBuffer;
                        onUpdate(state.streamBuffer, 'reasoning');
                        state.streamBuffer = "";
                    }
                }
            }
        }
    }
}

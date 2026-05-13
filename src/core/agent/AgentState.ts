import { BaseMessage, SystemMessage } from "@langchain/core/messages";

export interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    lastTurnUsage: { inputTokens: number, outputTokens: number, toolCalls: number }
}

export class AgentState {
    public messages: BaseMessage[] = [];
    public isCancelled: boolean = false;
    public abortController: AbortController | null = null;
    public toolCallCount = 0;
    public uniqueToolCallIds: Set<string> = new Set();
    public uniqueToolResultIds: Set<string> = new Set();
    public lastAnyToolTriggeredSafety = false;
    public currentTurnStartTime: number | null = null;
    public currentTurnEndTime: number | null = null;
    public activeFiles: { compose?: string, config?: string, gateway_config?: string, ruleset?: string } = {};
    
    public usageStats: UsageStats = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        lastTurnUsage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 }
    };
    public previousTurnUsage = { inputTokens: 0, outputTokens: 0 };

    constructor(systemPrompt: string) {
        this.messages.push(new SystemMessage(systemPrompt));
    }

    public reset(): void {
        const systemPrompt = this.messages[0];
        this.messages = [systemPrompt];
        this.isCancelled = false;
        this.toolCallCount = 0;
        this.usageStats = {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            lastTurnUsage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 }
        };
    }

    public cancel(): void {
        this.isCancelled = true;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    public startTurn(startTime?: number): void {
        this.currentTurnStartTime = startTime || Date.now();
        this.currentTurnEndTime = null;
        this.isCancelled = false;
        this.lastAnyToolTriggeredSafety = false;
        this.toolCallCount = 0;
        
        // Preserve last turn usage for stability checks before resetting
        this.previousTurnUsage = {
            inputTokens: this.usageStats.lastTurnUsage.inputTokens,
            outputTokens: this.usageStats.lastTurnUsage.outputTokens
        };
        this.usageStats.lastTurnUsage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
    }

    public endTurn(): void {
        this.currentTurnEndTime = Date.now();
        this.abortController = null;
    }
}

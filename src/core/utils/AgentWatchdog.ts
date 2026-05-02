/**
 * Utility for detecting infinite loops and excessive tool call churning.
 */
export class AgentWatchdog {
    private lastSequencedToolName: string | null = null;
    private lastSequencedToolArgs: string | null = null;
    private sequentialToolCount = 0;

    /**
     * Checks if a tool call is part of a repetitive loop.
     * Returns an error message if a loop is detected, otherwise null.
     */
    public checkLoop(toolName: string, args: any): string | null {
        const currentArgs = JSON.stringify(args);
        
        if (toolName === this.lastSequencedToolName && currentArgs === this.lastSequencedToolArgs) {
            this.sequentialToolCount++;
        } else {
            this.lastSequencedToolName = toolName;
            this.lastSequencedToolArgs = currentArgs;
            this.sequentialToolCount = 1;
        }

        if (this.sequentialToolCount > 3) {
            return `Excessive repetition of '${toolName}'.`;
        }
        
        return null;
    }

    /**
     * Resets the watchdog state for a new turn.
     */
    public reset(): void {
        this.lastSequencedToolName = null;
        this.lastSequencedToolArgs = null;
        this.sequentialToolCount = 0;
    }
}

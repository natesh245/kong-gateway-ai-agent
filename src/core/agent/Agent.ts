import { ChatOpenAI } from "@langchain/openai";
import {
    BaseMessage,
    HumanMessage,
    AIMessage,
    SystemMessage,
    ToolMessage,
} from "@langchain/core/messages";
import {
    createAgent,
    modelCallLimitMiddleware,
    toolCallLimitMiddleware,
} from "langchain";

import { ToolManager } from "./tools/ToolManager";
import { IConfig, IAppPlatform } from "../interfaces/ICoreInterfaces";
import { SanitizationUtil } from "../utils/SanitizationUtil";
import { buildAgentTools, ToolContext } from "./AgentTools";
import { PromptAnalyser } from "../utils/PromptAnalyser";
import { SYSTEM_PROMPT } from "./SystemPrompt";

import { AgentState } from "./AgentState";
import { AgentHistory } from "./AgentHistory";
import { AgentClient } from "./AgentClient";
import { AgentStream } from "./AgentStream";
import { MessageUtils } from "../utils/MessageUtils";
import { AgentWatchdog } from "../utils/AgentWatchdog";

export class Agent {
    private model: any | null = null;
    private langchainAgent: any = null;
    private state: AgentState;
    private watchdog: AgentWatchdog;

    public get activeFiles() {
        return this.state.activeFiles;
    }

    constructor(private config: IConfig, private toolManager: ToolManager, private platform: IAppPlatform) {
        this.state = new AgentState(SYSTEM_PROMPT);
        this.watchdog = new AgentWatchdog();
        this.toolManager.storage.setAgent(this);
    }

    private getFriendlyToolName(name: string): string {
        return MessageUtils.getFriendlyToolName(name);
    }

    public getMessages(): any[] {
        return AgentHistory.toUI(this.state.messages);
    }

    public setMessages(messages: any[]): void {
        this.state.messages = AgentHistory.fromUI(messages, SYSTEM_PROMPT);
    }

    public resetContext(): void {
        this.state.reset();
        this.langchainAgent = null;
    }

    public cancel(): void {
        this.state.cancel();
    }

    private initClient(): boolean {
        this.model = AgentClient.initModel(this.config, this.platform);
        return !!this.model;
    }

    private buildAgent(): void {
        if (!this.model) return;

        const modelCallLimit = this.config.get<number>('modelCallLimit') || 5;
        const toolCallLimit = this.config.get<number>('toolCallLimit') || 5;
        const recursionLimit = this.config.get<number>('recursionLimit') || 15;

        const toolCtx: ToolContext = {
            toolManager: this.toolManager,
            config: this.config,
            getMessages: () => this.state.messages,
            abortSignal: this.state.abortController?.signal,
        };

        const tools = buildAgentTools(toolCtx);

        const rawAgent = createAgent({
            model: this.model,
            tools: tools,
            systemPrompt: SYSTEM_PROMPT,
            middleware: [
                modelCallLimitMiddleware({
                    runLimit: modelCallLimit,
                    exitBehavior: 'end',
                }),
                toolCallLimitMiddleware({
                    runLimit: toolCallLimit,
                    exitBehavior: 'end',
                }),
            ],
        });

        this.langchainAgent = rawAgent.withConfig({ recursionLimit: recursionLimit });
    }

    public async fetchAvailableModels(providerOverride?: string, apiKeyOverride?: string): Promise<string[]> {
        return await AgentClient.fetchModels(this.config, providerOverride, apiKeyOverride);
    }

    public getUsageStats() {
        return {
            ...this.state.usageStats,
            lastTurnUsage: {
                ...this.state.usageStats.lastTurnUsage,
                toolCalls: this.state.toolCallCount
            },
            contextLimit: this.config.get<number>('maxContext') || 130000
        };
    }

    public async classifyFile(content: string): Promise<'compose' | 'kong' | 'ruleset' | 'gateway_config' | 'other'> {
        if (!this.initClient() || !this.model) return 'other';
        return await PromptAnalyser.classifyFile(content, this.model);
    }

    public async processMessage(content: string, onUpdate: (content: string, type?: string) => void, startTime?: number): Promise<void> {
        this.state.startTurn(startTime);
        
        const config = this.config;
        const maxContext = config.get<number>('maxContext') || 130000;
        await this.ensureContextStability(onUpdate);

        if (!this.initClient() || !this.model) {
            onUpdate("Error: LLM client initialization failed. Please check your provider and API key settings in the application settings.");
            return;
        }

        // FAST-PASS: Instantly allow common greetings without calling the LLM
        const normalizedInput = content.trim().toLowerCase().replace(/[?!.]/g, '');
        const trueGreetings = ['hi', 'hello', 'hey', 'yo', 'good morning', 'good afternoon', 'good evening'];
        const fastPassPhrases = [...trueGreetings];

        let classificationResult;
        try {
            const isGreeting = fastPassPhrases.includes(normalizedInput) || normalizedInput.length < 2;
            const isAutomatedReview = /accepted the changes to/i.test(content) || 
                                     /review and provide a detailed summary/i.test(content) ||
                                     /lint_kong_config/i.test(content) ||
                                     /validate_kong_config/i.test(content);

            if (isGreeting) {
                classificationResult = { classification: 'GREET', reason: 'Greeting (Fast-Pass)' };
            } else if (isAutomatedReview) {
                classificationResult = { classification: 'KONGR', reason: 'Automated Lifecycle (Fast-Pass)' };
            } else {
                classificationResult = await PromptAnalyser.classify(content, this.model, this.state.abortController?.signal);
            }
        } catch (e: any) {
            if (e.name === 'AbortError' || this.state.isCancelled) return;
            throw e;
        }

        if (classificationResult.usage) {
            this.state.usageStats.inputTokens += classificationResult.usage.inputTokens;
            this.state.usageStats.outputTokens += classificationResult.usage.outputTokens;
            this.state.usageStats.totalTokens += (classificationResult.usage.inputTokens + classificationResult.usage.outputTokens);

            this.state.usageStats.lastTurnUsage = {
                inputTokens: classificationResult.usage.inputTokens,
                outputTokens: classificationResult.usage.outputTokens,
                toolCalls: 0
            };
        }

        if (classificationResult.classification === 'OFFT') {
            const refusal = PromptAnalyser.getRefusalMessage();
            const isolatedUsage = { ...this.state.usageStats.lastTurnUsage };

            this.state.messages.push(new HumanMessage({ content: SanitizationUtil.scrubString(content), additional_kwargs: { category: 'off-topic' } } as any));
            this.state.messages.push(new AIMessage({
                content: refusal,
                additional_kwargs: {
                    role: 'off-topic',
                    lastUsage: isolatedUsage
                }
            } as any));
            onUpdate(refusal);
            return;
        }

        if (classificationResult.classification === 'GREET' && trueGreetings.includes(normalizedInput)) {
            const greeting = "Hello! I'm your dedicated Kong Gateway Specialist. How can I assist you with Kong Gateway today? I can help with configuration, management, troubleshooting, or any other Kong-related queries.";
            this.state.messages.push(new HumanMessage(SanitizationUtil.scrubString(content)));
            this.state.messages.push(new AIMessage({
                content: greeting,
                additional_kwargs: { role: 'greeting' }
            }));
            onUpdate(greeting);
            return;
        }

        // --- Run the LangChain Agent ---
        await this.runAgentTask(content, onUpdate);
    }

    private async runAgentTask(content: string, onUpdate: (content: string, type?: string) => void): Promise<void> {
        this.state.abortController = new AbortController();
        this.state.isCancelled = false;

        const streamState = {
            isInsideThought: false,
            streamBuffer: "",
            fullContent: "",
            fullReasoning: ""
        };

        let collectedToolCalls: any[] = [];
        let collectedToolResults: any[] = [];
        const executedToolNamesThisTurn = new Set<string>();

        const config = this.config;
        const kongMode = config.get<string>('kongMode') || 'local';
        const proxyPort = config.get<number>('proxyPort') || 8000;
        const adminPort = config.get<number>('adminApiPort') || 8001;
        const managerPort = config.get<number>('managerGuiPort') || 8002;

        const discovered = await this.toolManager.storage.findFilesByContent();
        this.state.activeFiles = discovered;
        const contextHeader = `🚨 **STRICT OPERATION BOUNDARY**: You are a DEDICATED Kong Gateway Specialist. \n` +
            `- **REFUSE** all non-Kong queries immediately.\n` +
            `- **MANDATORY REASONING**: Before Every Response or Tool Call, you MUST think inside <thought>...</thought> tags. \n` +
            `- **TRUST AUTO-DISCOVERY**: These files represent the absolute source of truth. NEVER call list_storage_files while these are present.\n` +
            `- Current Mode: **${kongMode.toUpperCase()}**\n` +
            `- Proxy Port: ${proxyPort} | Admin API Port: ${adminPort} | Manager Port: ${managerPort}\n` +
            `- Detected Compose: ${discovered.compose || 'none'}\n` +
            `- Detected decK State: ${discovered.config || 'none'}\n` +
            `- Detected Gateway Config: ${(discovered as any).gateway_config || 'none'}\n` +
            `- Detected Ruleset: ${discovered.ruleset || 'none'}\n\n`;

        this.state.messages.push(new HumanMessage(SanitizationUtil.scrubString(content)));
        this.buildAgent();

        if (!this.langchainAgent) {
            onUpdate("Error: Failed to build agent. Please check configuration.");
            return;
        }

        const maxAgentTimeout = config.get<number>('maxAgentTimeout') || 100;
        let timerId: NodeJS.Timeout;

        const timeoutPromise = new Promise<void>((_, reject) => {
            timerId = setTimeout(() => {
                this.cancel();
                reject(new Error(`Processing forcefully aborted because it exceeded the configured maxAgentTimeout of ${maxAgentTimeout} seconds.`));
            }, maxAgentTimeout * 1000);
        });

        const executionTask = async () => {
            const persistState = () => {
                if (collectedToolCalls.length > 0 && 
                    streamState.fullContent.trim() && 
                    !streamState.fullReasoning.trim() && 
                    !streamState.fullContent.includes('[APPROVAL_REQUIRED]') &&
                    !streamState.fullContent.includes('|')) {
                    streamState.fullReasoning = streamState.fullContent.trim();
                    streamState.fullContent = "";
                }

                if (collectedToolResults.length > 0) {
                    for (const tr of collectedToolResults) {
                        if (!tr.id) continue;
                        this.state.messages.push(new ToolMessage({
                            content: tr.content,
                            tool_call_id: tr.id,
                            id: tr.id,
                            name: tr.name || "unknown_tool",
                        }));
                    }
                    collectedToolResults = [];
                }

                if (streamState.fullContent || collectedToolCalls.length > 0 || streamState.fullReasoning) {
                    const validToolCalls = collectedToolCalls.filter(tc => tc.id && tc.name);
                    const assistantMsg = new AIMessage({
                        content: streamState.fullContent,
                        tool_calls: validToolCalls.length > 0 ? validToolCalls.map(tc => ({
                            id: tc.id,
                            name: tc.name,
                            args: tc.args,
                        })) : undefined,
                        additional_kwargs: {
                            reasoning: streamState.fullReasoning,
                            lastUsage: { ...this.state.usageStats.lastTurnUsage },
                            startTime: this.state.currentTurnStartTime,
                            endTime: this.state.currentTurnEndTime
                        }
                    });
                    this.state.messages.push(assistantMsg);
                    streamState.fullContent = "";
                    streamState.fullReasoning = "";
                    collectedToolCalls = [];
                }
            };

            try {
                const apiMessages: BaseMessage[] = [];
                const unifiedSystemPrompt = `${SYSTEM_PROMPT}\n\n${contextHeader}`;
                apiMessages.push(new SystemMessage(unifiedSystemPrompt));

                const rawMessages = this.state.messages.filter((m: any) =>
                    (m as any).role !== 'thinking' &&
                    !(m instanceof SystemMessage) &&
                    (m as any).role !== 'off-topic' &&
                    (m as any).category !== 'off-topic'
                );

                for (const m of rawMessages) {
                    apiMessages.push(m);
                }

                const recursionLimit = config.get<number>('recursionLimit') || 50;
                const runNameSnippet = content.length > 50 ? `${content.substring(0, 50)}...` : content;
                
                const stream = await this.langchainAgent.stream(
                    { messages: apiMessages },
                    {
                        streamMode: ["messages", "updates"] as any,
                        signal: this.state.abortController?.signal,
                        recursionLimit: recursionLimit,
                        runName: `KongAgent: ${runNameSnippet}`
                    }
                );

                this.watchdog.reset();
                let toolNames = new Map<string, string>();

                for await (const [mode, chunk] of stream) {
                    if (this.state.isCancelled) break;

                    if (this.state.usageStats.totalTokens >= (config.get<number>('maxContext') || 130000)) {
                        onUpdate("\n\n⚠️ **Context Watchdog Triggered**: Context limit reached. I will summarize our history at the start of the next turn to recover space.");
                        persistState();
                        this.cancel();
                        return;
                    }

                    if (mode === "messages") {
                        const [token, metadata] = chunk as [any, any];
                        const type = (token as any)._getType?.() || (token as any).type;
                        const targetType = type === 'ai' ? 'agent' : 'reasoning';

                        // Capture tool names
                        const toolCalls = (token as any).tool_calls || [];
                        const toolCallChunks = (token as any).tool_call_chunks || [];
                        for (const tc of toolCalls) if (tc.name) toolNames.set(tc.id, tc.name);
                        for (const tcc of toolCallChunks) if (tcc.name && tcc.id) toolNames.set(tcc.id, tcc.name);

                        if (token.contentBlocks) {
                            for (const b of token.contentBlocks) {
                                if (b.type === "reasoning" && b.reasoning) {
                                    streamState.fullReasoning += b.reasoning;
                                    onUpdate(b.reasoning, 'reasoning');
                                } else if (b.type === "text" && b.text) {
                                    AgentStream.processChunk(b.text, onUpdate, streamState, targetType);
                                }
                            }
                        } else if (token.content) {
                            AgentStream.processChunk(typeof token.content === 'string' ? token.content : '', onUpdate, streamState, targetType);
                        }

                        // Specialized reasoning
                        const nativeReasoning = token.additional_kwargs?.reasoning_content || token.additional_kwargs?.thought || (token as any).reasoning_content || (token as any).thought;
                        if (nativeReasoning) {
                            streamState.fullReasoning += nativeReasoning;
                            onUpdate(nativeReasoning, 'reasoning');
                        }

                        if (type === "tool" || type === "human" || (token as any).tool_call_id || metadata?.langgraph_node === "tools") continue;

                        if (token.usage_metadata) {
                            const usage = token.usage_metadata;
                            this.state.usageStats.inputTokens += usage.input_tokens || 0;
                            this.state.usageStats.outputTokens += usage.output_tokens || 0;
                            this.state.usageStats.totalTokens += usage.total_tokens || 0;
                            this.state.usageStats.lastTurnUsage.inputTokens += usage.input_tokens || 0;
                            this.state.usageStats.lastTurnUsage.outputTokens += usage.output_tokens || 0;
                        }
                    } else if (mode === "updates") {
                        const updateChunk = chunk as Record<string, any>;
                        for (const [step, stepContent] of Object.entries(updateChunk)) {
                            if (!stepContent?.messages) continue;
                            for (const msg of stepContent.messages) {
                                if (msg.tool_calls && msg.tool_calls.length > 0) {
                                    for (const tc of msg.tool_calls) {
                                        if (tc.id && !this.state.uniqueToolCallIds.has(tc.id)) {
                                            this.state.uniqueToolCallIds.add(tc.id);
                                            
                                            // Watchdog: Sequential Loops
                                            const loopError = this.watchdog.checkLoop(tc.name, tc.args);
                                            if (loopError) {
                                                onUpdate(`\n\n🚨 **Loop Watchdog Triggered**: ${loopError}`);
                                                persistState();
                                                this.cancel();
                                                return;
                                            }

                                            this.state.toolCallCount++;
                                            this.state.usageStats.lastTurnUsage.toolCalls++;

                                            if (this.state.toolCallCount > (config.get<number>('toolCallLimit') || 10)) {
                                                onUpdate(`\n\n⚠️ **Churn Watchdog Triggered**: Excessive tool calls.`);
                                                persistState();
                                                this.cancel();
                                                return;
                                            }

                                            onUpdate(`${this.getFriendlyToolName(tc.name)}...`, 'toolStatus');
                                            onUpdate(JSON.stringify({ id: tc.id, interaction: { name: tc.name, args: tc.args, status: 'started' } }), 'toolInteraction');
                                            collectedToolCalls.push(tc);
                                        }
                                    }
                                }

                                if (step === "tools" || msg.tool_call_id) {
                                    const safeResult = SanitizationUtil.scrubString(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
                                    const toolId = msg.tool_call_id || (msg as any).id;
                                    if (toolId && !this.state.uniqueToolResultIds.has(toolId)) {
                                        this.state.uniqueToolResultIds.add(toolId);
                                        collectedToolResults.push({ id: toolId, name: toolNames.get(toolId), content: safeResult });
                                        onUpdate(JSON.stringify({ id: toolId, interaction: { name: toolNames.get(toolId), result: safeResult.substring(0, 5000), status: 'completed' } }), 'toolInteraction');

                                        if (safeResult.includes("SAFETY_REQUIRED")) {
                                            this.state.lastAnyToolTriggeredSafety = true;
                                            onUpdate(`\n\n🛡️ **Safety Gate Triggered**: Manual approval required.`);
                                            this.state.endTurn();
                                            persistState();
                                            this.cancel();
                                            return;
                                        }
                                    }
                                }
                            }
                        }
                        if (streamState.streamBuffer.length > 0) {
                            if (streamState.isInsideThought) {
                                streamState.fullReasoning += streamState.streamBuffer;
                                onUpdate(streamState.streamBuffer, 'reasoning');
                            } else {
                                streamState.fullContent += streamState.streamBuffer;
                                onUpdate(streamState.streamBuffer, 'agent');
                            }
                            streamState.streamBuffer = "";
                        }
                        persistState();
                    }
                }

                if (streamState.streamBuffer.length > 0) {
                    if (streamState.isInsideThought) {
                        streamState.fullReasoning += streamState.streamBuffer;
                        onUpdate(streamState.streamBuffer, 'reasoning');
                    } else {
                        streamState.fullContent += streamState.streamBuffer;
                        onUpdate(streamState.streamBuffer, 'agent');
                    }
                    streamState.streamBuffer = "";
                }

                if (streamState.fullContent) onUpdate("", 'toolStatus');
                this.state.endTurn();
                persistState();
            } catch (e: any) {
                if (e.name === 'AbortError' || this.state.isCancelled) return;
                if (e.message?.includes('Recursion') || e.name === 'GraphRecursionError' || e.message?.includes('call limit reached')) {
                    onUpdate(`⚠️ **Agent Limit Reached**: Maximum steps exceeded.`);
                    persistState();
                    return;
                }
                onUpdate(`Agent Error: ${e.message}`);
            }
        };

        try {
            await Promise.race([executionTask(), timeoutPromise]);
        } catch (e: any) {
            onUpdate(`Agent Timeout: ${e.message}`);
        } finally {
            if (timerId!) clearTimeout(timerId);
        }
    }

    private async ensureContextStability(onUpdate: (content: string, type?: string) => void): Promise<void> {
        const config = this.config;
        const maxContext = config.get<number>('maxContext') || 130000;
        
        // Trigger summarization when we hit 85% of max context
        if (this.state.usageStats.totalTokens >= maxContext * 0.85) {
            onUpdate("🔄 **Optimizing Context**: You've reached 85% of the message limit. I'm summarizing the older part of our conversation to keep things running smoothly...\n\n");
            
            const { toSummarize, toKeep } = AgentHistory.getMessagesForSummarization(this.state.messages, 0.4);
            
            if (toSummarize.length > 0) {
                if (!this.initClient() || !this.model) return;

                const summary = await PromptAnalyser.summarizeHistory(toSummarize, this.model);
                const summaryMessage = new SystemMessage(`[PREVIOUS CONVERSATION SUMMARY]: ${summary}\n\nNote: The conversation above this point has been summarized to optimize performance.`);
                
                // New history: [System Prompt, Summary, ...Rest of kept messages]
                if (toKeep.length > 0 && toKeep[0] instanceof SystemMessage) {
                    this.state.messages = [toKeep[0], summaryMessage, ...toKeep.slice(1)];
                } else {
                    this.state.messages = [summaryMessage, ...toKeep];
                }
                
                // Decrement total tokens by a heuristic (40% of current usage)
                this.state.usageStats.totalTokens = Math.floor(this.state.usageStats.totalTokens * 0.6); 
                onUpdate("✅ **Context Optimized**: Conversation compressed. Continuing...\n\n");
            }
        }
    }
}

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
import { KongApiClient } from "../api-clients/KongApiClient";

import axios from "axios";
import { IConfig, IAppPlatform } from "../interfaces/ICoreInterfaces";
import { SanitizationUtil } from "../utils/SanitizationUtil";
import { buildAgentTools, ToolContext } from "./AgentTools";
import { PromptAnalyser } from "../utils/PromptAnalyser";
import { SYSTEM_PROMPT } from "./SystemPrompt";




export class Agent {
    private model: ChatOpenAI | null = null;
    private langchainAgent: any = null;
    private messages: BaseMessage[] = [];

    private isCancelled: boolean = false;
    private abortController: AbortController | null = null;
    private toolCallCount = 0;
    private uniqueToolCallIds: Set<string> = new Set(); // NEW: Deduplicate tool calls per turn
    private uniqueToolResultIds: Set<string> = new Set();
    private lastAnyToolTriggeredSafety = false;
    private currentTurnStartTime: number | null = null;
    private currentTurnEndTime: number | null = null;
    private usageStats = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        lastTurnUsage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 }
    };
    public activeFiles: { compose?: string, config?: string, gateway_config?: string, ruleset?: string } = {};


    constructor(private config: IConfig, private toolManager: ToolManager, private platform: IAppPlatform) {

        this.toolManager.storage.setAgent(this);

        // Keep the system prompt in messages for history serialization
        this.messages.push(new SystemMessage(SYSTEM_PROMPT));
    }

    private getFriendlyToolName(name: string): string {
        const mapping: Record<string, string> = {
            'start_kong': 'Starting Kong Gateway (Docker)...',
            'stop_kong': 'Stopping Kong Gateway...',
            'sync_to_kong_using_deck': 'Syncing configuration with decK...',
            'preview_sync_diff': 'Generating configuration diff...',
            'validate_kong_config': 'Validating configuration...',
            'verify_connectivity': 'Verifying Kong connectivity...',
            'get_kong_status': 'Checking Kong status...',
            'read_storage_file': 'Reading configuration file...',
            'write_storage_file': 'Saving configuration...',
            'git_sync_push': 'Pushing changes to Git...',
            'git_sync_pull': 'Pulling updates from Git...',
            'check_existing_containers': 'Scanning for active Kong instances...',
            'reconcile_port_settings': 'Reconciling port settings with Docker...'
        };
        return mapping[name] || `Executing ${name}...`;
    }

    public getMessages(): any[] {
        const result: any[] = [];

        for (let i = 0; i < this.messages.length; i++) {
            const m = this.messages[i];

            if (m instanceof SystemMessage) {
                result.push({ role: 'system', content: m.content });
            } else if (m instanceof HumanMessage) {
                result.push({ role: 'user', content: m.content });
            } else if (m instanceof AIMessage) {
                // Sanitization: Strip any JSON chunks that accidentally leaked into the content string
                // during previous broken runs. We only want pure AI text in the content field.
                let cleanContent = typeof m.content === 'string' ? m.content : "";
                if (cleanContent.includes('[{"') || cleanContent.includes('{"id":')) {
                    // Remove trailing JSON arrays or objects that look like tool result leaks
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

                    // Collate the tool results — stop once all tool_call IDs for THIS turn are matched
                    const remainingIds = new Set(m.tool_calls.map(tc => tc.id));
                    for (let j = i + 1; j < this.messages.length && remainingIds.size > 0; j++) {
                        const nextMsg = this.messages[j];
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
                            // Stop if we hit a new turn
                            break;
                        }
                    }
                }
                result.push(res);
            }
        }
        return result;
    }

    public setMessages(messages: any[]): void {
        const lcMessages: BaseMessage[] = [this.messages[0]]; // Always keep the core system prompt

        for (const m of messages) {
            // Skip system messages from history to avoid duplicates with our core prompt
            if (m.role === 'system') continue;

            if (m.role === 'user') {
                lcMessages.push(new HumanMessage(m.content));
            } else if (m.role === 'assistant' || m.role === 'agent') {
                let cleanContent = m.content || "";
                
                // CRITICAL FIX: If the persistent state incorrectly saved the tool result directly into the AIMessage content (e.g. from a past UI bug), we strip it here.
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

                // Re-create the ToolMessages so the Agent stays in sync with history
                if (m.toolInteractions && Array.isArray(m.toolInteractions)) {
                    for (const interaction of m.toolInteractions) {
                        lcMessages.push(new ToolMessage({
                            id: interaction.id,
                            name: interaction.name || interaction.toolName || "",
                            content: interaction.result || "",
                            tool_call_id: interaction.id
                        }));
                    }
                }
            }
        }
        this.messages = lcMessages;
    }

    public resetContext(): void {
        this.messages = [this.messages[0]]; // Keep only the system prompt
        this.isCancelled = false;
        this.langchainAgent = null; // Force re-creation on next call
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

    private initClient(): boolean {
        const config = this.config;
        const provider = config.get<string>('provider') || 'openrouter';
        const modelName = config.get<string>('model') || "openai/gpt-4o";

        // Native Observability Injection (replaces .env)
        if (config.get<boolean>('langChainTracing')) {
            const apiKey = config.get<string>('langSmithApiKey');
            const project = config.get<string>('langSmithProject') || "kong-gateway-agent";
            const endpoint = config.get<string>('langSmithEndpoint') || "https://api.smith.langchain.com";

            // Support both prefixes for maximum compatibility
            process.env.LANGCHAIN_TRACING_V2 = "true";
            process.env.LANGSMITH_TRACING = "true";
            
            process.env.LANGCHAIN_API_KEY = apiKey;
            process.env.LANGSMITH_API_KEY = apiKey;
            
            process.env.LANGCHAIN_PROJECT = project;
            process.env.LANGSMITH_PROJECT = project;
            
            process.env.LANGCHAIN_ENDPOINT = endpoint;
            process.env.LANGSMITH_ENDPOINT = endpoint;
        }

        if (provider === 'gemini') {
            const apiKey = config.get<string>('geminiApiKey');
            if (!apiKey) {
                this.platform.showErrorMessage("Kong Agent: Gemini API key is missing.");
                return false;
            }
            try {
                const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
                this.model = new ChatGoogleGenerativeAI({
                    modelName: modelName,
                    apiKey: apiKey,
                    temperature: 0,
                    maxOutputTokens: 4096,
                }) as any;
                const origBind = this.model!.bindTools;
                this.model!.bindTools = function(tools: any, kwargs: any) {
                    return origBind.call(this, tools, { ...kwargs, parallel_tool_calls: false });
                };
            } catch (e) {
                this.platform.showErrorMessage("Kong Agent: @langchain/google-genai package is not yet installed. Please run 'npm install @langchain/google-genai'.");
                return false;
            }
        } else if (provider === 'openrouter') {
            const apiKey = config.get<string>('openRouterApiKey');
            if (!apiKey) {
                this.platform.showErrorMessage("Kong Agent: OpenRouter API key is missing.");
                return false;
            }
            try {
                const { ChatOpenRouter } = require("@langchain/openrouter");
                this.model = new ChatOpenRouter({
                    modelName: modelName,
                    apiKey: apiKey,
                    temperature: 0,
                    configuration: {
                        baseURL: "https://openrouter.ai/api/v1",
                        defaultHeaders: {
                            "HTTP-Referer": this.platform.getAppReferer(),
                            "X-Title": this.platform.getAppName()
                        }
                    }
                }) as any;
                const origBindOR = this.model!.bindTools;
                this.model!.bindTools = function(tools: any, kwargs: any) {
                    return origBindOR.call(this, tools, { ...kwargs, parallel_tool_calls: false });
                };
            } catch (e) {
                // Fallback to legacy ChatOpenAI if ChatOpenRouter isn't ready
                this.model = new ChatOpenAI({
                    modelName: modelName,
                    apiKey: apiKey,
                    temperature: 0,
                    configuration: {
                        baseURL: "https://openrouter.ai/api/v1",
                        defaultHeaders: {
                            "HTTP-Referer": this.platform.getAppReferer(),
                            "X-Title": this.platform.getAppName()
                        }
                    }
                }) as any;
                const origBindAI = this.model!.bindTools;
                this.model!.bindTools = function(tools: any, kwargs: any) {
                    return origBindAI.call(this, tools, { ...kwargs, parallel_tool_calls: false });
                };
            }
        }

        return true;
    }

    /**
     * Build or rebuild the LangChain agent with current config limits.
     */
    private buildAgent(): void {
        if (!this.model) return;

        const modelCallLimit = this.config.get<number>('modelCallLimit') || 5;
        const toolCallLimit = this.config.get<number>('toolCallLimit') || 5;
        const recursionLimit = this.config.get<number>('recursionLimit') || 15;

        const toolCtx: ToolContext = {
            toolManager: this.toolManager,
            config: this.config,
            getMessages: () => this.messages,
            abortSignal: this.abortController?.signal,
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
        const config = this.config;
        const provider = providerOverride || config.get<string>('provider') || 'openrouter';

        const geminiFallback = [
            'gemini-3.1-pro-preview',
            'gemini-3-flash-preview',
            'gemini-3.1-flash-lite-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-1.5-pro',
            'gemini-1.5-flash',
            'gemini-1.5-flash-latest',
            'gemini-1.5-pro-latest'
        ];

        try {
            if (provider === 'gemini') {
                const geminiKey = apiKeyOverride || config.get<string>('geminiApiKey');
                if (!geminiKey) {
                    return geminiFallback;
                }

                try {
                    const response = await axios.get("https://generativelanguage.googleapis.com/v1beta/models", {
                        params: { key: geminiKey }
                    });

                    if (response.data && Array.isArray(response.data.models)) {
                        return response.data.models
                            .map((m: any) => m.name.replace(/^models\//, ''))
                            .filter((id: string) => id.toLowerCase().includes('gemini'));
                    }
                    return geminiFallback;
                } catch (err) {
                    console.error("Gemini model fetch failed, using fallback:", err);
                    return geminiFallback;
                }
            } else if (provider === 'openrouter') {
                try {
                    const response = await axios.get('https://openrouter.ai/api/v1/models');
                    if (response.data && Array.isArray(response.data.data)) {
                        return response.data.data
                            .filter((m: any) => !m.deprecated)
                            .map((m: any) => m.id);
                    }
                } catch (err) {
                    console.error("OpenRouter model fetch failed:", err);
                }
            }

            return [];
        } catch (e: any) {
            console.error(`Unexpected failure in model fetch: ${e.message}`);
            return provider === 'gemini' ? geminiFallback : [];
        }
    }

    public getUsageStats() {
        const config = this.config;
        return {
            ...this.usageStats,
            lastTurnUsage: {
                ...this.usageStats.lastTurnUsage,
                toolCalls: this.toolCallCount
            },
            contextLimit: config.get<number>('maxContext') || 130000
        };
    }

    public async classifyFile(content: string): Promise<'compose' | 'kong' | 'ruleset' | 'gateway_config' | 'other'> {
        if (!this.initClient() || !this.model) return 'other';
        const sample = content.length > 2000 ? content.substring(0, 2000) : content;

        try {
            const response = await this.model.invoke([
                new SystemMessage("Identify if the following content is a 'compose' (Docker Compose YAML), 'kong' (Kong Gateway decK state YAML), 'ruleset' (decK linting ruleset YAML), 'gateway_config' (Kong Gateway kong.conf properties file), or 'other'. Output ONLY the single word classification."),
                new HumanMessage(sample)
            ]);

            const result = (response.content as string).toLowerCase().trim() || 'other';
            if (result.includes('compose')) return 'compose';
            if (result.includes('kong')) return 'kong';
            if (result.includes('ruleset')) return 'ruleset';
            if (result.includes('gateway_config') || result.includes('gateway')) return 'gateway_config';
            return 'other';
        } catch (e) {
            return 'other';
        }
    }

    public async processMessage(content: string, onUpdate: (content: string, type?: string) => void, startTime?: number): Promise<void> {
        this.currentTurnStartTime = startTime || Date.now();
        this.currentTurnEndTime = null;
        this.isCancelled = false;
        this.lastAnyToolTriggeredSafety = false;
        const config = this.config;
        const maxContext = config.get<number>('maxContext') || 130000;
        if (this.usageStats.totalTokens >= maxContext) {
            this.resetContext();
            onUpdate("⚠️ **Context Limit Exceeded**: The agent token usage surpassed the absolute limit. To prevent instability, your conversation history has been forcefully cleared. Starting a fresh context...\n\n");
        }

        this.toolCallCount = 0;
        // NOTE: uniqueToolCallIds is NOT cleared here. 
        // It persists for the conversation to prevent 'Echoing' hallucinations 
        // where models re-propose previous turn tool calls with same IDs.
        this.usageStats.lastTurnUsage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
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
            if (fastPassPhrases.includes(normalizedInput) || normalizedInput.length < 2) {
                classificationResult = { classification: 'GREET', reason: 'Greeting (Fast-Pass)' };
            } else {
                classificationResult = await PromptAnalyser.classify(content, this.model, this.abortController?.signal);
            }
        } catch (e: any) {
            if (e.name === 'AbortError' || this.isCancelled) return;
            throw e;
        }

        // Update usage with classification cost
        if (classificationResult.usage) {
            this.usageStats.inputTokens += classificationResult.usage.inputTokens;
            this.usageStats.outputTokens += classificationResult.usage.outputTokens;
            this.usageStats.totalTokens += (classificationResult.usage.inputTokens + classificationResult.usage.outputTokens);

            this.usageStats.lastTurnUsage = {
                inputTokens: classificationResult.usage.inputTokens,
                outputTokens: classificationResult.usage.outputTokens,
                toolCalls: 0
            };
        }

        if (classificationResult.classification === 'OFFT') {
            const refusal = PromptAnalyser.getRefusalMessage();
            const isolatedUsage = { ...this.usageStats.lastTurnUsage };

            this.messages.push(new HumanMessage({ content: SanitizationUtil.scrubString(content), additional_kwargs: { category: 'off-topic' } } as any));
            this.messages.push(new AIMessage({
                content: refusal,
                additional_kwargs: {
                    role: 'off-topic',
                    lastUsage: isolatedUsage
                }
            } as any));
            onUpdate(refusal);
            return;
        }

        // EARLY EXIT: Only for TRUE greetings
        if (classificationResult.classification === 'GREET' && trueGreetings.includes(normalizedInput)) {
            const greeting = "Hello! I'm your dedicated Kong Gateway Specialist. How can I assist you with Kong Gateway today? I can help with configuration, management, troubleshooting, or any other Kong-related queries.";
            this.messages.push(new HumanMessage(SanitizationUtil.scrubString(content)));
            this.messages.push(new AIMessage({
                content: greeting,
                additional_kwargs: { role: 'greeting' }
            }));
            onUpdate(greeting);
            return;
        }

        // --- Run the LangChain Agent ---
        const runAgentTask = async () => {
            this.abortController = new AbortController();
            this.isCancelled = false;

            let fullContent = "";
            let fullReasoning = "";
            let collectedToolCalls: any[] = [];
            let collectedToolResults: any[] = [];
            const executedToolNamesThisTurn = new Set<string>();

            const kongMode = config.get<string>('kongMode') || 'local';
            const proxyPort = config.get<number>('proxyPort') || 8000;
            const adminPort = config.get<number>('adminApiPort') || 8001;
            const managerPort = config.get<number>('managerGuiPort') || 8002;

            const discovered = await this.toolManager.storage.findFilesByContent();
            this.activeFiles = discovered;
            const activeCompose = discovered.compose || 'none (default: kong-docker-compose.yml)';
            const activeConfig = discovered.config || 'none (default: kong-deck-state.yml)';
            const activeGateway = (discovered as any).gateway_config || 'none (default: kong.conf)';
            const activeRuleset = discovered.ruleset || 'none (default: ruleset.yaml)';

            const contextHeader = `🚨 **STRICT OPERATION BOUNDARY**: You are a DEDICATED Kong Gateway Specialist. \n` +
                `- **REFUSE** all non-Kong queries immediately.\n` +
                `- **MANDATORY REASONING**: Before Every Response or Tool Call, you MUST think inside <thought>...</thought> tags. \n` +
                `- **TRUST AUTO-DISCOVERY**: These files represent the absolute source of truth. NEVER call list_storage_files while these are present.\n` +
                `- Current Mode: **${kongMode.toUpperCase()}**\n` +
                `- Proxy Port: ${proxyPort} | Admin API Port: ${adminPort} | Manager Port: ${managerPort}\n` +
                `- Detected Compose: ${activeCompose}\n` +
                `- Detected decK State: ${activeConfig}\n` +
                `- Detected Gateway Config: ${activeGateway}\n` +
                `- Detected Ruleset: ${activeRuleset}\n\n`;

            // Store the clean user message in history
            this.messages.push(new HumanMessage(SanitizationUtil.scrubString(content)));

            // Build the agent with current limits (in case they changed)
            this.buildAgent();

            if (!this.langchainAgent) {
                onUpdate("Error: Failed to build agent. Please check configuration.");
                return;
            }

            try {
                // Prepare API history for the model
                const apiMessages: BaseMessage[] = [];
                
                // UNIFY Global Prompt + Dynamic Context into a single authoritative instruction
                const unifiedSystemPrompt = `${SYSTEM_PROMPT}\n\n${contextHeader}`;
                apiMessages.push(new SystemMessage(unifiedSystemPrompt));

                const rawMessages = this.messages.filter((m: any) =>
                    (m as any).role !== 'thinking' &&
                    !(m instanceof SystemMessage) && // We handle system prompt explicitly above
                    (m as any).role !== 'off-topic' &&
                    (m as any).category !== 'off-topic'
                );

                let lastUserIdx = -1;
                for (let i = rawMessages.length - 1; i >= 0; i--) {
                    if (rawMessages[i] instanceof HumanMessage) {
                        lastUserIdx = i;
                        break;
                    }
                }

                for (let i = 0; i < rawMessages.length; i++) {
                    apiMessages.push(rawMessages[i]);
                }

                const recursionLimit = config.get<number>('recursionLimit') || 50;

                // Stream with both "messages" (token-level) and "updates" (step-level) modes
                // recursionLimit is set high as a safety net — the real limits are enforced
                // by modelCallLimitMiddleware and toolCallLimitMiddleware
                const stream = await this.langchainAgent.stream(
                    { messages: apiMessages },
                    {
                        streamMode: ["messages", "updates"] as any,
                        signal: this.abortController?.signal,
                        recursionLimit: recursionLimit,
                    }
                );

                let isInsideThought = false;
                let streamBuffer = "";
                let toolNames = new Map<string, string>(); // Reliable tracking for tool names
                let lastSequencedToolName: string | null = null;
                let lastSequencedToolArgs: string | null = null;
                let sequentialToolCount = 0;

                const persistState = () => {
                    // Fallback: If the model called tools but failed to wrap its preamble in <thought> tags,
                    // we consider the content to be reasoning to prevent it from leaking into the user chat UI.
                    if (collectedToolCalls.length > 0 && fullContent.trim() && !fullReasoning.trim()) {
                        fullReasoning = fullContent.trim();
                        fullContent = "";
                    }

                    if (fullContent || collectedToolCalls.length > 0 || fullReasoning) {
                        const assistantMsg = new AIMessage({
                            content: fullContent,
                            tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls.map(tc => ({
                                id: tc.id,
                                name: tc.name,
                                args: tc.args,
                            })) : undefined,
                            additional_kwargs: {
                                reasoning: fullReasoning,
                                lastUsage: { ...this.usageStats.lastTurnUsage },
                                startTime: this.currentTurnStartTime,
                                endTime: this.currentTurnEndTime
                            }
                        });
                        this.messages.push(assistantMsg);

                        fullContent = "";
                        fullReasoning = "";
                        collectedToolCalls = [];
                    }

                    if (collectedToolResults.length > 0) {
                        for (const tr of collectedToolResults) {
                            this.messages.push(new ToolMessage({
                                content: tr.content,
                                tool_call_id: tr.id,
                                name: tr.name || "",
                            }));
                        }
                        collectedToolResults = [];
                    }
                };

                for await (const [mode, chunk] of stream) {
                    if (this.isCancelled) break;

                    // --- LIVE WATCHDOG: Mid-stream termination for context ---
                    const currentTotal = this.usageStats.totalTokens;
                    if (currentTotal >= maxContext) {
                        onUpdate("\n\n⚠️ **Context Watchdog Triggered**: Context limit reached during reasoning. Aborting to prevent instability.");
                        persistState();
                        this.cancel();
                        return;
                    }

                    // (Tool call check moved inside the updates loop for immediate deduplicated counting)

                    if (mode === "messages") {
                        // Token-level streaming: [message_chunk, metadata]
                        const [token, metadata] = chunk as [any, any];
                        const type = (token as any)._getType?.() || (token as any).type;
                        const nodeType = metadata?.langgraph_node;

                        // Capture tool names aggressively from both full tool_calls and streamed tool_call_chunks
                        const toolCalls = (token as any).tool_calls || [];
                        const toolCallChunks = (token as any).tool_call_chunks || [];

                        for (const tc of toolCalls) {
                            if (tc.name) toolNames.set(tc.id, tc.name);
                        }

                        for (const tcc of toolCallChunks) {
                            if (tcc.name && tcc.id) toolNames.set(tcc.id, tcc.name);
                        }

                        // Identify the target container: ONLY AI messages go to the main chat.
                        const isChat = type === 'ai';
                        const targetType = isChat ? 'agent' : 'reasoning';

                        // Handle reasoning / thinking content blocks (native)
                        if (token.contentBlocks) {
                            const reasoningBlocks = token.contentBlocks.filter((b: any) => b.type === "reasoning");
                            const textBlocks = token.contentBlocks.filter((b: any) => b.type === "text");

                            for (const rb of reasoningBlocks) {
                                if (rb.reasoning) {
                                    fullReasoning += rb.reasoning;
                                    onUpdate(rb.reasoning, 'reasoning');
                                }
                            }

                            for (const tb of textBlocks) {
                                if (tb.text) {
                                    this.processStreamContent(tb.text, onUpdate, {
                                        isInsideThought: () => isInsideThought,
                                        setInsideThought: (v: boolean) => { isInsideThought = v; },
                                        getBuffer: () => streamBuffer,
                                        setBuffer: (v: string) => { streamBuffer = v; },
                                        appendContent: (v: string) => { fullContent += v; },
                                        appendReasoning: (v: string) => { fullReasoning += v; },
                                        targetType
                                    });
                                }
                            }
                        }
                        else if (token.content && !token.contentBlocks) {
                            // Fallback for models that don't use contentBlocks (Ensures NO double processing)
                            const tokenContent = typeof token.content === 'string' ? token.content : '';
                            if (tokenContent) {
                                this.processStreamContent(tokenContent, onUpdate, {
                                    isInsideThought: () => isInsideThought,
                                    setInsideThought: (v: boolean) => { isInsideThought = v; },
                                    getBuffer: () => streamBuffer,
                                    setBuffer: (v: string) => { streamBuffer = v; },
                                    appendContent: (v: string) => { fullContent += v; },
                                    appendReasoning: (v: string) => { fullReasoning += v; },
                                    targetType
                                });
                            }
                        }

                        // Support for specialized reasoning chunks (OpenRouter / Gemini)
                        const nativeReasoning = token.additional_kwargs?.reasoning_content ||
                            token.additional_kwargs?.thought ||
                            token.additional_kwargs?.reasoning ||
                            (token as any).reasoning_content ||
                            (token as any).thought ||
                            (token as any).reasoning;

                        if (nativeReasoning) {
                            fullReasoning += nativeReasoning;
                            onUpdate(nativeReasoning, 'reasoning');
                        }

                        // Legacy Filter: Block raw Tool and Human chunks from the token stream.
                        if (type === "tool" || type === "human" || (token as any).tool_call_id || nodeType === "tools") {
                            continue;
                        }

                        // Track usage from metadata
                        if (token.usage_metadata) {
                            const usage = token.usage_metadata;
                            this.usageStats.inputTokens += usage.input_tokens || 0;
                            this.usageStats.outputTokens += usage.output_tokens || 0;
                            this.usageStats.totalTokens += usage.total_tokens || 0;
                            this.usageStats.lastTurnUsage.inputTokens += usage.input_tokens || 0;
                            this.usageStats.lastTurnUsage.outputTokens += usage.output_tokens || 0;
                        }
                    } else if (mode === "updates") {
                        // Step-level updates: { model: { messages: [...] }, tools: { messages: [...] } }
                        const updateChunk = chunk as Record<string, any>;

                        for (const [step, stepContent] of Object.entries(updateChunk)) {
                            if (!stepContent?.messages) continue;

                            for (const msg of stepContent.messages) {
                                // AI message with tool calls
                                if (msg.tool_calls && msg.tool_calls.length > 0) {
                                    for (const tc of msg.tool_calls) {
                                        // ONLY count and check if this is a NEW tool call ID
                                        if (tc.id && !this.uniqueToolCallIds.has(tc.id)) {
                                            this.uniqueToolCallIds.add(tc.id);
                                            executedToolNamesThisTurn.add(tc.name);
                                            
                                            // SEQUENTIAL WATCHDOG: Detect infinite tool loops
                                            const currentArgs = JSON.stringify(tc.args);
                                            if (tc.name === lastSequencedToolName && currentArgs === lastSequencedToolArgs) {
                                                sequentialToolCount++;
                                            } else {
                                                lastSequencedToolName = tc.name;
                                                lastSequencedToolArgs = currentArgs;
                                                sequentialToolCount = 1;
                                            }

                                            if (sequentialToolCount > 3) {
                                                onUpdate(`\n\n🚨 **Loop Watchdog Triggered**: The model is repeating the '${tc.name}' tool excessively. Terminating turn to prevent resource waste.`);
                                                persistState();
                                                this.cancel();
                                                return;
                                            }

                                            this.toolCallCount++;
                                            this.usageStats.lastTurnUsage.toolCalls++;

                                            // IMMEDIATE WATCHDOG: Kill mid-step if count is breached
                                            if (this.toolCallCount > (config.get<number>('toolCallLimit') || 10)) {
                                                onUpdate(`\n\n⚠️ **Churn Watchdog Triggered**: Excessive tool calls detected (${this.toolCallCount}). Aborting turn to prevent token waste.`);
                                                persistState();
                                                this.cancel();
                                                return; // Exit the entire processing task
                                            }

                                            onUpdate(`${this.getFriendlyToolName(tc.name)}...`, 'toolStatus');
                                            onUpdate(JSON.stringify({
                                                id: tc.id,
                                                interaction: {
                                                    name: tc.name,
                                                    args: tc.args,
                                                    status: 'started'
                                                }
                                            }), 'toolInteraction');
                                            
                                            collectedToolCalls.push(tc);
                                        }
                                    }
                                }

                                if (step === "tools" || msg.tool_call_id) {
                                    // Tool result message
                                    const safeResult = SanitizationUtil.scrubString(
                                        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                                    );

                                    const toolId = msg.tool_call_id || (msg as any).id;
                                    if (toolId && !this.uniqueToolResultIds.has(toolId)) {
                                        this.uniqueToolResultIds.add(toolId);

                                        collectedToolResults.push({
                                            id: toolId,
                                            name: toolNames.get(toolId),
                                            content: safeResult
                                        });

                                            onUpdate(JSON.stringify({
                                                id: toolId,
                                                interaction: {
                                                    name: toolNames.get(toolId),
                                                    result: safeResult.substring(0, 5000),
                                                    status: 'completed'
                                                }
                                            }), 'toolInteraction');

                                            // Check for SAFETY_REQUIRED pattern
                                            if (safeResult.includes("SAFETY_REQUIRED")) {
                                                this.lastAnyToolTriggeredSafety = true;
                                                onUpdate(`\n\n🛡️ **Safety Gate Triggered**: A manual approval is required. Terminating turn...`);
                                                this.currentTurnEndTime = Date.now();
                                                persistState();
                                                this.cancel();
                                                return;
                                            }
                                    }
                                }
                            }
                        }
                        // Flush any remaining buffer before persisting this step
                        if (streamBuffer.length > 0) {
                            if (isInsideThought) {
                                fullReasoning += streamBuffer;
                                onUpdate(streamBuffer, 'reasoning');
                            } else {
                                fullContent += streamBuffer;
                                onUpdate(streamBuffer, 'agent');
                            }
                            streamBuffer = "";
                        }
                        persistState();
                    }
                }

                // FLUSH REMAINING BUFFER
                if (streamBuffer.length > 0) {
                    if (isInsideThought) {
                        fullReasoning += streamBuffer;
                        onUpdate(streamBuffer, 'reasoning');
                    } else {
                        fullContent += streamBuffer;
                        onUpdate(streamBuffer, 'agent');
                    }
                    streamBuffer = "";
                }

                // Clear tool status
                if (fullContent) {
                    onUpdate("", 'toolStatus');
                }

                this.currentTurnEndTime = Date.now();

                // Sync messages: add the final AI message and any tool messages to our history
                persistState();
                // The stream naturally handles the multi-turn: model -> tools -> model -> ...
                // Our fullContent captures only the final text response from the last model step

            } catch (e: any) {
                if (e.name === 'AbortError' || this.isCancelled) return;
                // Handle LangGraph recursion limit error gracefully
                if (e.message?.includes('Recursion') || e.name === 'GraphRecursionError' || e.message?.includes('call limit reached')) {
                    const limitMsg = `⚠️ **Agent Limit Reached**: The agent exceeded the maximum number of reasoning steps or model calls for this turn. This usually happens during complex configuration reviews. Please try a simpler request or clear the chat to start fresh.`;

                    // CRITICAL: Persist partial results before exiting! 
                    // This ensures the agent 'remembers' work done in this turn for the next user message.
                    if (collectedToolCalls.length > 0) {
                        const partialAiMsg = new AIMessage({
                            content: fullContent || "Reasoning interrupted by safety limit...",
                            tool_calls: collectedToolCalls,
                            additional_kwargs: { reasoning: fullReasoning }
                        });
                        this.messages.push(partialAiMsg);

                        for (const tr of collectedToolResults) {
                            this.messages.push(new ToolMessage({
                                tool_call_id: tr.id,
                                content: tr.content
                            }));
                        }
                    }

                    onUpdate(limitMsg);
                    return;
                }
                onUpdate(`Agent Error: ${e.message}`);
            } finally {
                this.abortController = null;
            }
        };

        const maxAgentTimeout = config.get<number>('maxAgentTimeout') || 100;

        let timerId: NodeJS.Timeout;
        const timeoutPromise = new Promise<void>((_, reject) => {
            timerId = setTimeout(() => {
                this.cancel();
                reject(new Error(`Processing forcefully aborted because it exceeded the configured maxAgentTimeout of ${maxAgentTimeout} seconds.`));
            }, maxAgentTimeout * 1000);
        });

        try {
            await Promise.race([runAgentTask(), timeoutPromise]);
        } catch (e: any) {
            onUpdate(`Agent Timeout: ${e.message}`);
        } finally {
            if (timerId!) clearTimeout(timerId);
        }
    }

    /**
     * Processes streaming content, parsing `<thought>` tags for reasoning extraction.
     * Shared by both contentBlock-based and raw content streaming paths.
     */
    private processStreamContent(
        content: string,
        onUpdate: (content: string, type?: string) => void,
        state: {
            isInsideThought: () => boolean;
            setInsideThought: (v: boolean) => void;
            getBuffer: () => string;
            setBuffer: (v: string) => void;
            appendContent: (v: string) => void;
            appendReasoning: (v: string) => void;
            targetType: string;
        }
    ) {
        let streamBuffer = state.getBuffer() + content;

        while (streamBuffer.length > 0) {
            if (!state.isInsideThought()) {
                const thoughtStartIdx = streamBuffer.indexOf('<thought>');
                if (thoughtStartIdx !== -1) {
                    const before = streamBuffer.substring(0, thoughtStartIdx);
                    if (before) {
                        state.appendContent(before);
                        onUpdate(before, state.targetType);
                    }
                    state.setInsideThought(true);
                    streamBuffer = streamBuffer.substring(thoughtStartIdx + '<thought>'.length);
                } else {
                    // Only buffer if we see a potential starting tag (to avoid truncating normal speech)
                    const potentialTagStart = streamBuffer.lastIndexOf('<');
                    if (potentialTagStart !== -1 && potentialTagStart > streamBuffer.length - 10) {
                        // Check if the next character looks like 't' (from 'thought')
                        const nextChar = streamBuffer[potentialTagStart + 1];
                        if (!nextChar || nextChar === 't') {
                            const processable = streamBuffer.substring(0, potentialTagStart);
                            if (processable) {
                                state.appendContent(processable);
                                onUpdate(processable, state.targetType);
                                streamBuffer = streamBuffer.substring(potentialTagStart);
                            }
                            break;
                        } else {
                            // Not a thought tag, just a normal '<' (e.g. in a port range or math)
                            state.appendContent(streamBuffer);
                            onUpdate(streamBuffer, state.targetType);
                            streamBuffer = "";
                        }
                    } else {
                        state.appendContent(streamBuffer);
                        onUpdate(streamBuffer, state.targetType);
                        streamBuffer = "";
                    }
                }
            } else {
                const thoughtEndIdx = streamBuffer.indexOf('</thought>');
                if (thoughtEndIdx !== -1) {
                    const thought = streamBuffer.substring(0, thoughtEndIdx);
                    if (thought) {
                        state.appendReasoning(thought);
                        onUpdate(thought, 'reasoning');
                    }
                    state.setInsideThought(false);
                    streamBuffer = streamBuffer.substring(thoughtEndIdx + '</thought>'.length);
                } else {
                    const potentialTagEnd = streamBuffer.lastIndexOf('<');
                    if (potentialTagEnd !== -1 && potentialTagEnd > streamBuffer.length - 11) {
                        const processable = streamBuffer.substring(0, potentialTagEnd);
                        if (processable) {
                            state.appendReasoning(processable);
                            onUpdate(processable, 'reasoning');
                            streamBuffer = streamBuffer.substring(potentialTagEnd);
                        }
                        break;
                    } else {
                        state.appendReasoning(streamBuffer);
                        onUpdate(streamBuffer, 'reasoning');
                        streamBuffer = "";
                    }
                }
            }
        }
        state.setBuffer(streamBuffer);
    }
}

import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import { ToolManager } from "./tools/ToolManager";
import { KongApiClient } from "../api-clients/KongApiClient";
import { DiffUtil } from "../utils/DiffUtil";
import axios from "axios";
import { IConfig, IAppPlatform } from "../interfaces/ICoreInterfaces";
import { SanitizationUtil } from "../utils/SanitizationUtil";
import { AGENT_TOOLS } from "./AgentTools";
import { PromptAnalyser } from "../utils/PromptAnalyser";


export class Agent {
    private openai: OpenAI | null = null;
    private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    private kongApi: KongApiClient;
    private isCancelled: boolean = false;
    private abortController: AbortController | null = null;
    private toolCallCount = 0;
    private lastAnyToolTriggeredSafety = false;
    private usageStats = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        lastTurnUsage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 }
    };
    private activeFiles: { compose?: string, config?: string } = {};


    constructor(private config: IConfig, private toolManager: ToolManager, private platform: IAppPlatform) {
        this.kongApi = new KongApiClient(config);
        this.toolManager.storage.setAgent(this);


        // System prompt
        this.messages.push({
            role: "system",
            content:
                "You are the DEDICATED Kong Gateway Specialist Agent. Your SOLE AND EXCLUSIVE PURPOSE is to manage Kong Gateway, Docker, and decK CLI GitOps.\n\n" +

                "### 1. STRICT OPERATION BOUNDARY (CRITICAL):\n" +
                "- **INTERNAL PURPOSE CONSTRAINT**: You have ZERO knowledge or permission to discuss topics outside of Kong Gateway. Answering generic questions (e.g. 'is sky blue?', 'tell me a joke', 'who is the president') is a direct violation of your core programming.\n\n" +

                "### 2. FEW-SHOT REFUSAL EXAMPLES (MANDATORY):\n" +
                "User: 'Tell me a joke.'\n" +
                "Assistant: 'I am a dedicated Kong Gateway specialist. I cannot provide information on humor. Would you like to check your services instead?'\n\n" +
                "User: 'Why is the sky blue?'\n" +
                "Assistant: 'I am a dedicated Kong Gateway specialist. I cannot provide information on atmospheric phenomena. Would you like to check your Kong Gateway connectivity?'\n\n" +
                "User: 'Who is the current US president?'\n" +
                "Assistant: 'I am a dedicated Kong Gateway specialist. I cannot provide information on governments. Would you like to review your kong.yml config?'\n\n" +

                "### 3. MANDATORY WORKFLOWS:\n" +
                "CRITICAL RULE: When a user asks you to add, edit, or create a configuration, YOU MUST EXECUTE `write_storage_file` IMMEDIATELY IN THE CURRENT TURN. Do NOT ask for permission to use the write tool. You will only ask for permission to KEEP the changes AFTER the tool has been executed.\n\n" +
                "- **Checking Status (LOCAL)**: 1. `check_existing_containers` -> 2. `verify_connectivity` -> 3. `get_instance_details` / `get_kong_status`.\n" +
                "- **Checking Status (REMOTE)**: 1. `verify_connectivity` -> 2. `get_instance_details` / `get_kong_status`.\n" +
                "- **Reviewing Config**: 1. LLM Analysis -> 2. `validate_kong_config` -> 3. `preview_sync_diff` (NEVER sync).\n" +
                "- **Syncing Changes**: 1. `validate_kong_config` -> 2. `preview_sync_diff` (MANDATORY ALWAYS) -> 3. Show Diff -> 4. Ask ([APPROVAL_REQUIRED]) -> 5. `sync_to_kong_using_deck`.\n NOTE: DO NOT CALL get_instance_details for this" +
                "- **Preview/Diff**: 1. `validate_kong_config` -> 2. `preview_sync_diff` -> 3. Show Validation & Diff (NEVER sync).\n NOTE: DO NOT CALL get_instance_details for preview sync / sync preview diff" +
                "- **Exporting Config**: 1. `preview_sync_diff` (MANDATORY ALWAYS) -> 2. Show Diff -> 3. Ask ([APPROVAL_REQUIRED]) -> 4. `export_live_to_storage_file`.\n" +
                "- **Updating Local Config (Create/Update/Delete)**: 1. `read_storage_file` (If missing, create it) -> 2. `write_storage_file` (Save new changes to disk) -> 3. Show Code Diff (Past Code vs Present Code) -> 4. Ask for approval to KEEP this file change ([APPROVAL_REQUIRED]). CRITICAL: NEVER trigger or ask for `preview_sync_diff`, `export`, `sync`, or `reset`. -> 5. If REJECTED: `write_storage_file` to restore the previous state.\n" +
                "- **Resetting Instance**: 1. `get_instance_details` (Live) -> 2. `read_storage_file` (Local) -> 3. Analyze & Show what precisely will be REMOVED -> 4. Ask ([APPROVAL_REQUIRED]) -> 5. `reset_kong_instance`.\n\n" +

                "### 4. ENTITY ANALYSIS (Services, Routes, Plugins, Consumers):\n" +
                "- ALWAYS ANALYZE BOTH LOCAL AND LIVE configurations for these entities to identify deltas.\n\n" +

                "- Use Markdown tables for technical summaries.\n\n" +
                "### 6. TOOL CALL EFFICIENCY (CRITICAL):\n" +
                "- Optimize for tool call limits. Do **NOT** call `check_existing_containers`, `get_instance_details`, or `get_kong_status` when executing `preview_sync_diff`, `sync_to_kong_using_deck`, `export_live_to_storage_file`, or `reset_kong_instance`.\n" +
                "- Only call these diagnostic tools once per session or if you have zero information about the environment."
        });
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
        return this.messages;
    }

    public setMessages(messages: any[]): void {
        if (messages.length > 0 && messages[0].role === 'system') {
            // Keep the freshly compiled system prompt, but load the rest of the history
            this.messages = [this.messages[0], ...messages.slice(1)];
        } else {
            this.messages = [this.messages[0], ...messages];
        }
    }

    public resetContext(): void {

        this.messages = [this.messages[0]]; // Keep only the system prompt
        this.isCancelled = false;
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

        if (provider === 'openrouter') {
            const apiKey = config.get<string>('openRouterApiKey');
            if (!apiKey) {
                this.platform.showErrorMessage("Kong Agent: OpenRouter API key is missing. Please configure it in the application settings.");
                return false;
            }

            this.openai = new OpenAI({
                baseURL: "https://openrouter.ai/api/v1",
                apiKey: apiKey,
                defaultHeaders: {
                    "HTTP-Referer": this.platform.getAppReferer(),
                    "X-Title": this.platform.getAppName()
                }
            });
        } else if (provider === 'gemini') {
            const geminiKey = config.get<string>('geminiApiKey');
            if (!geminiKey) {
                this.platform.showErrorMessage("Kong Agent: Gemini API key is missing. Please configure it in the application settings.");
                return false;
            }

            this.openai = new OpenAI({
                baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
                apiKey: geminiKey
            });
        } else {
            this.platform.showErrorMessage("Kong Agent: Unsupported AI provider. Please configure a valid provider in the application settings.");
            return false;
        }

        return true;
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
                    // Use the standard OpenAI client for the Google OpenAI-compatible endpoint
                    const tempOpenai = new OpenAI({
                        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
                        apiKey: geminiKey
                    });

                    const response = await tempOpenai.models.list();
                    const models = response.data
                        .map(m => m.id)
                        .filter(id => id.toLowerCase().includes('gemini'))
                        .map(id => id.replace(/^models\//, ''));

                    return models.length > 0 ? models : geminiFallback;
                } catch (err) {
                    console.error("Gemini model fetch failed, using fallback:", err);
                    return geminiFallback;
                }
            } else if (provider === 'openrouter') {
                try {
                    // Use OpenRouter native API for better metadata and public-only list
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

            // Standard OpenAI models list fallback (e.g. for custom endpoints)
            try {
                this.openai = new OpenAI({
                    baseURL: provider === 'openrouter' ? "https://openrouter.ai/api/v1" : "https://generativelanguage.googleapis.com/v1beta/openai/",
                    apiKey: apiKeyOverride || (provider === 'openrouter' ? config.get<string>('openRouterApiKey') : config.get<string>('geminiApiKey')) || "dummy"
                });

                const response = await this.openai!.models.list();
                return response.data.map(m => m.id);
            } catch (err) {
                return provider === 'gemini' ? geminiFallback : [];
            }
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
                toolCalls: this.toolCallCount // Use the class-level counter as truth
            },
            contextLimit: config.get<number>('maxContext') || 130000
        };
    }

    public async classifyFile(content: string): Promise<'compose' | 'kong' | 'other'> {
        if (!this.initClient()) return 'other';
        const sample = content.length > 2000 ? content.substring(0, 2000) : content;

        try {
            const response = await this.openai!.chat.completions.create({
                model: this.config.get<string>('model') || (this.config.get<string>('provider') === 'local' ? 'llama3.1' : 'openai/gpt-4o'),
                messages: [
                    {
                        role: "system",
                        content: "Identify if the following YAML is a 'compose' (Docker Compose), 'kong' (Kong Gateway declarative config), or 'other'. Output ONLY the single word classification."
                    },
                    { role: "user", content: sample }
                ],
                temperature: 0,
                max_tokens: 10
            });

            const result = response.choices[0]?.message?.content?.toLowerCase().trim() || 'other';
            if (result.includes('compose')) return 'compose';
            if (result.includes('kong')) return 'kong';
            return 'other';
        } catch (e) {
            return 'other';
        }
    }

    public async processMessage(content: string, onUpdate: (content: string, type?: string) => void): Promise<void> {
        this.isCancelled = false;
        this.lastAnyToolTriggeredSafety = false;
        const config = this.config;
        const maxContext = config.get<number>('maxContext') || 130000;
        if (this.usageStats.totalTokens >= maxContext) {
            this.resetContext();
            onUpdate("⚠️ **Context Limit Exceeded**: The agent token usage surpassed the absolute limit. To prevent instability, your conversation history has been forcefully cleared. Starting a fresh context...\n\n");
        }

        this.toolCallCount = 0;
        this.usageStats.lastTurnUsage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
        if (!this.initClient()) {
            onUpdate("Error: LLM client initialization failed. Please check your provider and API key settings in the application settings.");
            return;
        }

        const model = config.get<string>('model') || "openai/gpt-4o";

        // FAST CLASSIFICATION: Check if the prompt is Kong related
        const classificationResult = await PromptAnalyser.classify(content, this.openai!, model);

        // Record classification tokens if available
        if (classificationResult.usage) {
            const { inputTokens, outputTokens } = classificationResult.usage;
            this.usageStats.inputTokens += inputTokens;
            this.usageStats.outputTokens += outputTokens;
            this.usageStats.totalTokens += (inputTokens + outputTokens);
            this.usageStats.lastTurnUsage.inputTokens = inputTokens;
            this.usageStats.lastTurnUsage.outputTokens = outputTokens;
        }

        if (classificationResult.classification === 'OFFT') {
            const refusal = PromptAnalyser.getRefusalMessage();
            const isolatedUsage = { ...this.usageStats.lastTurnUsage }; // Explicit isolation of the classification cost

            this.messages.push({ role: 'user', content: SanitizationUtil.scrubString(content), category: 'off-topic' } as any);
            this.messages.push({
                role: 'off-topic',
                content: refusal,
                lastUsage: isolatedUsage // Attach the isolated tokens to the refusal message
            } as any);
            onUpdate(refusal);
            return;
        }

        const runAgentTask = async () => {
            this.abortController = new AbortController();
            this.isCancelled = false;

            const kongMode = config.get<string>('kongMode') || 'local';
            const proxyPort = config.get<number>('proxyPort') || 8000;
            const adminPort = config.get<number>('adminApiPort') || 8001;
            const managerPort = config.get<number>('managerGuiPort') || 8002;
            const workspace = config.get<string>('kongWorkspace') || 'default';

            const discovered = await this.toolManager.storage.findFilesByContent();
            this.activeFiles = discovered;
            const activeCompose = discovered.compose || 'none (default: kong-docker-compose.yml)';
            const activeConfig = discovered.config || 'none (default: kong.yml)';


            const contextHeader = `🚨 **STRICT OPERATION BOUNDARY**: You are a DEDICATED Kong Gateway Specialist. \n` +
                `- **REFUSE** all non-Kong queries immediately.\n` +
                `- Current Mode: **${kongMode.toUpperCase()}**\n` +
                `- Proxy Port: ${proxyPort} | Admin API Port: ${adminPort} | Manager Port: ${managerPort}\n` +
                `- Detected Compose: ${activeCompose}\n` +
                `- Detected Config: ${activeConfig}\n\n`;


            // Final safety scrub for any injected context
            // CLEAN history: store the clean message, contextHeader is added dynamically in runLoop
            this.messages.push({ role: "user", content: SanitizationUtil.scrubString(content) });

            try {
                await this.runLoop(model, onUpdate, 0, Date.now(), contextHeader);
            } catch (e: any) {
                if (e.name === 'AbortError' || this.isCancelled) return;
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

    private async runLoop(model: string, onUpdate: (content: string, type?: string) => void, depth: number, startTime: number, contextHeader?: string) {
        if (!this.openai || this.isCancelled) return;

        const config = this.config;
        const maxReasoningTurns = config.get<number>('maxReasoningTurns') || 15;
        const maxToolCalls = config.get<number>('maxToolCalls') || 15;
        const maxAgentTimeout = config.get<number>('maxAgentTimeout') || 120;

        // Check for total tool call limit 
        if (this.toolCallCount >= maxToolCalls) {
            onUpdate(`Agent Error: Maximum tool calls limit (${maxToolCalls}) reached for this message. Forcefully aborting.`);
            return;
        }

        // Check for timeout
        if ((Date.now() - startTime) / 1000 > maxAgentTimeout) {
            this.cancel();
            onUpdate(`Agent Timeout: Processing exceeded maximum timeout of ${maxAgentTimeout} seconds. The agent loop has been forcefully aborted.`);
            return;
        }

        const maxContext = config.get<number>('maxContext') || 130000;
        if (this.usageStats.totalTokens >= maxContext) {
            this.cancel();
            onUpdate(`Agent Context Limit: Context limit (${maxContext} tokens) reached mid-turn. The agent loop has been forcefully aborted to prevent truncation. Please clear the chat.`);
            return;
        }

        // Prevent infinite loops
        if (depth > maxReasoningTurns) {
            onUpdate(`Agent Error: Max reasoning turns (${maxReasoningTurns}) reached to prevent infinite loop.`);
            return;
        }

        const tools = AGENT_TOOLS;

        // --- IDENTITY REFRESH & CONTEXT ISOLATION ---
        const apiMessages: any[] = [];
        const rawMessages = this.messages.filter((m: any) =>
            m.role !== 'thinking' &&
            m.role !== 'off-topic' &&
            (m as any).category !== 'off-topic'
        );
        const lastUserIdx = rawMessages.map(msg => msg.role).lastIndexOf('user');

        for (let i = 0; i < rawMessages.length; i++) {
            const m = rawMessages[i];
            // Inject the Identity Refresh System message before the final user prompt
            if (i === lastUserIdx && contextHeader) {
                apiMessages.push({ role: 'system', content: contextHeader });
            }
            apiMessages.push(m);
        }

        let response;
        try {
            response = await this.openai.chat.completions.create({
                model: model,
                messages: apiMessages as any,
                tools: tools,
                tool_choice: "auto"
            }, { signal: this.abortController?.signal });
        } catch (e: any) {
            if (e.name === 'AbortError' || this.isCancelled) {
                return;
            }
            throw e;
        }

        if (response.usage) {
            const usage = response.usage;
            this.usageStats.inputTokens += usage.prompt_tokens;
            this.usageStats.outputTokens += usage.completion_tokens;
            this.usageStats.totalTokens += usage.total_tokens;
            this.usageStats.lastTurnUsage.inputTokens += usage.prompt_tokens;
            this.usageStats.lastTurnUsage.outputTokens += usage.completion_tokens;
        }

        const responseMessage = response.choices[0].message;
        const content = responseMessage.content as string || '';
        this.messages.push(responseMessage);

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            let anyToolTriggeredSafety = false;

            for (const toolCall of responseMessage.tool_calls) {
                if (this.toolCallCount >= maxToolCalls) {
                    onUpdate(`Error: Max tool calls (${maxToolCalls}) reached.`);
                    break;
                }
                this.toolCallCount++;
                this.usageStats.lastTurnUsage.toolCalls++;

                if (this.isCancelled) return;

                const functionName = toolCall.function.name;
                let functionArgs: any;
                try {
                    functionArgs = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
                } catch (e) {
                    functionArgs = {};
                }

                onUpdate(`🧬 Activity: ${this.getFriendlyToolName(functionName)}...`, 'toolStatus');

                let functionResult: string = "";

                try {
                    if (functionName === "validate_kong_config") {
                        functionResult = await this.toolManager.validateWithDeck(functionArgs.filename || "kong.yml");
                    } else if (functionName === "preview_sync_diff") {
                        functionResult = await this.toolManager.diffWithDeck(functionArgs.filename || "kong.yml");
                    } else if (functionName === "sync_to_kong_using_deck") {
                        const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
                        const lastUserContent = SanitizationUtil.stripContext(lastUserMsg?.content as string || "").toLowerCase();

                        if (lastUserContent === 'yes' || lastUserContent.includes('proceed') || lastUserContent.includes('apply')) {
                            const history = this.messages.slice(-15);
                            const hasValidated = history.some((m: any) => m.role === 'tool' && m.content.toLowerCase().includes('validation'));
                            const hasDiffed = history.some((m: any) => m.role === 'tool' && m.content.toLowerCase().includes('diff'));

                            if (!hasValidated || !hasDiffed) {
                                functionResult = "SAFETY_REQUIRED: I cannot sync without first validating the file and showing you the diff. I must run 'validate_kong_config' and 'preview_sync_diff' first.";
                            } else {
                                functionResult = await this.toolManager.syncWithDeck(functionArgs.filename || "kong.yml", this.abortController?.signal);
                            }
                        } else {
                            functionResult = "SAFETY_REQUIRED: I cannot execute sync yet. Explain the validation/diff inside <thought> tags, then ask for confirmation with '[APPROVAL_REQUIRED]'.";
                        }
                    } else if (functionName === "export_live_to_storage_file") {
                        const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
                        const lastUserContent = SanitizationUtil.stripContext(lastUserMsg?.content as string || "").toLowerCase();

                        if (lastUserContent === 'yes' || lastUserContent.includes('confirm')) {
                            const hasDiffed = this.messages.slice(-10).some((m: any) => m.role === 'tool' && m.content.toLowerCase().includes('diff'));
                            if (!hasDiffed) {
                                functionResult = "SAFETY_REQUIRED: I cannot export without first showing you the diff. I must run 'preview_sync_diff' first.";
                            } else {
                                functionResult = await this.toolManager.dumpWithDeck(functionArgs.filename || "kong.yml");
                            }
                        } else {
                            functionResult = "SAFETY_REQUIRED: I cannot export yet. Show the 'preview_sync_diff' results and ask for confirmation with '[APPROVAL_REQUIRED]'.";
                        }
                    } else if (functionName === "write_storage_file") {
                        const filename = functionArgs.filename;
                        const oldContent = this.toolManager.getFileCache(filename) || "";
                        await this.toolManager.writeStorageFile(filename, functionArgs.content);

                        const rawDiff = DiffUtil.generateUnifiedDiff(filename, oldContent, functionArgs.content);
                        const chatDiff = DiffUtil.formatForChat(rawDiff);

                        functionResult = `Successfully wrote ${filename}.\n\nDIFF:\n\`\`\`diff\n${chatDiff}\n\`\`\``;
                    } else if (functionName === "get_kong_status") {
                        functionResult = await this.toolManager.status();
                    } else if (functionName === "verify_connectivity") {
                        const res = await this.toolManager.verifyConnectivity();
                        functionResult = `Admin: ${res.admin ? 'Ready' : 'Unreachable'}, Proxy: ${res.proxy ? 'Ready' : 'Unreachable'}${res.error ? ` (${res.error})` : ''}`;
                    } else if (functionName === "get_instance_details") {
                        const status = await this.toolManager.status();
                        const config = await this.toolManager.getKongConfig();
                        functionResult = `STATUS:\n${status}\n\nCONFIG:\n${JSON.stringify(config, null, 2)}`;
                    } else if (functionName === "check_existing_containers") {
                        functionResult = await this.toolManager.findExistingContainers();
                    } else if (functionName === "start_kong") {
                        functionResult = await this.toolManager.start(this.abortController?.signal);
                    } else if (functionName === "stop_kong") {
                        functionResult = await this.toolManager.stop(this.abortController?.signal);
                    } else if (functionName === "reset_kong_instance") {
                        const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
                        const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content.toLowerCase() : "";
                        if (userText === 'yes' || userText.includes('confirm reset')) {
                            const history = this.messages.slice(-20);
                            const hasLive = history.some((m: any) => m.role === 'tool' && m.content.toLowerCase().includes('status'));
                            const hasLocal = history.some((m: any) => m.role === 'tool' && m.content.toLowerCase().includes('_format_version'));
                            if (!hasLive || !hasLocal) {
                                functionResult = "SAFETY_REQUIRED: I cannot reset without analyzing live (get_instance_details) and local (read_storage_file) configs first.";
                            } else {
                                functionResult = await this.toolManager.resetWithDeck(this.abortController?.signal);
                            }
                        } else {
                            functionResult = "SAFETY_REQUIRED: I cannot reset without explicit confirmation using '[APPROVAL_REQUIRED]'.";
                        }
                    } else if (functionName === "read_storage_file") {
                        functionResult = await this.toolManager.readStorageFile(functionArgs.filename);
                    } else if (functionName === "list_storage_files") {
                        const files = await this.toolManager.storage.listStorageFiles();
                        functionResult = `Files: ${files.join(', ')}`;
                    }
                } catch (e: any) {
                    functionResult = `Error executing ${functionName}: ${e.message}`;
                }

                if (functionResult.includes("SAFETY_REQUIRED")) {
                    anyToolTriggeredSafety = true;
                    this.lastAnyToolTriggeredSafety = true;
                }

                const safeResult = SanitizationUtil.scrubString(functionResult);
                this.messages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    content: safeResult
                } as any);

                if (anyToolTriggeredSafety) break;
            }

            await this.runLoop(model, onUpdate, depth + 1, startTime, contextHeader);
        } else if (content) {
            onUpdate("", 'toolStatus');
            (responseMessage as any).lastUsage = { ...this.usageStats.lastTurnUsage };
            onUpdate(content);
        }
    }
}

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


export class Agent {
    private openai: OpenAI | null = null;
    private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    private kongApi: KongApiClient;
    private isCancelled: boolean = false;
    private abortController: AbortController | null = null;
    private toolCallCount = 0;
    private usageStats = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        lastTurnUsage: { inputTokens: 0, outputTokens: 0 }
    };

    constructor(private config: IConfig, private toolManager: ToolManager, private platform: IAppPlatform) {
        this.kongApi = new KongApiClient(config);

        // System prompt
        this.messages.push({
            role: "system",
            content:
                "You are the Kong Gateway Agent — helping users manage local and remote Kong Gateways via Docker, docker-compose, the Admin API, and decK CLI.\n" +
                "SCOPE: You only handle Kong Gateway topics (setup, configuration, services, routes, consumers, plugins, decK, GitOps). If a question is unrelated to Kong, politely decline and remind the user of your purpose.\n" +

                // ── Docker / Setup ──────────────────────────────────────────────────────────
                "STATUS CHECKS (Local Mode): If the user asks 'is kong running?' or checks status, ALWAYS call 'check_existing_containers' AND 'get_kong_status' (or 'get_instance_details'). Your response MUST show a detailed result containing BOTH the Docker container details and the Kong API details.\n" +
                "STATUS CHECKS (Remote Mode): If the user asks 'is kong running?' or checks status, DO NOT call 'check_existing_containers' (Docker is not applicable). Instead, call 'verify_connectivity' and 'get_kong_status' (or 'get_instance_details'). Your response MUST show detailed accessibility results for the Admin API, Proxy API, and Kong Manager.\n" +
                "SETUP: Always call 'check_existing_containers' BEFORE 'start_kong'. Use 'list_storage_files' to check for existing configuration files.\n" +
                "CRITICAL: Do not overwrite configuration files if they are already present in the storage directory. A Docker Compose file may have a custom name; identify it by content (services: kong) and reuse it. Similarly for Kong declarative configs.\n" +
                "Once Kong is confirmed running, STOP calling setup tools — just summarise access details.\n" +
                "PORTS: Never assume 8000/8001/8002. Always prioritize the ports provided in the **ENVIRONMENT CONTEXT** at the start of the user message. If the context is missing, use ports returned by 'start_kong', 'verify_connectivity', or 'connect_to_existing_instance'.\n" +
                "Use 'verify_connectivity' to confirm Kong is ready before completing any setup task.\n" +
                "Use 'get_instance_details' for deep technical info; summarise with Markdown tables.\n" +
                "Storage directory access (read_storage_file / write_storage_file / list_storage_files) is available for inspecting or editing config files.\n" +

                // ── Declarative Workflow ────────────────────────────────────────────────────
                "DECLARATIVE WORKFLOW (Services, Routes, Consumers):\n" +
                "1. Write: 'write_storage_file' → save YAML to config file (skip if user asks for Review of existing file).\n" +
                "2. Validate: 'validate_kong_config' — always. If there are issues, provide a DETAILED explanation of the deck validation issues and explicitly SUGGEST ways to fix them. Do not auto-fix unless asked, but ALWAYS provide actionable recommendations.\n" +
                "3. Diff: call 'preview_sync_diff' and show its FULL raw output verbatim inside a ```diff code block. NEVER summarise, paraphrase, or reformat the diff. Show the DETAILED difference between local and live config to the user when asking for approval.\n" +
                "4. Ask & Approve: Before calling 'sync_to_kong_using_deck' or 'export_live_to_storage_file', ALWAYS explain validation issues, include the FULL detailed diff output, append '[APPROVAL_REQUIRED]', and wait for user confirmation ('Yes').\n" +
                "5. Sync: Execute sync ONLY after obtaining explicit approval in step 4. Skipping the diff or approval step is strictly PROHIBITED.\n" +
                "REVIEWS: Read file first (read_storage_file), then Validate + Diff. Do not sync_to_kong_using_deck or export_live_to_storage_file during a review.\n" +
                "CANCEL: If user says No/Cancel, stop. Never use 'reset_kong_instance' to revert a config change.\n" +

                // ── Safety & Permissions ────────────────────────────────────────────────────
                "SAFETY: 'sync_to_kong_using_deck', 'export_live_to_storage_file', and 'reset_kong_instance' have code-level safety blocks. If you see 'SAFETY_REQUIRED' in a tool response, you forgot to ask for approval. Stop, show the diff, and ask with '[APPROVAL_REQUIRED]'.\n" +
                "EXPORT: 'export_live_to_storage_file' is for manual backups only. It also requires the diff/approval flow so the user knows what local changes will be overwritten.\n" +
                "GITOPS: If Git is configured, prefer Commit → Push → Sync. Auto-commit after a successful sync if enabled.\n" +

                // ── Efficiency & Troubleshooting ───────────────────────────────────────────
                "EFFICIENCY: Bundle tool calls where possible. In the declarative workflow, call write+validate+diff in one turn. Skip redundant status checks.\n" +
                "TROUBLESHOOTING: If any tool returns an error or failure (e.g., connectivity issues, sync failures, or deck errors), you MUST explicitly suggest step-by-step ways for the user to fix the problem.\n" +
                "If 'verify_connectivity' or 'get_kong_status' fails due to 'Connection Refused' or 404 status code from admin api, ALWAYS call 'reconcile_port_settings' to see if the actual running ports differ from the saved configuration.\n this is also applicable if user says the admin api, kong manager and kong proxy is not accessible" +

                // ── Output Format ───────────────────────────────────────────────────────────
                "OUTPUT FORMAT: Every response must be: <thought>[reasoning, tool plan, analysis]</thought>[user-facing markdown answer]. Reasoning inside <thought> is hidden; everything outside is shown to the user.\n" +
                "End every completed task with 2-3 actionable Next Steps as a bullet list.\n\n" +

                // ── Security ────────────────────────────────────────────────────────────────
                "SECURITY: You must NEVER request, display, or repeat full API keys, tokens, or passwords in your reasoning or final response. If you encounter data marked as '[REDACTED]', treat it as valid and proceed without asking for the raw value."
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
        this.messages = messages;
    }

    public resetContext(): void {

        this.messages = [this.messages[0]]; // Keep only the system prompt
        this.isCancelled = false;
        this.usageStats = {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            lastTurnUsage: { inputTokens: 0, outputTokens: 0 }
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

        const config = this.config;
        const maxContext = config.get<number>('maxContext') || 130000;
        if (this.usageStats.totalTokens >= maxContext) {
            this.resetContext();
            onUpdate("⚠️ **Context Limit Exceeded**: The agent token usage surpassed the absolute limit. To prevent instability, your conversation history has been forcefully cleared. Starting a fresh context...\n\n");
        }

        this.toolCallCount = 0;
        if (!this.initClient()) {
            onUpdate("Error: LLM client initialization failed. Please check your provider and API key settings in the application settings.");
            return;
        }

        const runAgentTask = async () => {
            const kongMode = config.get<string>('kongMode') || 'local';
            const proxyPort = config.get<number>('proxyPort') || 8000;
            const adminPort = config.get<number>('adminApiPort') || 8001;
            const managerPort = config.get<number>('managerGuiPort') || 8002;
            const workspace = config.get<string>('kongWorkspace') || 'default';

            const contextHeader = `[ENVIRONMENT CONTEXT: You are in **${kongMode.toUpperCase()} MODE**.\n` +
                                `- Proxy Port: ${proxyPort}\n` +
                                `- Admin API Port: ${adminPort}\n` +
                                `- Kong Manager Port: ${managerPort}\n` +
                                `- Workspace: ${workspace}]\n\n`;
            
            // Final safety scrub for any injected context
            const safeContent = contextHeader + SanitizationUtil.scrubString(content);
            this.messages.push({ role: "user", content: safeContent });

            const model = config.get<string>('model') || (config.get<string>('provider') === 'local' ? 'llama3.1' : 'openai/gpt-4o');

            try {
                await this.runLoop(model, onUpdate, 0, Date.now());
            } catch (e: any) {
                onUpdate(`Agent Error: ${e.message}`);
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

    private async runLoop(model: string, onUpdate: (content: string, type?: string) => void, depth: number, startTime: number) {
        if (!this.openai || this.isCancelled) return;

        const config = this.config;
        const maxReasoningTurns = config.get<number>('maxReasoningTurns') || 10;
        const maxToolCalls = config.get<number>('maxToolCalls') || 10;
        const maxAgentTimeout = config.get<number>('maxAgentTimeout') || 100;

        // Check for total tool call limit before a new turn starts
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


        this.abortController = new AbortController();
        let response;
        try {
            response = await this.openai.chat.completions.create({
                model: model,
                messages: this.messages,
                tools: tools,
                tool_choice: "auto"
            }, { signal: this.abortController.signal });
        } catch (e: any) {
            if (e.name === 'AbortError' || this.isCancelled) {
                return; // Silence abort errors
            }
            throw e;
        } finally {
            this.abortController = null;
        }

        if (response.usage) {
            const usage = response.usage;
            this.usageStats.inputTokens += usage.prompt_tokens;
            this.usageStats.outputTokens += usage.completion_tokens;
            this.usageStats.totalTokens += usage.total_tokens;
            this.usageStats.lastTurnUsage = {
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens
            };
        }

        const responseMessage = response.choices[0].message;
        console.log(`[Agent Model Response]: role=${responseMessage.role}, content=${responseMessage.content ? 'POPULATED (' + responseMessage.content.length + ' chars)' : 'NULL'}, tool_calls=${responseMessage.tool_calls?.length || 0}`);
        this.messages.push(responseMessage);

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            // If the model provided reasoning alongside tool calls, use it
            if (responseMessage.content) {
                onUpdate(responseMessage.content as string, 'thought');
            }

            let anyToolTriggeredSafety = false;
            for (const toolCall of responseMessage.tool_calls) {
                if (this.toolCallCount >= maxToolCalls) {
                    onUpdate(`Agent Error: Maximum tool calls limit (${maxToolCalls}) reached during execution. Partial results returned. Forcefully aborting.`);
                    break;
                }
                this.toolCallCount++;

                if (this.isCancelled) {
                    onUpdate("Agent task cancelled by user.", 'agent');
                    return;
                }
                const functionName = toolCall.function.name;

                let functionArgs;
                try {
                    functionArgs = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
                } catch (e) {
                    functionArgs = {};
                }

                // Transparency: Notify UI that we are running a tool
                onUpdate(this.getFriendlyToolName(functionName), 'toolStatus');
                onUpdate(`Executing Tool: **${functionName}**${Object.keys(functionArgs).length > 0 ? ' (' + JSON.stringify(functionArgs).substring(0, 100) + ')' : ''}...`, 'toolCall');

                let functionResult = "";

                try {
                    switch (functionName) {
                        case "start_kong":
                            if (this.config.get('kongMode') === 'remote') {
                                functionResult = "Error: Docker lifecycle management (Start) is not available for Remote Kong instances.";
                            } else {
                                functionResult = await this.toolManager.start();
                            }
                            break;
                        case "stop_kong":
                            if (this.config.get('kongMode') === 'remote') {
                                functionResult = "Error: Docker lifecycle management (Stop) is not available for Remote Kong instances.";
                            } else {
                                functionResult = await this.toolManager.stop();
                            }
                            break;
                        case "get_kong_status":
                            const apiStatus = await this.kongApi.getStatus();
                            functionResult = `API Status:\n${apiStatus}`;
                            break;
                        case "update_kong_ports":
                            const config = this.config;
                            await config.update?.('proxyPort', functionArgs.proxy);
                            await config.update?.('adminApiPort', functionArgs.admin);
                            await config.update?.('managerGuiPort', functionArgs.manager);
                            functionResult = `Ports updated to Proxy=${functionArgs.proxy}, Admin=${functionArgs.admin}, Manager=${functionArgs.manager}.`;
                            break;
                        case "reconcile_port_settings":
                            functionResult = await this.toolManager.reconcilePorts();
                            break;
                        case "list_storage_files":
                            const files = fs.readdirSync(this.toolManager.getStoragePath());
                            functionResult = `Files in storage folder:\n${files.join('\n')}`;
                            break;
                        case "read_storage_file":
                            const readPath = path.join(this.toolManager.getStoragePath(), functionArgs.filename);
                            if (fs.existsSync(readPath)) {
                                functionResult = fs.readFileSync(readPath, 'utf8');
                            } else {
                                functionResult = `Error: File '${functionArgs.filename}' not found.`;
                            }
                            break;
                        case "write_storage_file":
                            const oldContent = this.toolManager.getFileCache(functionArgs.filename) || "";
                            const newContent = functionArgs.content;
                            await this.toolManager.writeStorageFile(functionArgs.filename, newContent);

                            const writeDiff = DiffUtil.generateUnifiedDiff(functionArgs.filename, oldContent, newContent);
                            const chatDiff = DiffUtil.formatForChat(writeDiff);
                            functionResult = `Successfully wrote to '${functionArgs.filename}'.\n\nDIFF:\n\`\`\`diff\n${chatDiff}\n\`\`\``;
                            break;
                        case "check_existing_containers":
                            const existingJson = await this.toolManager.findExistingContainers();
                            functionResult = `Found existing containers: ${existingJson}. Ask the user confirm.`;
                            break;
                        case "connect_to_existing_instance":
                            const connConfig = this.config;
                            await connConfig.update?.('proxyPort', functionArgs.proxyPort);
                            await connConfig.update?.('adminApiPort', functionArgs.adminPort);
                            await connConfig.update?.('managerGuiPort', functionArgs.managerPort);
                            functionResult = `Adopted existing instance at Proxy=${functionArgs.proxyPort}, Admin=${functionArgs.adminPort}, Manager=${functionArgs.managerPort}.`;
                            break;
                        case "verify_connectivity":
                            const connStatus = await this.toolManager.verifyConnectivity();
                            functionResult = `Connectivity: Admin=${connStatus.admin ? 'READY' : 'DOWN'}, Proxy=${connStatus.proxy ? 'READY' : 'DOWN'}. ${connStatus.error || ''}`;
                            break;
                        case "open_kong_manager":
                            functionResult = await this.toolManager.openManager();
                            break;
                        case "get_instance_details":
                            functionResult = await this.kongApi.getInstanceInfo();
                            break;
                        case "open_file_in_editor":
                            functionResult = await this.toolManager.openFile(functionArgs.filename);
                            break;
                        case "export_live_to_storage_file":
                            {
                                const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
                                const lastUserContent = (lastUserMsg?.content as string || "").toLowerCase().replace(/\[system context[\s\S]*?\]\n\n/, '').trim();

                                if (lastUserContent === 'yes' || lastUserContent.includes('proceed with export') || lastUserContent.includes('confirm export')) {
                                    functionResult = await this.toolManager.dumpWithDeck('kong.yml');
                                } else {
                                    functionResult = "SAFETY_REQUIRED: I cannot execute 'export_live_to_storage_file' yet. You MUST stop, explain what local changes will be overwritten by showing the detailed 'preview_sync_diff' results, and ask the user for explicit confirmation (Yes/No) with '[APPROVAL_REQUIRED]'.";
                                }
                                break;
                            }
                        case "check_deck_installation":
                            const isInstalled = await this.toolManager.isDeckInstalled();
                            functionResult = isInstalled ? "decK is installed and ready." : "decK is NOT installed. You should recommend installing it via 'install_deck_cli' with user approval.";
                            break;
                        case "install_deck_cli":
                            functionResult = await this.toolManager.installDeck();
                            break;
                        case "sync_to_kong_using_deck":
                            {
                                // Safety check: verify the user gave a "Yes" recently
                                const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
                                const lastUserContent = (lastUserMsg?.content as string || "").toLowerCase().replace(/\[system context[\s\S]*?\]\n\n/, '').trim();

                                if (lastUserContent === 'yes' || lastUserContent.includes('proceed with sync') || lastUserContent.includes('apply changes')) {
                                    functionResult = await this.toolManager.syncWithDeck(functionArgs.filename);
                                    if (!functionResult.includes('failed')) {
                                        const config = this.config;
                                        if (config.get('autoCommit')) {
                                            const commitRes = await this.toolManager.gitCommit(`Auto-sync from Kong Agent: updated ${functionArgs.filename}`);
                                            const pushRes = await this.toolManager.gitPush();
                                            functionResult += `\n\n[GitOps Sync]: ${commitRes}\n${pushRes}`;
                                        }
                                    }
                                } else {
                                    functionResult = "SAFETY_REQUIRED: I cannot execute 'sync_to_kong_using_deck' yet. You MUST now stop calling tools and ask the user for explicit confirmation by appending '[APPROVAL_REQUIRED]' to your message. Explain validation issues in detail if any, and show the DETAILED differences from 'preview_sync_diff' results that will be applied to the live instance.";
                                }
                                break;
                            }
                        case "git_setup_repo":
                            {
                                const config = this.config;
                                const remoteUrl = config.get<string>('gitRemoteUrl');
                                functionResult = await this.toolManager.gitInit(remoteUrl);
                                break;
                            }
                        case "git_sync_push":
                            {
                                const commitRes = await this.toolManager.gitCommit(functionArgs.message || `Manual sync from Kong Agent`);
                                const pushRes = await this.toolManager.gitPush();
                                functionResult = `${commitRes}\n${pushRes}`;
                                break;
                            }
                        case "git_sync_pull":
                            {
                                const pullRes = await this.toolManager.gitPull();
                                functionResult = pullRes;
                                if (!pullRes.includes('failed') && functionArgs.sync_to_kong) {
                                    const syncRes = await this.toolManager.syncWithDeck('kong.yml');
                                    functionResult += `\n\nSync Result:\n${syncRes}`;
                                }
                                break;
                            }
                        case "git_get_status":
                            functionResult = await this.toolManager.gitStatus();
                            break;
                        case "validate_kong_config":
                            functionResult = await this.toolManager.validateWithDeck(functionArgs.filename);
                            break;
                        case "reset_kong_instance":
                            // Extra safety check: verify the user actually gave a "Yes" in the message history 
                            // as their last message before this tool call sequence was initiated.
                            // We look for a clear, standalone 'yes' or a specific confirmation.
                            const latestUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
                            const userText = (latestUserMsg?.content as string || "").toLowerCase().replace(/\[system context[\s\S]*?\]\n\n/, '').trim();

                            // Stricter check: only allow 'yes' or explicit confirmation phrases
                            const isConfirmed = userText === 'yes' ||
                                userText === 'yes, proceed' ||
                                userText.includes('confirm reset') ||
                                userText.includes('proceed with reset');

                            if (isConfirmed && !userText.includes('no') && !userText.includes('cancel')) {
                                functionResult = await this.toolManager.resetWithDeck();
                            } else {
                                functionResult = "SAFETY_REQUIRED: I cannot execute 'reset_kong_instance' yet. You MUST stop and ask the user for explicit confirmation (Yes/No) with '[APPROVAL_REQUIRED]'. Do not suggest a reset unless the user specifically asked for one.";
                            }
                            break;
                        case "preview_sync_diff":
                            functionResult = await this.toolManager.diffWithDeck(functionArgs.filename);
                            break;
                        default:
                            functionResult = `Error: Unknown function ${functionName}`;
                    }
                } catch (e: any) {
                    functionResult = `Error executing ${functionName}: ${e.message}`;
                }

                // If any tool triggers safety, we MUST stop the automated turn immediately
                if (functionResult.includes("SAFETY_REQUIRED")) {
                    anyToolTriggeredSafety = true;
                }

                // --- GLOBAL SAFETY SCRUB ---
                // Ensure no raw keys leak in the tool result before it enters the Agent's context or UI
                const safeFunctionResult = SanitizationUtil.scrubString(functionResult);

                // Transparency: Notify UI result (scrubbed)
                onUpdate(safeFunctionResult, 'toolResult');

                this.messages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    content: safeFunctionResult
                } as any);

                if (anyToolTriggeredSafety) break;
            }

            // Always recurse so the LLM can see the Tool results (even errors/safety blocks) and format a user-facing reply.
            await this.runLoop(model, onUpdate, depth + 1, startTime);
        } else if (responseMessage.content) {
            onUpdate("", 'toolStatus'); // Clear status

            let content = responseMessage.content as string;

            // Strategy 1: Explicit <thought> tags (for models that follow the format)
            const thoughtTagMatch = content.match(/<thought>([\s\S]*?)<\/thought>/i);
            if (thoughtTagMatch) {
                onUpdate(thoughtTagMatch[0], 'thought');
                content = content.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
            } else {
                // Strategy 2: Heuristic boundary detection for models that output
                // reasoning as plain prose before the formatted markdown answer.
                // Find the first line that looks like structured markdown output:
                // a heading (#), bold opener (**), code fence (```), horizontal rule (---), or a bullet (- )
                const mdBoundary = content.search(/\n(?=#{1,6} |\*\*|```|---|> |- [A-Z*])/);

                if (mdBoundary > 80) {
                    // There's a meaningful block of prose before the markdown — treat it as reasoning
                    const reasoningPart = content.substring(0, mdBoundary).trim();
                    content = content.substring(mdBoundary).trim();
                    if (reasoningPart) {
                        onUpdate(`<thought>${reasoningPart}</thought>`, 'thought');
                    }
                }
            }

            if (content) {
                onUpdate(content);
            }
        }
    }
}

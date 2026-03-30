import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import { ToolManager } from "./tools/ToolManager";
import { KongApiClient } from "../api-clients/KongApiClient";
import { DiffUtil } from "../utils/DiffUtil";
import axios from "axios";
import { IConfig, IAppPlatform } from "../interfaces/ICoreInterfaces";
import { SanitizationUtil } from "../utils/SanitizationUtil";

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
                "SETUP: Always call 'check_existing_containers' BEFORE 'start_kong'. If Kong/Postgres containers exist, show their details (Name, Image, Ports) and ask to reuse or restart. Use 'connect_to_existing_instance' to adopt an existing setup.\n" +
                "Once Kong is confirmed running, STOP calling setup tools — just summarise access details.\n" +
                "PORTS: Never assume 8000/8001/8002. Always use ports returned by 'start_kong', 'verify_connectivity', or 'connect_to_existing_instance'.\n" +
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
            const contextHeader = `[SYSTEM CONTEXT: You are currently operating in **${kongMode.toUpperCase()} MODE**.]\n\n`;

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

        const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
            {
                type: "function",
                function: {
                    name: "start_kong",
                    description: "Starts the local Kong Gateway using Docker Compose (Postgres-backed). Run this if the user asks to start Kong. Takes ~10s to boot.",
                }
            },
            {
                type: "function",
                function: {
                    name: "stop_kong",
                    description: "Stops the local Kong Gateway Docker Compose setup.",
                }
            },
            {
                type: "function",
                function: {
                    name: "get_kong_status",
                    description: "Fetches status info from Kong Admin API to test if it's reachable and running.",
                }
            },
            {
                type: "function",
                function: {
                    name: "update_kong_ports",
                    description: "Updates the configured ports for Kong Proxy, Admin API, and Manager GUI. Use this if the user agrees to switch to suggested ports after a conflict.",
                    parameters: {
                        type: "object",
                        properties: {
                            proxy: { type: "number" },
                            admin: { type: "number" },
                            manager: { type: "number" }
                        },
                        required: ["proxy", "admin", "manager"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "list_storage_files",
                    description: "Lists all files (yml, json, etc) in the current storage directory. Use this to verify which files exist before trying to read or open them.",
                }
            },
            {
                type: "function",
                function: {
                    name: "read_storage_file",
                    description: "Reads the content of a file in the storage directory for review or analysis.",
                    parameters: {
                        type: "object",
                        properties: {
                            filename: { type: "string" },
                        },
                        required: ["filename"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "write_storage_file",
                    description: "Writes content to a file in the storage directory.",
                    parameters: {
                        type: "object",
                        properties: {
                            filename: { type: "string" },
                            content: { type: "string" }
                        },
                        required: ["filename", "content"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "check_existing_containers",
                    description: "Checks if any Docker containers related to Kong or Postgres are currently running.",
                }
            },
            {
                type: "function",
                function: {
                    name: "connect_to_existing_instance",
                    description: "Adopts an existing Kong instance by updating the Agent's local configuration.",
                    parameters: {
                        type: "object",
                        properties: {
                            proxyPort: { type: "number" },
                            adminPort: { type: "number" },
                            managerPort: { type: "number" }
                        },
                        required: ["proxyPort", "adminPort", "managerPort"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "verify_connectivity",
                    description: "Pings the Kong Admin API and Proxy to verify they are reachable and ready."
                }
            },
            {
                type: "function",
                function: {
                    name: "open_kong_manager",
                    description: "Opens the Kong Manager GUI in the user's default browser."
                }
            },
            {
                type: "function",
                function: {
                    name: "get_instance_details",
                    description: "Fetches technical details like Kong version, database engine, and runtime configuration."
                }
            },
            {
                type: "function",
                function: {
                    name: "open_file_in_editor",
                    description: "Opens a specific file from the storage directory in the platform's editor for the user to see.",
                    parameters: {
                        type: "object",
                        properties: {
                            filename: { type: "string" },
                        },
                        required: ["filename"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "reconcile_port_settings",
                    description: "Detects incorrect port settings by inspecting running containers and the docker-compose file, then updates the configuration to match reality. Use this when connection or health checks fail."
                }
            },
            {
                type: "function",
                function: {
                    name: "export_live_to_storage_file",
                    description: "Downloads the current live Kong configuration (Services, Routes) and OVERWRITES 'kong.yml' in the storage directory. CAUTION: Requires explicit user approval AFTER showing them the preview_sync_diff to ensure they understand what local changes will be lost."
                }
            },
            {
                type: "function",
                function: {
                    name: "check_deck_installation",
                    description: "Verifies if the Kong decK CLI is installed on the host system."
                }
            },
            {
                type: "function",
                function: {
                    name: "install_deck_cli",
                    description: "Installs the Kong decK CLI via Homebrew. Use this only after the user has approved installation."
                }
            },
            {
                type: "function",
                function: {
                    name: "sync_to_kong_using_deck",
                    description: "Uses the official decK CLI to synchronize a configuration file (e.g., kong.yml) to the live Kong instance.",
                    parameters: {
                        type: "object",
                        properties: {
                            filename: { type: "string" }
                        },
                        required: ["filename"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "validate_kong_config",
                    description: "Uses decK to validate the schema and syntax of a Kong configuration file. Provide a detailed explanation of any validation issues found.",
                    parameters: {
                        type: "object",
                        properties: {
                            filename: { type: "string" }
                        },
                        required: ["filename"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "reset_kong_instance",
                    description: "Wipes all current configuration (Services, Routes, Plugins, etc.) from the live Kong instance. Use ONLY after explicit user confirmation."
                }
            },
            {
                type: "function",
                function: {
                    name: "preview_sync_diff",
                    description: "Compares the local configuration file against the live Kong Gateway to show exact differences. REQUIRED before asking for sync or export approval.",
                    parameters: {
                        type: "object",
                        properties: {
                            filename: { type: "string" }
                        },
                        required: ["filename"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "git_setup_repo",
                    description: "Initializes the storage folder as a Git repository and connects it to a remote URL."
                }
            },
            {
                type: "function",
                function: {
                    name: "git_sync_push",
                    description: "Manually commits and pushes all current changes in the storage folder to the remote Git repository.",
                    parameters: {
                        type: "object",
                        properties: {
                            message: { type: "string", description: "The commit message" }
                        }
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "git_sync_pull",
                    description: "Pulls the latest configuration from the remote Git repository.",
                    parameters: {
                        type: "object",
                        properties: {
                            sync_to_kong: { type: "boolean", description: "Whether to automatically sync the pulled 'kong.yml' to the live Kong Gateway." }
                        }
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "git_get_status",
                    description: "Checks the current status of the Git repository in the storage folder."
                }
            }
        ];

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

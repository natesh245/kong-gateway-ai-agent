import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import { ToolManager } from "./tools/ToolManager";
import { KongApiClient } from "../api-clients/KongApiClient";
import { DiffUtil } from "../utils/DiffUtil";
import axios from "axios";
import { IConfig, IAppPlatform } from "../interfaces/ICoreInterfaces";

export class Agent {
    private openai: OpenAI | null = null;
    private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    private kongApi: KongApiClient;

    constructor(private config: IConfig, private toolManager: ToolManager, private platform: IAppPlatform) {
        this.kongApi = new KongApiClient(config);

        // System prompt
        this.messages.push({
            role: "system",
            content: "You are the Kong Gateway Agent. You help users manage their local Kong Gateway. " +
                "You can start or stop the Kong Gateway using Docker, and interact with the Admin API to create routes, services, and consumers. " +
                "CRITICAL: Always call 'check_existing_containers' BEFORE calling 'start_kong'. " +
                "If any containers related to Kong or Postgres are already running, you MUST present their details (Name, Image, Ports) and ask the user if they want to use the existing setup or start a fresh one. " +
                "If they choose to use an existing instance, use the 'connect_to_existing_instance' tool to adopt those ports. " +
                "ONCE KONG IS CONFIRMED RUNNING AND ACCESSIBLE, STOP CALLING SETUP TOOLS. Simply summarize the access details for the user and wait for their next request. " +
                "PORT ACCURACY: NEVER assume ports 8000/8001/8002. ALWAYS use the specific port results returned by 'start_kong', 'verify_connectivity', or 'connect_to_existing_instance' in your final response. " +
                "TECHNICAL DETAILS: Use the 'get_instance_details' tool when the user asks for deep technical info like versions or configuration. Summarize these using Markdown tables for maximum readability. " +
                "CRITICAL: You have local file system access to your configured storage directory. You can list, read, and write files there. " +
                "If the user asks you to review manual edits (like kong.yml or docker-compose.yml), use the 'read_storage_file' tool to inspect the content and provide suggestions. " +
                "Use the 'verify_connectivity' tool to definitively confirm if Kong is ready before finishing a setup or adoption task. " +
                "When you modify a file, you MUST explain your 'Thinking' (why you are making the change) and then describe the changes you made based on the provided diff. " +
                "**MANDATORY DECLARATIVE WORKFLOW**: When the user asks to create or modify a Service, Route, or Consumer, you MUST follow this sequence:\n" +
                "1. **Edit File**: Use 'write_storage_file' to save your proposed YAML configuration to 'kong.yml'. **SKIP THIS STEP** if the user has already manually edited the file and asks for a 'Review'.\n" +
                "2. **Validate**: Call 'validate_kong_config' after EVERY internal change or manual update. If validation fails, show the details to the user, suggest a fix, but DO NOT call 'write_storage_file' for the fix unless specifically asked.\n" +
                "3. **Preview Diff**: Call 'preview_sync_diff' to show the exact changes to the user. Wrap this in ' ```diff ' code blocks.\n" +
                "4. **Smart Review Request**: If differences exist, summarize them and ask for approval using '[APPROVAL_REQUIRED]'.\n" +
                "5. **Sync**: Only sync AFTER the user sees your diff and provides explicit verbal approval (Yes). NEVER call 'sync_to_kong_using_deck' in the same turn as 'write_storage_file' or 'preview_sync_diff'.\n" +
                "**REVIEWS & MANUAL UPDATES**: When a user asks for a 'Review' of a file, you MUST ensure you have the full file content (via 'read_storage_file') before analyzing. Move directly to Step 2 (Validate) and Step 3 (Diff). You are PROHIBITED from calling 'sync_to_kong_using_deck' during a review task. Stop after showing the diff.\n" +
                "**NO RESET ON CANCEL**: If the user says 'Cancel' or 'No', STOP and confirm. NEVER use 'reset_kong_instance' as a way to 'revert' or 'cancel' a pending configuration change.\n" +
                "**APPROVAL BUTTONS**: Whenever you expect the user to say 'Yes' or 'No' for a critical action, you MUST include '[APPROVAL_REQUIRED]' at the end of your message.\n" +
                "**KONG INSTANCES**: You support both 'Local' (Docker-based) and 'Remote' (any URL) Kong Gateway instances.\n" +
                "**DESTRUCTIVE ACTIONS**: For tools like 'reset_kong_instance', you MUST ask for explicit confirmation including '[APPROVAL_REQUIRED]'. If you see 'SAFETY_REQUIRED', STOP and ask. The tool has a code-level block that checks for a recent 'Yes' from the user.\n" +
                "**SYNC SAFETY**: 'sync_to_kong_using_deck' has a safety block. You MUST show the diff and wait for 'Yes'. If you see 'SAFETY_REQUIRED', stop and ask.\n" +
                "**decK CLI**: ALWAYS prefer using the 'sync_to_kong_using_deck' tool for applying changes. If decK is not installed, the tool will fall back to Docker.\n" +
                "**EXPORT VS SYNC**: 'export_live_to_storage_file' is for manual backups ONLY. You are PROHIBITED from calling it during or after 'preview_sync_diff' or 'sync_to_kong_using_deck'. It is NOT part of the sync or review flow and does not need to be called to 'refresh' state.\n" +
                "**GITOPS SYNC**: If a Git repository is set up, favor 'Commit -> Push -> Sync'. If Auto-Commit is enabled, update Git after a successful sync.\n" +
                "**EFFICIENCY**: BUNDLE tool calls whenever possible. For the declarative workflow, you SHOULD call 'write_storage_file', 'validate_kong_config', and 'preview_sync_diff' in a SINGLE response turn. Avoid redundant status checks if you just performed one.\n" +
                "**STRICTLY DECLARATIVE**: You are PROHIBITED from using direct API calls to create Services, Routes, or Consumers. All configuration MUST be managed via 'kong.yml' and synced using the 'sync_to_kong_using_deck' tool. There are no 'Direct API' creation tools available to you.\n" +
                "**CRITICAL OUTPUT FORMAT — READ CAREFULLY**: Every single response you generate MUST follow this exact two-part structure:\n" +
                "PART 1 — HIDDEN REASONING: Wrap ALL internal thinking, planning, analysis, and tool selection rationale inside `<thought>` tags. This block is COMPLETELY HIDDEN from the user and displayed in a separate developer panel.\n" +
                "PART 2 — USER RESPONSE: Write the user-facing message ONLY after the closing `</thought>` tag. This is the ONLY part the user sees.\n" +
                "⚠️ WARNING: Any text you write OUTSIDE of `<thought>` tags (before the closing `</thought>`) will appear DIRECTLY in the user's chat as raw, ugly, confusing text. NEVER write planning notes, tooling rationale, or strategy analysis as plain text. ALWAYS put it inside `<thought>` tags.\n" +
                "MANDATORY FORMAT TEMPLATE:\n" +
                "<thought>\n[Your full reasoning here: what the user wants, what tools to use, why, and what to check]\n</thought>\n[Your clean, user-facing markdown response here]\n" +
                "**NEXT STEPS & SUGGESTIONS**: When you finish a task, ALWAYS provide 2-3 specific 'Next Steps' as a bulleted list. Each item should be a clear, actionable command (e.g., '- Check Kong status'). These will be rendered as clickable items in the UI."
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
            'check_existing_containers': 'Scanning for active Kong instances...'
        };
        return mapping[name] || `Executing ${name}...`;
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

    public async processMessage(content: string, onUpdate: (content: string, type?: string) => void): Promise<void> {
        if (!this.initClient()) {
            onUpdate("Error: LLM client initialization failed. Please check your provider and API key settings in the application settings.");
            return;
        }

        this.messages.push({ role: "user", content });
        const config = this.config;
        const model = config.get<string>('model') || (config.get<string>('provider') === 'local' ? 'llama3.1' : 'openai/gpt-4o');

        try {
            await this.runLoop(model, onUpdate, 0);
        } catch (e: any) {
            onUpdate(`Agent Error: ${e.message}`);
        }
    }

    private async runLoop(model: string, onUpdate: (content: string, type?: string) => void, depth: number) {
        if (!this.openai) return;

        const config = this.config;
        const maxDepth = config.get<number>('maxToolDepth') || 10;

        // Prevent infinite loops
        if (depth > maxDepth) {
            onUpdate(`Agent Error: Max tool call depth (${maxDepth}) reached to prevent infinite loop.`);
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
                    name: "export_live_to_storage_file",
                    description: "Downloads the current live Kong configuration (Services, Routes) and OVERWRITES 'kong.yml' in the storage directory. CAUTION: Use ONLY for backup; NEVER call during a sync or review flow unless specifically asked for a backup."
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
                    description: "Uses decK to validate the schema and syntax of a Kong configuration file.",
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
                    description: "Compares the local configuration file against the live Kong Gateway to show exact differences before syncing.",
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

        let response = await this.openai.chat.completions.create({
            model: model,
            messages: this.messages,
            tools: tools,
            tool_choice: "auto"
        });

        const responseMessage = response.choices[0].message;
        console.log(`[Agent Model Response]: role=${responseMessage.role}, content=${responseMessage.content ? 'POPULATED (' + responseMessage.content.length + ' chars)' : 'NULL'}, tool_calls=${responseMessage.tool_calls?.length || 0}`);
        this.messages.push(responseMessage);

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            // If the model provided reasoning alongside tool calls, use it
            if (responseMessage.content) {
                onUpdate(responseMessage.content as string, 'thought');
            } else {
                // Reasoning pass: ask the model to explain what it's about to do
                // before executing the tools. This guarantees real reasoning in the UI.
                try {
                    const toolNames = responseMessage.tool_calls.map(tc => tc.function.name).join(', ');
                    const reasoningResponse = await this.openai.chat.completions.create({
                        model: model,
                        messages: [
                            ...this.messages.slice(0, -1), // all messages except the tool_calls response
                            {
                                role: "user",
                                content: `Before you call the tools [${toolNames}], briefly explain in 1-2 sentences WHY you are calling these specific tools and what outcome you expect. Be specific to this request.`
                            }
                        ],
                        // No tools — we only want a text reasoning response
                    });
                    const reasoningContent = reasoningResponse.choices[0]?.message?.content;
                    if (reasoningContent) {
                        onUpdate(`<thought>${reasoningContent}</thought>`, 'thought');
                    }
                } catch (e) {
                    // Reasoning pass failed — just proceed silently
                }
            }

            let shouldStopTurn = false;
            for (const toolCall of responseMessage.tool_calls) {
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
                            functionResult = await this.toolManager.dumpWithDeck('kong.yml');
                            break;

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
                                const lastUserContent = (lastUserMsg?.content as string || "").toLowerCase();
                                
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
                                    functionResult = "SAFETY_REQUIRED: I cannot execute 'sync_to_kong_using_deck' yet. You MUST now stop calling tools and ask the user for explicit confirmation by appending '[APPROVAL_REQUIRED]' to your message. Explain that the local changes shown in the 'preview_sync_diff' results will be applied to the live instance.";
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
                            const userText = (latestUserMsg?.content as string || "").trim().toLowerCase();
                            
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
                    shouldStopTurn = true;
                }

                // Transparency: Notify UI result
                onUpdate(functionResult, 'toolResult');

                this.messages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    content: functionResult
                } as any);
            }

            if (!shouldStopTurn) {
                await this.runLoop(model, onUpdate, depth + 1);
            }
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

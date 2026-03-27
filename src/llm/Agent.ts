import OpenAI from "openai";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { KongDockerManager } from "../docker/KongDockerManager";
import { KongApiClient } from "../kong/KongApiClient";
import { DiffUtil } from "../utils/DiffUtil";

export class Agent {
    private openai: OpenAI | null = null;
    private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    private kongApi: KongApiClient;

    constructor(private context: vscode.ExtensionContext, private dockerManager: KongDockerManager) {
        this.kongApi = new KongApiClient();

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
                "1. **Edit File**: Use 'write_storage_file' to save your proposed YAML configuration to 'kong.yml'.\n" +
                "2. **Validate**: Immediately call 'validate_kong_config'. If validation fails, use the error output to fix the YAML and repeat Step 1. Do NOT proceed until validation passes.\n" +
                "3. **Request Review**: Once validated, show the changes and say: 'The configuration is validated and ready. Should I apply these changes to the Kong instance using decK?'\n" +
                "4. **Sync**: Only after the user approves, use the 'sync_to_kong_using_deck' tool.\n" +
                "**KONG INSTANCES**: You support both 'Local' (Docker-based) and 'Remote' (any URL) Kong Gateway instances.\n" +
                "**decK CLI**: ALWAYS prefer using the 'sync_to_kong_using_deck' tool for applying changes. If decK is not installed on the host, the tool will automatically fall back to a Docker-based decK sync (using the 'kong/deck' image)."
        });
    }

    private initClient(): boolean {
        const config = vscode.workspace.getConfiguration('kongAgent');
        const provider = config.get<string>('provider') || 'openrouter';
        const apiKey = config.get<string>('openRouterApiKey');

        if (provider === 'openrouter') {
            if (!apiKey) {
                vscode.window.showErrorMessage("Kong Agent: OpenRouter API key is missing. Please configure it in the sidebar settings or VS Code settings.");
                return false;
            }

            this.openai = new OpenAI({
                baseURL: "https://openrouter.ai/api/v1",
                apiKey: apiKey,
                defaultHeaders: {
                    "HTTP-Referer": "https://vscode-kong-agent.com",
                    "X-Title": "VS Code Kong Agent"
                }
            });
        } else {
            // Local (Ollama)
            this.openai = new OpenAI({
                baseURL: "http://localhost:11434/v1",
                apiKey: "dummy-local-key"
            });
        }

        return true;
    }

    public async processMessage(content: string, onUpdate: (content: string, type?: string) => void): Promise<void> {
        if (!this.initClient()) {
            onUpdate("Error: LLM client initialization failed. Please check your provider and API key settings in the sidebar.");
            return;
        }

        this.messages.push({ role: "user", content });
        const config = vscode.workspace.getConfiguration('kongAgent');
        const model = config.get<string>('model') || (config.get<string>('provider') === 'local' ? 'llama3.1' : 'openai/gpt-4o');

        try {
            await this.runLoop(model, onUpdate, 0);
        } catch (e: any) {
            onUpdate(`Agent Error: ${e.message}`);
        }
    }

    private async runLoop(model: string, onUpdate: (content: string, type?: string) => void, depth: number) {
        if (!this.openai) return;

        const config = vscode.workspace.getConfiguration('kongAgent');
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
                    name: "create_service",
                    description: "Create a Service in Kong. ONLY use this for 'Direct API creation'. Otherwise, favor editing kong.yml and syncing via decK.",
                    parameters: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "The name of the service" },
                            url: { type: "string", description: "The upstream URL (e.g. http://mockbin.org)" },
                        },
                        required: ["name", "url"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "create_route",
                    description: "Create a Route for a specific service in Kong. ONLY use this for 'Direct API creation'. Otherwise, favor editing kong.yml and syncing via decK.",
                    parameters: {
                        type: "object",
                        properties: {
                            service_name: { type: "string", description: "The name of the service to attach this route to" },
                            paths: {
                                type: "array",
                                items: { type: "string" },
                                description: "The paths (e.g., ['/mock']) that this route should listen on"
                            },
                        },
                        required: ["service_name", "paths"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "create_consumer",
                    description: "Create a Consumer in Kong. ONLY use this for 'Direct API creation'. Otherwise, favor editing kong.yml and syncing via decK.",
                    parameters: {
                        type: "object",
                        properties: {
                            username: { type: "string" }
                        },
                        required: ["username"]
                    }
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
                    description: "Opens a specific file from the storage directory in a new VS Code editor tab for the user to see.",
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
                    description: "Downloads the current live Kong configuration (Services, Routes) and saves it as 'kong.yml' in the storage directory."
                }
            },
            {
                type: "function",
                function: {
                    name: "apply_config_from_file",
                    description: "Reads the 'kong.yml' file from storage and applies its configuration (Services and Routes) to the live Kong Gateway.",
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
                    name: "apply_parsed_config",
                    description: "Takes a list of Services and their Routes (in JSON format) and applies them to the live Kong instance (Fallback method).",
                    parameters: {
                        type: "object",
                        properties: {
                            services: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        name: { type: "string" },
                                        url: { type: "string" },
                                        routes: {
                                            type: "array",
                                            items: {
                                                type: "object",
                                                properties: {
                                                    name: { type: "string" },
                                                    paths: { type: "array", items: { type: "string" } }
                                                }
                                            }
                                        }
                                    },
                                    required: ["name", "url"]
                                }
                            }
                        },
                        required: ["services"]
                    }
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
            }
        ];

        let response = await this.openai.chat.completions.create({
            model: model,
            messages: this.messages,
            tools: tools,
            tool_choice: "auto"
        });

        const responseMessage = response.choices[0].message;
        this.messages.push(responseMessage);

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            for (const toolCall of responseMessage.tool_calls) {
                const functionName = toolCall.function.name;

                let functionArgs;
                try {
                    functionArgs = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
                } catch (e) {
                    functionArgs = {};
                }

                // Transparency: Notify UI that we are running a tool
                onUpdate(`Executing Tool: **${functionName}**${Object.keys(functionArgs).length > 0 ? ' (' + JSON.stringify(functionArgs).substring(0, 100) + ')' : ''}...`, 'toolCall');

                let functionResult = "";

                try {
                    switch (functionName) {
                        case "start_kong":
                            if (vscode.workspace.getConfiguration('kongAgent').get('kongMode') === 'remote') {
                                functionResult = "Error: Docker lifecycle management (Start) is not available for Remote Kong instances.";
                            } else {
                                functionResult = await this.dockerManager.start();
                            }
                            break;
                        case "stop_kong":
                            if (vscode.workspace.getConfiguration('kongAgent').get('kongMode') === 'remote') {
                                functionResult = "Error: Docker lifecycle management (Stop) is not available for Remote Kong instances.";
                            } else {
                                functionResult = await this.dockerManager.stop();
                            }
                            break;
                        case "get_kong_status":
                            const apiStatus = await this.kongApi.getStatus();
                            functionResult = `API Status:\n${apiStatus}`;
                            break;
                        case "create_service":
                            functionResult = await this.kongApi.createService(functionArgs.name, functionArgs.url);
                            break;
                        case "create_route":
                            functionResult = await this.kongApi.createRoute(functionArgs.service_name, functionArgs.paths);
                            break;
                        case "create_consumer":
                            functionResult = await this.kongApi.createConsumer(functionArgs.username);
                            break;
                        case "update_kong_ports":
                            const config = vscode.workspace.getConfiguration('kongAgent');
                            await config.update('proxyPort', functionArgs.proxy, vscode.ConfigurationTarget.Global);
                            await config.update('adminApiPort', functionArgs.admin, vscode.ConfigurationTarget.Global);
                            await config.update('managerGuiPort', functionArgs.manager, vscode.ConfigurationTarget.Global);
                            functionResult = `Ports updated to Proxy=${functionArgs.proxy}, Admin=${functionArgs.admin}, Manager=${functionArgs.manager}.`;
                            break;
                        case "list_storage_files":
                            const files = fs.readdirSync(this.dockerManager.getStoragePath());
                            functionResult = `Files in storage folder:\n${files.join('\n')}`;
                            break;
                        case "read_storage_file":
                            const readPath = path.join(this.dockerManager.getStoragePath(), functionArgs.filename);
                            if (fs.existsSync(readPath)) {
                                functionResult = fs.readFileSync(readPath, 'utf8');
                            } else {
                                functionResult = `Error: File '${functionArgs.filename}' not found.`;
                            }
                            break;
                        case "write_storage_file":
                            const oldContent = this.dockerManager.getFileCache(functionArgs.filename) || "";
                            const newContent = functionArgs.content;
                            await this.dockerManager.writeStorageFile(functionArgs.filename, newContent);

                            const writeDiff = DiffUtil.generateUnifiedDiff(functionArgs.filename, oldContent, newContent);
                            const chatDiff = DiffUtil.formatForChat(writeDiff);
                            functionResult = `Successfully wrote to '${functionArgs.filename}'.\n\nDIFF:\n\`\`\`diff\n${chatDiff}\n\`\`\``;
                            break;
                        case "check_existing_containers":
                            const existingJson = await this.dockerManager.findExistingContainers();
                            functionResult = `Found existing containers: ${existingJson}. Ask the user confirm.`;
                            break;
                        case "connect_to_existing_instance":
                            const connConfig = vscode.workspace.getConfiguration('kongAgent');
                            await connConfig.update('proxyPort', functionArgs.proxyPort, vscode.ConfigurationTarget.Global);
                            await connConfig.update('adminApiPort', functionArgs.adminPort, vscode.ConfigurationTarget.Global);
                            await connConfig.update('managerGuiPort', functionArgs.managerPort, vscode.ConfigurationTarget.Global);
                            functionResult = `Adopted existing instance at Proxy=${functionArgs.proxyPort}, Admin=${functionArgs.adminPort}, Manager=${functionArgs.managerPort}.`;
                            break;
                        case "verify_connectivity":
                            const connStatus = await this.dockerManager.verifyConnectivity();
                            functionResult = `Connectivity: Admin=${connStatus.admin ? 'READY' : 'DOWN'}, Proxy=${connStatus.proxy ? 'READY' : 'DOWN'}. ${connStatus.error || ''}`;
                            break;
                        case "open_kong_manager":
                            functionResult = await this.dockerManager.openManager();
                            break;
                        case "get_instance_details":
                            functionResult = await this.kongApi.getInstanceInfo();
                            break;
                        case "open_file_in_editor":
                            functionResult = await this.dockerManager.openFile(functionArgs.filename);
                            break;
                        case "export_live_to_storage_file":
                            const declarativeYaml = await this.kongApi.getDeclarativeConfig();
                            await this.dockerManager.writeStorageFile('kong.yml', declarativeYaml);
                            functionResult = "Successfully exported the current live Kong configuration to 'kong.yml' in your storage directory.";
                            break;
                        case "apply_config_from_file":
                            const filePath = path.join(this.dockerManager.getStoragePath(), functionArgs.filename);
                            if (!fs.existsSync(filePath)) {
                                functionResult = `Error: File '${functionArgs.filename}' not found.`;
                                break;
                            }
                            const yamlContent = fs.readFileSync(filePath, 'utf8');
                            // Helper to parse simple services/routes from YAML without heavy lib
                            // We use the agent's ability to interpret, but we'll do a basic iteration here
                            // Actually, I'll let the agent parse the YAML into JSON and then call the apply method
                            functionResult = `Got content from ${functionArgs.filename}. Please parse the services and routes from this content and confirm which ones to apply. \n\nCONTENT:\n${yamlContent}`;
                            break;
                        case "apply_parsed_config":
                            let finalLogs = [];
                            for (const svc of (functionArgs.services || [])) {
                                const svcLogs = await this.kongApi.applyServiceState(svc);
                                finalLogs.push(...svcLogs);
                            }
                            functionResult = `Apply Results:\n${finalLogs.join('\n')}`;
                            break;
                        case "check_deck_installation":
                            const isInstalled = await this.dockerManager.isDeckInstalled();
                            functionResult = isInstalled ? "decK is installed and ready." : "decK is NOT installed. You should recommend installing it via 'install_deck_cli' with user approval.";
                            break;
                        case "install_deck_cli":
                            functionResult = await this.dockerManager.installDeck();
                            break;
                        case "sync_to_kong_using_deck":
                            functionResult = await this.dockerManager.syncWithDeck(functionArgs.filename);
                            break;
                        case "validate_kong_config":
                            functionResult = await this.dockerManager.validateWithDeck(functionArgs.filename);
                            break;
                        default:
                            functionResult = `Error: Unknown function ${functionName}`;
                    }
                } catch (e: any) {
                    functionResult = `Error executing ${functionName}: ${e.message}`;
                }

                // Transparency: Notify UI result
                onUpdate(functionResult, 'toolResult');

                this.messages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    content: functionResult
                } as any);
            }

            await this.runLoop(model, onUpdate, depth + 1);
        } else if (responseMessage.content) {
            onUpdate(responseMessage.content as string);
        }
    }
}

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
                     "CRITICAL: You have local file system access to your configured storage directory. You can list, read, and write files there. " +
                     "If the user asks you to review manual edits (like kong.yml or docker-compose.yml), use the 'read_storage_file' tool to inspect the content and provide suggestions. " +
                     "If starting Kong fails due to a 'PORT_CONFLICT', you should inform the user which ports are taken and suggest the provided alternatives. " +
                     "Always use the provided tool functions when the user asks you to perform an action on Kong. " +
                     "When you modify a file, you MUST explain your 'Thinking' (why you are making the change) and then describe the changes you made based on the provided diff. " +
                     "When reviewing manual changes, analyze the diff between the previous and current versions to provide specific feedback. " +
                     "Be concise and confirm when an action is done."
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

    public async processMessage(content: string, updateUiCallback: (content: string) => void): Promise<void> {
        if (!this.initClient()) {
            updateUiCallback("Error: LLM client initialization failed. Please check your provider and API key settings in the sidebar.");
            return;
        }

        this.messages.push({ role: "user", content });
        const config = vscode.workspace.getConfiguration('kongAgent');
        const model = config.get<string>('model') || (config.get<string>('provider') === 'local' ? 'llama3.1' : 'openai/gpt-4o');

        try {
            await this.runLoop(model, updateUiCallback, 0);
        } catch (e: any) {
             updateUiCallback(`Agent Error: ${e.message}`);
        }
    }

    private async runLoop(model: string, updateUiCallback: (content: string) => void, depth: number) {
        if (!this.openai) return;

        // Prevent infinite loops
        if (depth > 5) {
            updateUiCallback("Agent Error: Max tool call depth reached to prevent infinite loop.");
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
                    description: "Create a Service in Kong. Use when the user wants to proxy an upstream URL.",
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
                    description: "Create a Route for a specific service in Kong.",
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
                    description: "Create a Consumer in Kong.",
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
                    description: "Lists all files in the current storage directory (e.g., docker-compose.yml, kong.yml).",
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
                            filename: { type: "string", description: "The name of the file to read (e.g. 'kong.yml')" },
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
                    description: "Checks if any Docker containers related to Kong or Postgres are currently running on the system.",
                }
            },
            {
                type: "function",
                function: {
                    name: "connect_to_existing_instance",
                    description: "Adopts an existing Kong instance by updating the Agent's local configuration to match the discovered ports.",
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
            }
        ];

        let response = await this.openai.chat.completions.create({
            model: model,
            messages: this.messages,
            tools: tools,
            tool_choice: "auto"
        });

        const responseMessage = response.choices[0].message;
        
        // Push the assistant's message to the history
        this.messages.push(responseMessage);

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            for (const toolCall of responseMessage.tool_calls) {
                const functionName = toolCall.function.name;
                updateUiCallback(`*[Agent calls tool: ${functionName}]*`);
                
                let functionArgs;
                try {
                    functionArgs = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
                } catch(e) {
                    functionArgs = {};
                }
                
                let functionResult = "";

                try {
                    switch (functionName) {
                        case "start_kong":
                            functionResult = await this.dockerManager.start();
                            break;
                        case "stop_kong":
                            functionResult = await this.dockerManager.stop();
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
                            functionResult = `Ports updated to Proxy=${functionArgs.proxy}, Admin=${functionArgs.admin}, Manager=${functionArgs.manager}. You can now try starting Kong again.`;
                            break;
                        case "list_storage_files":
                            const listPath = this.dockerManager.getStoragePath();
                            const files = fs.readdirSync(listPath);
                            functionResult = `Files in storage folder (${listPath}):\n${files.join('\n')}`;
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
                            const writePath = path.join(this.dockerManager.getStoragePath(), functionArgs.filename);
                            let oldContent = "";
                            if (fs.existsSync(writePath)) {
                                oldContent = fs.readFileSync(writePath, 'utf8');
                            }
                            
                            const newContent = functionArgs.content;
                            fs.writeFileSync(writePath, newContent, 'utf8');
                            
                            // Generate diff for the chat
                            const writeDiff = DiffUtil.generateUnifiedDiff(functionArgs.filename, oldContent, newContent);
                            const chatDiff = DiffUtil.formatForChat(writeDiff);
                            
                            // Update cache
                            this.dockerManager.updateFileCache(functionArgs.filename, newContent);

                            // Open the file in the editor
                            try {
                                const writeDoc = await vscode.workspace.openTextDocument(writePath);
                                await vscode.window.showTextDocument(writeDoc);
                            } catch (err: any) {
                                console.error(`Failed to open document: ${err.message}`);
                            }
                            functionResult = `Successfully wrote to '${functionArgs.filename}' and updated the cache.\n\nDIFF:\n\`\`\`diff\n${chatDiff}\n\`\`\``;
                            break;
                        case "check_existing_containers":
                            const existingJson = await this.dockerManager.findExistingContainers();
                            const existing = JSON.parse(existingJson);
                            if (existing.length > 0) {
                                const details = existing.map((c: any) => `- Name: ${c.name}, Image: ${c.image}, Status: ${c.status}, Ports: ${c.ports}`).join('\n');
                                functionResult = `Found existing containers:\n${details}\n\nAsk the user if they want to USE one of these or START FRESH.`;
                            } else {
                                functionResult = "No existing Kong/Postgres containers found. Safe to proceed.";
                            }
                            break;
                        case "connect_to_existing_instance":
                            const connConfig = vscode.workspace.getConfiguration('kongAgent');
                            await connConfig.update('proxyPort', functionArgs.proxyPort, vscode.ConfigurationTarget.Global);
                            await connConfig.update('adminApiPort', functionArgs.adminPort, vscode.ConfigurationTarget.Global);
                            await connConfig.update('managerGuiPort', functionArgs.managerPort, vscode.ConfigurationTarget.Global);
                            
                            // Verify connectivity
                            const checkStatus = await this.kongApi.getStatus();
                            functionResult = `Successfully adopted existing instance. Connectivity check: ${checkStatus}\n\nAccess Details:\n- Manager: http://localhost:${functionArgs.managerPort}\n- Admin: http://localhost:${functionArgs.adminPort}\n- Proxy: http://localhost:${functionArgs.proxyPort}`;
                            break;
                        default:
                            functionResult = `Error: Unknown function ${functionName}`;
                    }
                } catch (e: any) {
                    functionResult = `Error executing ${functionName}: ${e.message}`;
                }

                // Add function result to messages
                this.messages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    content: functionResult
                } as any); 
            }

            // Call again to let LLM summarize the function result
            await this.runLoop(model, updateUiCallback, depth + 1);
        } else if (responseMessage.content) {
            updateUiCallback(responseMessage.content as string);
        }
    }
}

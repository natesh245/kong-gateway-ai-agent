import OpenAI from "openai";
import * as vscode from "vscode";
import { KongDockerManager } from "../docker/KongDockerManager";
import { KongApiClient } from "../kong/KongApiClient";

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
                     "You can start or stop the Kong Docker containers, and interact with the Admin API to create routes, services, and consumers. " +
                     "Always use the provided tool functions when the user asks you to perform an action on Kong. " +
                     "Be concise and confirm when an action is done."
        });
    }

    private initClient(): boolean {
        const config = vscode.workspace.getConfiguration('kongAgent');
        const provider = config.get<string>('provider') || 'openrouter';
        const apiKey = config.get<string>('openRouterApiKey');
        const model = config.get<string>('model') || 'openai/gpt-4o';

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
            await this.runLoop(model, updateUiCallback);
        } catch (e: any) {
             updateUiCallback(`Agent Error: ${e.message}`);
        }
    }

    private async runLoop(model: string, updateUiCallback: (content: string) => void) {
        if (!this.openai) return;

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
                } as any); // using any for simplicity since OpenRouter SDK types can be strict
            }

            // Call again to let LLM summarize the function result
            await this.runLoop(model, updateUiCallback);
        } else if (responseMessage.content) {
            updateUiCallback(responseMessage.content as string);
        }
    }
}

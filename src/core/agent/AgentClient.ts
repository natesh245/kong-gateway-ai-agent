import { ChatOpenAI } from "@langchain/openai";
import axios from "axios";
import { IConfig, IAppPlatform } from "../interfaces/ICoreInterfaces";

export class AgentClient {
    /**
     * Initializes the LLM client based on configuration.
     */
    public static initModel(config: IConfig, platform: IAppPlatform): any | null {
        const provider = config.get<string>('provider') || 'openrouter';
        const modelName = config.get<string>('model') || "openai/gpt-4o";

        // Native Observability Injection
        if (config.get<boolean>('langChainTracing')) {
            const apiKey = config.get<string>('langSmithApiKey');
            const project = config.get<string>('langSmithProject') || "kong-gateway-agent";
            const endpoint = config.get<string>('langSmithEndpoint') || "https://api.smith.langchain.com";

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
                platform.showErrorMessage("Kong Agent: Gemini API key is missing.");
                return null;
            }
            try {
                const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
                const model = new ChatGoogleGenerativeAI({
                    modelName: modelName,
                    apiKey: apiKey,
                    temperature: 0,
                    maxOutputTokens: 4096,
                });
                // Disable parallel tool calls for better reliability in agent loops
                const origBind = model.bindTools;
                model.bindTools = function(tools: any, kwargs: any) {
                    return origBind.call(this, tools, { ...kwargs, parallel_tool_calls: false });
                };
                return model;
            } catch (e) {
                platform.showErrorMessage("Kong Agent: @langchain/google-genai package is not yet installed.");
                return null;
            }
        } else if (provider === 'openrouter') {
            const apiKey = config.get<string>('openRouterApiKey');
            if (!apiKey) {
                platform.showErrorMessage("Kong Agent: OpenRouter API key is missing.");
                return null;
            }
            try {
                const { ChatOpenRouter } = require("@langchain/openrouter");
                const model = new ChatOpenRouter({
                    modelName: modelName,
                    apiKey: apiKey,
                    temperature: 0,
                    configuration: {
                        baseURL: "https://openrouter.ai/api/v1",
                        defaultHeaders: {
                            "HTTP-Referer": platform.getAppReferer(),
                            "X-Title": platform.getAppName()
                        }
                    }
                });
                const origBindOR = model.bindTools;
                model.bindTools = function(tools: any, kwargs: any) {
                    return origBindOR.call(this, tools, { ...kwargs, parallel_tool_calls: false });
                };
                return model;
            } catch (e) {
                // Fallback to legacy ChatOpenAI if ChatOpenRouter isn't ready
                const model = new ChatOpenAI({
                    modelName: modelName,
                    apiKey: apiKey,
                    temperature: 0,
                    configuration: {
                        baseURL: "https://openrouter.ai/api/v1",
                        defaultHeaders: {
                            "HTTP-Referer": platform.getAppReferer(),
                            "X-Title": platform.getAppName()
                        }
                    }
                });
                const origBindAI = model.bindTools;
                model.bindTools = function(tools: any, kwargs: any) {
                    return origBindAI.call(this, tools, { ...kwargs, parallel_tool_calls: false });
                };
                return model;
            }
        }

        return null;
    }

    /**
     * Fetches available models from the provider.
     */
    public static initEmbeddings(config: IConfig, platform: IAppPlatform): any | null {
        const provider = config.get<string>('provider') || 'openrouter';

        if (provider === 'gemini') {
            const apiKey = config.get<string>('geminiApiKey');
            if (!apiKey) return null;
            try {
                const { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
                return new GoogleGenerativeAIEmbeddings({
                    apiKey: apiKey,
                    modelName: "text-embedding-004",
                });
            } catch (e) {
                return null;
            }
        } else if (provider === 'openrouter') {
            const apiKey = config.get<string>('openRouterApiKey');
            if (!apiKey) return null;
            try {
                const { OpenAIEmbeddings } = require("@langchain/openai");
                return new OpenAIEmbeddings({
                    apiKey: apiKey,
                    configuration: {
                        baseURL: "https://openrouter.ai/api/v1",
                        defaultHeaders: {
                            "HTTP-Referer": platform.getAppReferer(),
                            "X-Title": platform.getAppName()
                        }
                    },
                    modelName: "openai/text-embedding-3-small"
                });
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    public static async fetchModels(config: IConfig, providerOverride?: string, apiKeyOverride?: string): Promise<string[]> {
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
                if (!geminiKey) return geminiFallback;

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
            return provider === 'gemini' ? geminiFallback : [];
        }
    }
}

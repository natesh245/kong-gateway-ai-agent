import { z } from "zod";
import { tool } from "langchain";
import {
    BaseMessage,
    HumanMessage,
    ToolMessage,
} from "@langchain/core/messages";
import { ToolManager, ToolExecutionContext } from "./tools/ToolManager";
import { SanitizationUtil } from "../utils/SanitizationUtil";
import { IConfig } from "../interfaces/ICoreInterfaces";

/**
 * Context object passed to each tool, allowing access to agent internals.
 */
export interface ToolContext {
    toolManager: ToolManager;
    config: IConfig;
    getMessages: () => BaseMessage[];
    abortSignal?: AbortSignal;
}

/**
 * Builds an array of executable LangChain `tool()` instances.
 * Each tool wraps its corresponding ToolManager method + embeds safety gates.
 */
export function buildAgentTools(ctx: ToolContext) {
    const { toolManager } = ctx;
    const executedToolsThisTurn = new Set<string>();

    function checkParsimony(toolName: string): string | null {
        if (executedToolsThisTurn.has(toolName)) {
            return `SYSTEM_WARNING: You have already executed '${toolName}' in this turn. Do not call it again. Please proceed to generate the markdown summary table for the user based on the previous result.`;
        }
        executedToolsThisTurn.add(toolName);
        return null;
    }

    // --- Helpers for safety gate checks ---
    function getLastUserContent(): string {
        const messages = ctx.getMessages();
        // Only consider the absolute most recent HumanMessage
        const lastHumanIndex = [...messages].reverse().findIndex(m => m instanceof HumanMessage);

        if (lastHumanIndex === -1 || lastHumanIndex > 2) {
            // If the last human interaction is too far back (more than 2 messages ago), 
            // it's likely "consumed" or stale.
            return "";
        }

        const lastUser = [...messages].reverse()[lastHumanIndex];
        return SanitizationUtil.stripContext(lastUser?.content as string || "").toLowerCase();
    }

    function recentHistoryHas(keyword: string, lookback = 50): boolean {
        const messages = ctx.getMessages();
        const history = messages.slice(-lookback);
        return history.some((m: any) => {
            const content = typeof m.content === 'string' ? m.content : "";
            return content.toLowerCase().includes(keyword.toLowerCase());
        });
    }

    function recentHistoryHasToolCall(toolName: string, lookback = 50): boolean {
        const messages = ctx.getMessages();
        const history = messages.slice(-lookback);
        
        // Robustness: For sync/preview, also check if the result marker [SYNC_PREVIEW] exists in history
        if (toolName === 'preview_sync_diff') {
            if (recentHistoryHas('[SYNC_PREVIEW]', lookback)) return true;
        }

        return history.some((m: any) =>
            (m.toolInteractions && m.toolInteractions.some((ti: any) => ti.name === toolName)) ||
            (m.tool_calls && m.tool_calls.some((tc: any) => (tc.name === toolName) || (tc.function && tc.function.name === toolName)))
        );
    }

    const execCtx: ToolExecutionContext = {
        lastUserContent: getLastUserContent,
        recentHistoryHas: recentHistoryHas,
        recentHistoryHasToolCall: recentHistoryHasToolCall,
        abortSignal: ctx.abortSignal
    };

    return [
        // --- Docker / Instance ---
        tool(
            async () => {
                return await toolManager.start(ctx.abortSignal);
            },
            {
                name: "start_kong",
                description: "LOCAL KONG MODE ONLY. Starts the local Kong Gateway using Docker Compose (Postgres-backed). Run this if the user asks to start Kong. Takes ~10s to boot. NEVER call this tool when operating in REMOTE KONG MODE.",
                schema: z.object({}),
            }
        ),

        tool(
            async () => {
                return await toolManager.stop(ctx.abortSignal);
            },
            {
                name: "stop_kong",
                description: "LOCAL KONG MODE ONLY. Stops the local Kong Gateway Docker Compose setup. NEVER call this tool when operating in REMOTE KONG MODE.",
                schema: z.object({}),
            }
        ),

        tool(
            async () => {
                return await toolManager.status();
            },
            {
                name: "get_kong_status",
                description: "LOCAL KONG MODE ONLY. Checks if Kong Docker containers are running. NEVER call this tool when operating in REMOTE KONG MODE. DO NOT call this tool before a preview or sync if you have recently verified connectivity. NEVER call this tool as a concluding 'heartbeat' check.",
                schema: z.object({}),
            }
        ),

        tool(
            async ({ proxy, admin, manager }) => {
                return await toolManager.updateKongPorts(proxy, admin, manager);
            },
            {
                name: "update_kong_ports",
                description: "LOCAL KONG MODE ONLY. Updates the Agent's local configuration for Kong Proxy, Admin API, and Manager GUI ports. Use this when resolving port conflicts or when the user manually changes local port mapping. NEVER call this tool when operating in REMOTE KONG MODE.",
                schema: z.object({
                    proxy: z.number().describe("The new port for the Kong Proxy"),
                    admin: z.number().describe("The new port for the Kong Admin API"),
                    manager: z.number().describe("The new port for the Kong Manager GUI"),
                }),
            }
        ),

        tool(
            async () => {
                return await toolManager.findExistingContainers();
            },
            {
                name: "check_existing_containers",
                description: "LOCAL KONG MODE ONLY. Scans the local Docker host for any running containers related to 'kong' or 'postgres' and returns a JSON list. Use this to find existing instances to adopt. NEVER call this tool when operating in REMOTE KONG MODE.",
                schema: z.object({}),
            }
        ),

        // SAFETY-GATED: connect_to_existing_instance
        tool(
            async ({ proxyPort, adminPort, managerPort }) => {
                return await toolManager.connectWithSafetyGate(execCtx, proxyPort, adminPort, managerPort);
            },
            {
                name: "connect_to_existing_instance",
                description: "LOCAL KONG MODE ONLY. Adopts an already-running Kong instance by updating the Agent's local configuration for all service ports. MANDATORY: You MUST run 'check_existing_containers' or 'reconcile_port_settings' and show the results to the user BEFORE asking for approval to connect. NEVER call this tool when operating in REMOTE KONG MODE.",
                schema: z.object({
                    proxyPort: z.number(),
                    adminPort: z.number(),
                    managerPort: z.number(),
                }),
            }
        ),

        tool(
            async () => {
                const res = await toolManager.verifyConnectivity();
                return `Admin: ${res.admin ? 'Ready' : 'Unreachable'}, Proxy: ${res.proxy ? 'Ready' : 'Unreachable'}${res.error ? ` (${res.error})` : ''}`;
            },
            {
                name: "verify_connectivity",
                description: "Pings the Kong Admin API and Proxy to verify they are reachable. Works in both LOCAL and REMOTE modes. DO NOT call this tool before a preview or sync as those tools perform their own connectivity checks.",
                schema: z.object({}),
            }
        ),

        tool(
            async () => {
                return await toolManager.openManager();
            },
            {
                name: "open_kong_manager",
                description: "Opens the Kong Manager GUI in the user's default browser. Works in both LOCAL and REMOTE modes (using the configured manager URL or localhost).",
                schema: z.object({}),
            }
        ),

        tool(
            async () => {
                return await toolManager.getHybridInstanceDetails();
            },
            {
                name: "get_instance_details",
                description: "Fetches technical details like Kong version, database engine, and runtime configuration. Works in both LOCAL and REMOTE modes. DO NOT call this tool before a preview or sync unless you have zero information about the environment.",
                schema: z.object({}),
            }
        ),
        
        tool(
            async ({ entity }) => {
                return await toolManager.listEntities(entity);
            },
            {
                name: "list_kong_entities",
                description: "Fetches a list of specific entities (services, routes, plugins, consumers) from the live Kong Gateway Admin API. Use this to count or inspect existing configuration when it's not available in local storage files. CEILING: 4 calls per turn.",
                schema: z.object({
                    entity: z.enum(["services", "routes", "plugins", "consumers", "snis", "certificates"]).describe("The type of entity to list"),
                }),
            }
        ),

        tool(
            async () => {
                return await toolManager.reconcilePorts();
            },
            {
                name: "reconcile_port_settings",
                description: "LOCAL KONG MODE ONLY. Detects incorrect port settings by inspecting local running containers and the docker-compose file, then updates the configuration to match reality. NEVER call this tool when operating in REMOTE KONG MODE.",
                schema: z.object({}),
            }
        ),

        // --- Storage ---
        tool(
            async () => {
                const files = await toolManager.storage.listStorageFiles();
                return `Files: ${files.join(', ')}`;
            },
            {
                name: "list_storage_files",
                description: "Lists all files (YAML, JSON, Docker Compose, etc.) in the Agent's local storage directory. Use this to orient yourself at the START of a turn. NEVER call this tool as the concluding action of a turn if you already know the file names from earlier turns.",
                schema: z.object({}),
            }
        ),

        tool(
            async ({ filename }) => {
                return await toolManager.readStorageFile(filename);
            },
            {
                name: "read_storage_file",
                description: "Reads the content of a specific file from the local storage directory (e.g., kong-deck-state.yml) for analysis, validation, or diffing.",
                schema: z.object({
                    filename: z.string().describe("The name of the file to read"),
                }),
            }
        ),

        tool(
            async ({ filename, content }) => {
                return await toolManager.writeStorageFileWithDiff(filename, content);
            },
            {
                name: "write_storage_file",
                description: "Proposes a change to a file in the local storage directory. This tool DOES NOT write to disk immediately. It STAGES the file and presents a diff in the UI for the user to review. The user MUST explicitly click 'Accept' in the UI to save it. If the user asks for additional changes BEFORE accepting, you MUST call this tool again on the SAME filename to cumulatively update the staged file. Do not create new patch files. NEVER call 'preview_sync_diff' or 'sync_to_kong_using_deck' immediately after this. You must wait for the user to Accept the changes and initiate the next action themselves.",
                schema: z.object({
                    filename: z.string().describe("The name of the file to write to"),
                    content: z.string().describe("The full content to write to the file"),
                }),
            }
        ),

        tool(
            async ({ filename }) => {
                return await toolManager.openFile(filename);
            },
            {
                name: "open_file_in_editor",
                description: "Opens a specific file (e.g., kong-deck-state.yml) in the IDE's editor window for the user to view or manually edit. This is purely for UI visibility.",
                schema: z.object({
                    filename: z.string(),
                }),
            }
        ),

        // --- decK CLI / APIOps Transformations ---
        tool(
            async ({ input, output }) => {
                return await toolManager.openapi2kong(input, output, ctx.abortSignal);
            },
            {
                name: "openapi_to_kong",
                description: "APIOPS: TRANSFORMATION. Converts an OpenAPI Specification (OAS/Swagger) file into a decK declarative configuration file. Use this at the start of a 'Design-First' workflow. You must provide the input filename and a name for the generated output file (e.g., kong-deck-state.yml).",
                schema: z.object({
                    input: z.string().describe("The OAS file to convert"),
                    output: z.string().describe("The name of the generated Kong config file"),
                }),
            }
        ),

        tool(
            async ({ filename, rulesetFile }) => {
                return await toolManager.lint(filename, rulesetFile, ctx.abortSignal);
            },
            {
                name: "lint_kong_config",
                description: "APIOPS: GOVERNANCE. Lints a local Kong configuration file against best practices and governance rules. Returns a report of any recommendations or rule violations. Use this before validation or sync to ensure high configuration quality. A ruleset file is required to run this tool.",
                schema: z.object({
                    filename: z.string().describe("The configuration file to lint"),
                    rulesetFile: z.string().optional().describe("Optional: The name of the ruleset file (e.g., ruleset.yaml). If omitted, the tool will try to auto-detect one."),
                }),
            }
        ),

        tool(
            async ({ filenames, output }) => {
                return await toolManager.merge(filenames, output, ctx.abortSignal);
            },
            {
                name: "merge_kong_configs",
                description: "APIOPS: BUILD. Merges multiple Kong configuration files into a single unified state file. Use this to combine modular configurations or merge global settings with team-specific configs.",
                schema: z.object({
                    filenames: z.array(z.string()).describe("List of files to merge"),
                    output: z.string().describe("The name of the merged output file"),
                }),
            }
        ),

        tool(
            async ({ filename, patchFile }) => {
                return await toolManager.patch(filename, patchFile, ctx.abortSignal);
            },
            {
                name: "patch_kong_config",
                description: "APIOPS: BUILD. Applies a patch file to an existing Kong configuration file. Use this for environment-specific adjustments or programmatic mass-updates to existing state files.",
                schema: z.object({
                    filename: z.string().describe("The configuration file to patch"),
                    patchFile: z.string().describe("The patch file containing the changes"),
                }),
            }
        ),

        tool(
            async () => {
                return await toolManager.deck.initializeGatewayConfig(ctx.abortSignal);
            },
            {
                name: "initialize_gateway_config",
                description: "Initializes a default 'kong.conf' Gateway configuration file in the workspace by downloading it from the official Kong repository. Use this if the user asks to setup a gateway config or if it is missing.",
                schema: z.object({}),
            }
        ),

        tool(
            async ({ filename }) => {
                const warning = checkParsimony("validate_kong_config");
                if (warning) return warning;
                return await toolManager.validateWithDeck(filename || "kong-deck-state.yml");
            },
            {
                name: "validate_kong_config",
                description: "APIOPS: VALIDATE. Uses decK to validate the schema and syntax of a local Kong configuration file. This provides a deep structural check to ensure the file is ready for a gateway sync.",
                schema: z.object({
                    filename: z.string(),
                }),
            }
        ),

        tool(
            async ({ filename }) => {
                const warning = checkParsimony("preview_sync_diff");
                if (warning) return warning;
                return await toolManager.diffWithDeck(filename || "kong-deck-state.yml");
            },
            {
                name: "preview_sync_diff",
                description: "Compares your local configuration file against the live Kong Gateway to show the exact differences. This is a read-only preview that internally verifies connectivity; do NOT call auxiliary diagnostic tools (Scan/Status/Connect) before / after this. Do not sync or export the changes after this without user approval. You can suggest to sync changes as the next step",
                schema: z.object({
                    filename: z.string(),
                }),
            }
        ),

        // SAFETY-GATED: sync_to_kong_using_deck
        tool(
            async ({ filename }) => {
                const warning = checkParsimony("sync_to_kong_using_deck");
                if (warning) return warning;
                return await toolManager.syncWithSafetyGate(execCtx, filename || "kong-deck-state.yml");
            },
            {
                name: "sync_to_kong_using_deck",
                description: "Applies local configuration changes to the live Kong Gateway. MANDATORY: You MUST run 'preview_sync_diff' in a separate turn first. Then, you MUST ask the user for approval and STOP. Do NOT call this tool until the user replies with 'yes' or 'confirm'. If you call this tool before the user explicitly approves the diff, the safety gate will block it. Use the text '[APPROVAL_REQUIRED]' to trigger the UI buttons.",
                schema: z.object({
                    filename: z.string().describe("The configuration file to sync"),
                }),
            }
        ),

        // SAFETY-GATED: preview_export_diff
        tool(
            async ({ filename }) => {
                const warning = checkParsimony("preview_export_diff");
                if (warning) return warning;
                return await toolManager.previewExportHardened(execCtx, filename || "kong-deck-state.yml");
            },
            {
                name: "preview_export_diff",
                description: "Compares the LIVE Kong Gateway configuration against your local file to show how it will be updated. This is a read-only preview that internally verifies connectivity; do NOT call auxiliary diagnostic tools (Scan/Status/Connect) before / after this.Do not sync or export the changes after this without user approval. You can suggest to export config as next step",
                schema: z.object({
                    filename: z.string().optional().default("kong-deck-state.yml"),
                }),
            }
        ),

        // SAFETY-GATED: export_live_to_storage_file
        tool(
            async ({ filename }) => {
                const warning = checkParsimony("export_live_to_storage_file");
                if (warning) return warning;
                return await toolManager.exportWithSafetyGate(execCtx, filename || "kong-deck-state.yml");
            },
            {
                name: "export_live_to_storage_file",
                description: "Downloads the current live Kong configuration and OVERWRITES your local configuration file (e.g., kong-deck-state.yml). MANDATORY: You MUST run 'preview_export_diff' first and show the results to the user. This tool requires explicit user approval via '[APPROVAL_REQUIRED]' after the preview has been reviewed. NEVER skip the preview step.",
                schema: z.object({
                    filename: z.string().optional().default("kong-deck-state.yml"),
                }),
            }
        ),

        // SAFETY-GATED: reset_kong_instance
        tool(
            async () => {
                const warning = checkParsimony("reset_kong_instance");
                if (warning) return warning;
                return await toolManager.resetWithSafetyGate(execCtx);
            },
            {
                name: "reset_kong_instance",
                description: "DESTRUCTIVE: Wipes ALL configuration (Services, Routes, Plugins, etc.) from the live Kong Gateway. MANDATORY: You MUST run 'get_instance_details' and show the user exactly what will be deleted before asking for approval via '[APPROVAL_REQUIRED]'. NEVER skip the diagnostic phase before a reset.",
                schema: z.object({}),
            }
        ),

    ];
}

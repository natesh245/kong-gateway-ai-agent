import { z } from "zod";
import { tool } from "langchain";
import {
    BaseMessage,
    HumanMessage,
    ToolMessage,
} from "@langchain/core/messages";
import { ToolManager } from "./tools/ToolManager";
import { DiffUtil } from "../utils/DiffUtil";
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
    const { toolManager, config } = ctx;

    // --- Helpers for safety gate checks ---
    function getLastUserContent(): string {
        const messages = ctx.getMessages();
        const lastUser = [...messages].reverse().find(m => m instanceof HumanMessage);
        return SanitizationUtil.stripContext(lastUser?.content as string || "").toLowerCase();
    }

    function recentHistoryHas(keyword: string, lookback = 30): boolean {
        const messages = ctx.getMessages();
        const history = messages.slice(-lookback);
        return history.some((m: any) =>
            m instanceof ToolMessage &&
            typeof m.content === 'string' &&
            m.content.toLowerCase().includes(keyword)
        );
    }

    return [
        // --- Docker / Instance ---
        tool(
            async () => {
                return await toolManager.start(ctx.abortSignal);
            },
            {
                name: "start_kong",
                description: "Starts the local Kong Gateway using Docker Compose (Postgres-backed). Run this if the user asks to start Kong. Takes ~10s to boot.",
                schema: z.object({}),
            }
        ),

        tool(
            async () => {
                return await toolManager.stop(ctx.abortSignal);
            },
            {
                name: "stop_kong",
                description: "Stops the local Kong Gateway Docker Compose setup.",
                schema: z.object({}),
            }
        ),

        tool(
            async () => {
                return await toolManager.status();
            },
            {
                name: "get_kong_status",
                description: "Fetches status info from Kong Admin API to test if it's reachable and running.",
                schema: z.object({}),
            }
        ),

        tool(
            async ({ proxy, admin, manager }) => {
                await config.update?.('proxyPort', proxy);
                await config.update?.('adminApiPort', admin);
                await config.update?.('managerGuiPort', manager);
                return "Successfully updated Kong ports in configuration.";
            },
            {
                name: "update_kong_ports",
                description: "Updates the configured ports for Kong Proxy, Admin API, and Manager GUI. Use this if the user agrees to switch to suggested ports after a conflict.",
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
                description: "Checks if any Docker containers related to Kong or Postgres are currently running.",
                schema: z.object({}),
            }
        ),

        tool(
            async ({ proxyPort, adminPort, managerPort }) => {
                await config.update?.('proxyPort', proxyPort);
                await config.update?.('adminApiPort', adminPort);
                await config.update?.('managerGuiPort', managerPort);
                return "Successfully connected to existing Kong instance by updating configuration.";
            },
            {
                name: "connect_to_existing_instance",
                description: "Adopts an existing Kong instance by updating the Agent's local configuration.",
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
                description: "Pings the Kong Admin API and Proxy to verify they are reachable and ready.",
                schema: z.object({}),
            }
        ),

        tool(
            async () => {
                return await toolManager.openManager();
            },
            {
                name: "open_kong_manager",
                description: "Opens the Kong Manager GUI in the user's default browser.",
                schema: z.object({}),
            }
        ),

        tool(
            async () => {
                const status = await toolManager.status();
                const kongConfig = await toolManager.getKongConfig();
                return `STATUS:\n${status}\n\nCONFIG:\n${JSON.stringify(kongConfig, null, 2)}`;
            },
            {
                name: "get_instance_details",
                description: "Fetches technical details like Kong version, database engine, and runtime configuration.",
                schema: z.object({}),
            }
        ),

        tool(
            async () => {
                return await toolManager.reconcilePorts();
            },
            {
                name: "reconcile_port_settings",
                description: "Detects incorrect port settings by inspecting running containers and the docker-compose file, then updates the configuration to match reality. Use this when connection or health checks fail.",
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
                description: "Lists all files (yml, json, etc) in the current storage directory. Use this to verify which files exist before trying to read or open them.",
                schema: z.object({}),
            }
        ),

        tool(
            async ({ filename }) => {
                return await toolManager.readStorageFile(filename);
            },
            {
                name: "read_storage_file",
                description: "Reads the content of a file in the storage directory for review or analysis.",
                schema: z.object({
                    filename: z.string().describe("The name of the file to read"),
                }),
            }
        ),

        tool(
            async ({ filename, content }) => {
                const oldContent = toolManager.getFileCache(filename) || "";
                await toolManager.writeStorageFile(filename, content);
                const rawDiff = DiffUtil.generateUnifiedDiff(filename, oldContent, content);
                const chatDiff = DiffUtil.formatForChat(rawDiff);
                return `Successfully wrote ${filename}.\n\nDIFF:\n\`\`\`diff\n${chatDiff}\n\`\`\``;
            },
            {
                name: "write_storage_file",
                description: "Writes content to a file in the storage directory. MANDATORY: You must execute this tool IMMEDIATELY when the user asks to add, change, or delete a route/service. Write the file BEFORE asking for approval! The approval phase comes AFTER the file is physically written to disk.",
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
                description: "Opens a specific file from the storage directory in the platform's editor for the user to see.",
                schema: z.object({
                    filename: z.string(),
                }),
            }
        ),

        // --- decK CLI ---
        tool(
            async ({ filename }) => {
                return await toolManager.validateWithDeck(filename || "kong.yml");
            },
            {
                name: "validate_kong_config",
                description: "Uses decK to validate the schema and syntax of a Kong configuration file. Provide a detailed explanation of any validation issues found.",
                schema: z.object({
                    filename: z.string(),
                }),
            }
        ),

        tool(
            async ({ filename }) => {
                return await toolManager.diffWithDeck(filename || "kong.yml");
            },
            {
                name: "preview_sync_diff",
                description: "Compares the local configuration file against the live Kong Gateway to show exact differences. REQUIRED before asking for sync or export approval.",
                schema: z.object({
                    filename: z.string(),
                }),
            }
        ),

        // SAFETY-GATED: sync_to_kong_using_deck
        tool(
            async ({ filename }) => {
                const lastUserContent = getLastUserContent();
                if (lastUserContent === 'yes' || lastUserContent.includes('proceed') || lastUserContent.includes('apply')) {
                    const hasValidated = recentHistoryHas('valid') || recentHistoryHas('success');
                    const hasDiffed = recentHistoryHas('diff') || recentHistoryHas('no differences');

                    if (!hasValidated || !hasDiffed) {
                        return "SAFETY_REQUIRED: I cannot sync without first validating the file and showing you the diff. I must run 'validate_kong_config' and 'preview_sync_diff' first.";
                    }
                    return await toolManager.syncWithDeck(filename || "kong.yml", ctx.abortSignal);
                }
                return "SAFETY_REQUIRED: I cannot execute sync yet. Explain the validation/diff inside <thought> tags, then ask for confirmation with '[APPROVAL_REQUIRED]'.";
            },
            {
                name: "sync_to_kong_using_deck",
                description: "Uses the official decK CLI to synchronize a configuration file (e.g., kong.yml) to the live Kong instance. MANDATORY: You MUST run 'validate_kong_config' and 'preview_sync_diff' and show the results to the user BEFORE asking for approval to sync.",
                schema: z.object({
                    filename: z.string().describe("The configuration file to sync"),
                }),
            }
        ),

        // SAFETY-GATED: export_live_to_storage_file
        tool(
            async ({ filename }) => {
                const lastUserContent = getLastUserContent();
                if (lastUserContent === 'yes' || lastUserContent.includes('confirm')) {
                    const hasDiffed = recentHistoryHas('diff') || recentHistoryHas('no differences');
                    if (!hasDiffed) {
                        return "SAFETY_REQUIRED: I cannot export without first showing you the diff. I must run 'preview_sync_diff' first.";
                    }
                    return await toolManager.dumpWithDeck(filename || "kong.yml");
                }
                return "SAFETY_REQUIRED: I cannot export yet. Show the 'preview_sync_diff' results and ask for confirmation with '[APPROVAL_REQUIRED]'.";
            },
            {
                name: "export_live_to_storage_file",
                description: "Downloads the current live Kong configuration (Services, Routes) and OVERWRITES 'kong.yml' in the storage directory. MANDATORY: You MUST run 'preview_sync_diff' and show the results to the user BEFORE asking for approval to export.",
                schema: z.object({
                    filename: z.string().optional().default("kong.yml"),
                }),
            }
        ),

        // SAFETY-GATED: reset_kong_instance
        tool(
            async () => {
                const lastUserContent = getLastUserContent();
                if (lastUserContent === 'yes' || lastUserContent.includes('confirm reset')) {
                    const hasLive = recentHistoryHas('status', 20);
                    const hasLocal = recentHistoryHas('_format_version', 20);
                    if (!hasLive || !hasLocal) {
                        return "SAFETY_REQUIRED: I cannot reset without analyzing live (get_instance_details) and local (read_storage_file) configs first.";
                    }
                    return await toolManager.resetWithDeck(ctx.abortSignal);
                }
                return "SAFETY_REQUIRED: I cannot reset without explicit confirmation using '[APPROVAL_REQUIRED]'.";
            },
            {
                name: "reset_kong_instance",
                description: "Wipes all current configuration (Services, Routes, Plugins, etc.) from the live Kong instance. MANDATORY: This is destructive. You MUST run 'get_instance_details' and 'read_storage_file', calculate the diff, and show the user exactly what will be removed before asking for approval.",
                schema: z.object({}),
            }
        ),

        // --- decK installation ---
        tool(
            async () => {
                return (await toolManager.isDeckInstalled()) ? "decK is installed." : "decK is not installed.";
            },
            {
                name: "check_deck_installation",
                description: "Verifies if the Kong decK CLI is installed on the host system.",
                schema: z.object({}),
            }
        ),

        tool(
            async () => {
                return await toolManager.installDeck();
            },
            {
                name: "install_deck_cli",
                description: "Installs the Kong decK CLI via Homebrew. Use this only after the user has approved installation.",
                schema: z.object({}),
            }
        ),

        // --- Git ---
        tool(
            async () => {
                return await toolManager.gitInit();
            },
            {
                name: "git_setup_repo",
                description: "Initializes the storage folder as a Git repository and connects it to a remote URL.",
                schema: z.object({}),
            }
        ),

        tool(
            async ({ message }) => {
                const commitResult = await toolManager.gitCommit(message || "Update from Kong Agent");
                await toolManager.gitPush();
                return commitResult;
            },
            {
                name: "git_sync_push",
                description: "Manually commits and pushes all current changes in the storage folder to the remote Git repository.",
                schema: z.object({
                    message: z.string().describe("The commit message"),
                }),
            }
        ),

        tool(
            async ({ sync_to_kong }) => {
                return await toolManager.gitPull();
            },
            {
                name: "git_sync_pull",
                description: "Pulls the latest configuration from the remote Git repository.",
                schema: z.object({
                    sync_to_kong: z.boolean().describe("Whether to automatically sync the pulled 'kong.yml' to the live Kong Gateway."),
                }),
            }
        ),

        tool(
            async () => {
                return await toolManager.gitStatus();
            },
            {
                name: "git_get_status",
                description: "Checks the current status of the Git repository in the storage folder.",
                schema: z.object({}),
            }
        ),
    ];
}

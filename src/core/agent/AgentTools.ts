import OpenAI from "openai";

export const AGENT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
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

# 🦍 Kong Gateway Agent for VS Code

An AI-powered VS Code extension that provides a declarative, GitOps-first interface for managing Kong Gateway instances.

## 🚀 Key Features

- **Agentic AI Interface**: Manage Kong via natural language chat (powered by OpenRouter/LLM).
- **GitOps-First Workflow**: Uses the official **decK CLI** for declarative configuration (`kong.yml`).
- **Flexible Connectivity**: Support for **Local** (Docker-based) and **Remote** (URL-based) Kong instances.
- **Docker Integration**: Automated lifecycle management (Start/Stop/Logs) for local Kong and Postgres.
- **Enterprise Support**: Handles **Workspaces**, **RBAC Tokens**, and **TLS Verification** settings.
- **Safety First**: Mandatory validation and diff previews before syncing changes to live instances.
- **Visual Excellence**: Modern, premium chat UI with "Thinking Process" toggles and error highlighting.

---

## 🛠️ Prerequisites

1.  **Docker Desktop**: Required for Local mode and the Dockerized decK fallback.
2.  **decK CLI** (Optional): If installed on your host, the agent will use it directly for faster performance.
3.  **OpenRouter API Key**: Required for the LLM-based reasoning agent.

---

## ⚡ Getting Started

### 1. Installation & Development Setup
Clone the repository and install dependencies:
```bash
git clone <your-repo-url>
cd kong-gateway-agent
npm install
```

### 2. Run the Extension
- Open the project in VS Code.
- Press `F5` (or go to **Run and Debug** > **Extension**) to launch a new VS Code window with the extension loaded.
- Click the **Kong Agent** icon (⚡) in the Activity Bar to open the chat sidebar.

### 3. Test & Build
- **Watch mode**: `npm run watch` (rebuilds as you save).
- **Production Build**: `npm run build`.

---

## ⚙️ Configuration

Open the **Settings Panel** within the Kong Agent Chat view to configure:

| Setting | Description |
| :--- | :--- |
| **LLM Provider** | Choose between **OpenRouter** or local models via **Ollama**. |
| **API Key** | Your OpenRouter API key. |
| **Kong Mode** | Toggle between **Local (Docker)** and **Remote (URL)**. |
| **Storage Path** | Where your `kong.yml` and `docker-compose.yml` files are stored. |
| **Admin Token** | Your RBAC token for authenticated Kong instances. |
| **Workspace** | Target a specific Kong workspace (e.g., `default`). |
| **Skip TLS** | Disable TLS verification for self-signed certificates. |

---

## 🔄 Recommended Workflow

The agent enforces a professional GitOps lifecycle:
1.  **Edit**: Modify your `kong.yml` through the chat (e.g., "Add a route to /service").
2.  **Validate**: The agent runs `deck validate` automatically.
3.  **Preview Diff**: The agent generates a `deck diff` to show live-vs-local changes.
4.  **Review**: You review the exact changes in the chat.
5.  **Sync**: Approve the sync to apply changes to the live Kong Gateway.

---

## 🔍 Troubleshooting

- **Port Collisions**: Use the **"Check Local Ports"** button in settings to verify if 8000, 8001, etc., are available.
- **Docker Errors**: Ensure Docker Desktop is running. The agent uses `host.docker.internal` for local connectivity.
- **Permission Issues**: The agent uses a "Volume-less" export method for `deck dump` to avoid host filesystem permission errors on macOS.

---

## 📄 License
MIT

# 🦍 Kong Gateway Agent for VS Code

An AI-powered VS Code extension that provides a declarative, GitOps-first interface for managing Kong Gateway instances.

## 🚀 Key Features

- **Agentic AI Interface**: Manage Kong via natural language chat (powered by OpenRouter/LLM).
- **GitOps-First Workflow**: Uses the official **decK CLI** for declarative configuration (`kong-deck-state.yml`).
- **Flexible Connectivity**: Support for **Local** (Docker-based) and **Remote** (URL-based) Kong instances.
- **Docker Integration**: Automated lifecycle management (Start/Stop/Logs) for local Kong and Postgres.
- **Token & Context Tracking**: Real-time monitoring of token consumption with intelligent **Sliding Window Summarization** to prevent context loss.
- **Enterprise Support**: Handles **Workspaces**, **RBAC Tokens**, and **TLS Verification** settings.
- **Hardened Safety Gates**: Mandatory validation and diff previews with robust text-based fallback detection for sync/export/reset.
- **Modular Architecture**: Decoupled core logic (State, History, Client, Stream) for high performance and stability.
- **Visual Excellence**: Modern, premium chat UI with "Thinking Process" toggles and error highlighting.
- **Loop Protection**: Built-in watchdog to prevent infinite reasoning loops and tool call churning.

---

## 🦍 What can the Kong Agent do?

The agent is a specialized specialist for Kong Gateway operations, capable of performing complex multi-step tasks across several domains:

### 🚢 Docker & Environment Management
- **Lifecycle Control**: Start, stop, and restart local Kong Gateway and Postgres instances.
- **Health Monitoring**: Check Docker container status and verify Admin/Proxy API connectivity.
- **Port Reconciliation**: Automatically detect and fix mismatches between your configuration and running Docker containers.
- **Instance Adoption**: Seamlessly connect to and manage existing Kong instances found on your system.

### 📜 Declarative Configuration (decK)
- **GitOps Workflows**: Full support for `validate`, `diff`, and `sync` operations using `kong-deck-state.yml`.
- **Live-to-Local Export**: Download current live configurations and surgically update your local files with preview diffs.
- **Safe Resets**: Wipe a live Kong instance after generating a detailed markdown inventory of what will be deleted.
- **Entity Discovery**: Search and list live Services, Routes, Plugins, and Consumers.

### 🛠️ APIOps & Transformation
- **OAS Conversion**: Transform OpenAPI (Swagger) specifications into Kong declarative configuration.
- **Configuration Linting**: Validate your Kong configuration against best practices and custom rulesets.
- **Modular Management**: Merge multiple configuration files or apply patches to existing YAML states.

### 📂 Integrated Workspace Tools
- **Surgical File Edits**: Modify specific parts of your configuration files with human-in-the-loop approval.
- **Staged Changes**: View diffs of proposed file changes directly in the VS Code editor before accepting them.
- **Git Integration**: Push and pull configuration changes to/from remote Git repositories.


---

## 📂 Repository Structure

The project follows a modular architecture:
- **`src/core/`**: Platform-agnostic logic (Agent, Tool Management, Kong API Client).
- **`src/platforms/`**: Platform-specific implementations (e.g., VS Code extension, Webview).
- **`src/test/`**: End-to-End (E2E) testing suite using `@vscode/test-electron` and Mocha.


For more details, see the sub-READMEs in each directory.

---

## 🛠️ Prerequisites

1.  **Docker Desktop**: Required for Local mode and the Dockerized decK fallback.
2.  **decK CLI**: The agent includes automated installation for macOS (via Homebrew) and robust fallback logic for other platforms.
3.  **OpenRouter/Gemini API Key**: Required for the LLM-based reasoning agent.


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
- Press `F5` (or go to **Run > Start Debug** ) to launch a new VS Code window with the extension loaded.
- Click the **Kong Agent** icon (⚡) in the Activity Bar to open the chat sidebar.
- Your conversation history will be automatically restored on every launch.

### 3. Testing & Quality

#### Automated Logic Tests
Run the core test suite (decK interactions, agent logic):
```bash
npm run compile
npm test
```

#### Visual Webview Testing
For rapid UI iteration without launching a full VS Code instance, use the provided **Webview Harness**:
1. Start a local server (e.g., `npx serve .`) from the root.
2. Open `src/platforms/vscode/test/webview-harness.html` in your browser.
3. This harness mocks the VS Code API and CSS variables, allowing you to test:
    - Chat scrolling and message rendering.
    - Component styling and theme consistency.
    - Configuration panel interactions.

Check code quality:
```bash
npm run lint
npm run format
```


---

## ⚙️ Configuration

Open the **Settings Panel** within the Kong Agent Chat view to configure:

| Setting | Description |
| :--- | :--- |
| **LLM Provider** | Choose between **OpenRouter** or **Google Gemini**. |
| **API Key** | Your OpenRouter or Gemini API key. |
| **Kong Mode** | Toggle between **Local (Docker)** and **Remote (URL)**. |
| **Max Tool Depth** | Limit how many tool-calls the agent can make per turn. |
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

## 🚀 Roadmap / Future Features

- **Intelligent Context Management**: [PHASE 1 COMPLETE] Implemented sliding window summarization to prevent "context cliff" effects.
- **Multiple Chat Sessions**: Support for switching between different Kong environments or tasks without losing context or mixing settings.
- **SQLite Storage**: [PHASE 2 COMPLETE] Implementation of `MemoryManager` for robust disk-based chat history and fact storage, including legacy data migration.

---

## 📝 Documentation

- [Future Considerations](FUTURE_CONSIDERATIONS.md): Tracking ideas and future enhancements.
- [Known Issues](ISSUES.md): Tracking known issues and bugs.

---

## 📄 License
MIT

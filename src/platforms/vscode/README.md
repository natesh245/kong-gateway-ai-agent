# ⚡ Kong Gateway Agent - VS Code Platform

This directory contains the VS Code-specific implementation of the Kong Gateway Agent. It serves as the bridge between the IDE and the core reasoning engine.

## 🏗️ Architecture

The platform follows a classic VS Code Webview architecture:

1.  **`extension.ts`**: The main entry point that registers commands and initializes the `ChatViewProvider`.
2.  **`ChatViewProvider.ts`**: The "Backend" of the sidebar. It manages the `Agent` instance and handles `postMessage` communication with the Webview.
3.  **`chat.js`**: The client-side logic running inside the Webview (sidebar).
4.  **`chat.html`** & **`chat.css`**: The structural and visual presentation of the chat interface.

---

## 🎨 UI/UX Design

The webview is built using **Vanilla CSS** and **HTML5** to maintain maximum performance and a premium, professional aesthetic.

### Key Visual Elements:
- **Dynamic Model Bar**: A compact info bar above the input that shows the active Provider, Model, and **Usage Statistics** (Tokens & Context %).
- **Reasoning Stream**: A foldable session container that displays the agent's `<thought>` process and current tool-call status.
- **Diff Highlighting**: Custom CSS highlighting for `deck diff` outputs to show additions (+) and deletions (-) clearly within the chat bubble.
- **Portal Dropdowns**: A fixed-positioning implementation for searchable model selectors to prevent UI clipping in scrollable panels.

---

## 🔌 IDE Integration Features

The VS Code platform provides deep integration with the editor's environment to enhance the developer experience:

- **Automatic Workspace Discovery**: Detects `docker-compose.yml`, `kong.yml`, and `ruleset.yaml` files in the active workspace on startup.
- **Staged File Editing**: Proposed configuration changes are written to temporary "staged" files and opened in a side-by-side **Diff Editor** for manual review.
- **Persistent Global State**: Conversation history, token counts, and configuration settings are stored in VS Code's `globalState`, ensuring they survive extension updates and IDE restarts.
- **Dynamic Model Fetching**: Automatically fetches available model lists from OpenRouter/Gemini based on your API Key.
- **Theme Awareness**: The chat UI automatically adapts to your VS Code theme (Light, Dark, High Contrast) using standard CSS variables.
- **Abort Signal Propagation**: Long-running tool calls (like starting Kong or syncing large files) can be safely cancelled using the "Cancel" button, which propagates an `AbortSignal` all the way to the underlying CLI/Docker process.

---

## 🛰️ Messaging Protocol

Communication between the `ChatViewProvider` (Host) and `chat.js` (Webview) occurs via `vscode.postMessage`:

### Host -> Webview (`postMessage`):
- **`addMessage`**: Appends a user or agent message to the UI.
- **`setConfig`**: Synchronizes settings (Provider, Model, Ports) with the UI.
- **`updateUsage`**: Sends real-time token and context % updates.
- **`toolStatus`**: Updates the "Currently executing..." text in the reasoning session.
- **`performClear`**: Triggers a full UI wipe on "Clear Chat".

### Webview -> Host:
- **`prompt`**: Sends a user message to the agent.
- **`updateConfig`**: Saves modified settings (API Key, Provider, etc.) back to VS Code's configuration.
- **`cancelAgent`**: Aborts the current reasoning/tool loop (using `AbortController`).
- **`fetchModels`**: Requests an updated list of models for the active provider.

---

## 🛠️ Development & Building

### Assets:
- CSS tokens are derived from VS Code's standard theme colors (using variables like `--vscode-editor-background`) to ensure perfect compatibility with Light, Dark, and High-Contrast themes.
- Icons are implemented using standard Unicode characters and custom CSS shapes for a dependency-free, fast-loading experience.

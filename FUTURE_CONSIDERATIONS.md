# Future Considerations

This document tracks ideas, feature requests, and design considerations for future development of the Kong Gateway Agent.

## Ideas & Enhancements
- (Ongoing tracking of future architectural and feature discussions)

### Chat History Persistence
**Current State**: 
We are currently persisting chat messages using VS Code's native `ExtensionContext.globalState` (specifically `kongAgentChatHistory`). It is limited to the last 50 messages to prevent state bloat, as `globalState` is not designed for massive data payloads.

**Future Considerations for Better Persistence**:
1. **Local File System (`.jsonl` or `.json` logs)**: Storing history in a dedicated file (e.g., `~/.kong-agent/history.json`). This would eliminate VS Code's native state limits, allow users to easily backup or clear their logs, and support unlimited history.
2. **Local Database (SQLite)**: A more robust approach if we want to introduce features like "Search past chats", "Multiple chat threads/sessions", or paginated loading without dumping everything into memory at once.
3. **Workspace-based Persistence**: Moving away from `globalState` (which applies to the whole editor) to `workspaceState` or `.vscode/agent-history.json` if we want project-specific conversations.

### Multiple Chat Sessions & Scoped Configuration
**Status**: 💡 Proposed (Not planned for immediate implementation)

**Goal**: Support multiple independent chat sessions, allowing users to switch between different Kong environments or tasks without mixing contexts.

**Proposed Architecture**:
- **Session Manager**: A dedicated class to handle session lifecycle and file-based persistence (JSON).
- **Scoped Configuration**: A configuration wrapper that allows per-session overrides for settings like `kongMode`, `adminApiUrl`, and `workspace`.
- **UI Switched**: A session browser in the sidebar to create, rename, and switch between active threads.

### LangChain Migration
**Status**: 🏗️ In Planning

**Goal**: Refactor the custom reasoning engine to use LangChain for better tool-calling reliability, standardized property validation (Zod), and easier multi-provider management.

**Key Benefits**:
- **Structured Tooling**: Move away from manual JSON schema mapping in `AgentTools.ts` to `StructuredTool` classes.
- **Improved Reasoning**: Use `AgentExecutor` or `LangGraph` to manage complex multi-turn reasoning and safety loops.
- **Provider Agnostic**: Seamlessly integrate other providers (Anthropic, Bedrock) using LangChain's mature ecosystem.

[See proposed LangChain Migration Plan](file:///Users/natesh/.gemini/antigravity/brain/75beacb7-63b5-4ea0-92a5-6c56860f8b62/langchain_migration_plan.md)

### Frontend Migration: React for VS Code Chat
**Status**: 💡 Proposed (Feasibility Confirmed)

**Goal**: Replace the current 1,000-line vanilla JavaScript `chat.js` with a modern React-based architecture to improve maintainability, state management, and UI extensibility.

**Key Benefits**:
- **Declarative UI**: Move away from manual DOM manipulation (`document.createElement`) to state-driven rendering.
- **Component isolation**: Individual components for Thinking bubbles, Message units, Port-check cards, and Settings inputs.
- **Type Safety**: Use TypeScript for the entire frontend to prevent common runtime errors in the webview.
- **Improved State Sync**: Use React hooks (e.g., `useVsCodeApi`) to manage the complex configuration and history synchronization.

**Proposed Architecture**:
- **Bundling**: Use `esbuild` to bundle `src/platforms/vscode/webview/index.tsx` into a single `dist/webview/chat.js`.
- **VS Code Toolkit**: Leverage `@vscode/webview-ui-toolkit` for native-looking components (buttons, text fields, checkboxes).
- **Communication Layer**: A custom React context to handle `postMessage` and `onMessage` events seamlessly.

### Full-Screen Mode (WebApp Layout)
**Status**: 💡 Proposed

**Goal**: Provide a rich, dashboard-like experience by allowing the Kong Agent to open in a full editor tab (`WebviewPanel`) instead of just the sidebar.

**Proposed Features**:
- **Dual-Pane Layout**: A side-by-side view featuring a persistent Instance Dashboard (real-time metrics, service health, and active routes) on one side and the Reasoning Chat on the other.
- **Enhanced Visualizations**: Use the increased screen real-estate for bigger diff previews, topology maps of Kong services, and interactive configuration editors.
- **Shared Context**: Ensure perfect synchronization between the sidebar and the full-screen view using a centralized `AgentManager`.
- **"Zen Mode" Support**: A distraction-free interface focused purely on declarative GitOps workflows.

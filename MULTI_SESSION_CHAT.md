# Multi-Session Chat: Concurrent Task Management

Multi-Session Chat allows users to maintain multiple, independent conversation threads. This is essential for switching between different tasks (e.g., a long-running migration vs. a quick diagnostic check) without losing context or polluting history.

## 1. User Experience (UX)

### A. Session Management UI
*   **Session List**: A vertical list in the VS Code sidebar or a "History" tab in the Chat Webview showing all saved sessions.
*   **New Chat**: A prominent button to start a fresh thread with a clean context.
*   **Session Titles**: The Agent will automatically generate a concise title (e.g., "Auth Service Migration") after the first 2-3 messages using the `PromptAnalyser`.

### B. Switching & State Persistence
*   When a user switches sessions, the current `AgentState` is serialized and archived, and the new session's state is loaded into memory.
*   **Target Isolation**: Each session maintains its own **Configuration Overlay**. This includes:
    *   **Workspace Path**: Pointing to a specific local folder.
    *   **Kong Instance**: Unique URLs, Admin API keys, and port settings.
*   **Staged Changes Isolation**: Each session can have its own set of "Staged Files." This prevents changes from a "Debug" session from accidentally being committed in a "Production Deploy" session.

---

## 2. Technical Architecture

### A. Data Schema
Sessions will be stored as individual JSON files in the **External Global Storage** (refer to `AGENT_MEMORY.md`):

```json
{
  "id": "uuid-v4",
  "title": "Migration of Auth Service",
  "createdAt": "2024-05-09T...",
  "updatedAt": "2024-05-09T...",
  "messages": [...],
  "stagedFiles": [...],
  "config": {
    "workspacePath": "/Users/user/projects/service-a",
    "kongMode": "remote",
    "adminApiUrl": "https://kong-dev-a.internal",
    "adminApiPort": 8001,
    "proxyPort": 8000
  },
  "metadata": {
    "totalTokens": 4500,
    "kongMode": "local"
  }
}
```

### B. The Session Manager
A new `SessionManager.ts` will coordinate the lifecycle:
*   `createSession()`: Initializes a new state.
*   `switchSession(id)`: Handles the swap, including updating the UI.
*   `deleteSession(id)`: Removes the local JSON file.
*   `archiveSession(id)`: Moves the session to a "Long-term Storage" category to keep the active list clean.

---

## 3. Implementation Roadmap

### Phase 1: Storage Refactoring (Short-Term)
- [ ] Move from a single `globalState` key to a file-per-session model in `globalStorageUri`.
- [ ] Implement `SessionManager` to handle basic CRUD (Create, Read, Update, Delete) of sessions.

### Phase 2: Webview UI (Medium-Term)
- [ ] Add a "History" or "Sessions" drawer to the React/Webview UI.
- [ ] Implement "Auto-titling" logic using a lightweight LLM call.

### Phase 3: Advanced Orchestration (Long-Term)
- [ ] **Cross-Session Knowledge**: Allow the agent to "Recall" facts from a different session via the `ContextEngine`.
- [ ] **Shared State**: Optionally allow sessions to share a "Global Knowledge Base" while keeping their message history separate.

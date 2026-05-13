# 🧠 Kong Gateway Agent - Core Logic

This directory contains the platform-agnostic core logic for the Kong Gateway Agent. It is designed to be embedded in various platforms (VS Code, CLI, Web) by providing a unified reasoning and tool-execution engine.

## 🏗️ Architecture

The Agent core has been refactored into a modular, decoupled architecture to improve maintainability and testability:

1.  **`Agent.ts`**: The central coordinator (Facade) that orchestrates the conversation loop.
2.  **`AgentState.ts`**: Encapsulates conversation history, token usage tracking, and turn-specific execution metadata.
3.  **`AgentHistory.ts`**: Handles marshaling between LangChain `BaseMessage` structures and the external JSON formats required by UIs. Includes advanced history analysis for safety gates.
4.  **`AgentClient.ts`**: Manages LLM provider initialization (OpenRouter/Gemini), model discovery, and observability (LangSmith).
5.  **`AgentStream.ts`**: A specialized processor for handling streaming AI output, including the extraction of `<thought>` tags for reasoning display.
6.  **`SemanticManager.ts`**: Handles local vector indexing and similarity search for long-term technical memory (RAG).
7.  **`ToolManager.ts`**: Coordinates specialized tool implementations (Docker, decK, Git, etc.).

---

## 🛡️ Safety & Watchdogs

The agent includes several layers of protection to ensure safe operations on Kong Gateway instances:

### 1. Hardened Safety Gates
High-impact tools (Sync, Export, Reset) are protected by safety gates that require a previous "preview" step. These gates are now **hardened with text-based fallbacks**:
- Even if the LLM skips a tool call but describes the preview results in plain text, the system recognizes the intent and allows the subsequent approved action to proceed.
- Supported markers include `[SYNC_PREVIEW]`, `PREVIEW EXPORT RESULTS`, and `RESET PREVIEW DATA`.

### 2. Loop Watchdog (`AgentWatchdog.ts`)
A specialized utility that detects and prevents infinite reasoning loops or excessive tool call churning. It monitors for:
- Repetitive tool calls with identical arguments.
- Excessive turn counts that exceed safety limits.

### 3. Context & Token Monitoring
The `AgentState` class tracks resource consumption in real-time, while the `Agent` core enforces proactive stability:
- **`inputTokens` / `outputTokens`**: Detailed usage metrics per turn and session.
- **Predictive Guardrails**: Proactively estimates the token impact of new prompts and triggers summarization **before** calling the model if the projected context exceeds 85%.
- **Semantic Memory (RAG)**: Integrates with `SemanticManager` to index conversation summaries, allowing the agent to use the `recall_memory` tool to find past technical context.

---

## ⚒️ Tool Management

Tools are defined as standard LangChain `tool()` instances. The `ToolManager` coordinates the execution and provides context to each tool through a unified `ToolExecutionContext`.

### Available Tool Sets:
- **Docker Lifecycle**: Start/stop/status for Postgres and Kong containers.
- **Declarative (decK)**: `validate`, `diff`, `sync`, `export`, and `reset` commands.
- **Filesystem**: Managed reading and writing of configuration files with automatic staging and diffing.
- **Memory (RAG)**: Semantic search and recall of past conversation summaries.
- **GitOps**: Support for syncing local configurations with remote Git repositories.

# Agent Memory: Optimization & Architecture

This document outlines the current state of the Kong Gateway Agent's memory system and proposes optimizations to enhance performance, reliability, and context retention.

## 1. Current Memory Architecture

The agent currently employs three distinct types of "memory":

### A. Conversational Memory (`AgentHistory.ts`, `AgentState.ts`, `ChatViewProvider.ts`)
*   **Implementation**: A linear array of LangChain `BaseMessage` objects.
*   **Persistence**: Automatically persisted to VS Code's `globalState` (memento) under the key `kongAgentChatHistory`.
*   **Buffer Limit**: Persisted history is capped at the **last 50 messages** to prevent state bloat.
*   **Management**: If the total token count exceeds the `maxContext` (default 130k), the active runtime history is **hard-reset** (cleared back to the system prompt).
*   **Filtering**: `thinking` and `off-topic` messages are excluded from the LLM prompt but preserved in the UI and persistent history.

### B. Staged Action Memory (`StorageTool.ts`)
*   **Implementation**: A Map (`_stagedFiles`) storing pending file modifications.
*   **Scope**: Session-bound, with fallback to `.staged` files on disk.
*   **Purpose**: Tracks cumulative edits to configuration files before they are finalized or exported.

### C. Discovery Memory (`Agent.ts`)
*   **Implementation**: `activeFiles` object in `AgentState`.
*   **Scope**: Re-evaluated at the start of every message turn via `toolManager.storage.findFilesByContent()`.
*   **Purpose**: Provides the "Source of Truth" for Kong-related files in the workspace.

---

## 2. Identified Limitations

1. **Fixed Persistence Buffer**: The current 50-message cap in `ChatViewProvider.ts` is arbitrary and may cut off relevant context for long-running architectural migrations.
2. **Context Exhaustion (The "Cliff" Effect)**: When the context limit is hit, the agent loses all memory of the current task. There is no middle ground between "full history" and "no history."
3. **State Decay**: The agent is told to "trust memory of the system state for 60 seconds," but there is no explicit mechanism to expire or refresh specific system facts.
4. **Redundant Processing**: Re-discovering files on every turn is inefficient for large workspaces.

---

## 3. Proposed Optimizations

### Tier 1: Intelligent Context Management (Short-Term)

#### 1.1 Sliding Window Summarization
Instead of a hard reset, implement a sliding window.
*   **Mechanism**: When tokens reach 80% of `maxContext`, the oldest 40% of messages are sent to a "Summarizer" LLM.
*   **Result**: The summarized context is injected as a single `SystemMessage` or `HumanMessage` at the start of the chain, and the raw messages are purged.

#### 1.2 "Thinking" Compression
The `thinking` tags can be quite verbose.
*   **Mechanism**: Store full reasoning in history for UI audit logs, but only send the last 2-3 reasoning steps to the LLM in subsequent turns.

### Tier 2: Persistent Long-Term Memory (Medium-Term)

#### 2.2 Knowledge Extraction (Entity Memory)
*   **Implementation**: Extract key facts (e.g., "The user is using Kong Enterprise 3.4") and store them in a persistent JSON key-value store.
*   **Temporal Resolution**: During extraction, convert relative dates ("yesterday", "last week") into absolute timestamps to ensure memory accuracy over long durations.
*   **Supersession Logic**: If a fact is updated (e.g., Kong version changes from 3.4 to 3.5), the old memory should be marked as "Superseded" with a pointer to the new version, preserving a version chain for auditability.
*   **Storage Location**: **External** (VS Code `globalStorageUri`).

#### 2.3 Configuration Persistence (Global) [PROPOSAL ONLY]
*   **Implementation**: Create a `GlobalConfigProvider` that mirrors non-sensitive settings into a JSON file located in the extension's global storage path (outside the workspace).
*   **Benefit**: Maintains settings across different sessions and machines (if synced) without cluttering the project or exposing secrets to the workspace tools.

#### 2.4 Procedural Memory (Rules & Patterns)
*   **Implementation**: A specialized persistent layer for the agent's "Operational DNA."
*   **Content**: Hard-earned rules (e.g., "Always check if a service has active routes before deletion", "Use the 1.5.0-latest tag for decK in this environment").
*   **Benefit**: Unlike the system prompt (which is fixed), Procedural Memory allows the agent to "learn" new operational guardrails over time.

#### 2.5 Knowledge Graph Integration (Long-Term)
*   **Implementation**: Model the relationship between Kong entities (Services, Routes, Plugins, Upstreams) in a graph format.
*   **Benefit**: Allows the agent to perform "Relational Reasoning" (e.g., "If I delete this Service, which Routes will be orphaned?") without having to re-scan the entire workspace.

*   **⚠️ SECURITY UPDATE**: All internal agent memory (Chat History, Summaries, Vector Indexes) should reside in **External Storage** (VS Code's Global App Data) by default. The local workspace should ONLY contain files that are part of the active development cycle (e.g., `.staged` files for user-driven diffing).

### Tier 3: Semantic Retrieval (Long-Term)

#### 3.1 Vector Memory (RAG)
*   **Implementation**: Integrate a local vector store (e.g., ChromaDB or a simple JSON-based vector index).
*   **HyDE (Hypothetical Document Embedding)**: Improve retrieval by having the agent generate a "Hypothetical Answer" and searching for memories similar to that answer, rather than searching with the user's raw query.
*   **Usage**:
    *   **Past Solutions**: Index successful tool execution sequences.
    *   **Kong Documentation**: Index relevant sections of Kong docs for RAG retrieval.
    *   **Large Configs**: If a `kong.yml` is too large for context, chunk it and retrieve relevant parts semantically.

---

## 4. Implementation Roadmap

### Phase 1: Context Stability
- [ ] Implement `SlidingWindowMemory` in `AgentHistory.ts`.
- [ ] Add a `summarizeHistory` utility in `PromptAnalyser.ts`.
- [ ] Replace `this.resetContext()` in `Agent.ts` with a call to the summarizer.

### Phase 2: Persistence
- [ ] Create `MemoryManager.ts` to handle disk I/O for session state.
- [ ] Implement automatic "save on turn end" and "load on init".
- [ ] Implement `LocalConfigProvider` to sync VS Code settings to `.kong-agent/config.json`.

### Phase 3: Semantic Enhancement
- [ ] Research lightweight vector embedding options for local use.
- [ ] Implement `ContextualRetrievalTool` to pull from history semantically when context is tight.

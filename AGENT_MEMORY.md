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
5. **Watchdog Infinite Loops (Root Causes Found)**: 
    *   **Baseline Stale-ness**: After summarization, the internal `lastTurnUsage` counter must be reset to the new compressed size. Failure to do so causes the Watchdog to trigger instantly on the next turn.
    *   **Threshold Blocking**: Summarization thresholds based purely on message count (e.g., > 6 messages) fail in "heavy" short-lived sessions where a single large YAML dump can hit the 100% limit in just 2-3 turns.

---

## 3. Proposed Optimizations

### Tier 1: Intelligent Context Management (Short-Term)

#### 1.1 Tiered Context Recovery (Summarization & Truncation)
Instead of a hard reset, the agent employs a two-stage stabilization strategy:
*   **Tier 1: Intelligent Summarization (85% Agent Limit)**: The agent attempts to condense the oldest 40% of history using an LLM. This preserves technical facts while reclaiming space.
*   **Tier 2: Hard Truncation Fallback (Fail-safe)**: If summarization fails (e.g., the **LLM's physical context** is hit, or the provider errors), the agent performs a deterministic "Hard Truncation"—discarding the oldest messages without an LLM call.
*   **Baseline Reset**: After either recovery method, the agent resets its internal token counters to prevent "Watchdog" infinite loops.

#### 1.2 "Thinking" Compression
The `thinking` tags can be quite verbose.
*   **Mechanism**: Store full reasoning in history for UI audit logs, but only send the last 2-3 reasoning steps to the LLM in subsequent turns.

### Tier 2: Persistent Long-Term Memory (Medium-Term)

#### 2.2 Knowledge Extraction (Entity Memory)
*   **Implementation**: Extract key facts (e.g., "The user is using Kong Enterprise 3.4") and store them as structured **Memory Units**.
*   **Memory Unit Metadata**:
    *   **Temporal Context**: Absolute timestamp of when the fact was learned.
    *   **Strength Indicator**: A score (0.0 - 1.0) based on verification (e.g., direct API response = 1.0, user mention = 0.8, LLM inference = 0.5).
    *   **Associative Links**: References to related files, Kong entities, or other memories.
*   **Temporal Resolution**: During extraction, convert relative dates ("yesterday", "last week") into absolute timestamps to ensure memory accuracy over long durations.
*   **Supersession Logic**: If a fact is updated, the old memory should be marked as "Superseded" with a pointer to the new version.
*   **Storage Location**: **External** (VS Code `globalStorageUri`).

#### 2.3 Configuration Persistence (Global) [PROPOSAL ONLY]
*   **Implementation**: Create a `GlobalConfigProvider` that mirrors non-sensitive settings into a JSON file located in the extension's global storage path (outside the workspace).
*   **Benefit**: Maintains settings across different sessions and machines (if synced) without cluttering the project or exposing secrets to the workspace tools.

#### 2.4 Procedural Memory (Rules & Patterns)
*   **Implementation**: A specialized persistent layer for the agent's "Operational DNA."
*   **Content**: Hard-earned rules (e.g., "Always check if a service has active routes before deletion", "Use the 1.5.0-latest tag for decK in this environment").
*   **File-Anchored Memory**: Associate specific memories with individual files (e.g., "Note: `kong-auth.yml` requires the `jwt` plugin version 2.0+"). When the agent reads a file, its anchored memories are automatically injected into the prompt.
*   **Benefit**: Unlike the system prompt (which is fixed), Procedural Memory allows the agent to "learn" new operational guardrails over time.

#### 2.5 Knowledge Graph Integration (Long-Term)
*   **Implementation**: Model the relationship between Kong entities (Services, Routes, Plugins, Upstreams) in a graph format.
*   **Benefit**: Allows the agent to perform "Relational Reasoning" (e.g., "If I delete this Service, which Routes will be orphaned?") without having to re-scan the entire workspace.

#### 2.6 Episodic Memory (Success Patterns)
*   **Implementation**: Automatically extract and store "Success Episodes"—sequences of tool calls that successfully resolved a complex task.
*   **Causal Linking**: Each episode stores the **Intent -> Action -> Result** chain, helping the agent understand *why* a specific solution worked.
*   **Pattern Matching**: When the agent encounters a similar problem in the future, it retrieves the successful episode as a "few-shot" example.
*   **Trial-and-Error Pruning**: Explicitly discard failed attempts and only store the final, verified solution path in long-term episodic memory.

*   **⚠️ SECURITY UPDATE**: All internal agent memory (Chat History, Summaries, Vector Indexes) should reside in **External Storage** (VS Code's Global App Data) by default. The local workspace should ONLY contain files that are part of the active development cycle (e.g., `.staged` files for user-driven diffing).

### Tier 3: Semantic Retrieval (Long-Term)

#### 3.1 Vector Memory (RAG)
*   **Hybrid Search**: Implement a dual-index system combining **Vector Similarity** (for semantic meaning) and **Keyword Search/BM25** (for exact technical terms like error codes or entity IDs).
*   **Storage**: Integrate a local vector store (e.g., ChromaDB or a simple JSON-based vector index).
*   **HyDE (Hypothetical Document Embedding)**: Improve retrieval by having the agent generate a "Hypothetical Answer" and searching for memories similar to that answer, rather than searching with the user's raw query.
*   **Usage**:
    *   **Past Solutions**: Index successful tool execution sequences.
    *   **Kong Documentation**: Index relevant sections of Kong docs for RAG retrieval.
    *   **Large Configs**: If a `kong.yml` is too large for context, chunk it and retrieve relevant parts semantically.
    *   **[NEW] Technical Reference (Doc-RAG)**: Ingest official Kong and decK documentation as a read-only semantic layer to eliminate schema hallucinations.

---

## 4. Implementation Roadmap

### Phase 1: Context Stability
- [x] Implement `SlidingWindowMemory` in `AgentHistory.ts`.
- [x] Add a `summarizeHistory` utility in `PromptAnalyser.ts`.
- [x] Replace `this.resetContext()` in `Agent.ts` with a call to the summarizer.
- [ ] Implement **Hard Truncation Fallback** to handle LLM-physical-limit breaches.
- [ ] **Harden Baseline Reset**: Ensure `lastTurnUsage` is updated immediately after any context optimization to prevent watchdog loops.
- [ ] **Relax Summarization Thresholds**: Trigger summarization for "heavy" histories regardless of low message count.

### Phase 2: Persistence
- [x] Create `MemoryManager.ts` to handle disk I/O for session state.
- [x] Implement automatic "save on turn end" and "load on init".
- [x] Implement one-time migration from `globalState` to file-based storage.

### Phase 3: Semantic Enhancement [COMPLETE]
- [x] Research and implement local vector indexing in `SemanticManager.ts`.
- [x] Integrate embedding API (Gemini/OpenRouter) in `AgentClient.ts`.
- [x] Add `recall_memory` tool for explicit semantic retrieval (RAG).
- [x] Implement **Predictive Context Guardrails** to proactively summarize before large payloads.
- [x] **Harden RAG**: Implement a **0.40 similarity threshold** to eliminate memory noise.
- [x] **Harden Intent**: Update `PromptAnalyser` to classify "Recall" requests as valid technical tasks.

### Phase 4: Knowledge Extraction & Facts [PENDING]
- [ ] Implement a `FactExtractor` to pull structured entities (versions, ports, envs) from history.
- [ ] Store facts in a dedicated `facts.json` to supplement the fuzzy summaries.
- [ ] Implement "Supersession" logic to update facts when the user changes configuration.

### Phase 5: Memory Lifecycle & Journaling [PENDING]
- [ ] **Session Journaling**: Automatically generate and store a semantic summary in the vector store before a user performs a "Clear Chat" action.
- [ ] **Memory TTL Pruning**: Implement time-based expiration for vector entries (default 7 days) to maintain index performance.

### Phase 6: Technical Reference (Doc-RAG) [PENDING]
- [ ] **Ingestion Engine**: Implement a markdown ingestion logic to load official Kong/decK documentation into the vector store.
    - *Scope*: Gateway API specs, decK command flags, and official plugin schemas.
- [ ] **Version-Aware Retrieval**: Tag documentation with versions to allow the agent to filter by the user's active Kong version.

### Phase 7: Episodic Memory & Procedural Learning [PENDING]
- [ ] Index successful tool-call sequences as "Success Episodes."
- [ ] Automatically inject relevant past solutions into the prompt as few-shot examples.

---

## 5. Implementation Details

### 5.1 Semantic Recall (RAG)
The agent maintains a local `vector_index.json`. Every time context is optimized (summarized), the summary is indexed. The agent can use the `recall_memory` tool to search this index using cosine similarity.
*   **Similarity Threshold**: To reduce token noise, results with a cosine similarity `< 0.40` are discarded.
*   **Classification**: The intent gatekeeper allows "find", "recall", and "remember" queries if they relate to technical history.

### 5.2 Predictive Guardrails
To prevent mid-turn crashes, the agent estimates the token impact of every incoming prompt:
1. `TokenEstimate = prompt.length / 3.5`
2. `ProjectedContext = PreviousTurnUsage + TokenEstimate`
3. If `ProjectedContext > 85%`, summarize **before** calling the LLM.
### 5.3 Non-Destructive Context Squeezing (Deterministic Pruning)
To maximize token efficiency without losing technical detail, the agent employs a "Squeezer" filter during prompt assembly:
1. **Threshold**: 2,000 characters.
2. **Deterministic Truncation**: Keeps the first 500 (Head) and last 500 (Tail) characters.
3. **Purity**: The internal `AgentState` is NEVER mutated by the squeezer. This ensures that the **LLM Summarizer** always sees the full-fidelity raw logs, while the **LLM Chat** only sees the compressed version.
4. **Result**: Reclaims thousands of tokens per turn with zero impact on long-term memory accuracy.

### 5.4 Importance-Based Relevance Scoring
During summarization, the agent uses a weighted scoring mechanism:
- **High Importance (Z=1.0)**: System Prompts, Connectivity Errors, Sync/Export Previews.
- **Low Importance (Z=0.1)**: Greetings, off-topic chat, redundant status checks.
Critical technical facts are prioritized for retention, ensuring they survive multiple summarization cycles.

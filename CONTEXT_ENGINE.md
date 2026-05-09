# Context Engine: Intelligent Prompt Assembly

The Context Engine is the logic layer responsible for selecting, pruning, and formatting information from the Agent's memory into the active LLM prompt. Its goal is to maximize **Information Density** while minimizing token waste and latency.

## 1. Core Principles

1.  **Relevance over Recency**: Old but highly relevant technical details are prioritized over recent greetings or off-topic chat.
2.  **Surgical Pruning**: Tool results that are no longer relevant to the current turn are compressed or dropped.
3.  **Token Budgeting**: Every turn is allocated a specific "Token Budget" across different layers (System, Thinking, History, Results).
4.  **Just-in-Time (JIT) Injection**: System status (connectivity, docker health) is injected only when the "Context Watchdog" determines the state might have changed.
5.  **Metadata Anchoring**: Every prompt is anchored with high-fidelity metadata, including absolute current time and session-specific environment tags.
6.  **Modular Guidance**: Context-specific rules are loaded dynamically based on the files being touched (e.g., loading `*.yaml` rules only when editing configs).
7.  **Automated Hooks**: Deterministic actions (like `decK lint`) are triggered by agent events to ensure configuration integrity.
8.  **Staleness Checks**: A mechanism to detect when a memory or tool result no longer applies to the current state of the codebase.
9.  **File-Anchored Memory Injection**: Automatically surface memories that are linked to the specific files currently being read or modified by the agent.
10. **Trial-and-Error Pruning**: Upon successful task completion, the engine compresses the intermediate failed attempts and only keeps the "Success Path" in the prompt context to keep reasoning clean.
11. **Importance Weighting**: High-value discoveries (e.g., "The Admin API is on port 8444") are tagged with permanent high importance, ensuring they stay in the prompt even after multiple summarization cycles.
12. **Associative Retrieval**: When a specific memory is triggered, the engine automatically pulls in "linked" memories (e.g., pulling in a known Auth issue when the user mentions a Service that uses that Auth).

---

## 2. Context Management Strategies

### A. Dynamic Result Compression
*   **Problem**: Large tool outputs (e.g., a full `kong.yml` dump) can consume 50k+ tokens.
*   **Engine Logic**: If a tool result has been "processed" (the agent has already responded to it), the raw result is archived in long-term memory and replaced in the active prompt with a **Semantic Summary** (e.g., "Successfully read kong.yml; contains 5 Services and 10 Routes").

### B. Priority-Based History Pruning (The "N-Back" Strategy)
*   **Engine Logic**:
    *   **Critical Path**: The last 3-5 turns are kept in full fidelity.
    *   **Compressed Path**: Turns 6-20 are summarized.
    *   **Discard Path**: Turns 20+ are archived for RAG retrieval only.

### C. Budget Allocation (The "Token Pie")
For a 128k context model, the engine enforces strict limits:
*   **System Prompt & State**: 5,000 tokens.
*   **Active Tool Results**: 60,000 tokens (Surgical focus).
*   **Recent History**: 20,000 tokens.
*   **Reasoning/Thinking Space**: 10,000 tokens.
*   **Buffer for Output**: 33,000 tokens.

---

## 3. The Context Assembly Pipeline

Every turn follows a 4-step assembly process:

1.  **Harvesting**: Retrieve raw messages from `AgentHistory`.
2.  **Ranking**: The "Context Watchdog" scores each message/file based on its relevance to the current user intent (e.g., if the user is asking about "Routes", prioritize Route-related tool results).
3.  **Pruning**: Information below a certain relevance threshold is compressed or dropped to fit the Token Budget.
4.  **Injection**: Dynamic context (Detected files, Mode, Ports) is added as a fresh header to ensure the agent uses the absolute latest system state.

---

## 4. Implementation Roadmap

### Phase 1: Budgeting & Monitoring
- [ ] Implement `TokenCounter` utility to track real-time budget usage.
- [ ] Add `ContextWarning` UI notification when the budget is 90% full.

### Phase 2: Active Pruning
- [ ] Implement `ResultSummarizer` to compress "stale" tool outputs.
- [ ] Develop `RelevanceScorer` to decide which history turns to keep in full.

### Phase 3: JIT Context
- [ ] Implement `StateWatcher` to only inject `get_kong_status` results into the prompt if the previous check was > 60 seconds ago.

### Phase 4: Advanced Orchestration (Long-Term)
- [ ] **Modular Rule Loader**: Implement path-based rule loading (e.g., `.kong-rules/docker.md` loaded only for compose files).
- [ ] **Post-Edit Hooks**: Automatically trigger `decK lint` after any tool modifies a YAML file.
- [ ] **Subagent Manager**: Implement a "Diagnostic Subagent" that runs long log-reading tasks in an isolated context window, returning only a high-level summary to the main session.

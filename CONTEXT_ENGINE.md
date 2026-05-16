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
12. **Associative Retrieval**: When a specific memory is triggered, the engine automatically pulls in "linked" memories.
13. **Z-Score Normalization**: Combine Recency, Importance, and Relevance signals using Z-scores to prevent any single score from disproportionately influencing the final ranking.
14. **Post-Optimization Baseline Reset**: Immediately after any context reduction (summarization or truncation), the internal token counters must be reset to the new reality to prevent stale watchdog triggers.
15. **Volume-Aware Triggering**: Context optimization must be triggered based on total token weight, not just message count, to prevent "heavy" short sessions from hitting a wall.

---

## 2. Context Management Strategies

### A. Deterministic Result Compression ("The Squeezer")
*   **Problem**: Large tool outputs (e.g., a full `kong.yml` dump) can consume 50k+ tokens, drowning out critical reasoning.
*   **Engine Logic**: If a tool result is **stale** (older than 2 messages) and exceeds **2,000 characters**, the engine deterministicly keeps the first 500 and last 500 characters, replacing the middle with a marker: `[OMITTED XXX CHARS]`.
*   **Non-Destructive**: This compression is applied only at the moment of prompt assembly. The internal `AgentState` preserves the full-fidelity raw logs, ensuring that the **LLM Summarizer** always has access to the complete data for building accurate long-term memory.

### B. Priority-Based History Pruning (The "N-Back" Strategy)
*   **Engine Logic**:
    *   **Critical Path**: The last 3-5 turns are kept in full fidelity.
    *   **Compressed Path**: Turns 6-20 are summarized.
### D. Tiered Recovery (Fail-safe)
*   **Intelligent Recovery**: Attempt `summarizeHistory()` first to preserve facts.
*   **Hard Fallback**: If the **LLM Context** is physically exceeded (or the Agent limit is set too high), the engine performs a **Hard Truncation** (deterministic discard) as a last resort to restore session stability.



### C. Budget Allocation (The "Token Pie")
For a 128k context model, the engine enforces strict limits:
*   **System Prompt & State**: 5,000 tokens.
*   **Active Tool Results**: 60,000 tokens (Surgical focus).
*   **Recent History**: 20,000 tokens.
*   **Reasoning/Thinking Space**: 10,000 tokens.
*   **Buffer for Output**: 33,000 tokens.

### D. Session Journaling (The "Post-Mortem")
*   **Engine Logic**: Before a "Clear Chat" or "Hard Reset" event, the engine triggers a final `summarizeHistory()` call. 
*   **Purpose**: This preserves the "Lessons Learned" (e.g., successful config patterns) as a semantic embedding in the vector store before the raw logs are deleted.

---

## 3. The Context Assembly Pipeline

Every turn follows a 4-step assembly process:

1.  **Harvesting**: Retrieve raw messages from `AgentHistory`.
2.  **Ranking**: The "Context Watchdog" scores each message/file based on its relevance to the current user intent (e.g., if the user is asking about "Routes", prioritize Route-related tool results).
3.  **Pruning**: Information below a certain relevance threshold is compressed or dropped to fit the Token Budget.
4.  **Injection**: Dynamic context (Detected files, Mode, Ports) is added as a fresh header to ensure the agent uses the absolute latest system state.

---

## 4. Implementation Roadmap

### Phase 1: Budgeting & Monitoring [COMPLETE]
- [x] Implement `TokenCounter` utility to track real-time budget usage.
- [x] Add `🔄 Optimizing Context` status bar and predictive overflow detection.

### Phase 2: Active Pruning & Compression [COMPLETE]
- [x] **Predictive Guardrails**: Summarize history before large payloads (Implemented).
- [x] **Similarity Gating**: Implement 0.40 threshold for RAG retrieval (Implemented).
- [x] **Result Compression**: Implement logic to replace "processed" large tool outputs with deterministic truncation.
- [x] **Relevance Scorer**: Implement Importance-based weighting to preserve critical technical facts.
- [ ] **Baseline Hardening**: Prevent infinite watchdog loops via state-reset logic.
- [ ] **Aggressive Thresholds**: Implement token-weighted summarization triggers.
- [ ] **Panic Recovery**: Implement Hard Truncation fallback for 100% context scenarios.

### Phase 3: JIT Context & Memory Lifecycle
- [ ] **StateWatcher**: Only inject system health checks if the previous check is > 60s old.
- [ ] **Session Journaling**: Automatically generate and store a semantic summary in the vector store before a user performs a "Clear Chat" action.
- [ ] **Memory TTL Pruning**: Implement time-based expiration for vector entries (default 7 days) to maintain index performance.
- [x] **Post-Edit Hooks**: Automatically trigger `decK lint` after configuration edits (Implemented).

### Phase 4: Advanced Orchestration (Long-Term)
- [ ] **Modular Rule Loader**: Path-based dynamic rule loading.
- [ ] **Subagent Manager**: Run long diagnostic tasks in isolated context windows.
- [ ] **Episodic Learning**: Inject "Success Paths" as few-shot examples into the prompt.

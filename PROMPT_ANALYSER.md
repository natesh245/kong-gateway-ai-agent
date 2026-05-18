# Prompt Analyser: Intent & File Classification

The `PromptAnalyser` is a specialized utility designed to pre-process user inputs and workspace files. It acts as a safety gate and intent router, ensuring the Agent stays focused on Kong Gateway operations.

## 1. Current Implementation

The analyzer uses LangChain's `withStructuredOutput` to enforce a strict schema for intent classification.

### A. Intent Classification (`classify`)
*   **Method**: Zero-shot classification using a structured Zod schema.
*   **Categories**:
    *   `GREET`: Greetings, pleasantries, and simple confirmations (e.g., "Yes", "No").
    *   `KONGR`: Technical Kong-related queries, Docker status, decK operations, and configuration reviews.
    *   `OFFT`: Off-topic requests (jokes, general trivia) that trigger a polite refusal.
*   **Mechanism**: A separate, fast LLM call performed *before* the main agent loop to determine if the query should be handled by the specialized agent or refused.

### B. File Classification (`classifyFile`)
*   **Method**: Sample-based classification (analyzing the first 2,000 characters).
*   **Supported Types**:
    *   `compose`: Docker Compose files.
    *   `kong`: decK state files.
    *   `ruleset`: decK linting rulesets.
    *   `gateway_config`: `kong.conf` properties.
    *   `other`: Non-relevant files.

### C. History Summarization (`summarizeHistory`)
*   **Method**: Condenses older conversation chains into a single, technically precise summary paragraph when context limits are approached.
*   **Mechanism**: Join previous turn strings into a single history block, and instruct the LLM to extract primary intents, services modified, and final outcomes.
*   **Limitations**: Currently operates as a black box—only returns the summary text without reporting input/output token usage to the session counter.

---

## 2. Identified Limitations

1.  **Sequential Latency**: The classification step is sequential. The main agent loop doesn't start until the classifier returns, adding 500ms–1s to every turn.
2.  **Ambiguity in Short Affirmations**: A simple "Yes" is classified as `GREET`. However, in a multi-turn conversation, "Yes" might be an approval for a destructive Kong operation.
3.  **Cost Overhead**: While small, performing a structured output call for every "Hi" or "Ok" adds up in high-volume environments.
4.  **Static Rules**: The rules are hardcoded in the system prompt rather than being dynamic or based on the current agent state.
5.  **Token Accounting Leak (Summarizer)**: While `classify` successfully registers input/output tokens to the Session statistics, `summarizeHistory` does not. Any tokens spent on summarizing old history (which can be substantial) are currently invisible in the UI's Session IN/OUT tally.

---

## 3. Implementation Roadmap

### Tier 1: Token Accounting & Latency Reduction [PENDING]
- [ ] **Token Accounting Integration**: Update `PromptAnalyser.summarizeHistory` to return model usage stats along with the summary text, and pipe these to `updateTurnUsage` to guarantee 100% accurate billing display.
- [ ] **Fast-Pass Expansion**: Expand the list of hardcoded greeting phrases in the local fast-pass to skip LLM latency entirely on trivial inputs.
- [ ] **Parallelized Inference**: Start the classification task in parallel with the main agent loop's preparation phase to shave off sequential latency.

### Tier 2: Intent Refining & Context Gating [PENDING]
- [ ] **Few-Shot Tuning**: Transition from zero-shot classification to a few-shot structure using high-fidelity edge cases (e.g., distinguishing confirmations from greetings).
- [ ] **Hybrid Intent Contextualizer**: Intercept affirmations (like "Yes") and cross-reference them with prior context state to prevent false GREET categorizations.

### Tier 3: Semantic & State-Aware Routing [PENDING]
- [ ] **Sub-Intent Classification**: Split `KONGR` into dedicated sub-intents (e.g., `DIAGNOSTIC` vs `MIGRATION` vs `SECURITY`) to dynamically load smaller, task-specific prompts.
- [ ] **State-Driven Context Injections**: Dynamically feed the current operational state of the agent into the classification engine.
- [ ] **Embedding-Based Gating**: Implement local cosine similarity comparison of user queries against a static vector space of common intents to resolve routing locally.

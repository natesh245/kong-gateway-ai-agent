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

---

## 2. Identified Limitations

1.  **Sequential Latency**: The classification step is sequential. The main agent loop doesn't start until the classifier returns, adding 500ms–1s to every turn.
2.  **Ambiguity in Short Affirmations**: A simple "Yes" is classified as `GREET`. However, in a multi-turn conversation, "Yes" might be an approval for a destructive Kong operation.
3.  **Cost Overhead**: While small, performing a structured output call for every "Hi" or "Ok" adds up in high-volume environments.
4.  **Static Rules**: The rules are hardcoded in the system prompt rather than being dynamic or based on the current agent state.

---

## 3. Proposed Improvements

### Tier 1: Performance & Accuracy (Short-Term)
*   **Few-Shot Optimization**: Move from zero-shot to few-shot by providing a more diverse set of "Edge Case" examples (e.g., confirming a sync operation).
*   **Hybrid Intent**: Check for "Approval Keywords" (e.g., `[APPROVAL_REQUIRED]`) in the recent history to prevent classifying technical confirmations as simple greetings.
*   **Parallelization**: Start the classification and the "Thinking" phase of the main agent in parallel if the confidence score is high.

### Tier 2: Enhanced Routing (Medium-Term)
*   **Sub-Intent Detection**: Split `KONGR` into more specific routes:
    *   `DIAGNOSTIC`: "Is Kong running?"
    *   `MIGRATION`: "Migrate this service."
    *   `SECURITY`: "Is my proxy secure?"
*   **Local Classification**: Use a tiny, local model (e.g., a BERT-based classifier or a regex-based fast path) for common greetings to eliminate LLM latency for non-technical turns.

### Tier 3: Context-Aware Analysis (Long-Term)
*   **State-Driven Classification**: The analyzer should know the *current state* of the agent (e.g., "The agent is waiting for a sync confirmation"). This would allow it to classify "Go ahead" as a technical trigger rather than a greeting.
*   **Embedding-Based Filtering**: Use vector embeddings to compare the user prompt against a "Knowledge Base of Intent" for faster, more accurate routing.

# Secret Scanner: Multi-Layer Security Guardrail

The Secret Scanner is a security layer designed to detect and redact sensitive information (API keys, tokens, passwords) across all data flows between the user, the workspace, and the LLM.

## 1. Security Architecture

The scanner operates at three critical interception points:

### A. Inbound (Prompt) Protection
*   **Target**: User input messages.
*   **Goal**: Prevent users from accidentally pasting sensitive credentials into the chat.
*   **Action**: Scan the user prompt *before* it is sent to the LLM or stored in history. If a secret is found, the agent rejects the input and asks the user to redact it.

### B. Context (File) Protection
*   **Target**: Content read from the workspace via tools (e.g., `read_file`, `dump_deck_state`).
*   **Goal**: Prevent hardcoded secrets in `kong.yml` or `.env` files from entering the LLM's context window.
*   **Action**: Automatically mask detected secrets within tool results (e.g., `key: "super-secret"` -> `key: "[REDACTED]"`).

### C. Outbound (Response) Protection
*   **Target**: LLM-generated responses and reasoning.
*   **Goal**: Ensure the agent doesn't repeat or "hallucinate" a secret in its final response to the user.
*   **Action**: Scan the final response stream. If a high-entropy string matching a secret pattern is detected, the stream is interrupted or masked.

---

## 2. Detection Mechanisms

1.  **Regex-Based (Pattern Matching)**:
    *   **Kong Specific**: Admin tokens, RBAC tokens, consumer credentials.
    *   **General**: OpenAI keys, AWS keys, Database URIs, Bearer tokens.
2.  **Entropy-Based**:
    *   Detect high-entropy strings that don't match known English words, which often indicate generated keys or passwords.
3.  **Keyword-Based**:
    *   Scanning for sensitive labels like `password:`, `secret:`, `token:`, `private_key:`.

---

## 3. Implementation Roadmap

### Phase 1: Basic Redaction (Short-Term)
- [ ] Implement `SecretScanner` utility using regex patterns for Kong and common cloud providers.
- [ ] Integrate scanner into `StorageTool.ts` to redact content *before* it is cached or sent to the agent.
- [ ] Add `redact_secrets` middleware to the LangChain pipeline.

### Phase 2: Active Prompt Guarding (Medium-Term)
- [ ] Implement pre-flight prompt scanning in `Agent.ts`.
- [ ] Create a "Safe Mode" UI toggle that enables/disables strict secret blocking.
- [ ] Develop a `SafeDiff` utility to ensure secrets aren't exposed in diff views.

### Phase 3: Advanced Entropy Detection (Long-Term)
- [ ] Integrate a specialized library (e.g., `shhgit` logic or `trufflehog` patterns) for deep secret scanning.
- [ ] Implement "Secret State Tracking": If the agent *needs* a token to perform an operation (e.g., calling the Admin API), the scanner ensures it only uses the token in the tool execution and never logs it.

---

## 4. Kong-Specific Patterns
The scanner will prioritize these high-risk fields:
- `kong_admin_token`
- `pg_password`
- `consumer.custom_id` (if sensitive)
- `key-auth` credentials
- `jwt` secrets

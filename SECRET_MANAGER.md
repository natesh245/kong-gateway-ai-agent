# Secret Manager: Multi-Layer Security Guardrail

The Secret Manager is a security layer designed to detect, redact, and securely manage sensitive information (API keys, tokens, passwords) across all data flows between the user, the workspace, and the LLM.

## 1. Security Architecture

The manager operates at four critical interception points:

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

### D. Workspace Integrity & Linter Policies
*   **Kong decK Configurations (`kong.yml`)**:
    *   **Rule**: Plaintext secrets (passwords, tokens, database URIs, API keys) must **never** be hardcoded. 
    *   **Enforcement**: By default, the decK linter ruleset `ruleset.yaml` includes a strict `no-hardcoded-credentials` rule. This validates that any property containing `secret`, `password`, `token`, or `key` is resolved dynamically.
    *   **Format**: Secrets must utilize **Kong Vault** `env-vault` references (`{vault://env/SECRET_NAME}`) or decK environment variable templates (`${{env "SECRET_NAME"}}`).
*   **Docker Compose Configurations (`docker-compose.yml`)**:
    *   **Rule**: Plaintext environment credentials (e.g. `KONG_PASSWORD`, `POSTGRES_PASSWORD`) must be externalized.
    *   **Enforcement**: The agent's file analyzer scans docker-compose files to ensure all credentials are mapped to `.env` variables (e.g., `KONG_PASSWORD=${KONG_PASSWORD}`) rather than inlining raw strings.
    *   **Location**: The `.env` file containing these actual secret assignments must reside securely in the configured local workspace path (`storagePath`) alongside the `docker-compose.yml` file, ensuring Docker Compose resolves them correctly at runtime and the agent can securely verify their presence without storing them in the repository.

---

## 2. Detection & Management Mechanisms

1.  **Regex-Based (Pattern Matching)**:
    *   **Kong Specific**: Admin tokens, RBAC tokens, consumer credentials.
    *   **General**: OpenAI keys, AWS keys, Database URIs, Bearer tokens.
2.  **Entropy-Based**:
    *   Detect high-entropy strings that don't match known English words, which often indicate generated keys or passwords.
3.  **Keyword-Based**:
    *   Scanning for sensitive labels like `password:`, `secret:`, `token:`, `private_key:`.
4.  **Vault Reference Enforcement**:
    *   Promotes safe development by recommending Kong Vault syntax (`{vault://...}`) or local `.env` variables.

---

## 3. Implementation Roadmap

### Phase 1: Basic Redaction & Linter Security (Short-Term)
- [ ] Implement `SecretManager` utility using regex patterns for Kong and common cloud providers.
- [ ] Integrate manager into `StorageTool.ts` to redact content *before* it is cached or sent to the agent.
- [ ] Add `redact_secrets` middleware to the LangChain pipeline.
- [ ] **Default Credentials Ruleset**: Add strict `no-hardcoded-credentials` decK lint rules to block hardcoded values in generated workspace rulesets (Design Complete).

### Phase 2: Active Prompt Guarding & Environment Validation (Medium-Term)
- [ ] Implement pre-flight prompt scanning in `Agent.ts`.
- [ ] Create a "Safe Mode" UI toggle that enables/disables strict secret blocking.
- [ ] Develop a `SafeDiff` utility to ensure secrets aren't exposed in diff views.
- [ ] **Docker Compose Security Checker**: Verify environment blocks in Docker Compose files to ensure all credentials map dynamically to `.env` variables rather than being inlined.

### Phase 3: Advanced Entropy & 3rd-Party Integration (Long-Term)
- [ ] **Gitleaks/Trufflehog Integration**: Integrate with established 3rd-party scanners to perform full workspace audits.
- [ ] **Pre-Commit Hook Simulation**: Allow the agent to run a secret scan on any file before it is "accepted" or "synced" to the gateway.
- [ ] **Secret State Tracking**: If the agent *needs* a token to perform an operation, the manager ensures it only uses the token in the tool execution and never logs it.

---

## 4. 3rd-Party Integration: Gitleaks / Trufflehog

To provide industrial-grade scanning, the Agent will support integration with **Gitleaks** or **Trufflehog**:

1.  **Workspace Audit Tool**: A new tool `scan_workspace_for_secrets` that runs `gitleaks detect --source .` and returns a summary of risks to the user.
2.  **Auto-Discovery**: If the tool detects a binary of Gitleaks on the user's `$PATH`, it will offer to run a security audit during the initial workspace discovery phase.
3.  **Human-in-the-Loop**: If a 3rd-party tool finds a secret in a file the agent is trying to read, the agent will pause and warn the user: *"⚠️ Gitleaks detected a potential secret in this file. Redacting before proceeding."*

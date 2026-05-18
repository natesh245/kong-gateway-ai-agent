# Drift Detection: Monitoring External Changes

Drift Detection is the ability of the Agent to recognize when the live Kong Gateway configuration has changed independently of the Agent's own actions (e.g., via Kong Manager, direct Admin API calls, or other users).

## 1. Mechanism: The Drift Engine

The Drift Engine operates as a background observer with four main steps:

### A. Baseline Capturing
*   Whenever the agent performs a `sync` or `reset` operation, it automatically creates a **State Baseline** (a snapshot of the live configuration).
*   This baseline is stored externally in the Agent's global storage.

### B. Periodic Polling (The "Pulse")
*   The Agent runs a lightweight "Pulse" check every 5–10 minutes (configurable).
*   It performs a `deck dump --stdout` and compares the output with the last known baseline.

### C. Change Attribution
*   **Agent-Initiated**: If a change matches a recent `sync` or `patch` operation recorded in the Agent's tool history, it is marked as "Expected."
*   **External (Drift)**: If a change is detected but no corresponding Agent action exists in the history, it is flagged as **External Drift**.

### D. User Notification
*   When drift is detected, the Agent triggers a VS Code notification:
    *   *"⚠️ Kong Gateway Drift Detected: 2 services and 1 route were modified externally. [Review Changes]"*
*   Clicking the notification opens a diff view between the **Last Known State** and the **Current Live State**.

---

## 2. Implementation Roadmap

### Phase 1: Snapshotting (Short-Term)
- [ ] Implement `StateSnapshotManager` to save/load decK state dumps to global storage.
- [ ] Automatically trigger a snapshot after every successful `deck sync` tool call.

### Phase 2: Drift Checking (Medium-Term)
- [ ] Create a `DriftWatcher` service that runs in the background of the VS Code extension.
- [ ] Implement a `DriftAnalysisTool` that can perform a quiet `deck diff` between the snapshot and live state.

### Phase 3: Interactive & Automated Reconciliation (Long-Term)
- [ ] **Interactive Diff Dashboard**: A rich webview showing side-by-side local desired state vs live state (ArgoCD "App Details" style).
- [ ] **One-Click Reconciliation Modes**:
    *   **Heal (Push)**: Overwrite the live gateway with local workspace configuration.
    *   **Adopt (Pull)**: Pull live gateway changes back into the local `kong-deck-state.yml` to keep local Git in sync.
- [ ] **Automated Self-Healing**: Background reconciliation that triggers automatically when drift is detected.
- [ ] **Audit Trail**: Maintain a history of external drifts to identify if specific upstream services are being modified too frequently by "shadow IT."

### Phase 4: Headless & Remote Notifications (Future)
- [ ] **External Notification Bridge**: Integrate with Slack, Microsoft Teams, or Email to send alerts even when VS Code is closed.
- [ ] **"Catch-up" Scan**: Implement a logic that automatically runs a drift check immediately upon VS Code startup to detect "while-you-were-away" changes.
- [ ] **CLI Daemon**: Provide a standalone Node.js daemon that can be run as a system service to monitor drift without the IDE.

---

## 3. Configuration Settings: ArgoCD-Inspired Control Plane

Users can tune the Drift Engine via VS Code settings to control background check behavior, pruning, and self-healing:

### A. General Behavior
*   `kongAgent.driftDetection.enabled`: `boolean` (Default: `false`) — Enables/disables the background drift checking service.
*   `kongAgent.driftDetection.interval`: `integer` (Default: `5`) — Polling frequency in minutes.

### B. Reconciliation Modes (The ArgoCD Approach)
*   `kongAgent.driftDetection.reconciliationMode`: `"manual"` | `"self-healing"` | `"auto-adopt"` (Default: `"manual"`)
    *   `"manual"`: Drift triggers a standard IDE notification with a "Review Changes" visual diff action.
    *   `"self-healing"` (Auto-Revert): The agent silently runs `deck sync` to overwrite any live configuration changes, forcing it back to the Git state.
    *   `"auto-adopt"` (Auto-Import): The agent automatically writes live gateway modifications back into the local files and schedules a git commit/alert.

### C. Resource Boundaries
*   `kongAgent.driftDetection.pruneEnabled`: `boolean` (Default: `true`) — If `false`, reconciliation will add/update resources but will *never* delete live entities that are missing in the local config files.
*   `kongAgent.driftDetection.ignoredPaths`: `string[]` (Default: `[]`) — Fine-grained drift exclusions (e.g. `$.services[*].tags` or `$.routes[*].plugins[?(@.name=='rate-limiting')]`). Allows users to ignore non-functional or dynamically changing fields to prevent notification noise.

---

## 4. Handling Offline Drift (When VS Code is Closed)

If VS Code is closed, the internal `DriftWatcher` cannot run. To address this, the engine will implement two strategies:

1.  **The "Startup Catch-up" (Default)**:
    *   Upon every launch of the extension, the agent compares the current live state against the **Last Known Snapshot** taken before the IDE was closed.
    *   If a delta is found, a summary is presented immediately in the Agent's reasoning container.

2.  **Out-of-Editor Notifications (Enterprise Feature)**:
    *   For production environments, the Agent can be configured with a **Webhook URL** (e.g., for Slack or a custom notification server).
    *   A small, headless background process (installed via the extension) can monitor the gateway and trigger these webhooks even when the IDE is inactive.

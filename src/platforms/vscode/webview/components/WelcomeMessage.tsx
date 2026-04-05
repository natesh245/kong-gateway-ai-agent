import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getVsCodeApi } from '../vscode-api';

export const WelcomeMessage: React.FC = () => {
    const vscode = getVsCodeApi();
    
    const welcomeText = `
# Welcome to Kong Gateway Agent! 🦍

Your AI pair-programmer for **Kong Gateway**. I can help you architect, deploy, and manage your API infrastructure with ease.

### 🚀 Life-cycle & Management
- **One-Click Setup**: Boot a fresh Kong instance with a single command.
- **Deep Adoption**: I'll scan and connect to your existing local or remote gateways automatically.
- **Port Resolution**: I'll detect port collisions and suggest available ones to keep you moving.

### 🛠️ Declarative Configuration (GitOps)
- **Smart YAML Generation**: Describe your Service or Route; I'll write the \`kong.yml\` for you.
- **decK Validation**: I use industrial-strength validation to ensure your config is schema-perfect.
- **Safe Sync**: I always show a **Preview Diff** for your approval before applying any changes.
- **Repository Sync**: I can handle Git commits to keep your source-of-truth in sync.

### 🔍 Intelligence & Troubleshooting
- **Manual Review**: Paste your YAML, and I'll analyze it for errors and best practices.
- **Live Diagnostics**: Verify your Admin API and Proxy health in real-time.

---
**What would you like to build today?** Try saying *"Start a fresh Kong instance"* or *"Review my config"*!
`;

    const handleActionClick = (e: React.MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'LI' || target.parentElement?.tagName === 'LI') {
            const li = target.tagName === 'LI' ? target : target.parentElement!;
            const boldPart = li.querySelector('strong');
            const promptText = boldPart ? boldPart.innerText : li.innerText.split(':')[0];
            vscode.postMessage({ type: 'prompt', value: promptText.trim() });
        }
    };

    return (
        <div className="message agent welcome-message" onClick={handleActionClick}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {welcomeText}
            </ReactMarkdown>
        </div>
    );
};

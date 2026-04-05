import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
import { ToolManager } from '../../core/agent/tools/ToolManager';
import { VscodeConfig, VscodePlatform } from './VscodeProvider';

export function activate(context: vscode.ExtensionContext) {
    const config = new VscodeConfig();
    const platform = new VscodePlatform(context);
    const toolManager = new ToolManager(config, platform);
    const provider = new ChatViewProvider(context.extensionUri, context, toolManager, config, platform);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
    );
}

export function deactivate() {}

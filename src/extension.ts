import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { KongDockerManager } from './docker/KongDockerManager';

export function activate(context: vscode.ExtensionContext) {
    const dockerManager = new KongDockerManager(context);
    const provider = new ChatViewProvider(context.extensionUri, context, dockerManager);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
    );
}

export function deactivate() {}

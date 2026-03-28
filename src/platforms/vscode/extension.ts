import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { ProviderManager } from '../../core/providers/ProviderManager';
import { VscodeConfig, VscodePlatform } from './VscodeProvider';

export function activate(context: vscode.ExtensionContext) {
    const config = new VscodeConfig();
    const platform = new VscodePlatform(context);
    const providerManager = new ProviderManager(config, platform);
    const provider = new ChatViewProvider(context.extensionUri, context, providerManager, config, platform);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
    );
}

export function deactivate() {}

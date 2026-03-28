import * as vscode from 'vscode';
import { IConfig, IAppPlatform } from '../../core/interfaces/ICoreInterfaces';

export class VscodeConfig implements IConfig {
    get<T>(key: string): T | undefined {
        return vscode.workspace.getConfiguration('kongAgent').get<T>(key);
    }

    async update(key: string, value: any): Promise<void> {
        await vscode.workspace.getConfiguration('kongAgent').update(key, value, vscode.ConfigurationTarget.Global);
    }
}

export class VscodePlatform implements IAppPlatform {
    constructor(private context: vscode.ExtensionContext) {}

    getAppName(): string {
        return "VS Code Kong Agent";
    }

    getAppReferer(): string {
        return "https://vscode-kong-agent.com";
    }

    async openExternal(url: string): Promise<void> {
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    getStoragePath(): string {
        return this.context.globalStorageUri.fsPath;
    }

    showInformationMessage(message: string): void {
        vscode.window.showInformationMessage(message);
    }

    showErrorMessage(message: string): void {
        vscode.window.showErrorMessage(message);
    }

    async openFileInEditor(filePath: string): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
    }
}

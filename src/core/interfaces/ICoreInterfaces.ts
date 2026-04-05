/**
 * Core interfaces to decouple business logic from platform-specific APIs (like VS Code).
 */

export interface IConfig {
    get<T>(key: string): T | undefined;
    update?(key: string, value: any): Promise<void>;
}

export interface ILogger {
    log(message: string): void;
    error(message: string): void;
    info(message: string): void;
}

export interface IAppPlatform {
    getAppName(): string;
    getAppReferer(): string;
    openExternal(url: string): Promise<void>;
    getStoragePath(): string;
    showInformationMessage(message: string): void;
    showErrorMessage(message: string): void;
    openFileInEditor(filePath: string): Promise<void>;
}

export interface IMessage {
    role: string;
    content: string;
    complete?: boolean;
    startTime?: number;
    endTime?: number;
    lastUsage?: any;
    className?: string;
}

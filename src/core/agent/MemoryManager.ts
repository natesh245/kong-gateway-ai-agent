import * as fs from 'fs';
import * as path from 'path';
import { IAppPlatform } from '../interfaces/ICoreInterfaces';

/**
 * MemoryManager handles persistence of agent state (history, facts, config) to disk.
 * It uses the platform-provided storage path to ensure cross-platform compatibility.
 */
export class MemoryManager {
    private storagePath: string;
    private historyFile: string;
    private factsFile: string;

    constructor(private platform: IAppPlatform) {
        this.storagePath = this.platform.getStoragePath();
        this.historyFile = path.join(this.storagePath, 'chat_history.json');
        this.factsFile = path.join(this.storagePath, 'facts.json');
        this.ensureStorageExists();
    }

    /**
     * Ensures the storage directory exists.
     */
    private ensureStorageExists() {
        if (!fs.existsSync(this.storagePath)) {
            fs.mkdirSync(this.storagePath, { recursive: true });
        }
    }

    /**
     * Saves chat history to disk.
     * @param history Array of messages (BaseMessage[]) to save.
     */
    public async saveChatHistory(history: any[]): Promise<void> {
        try {
            this.ensureStorageExists();
            // Important: history might be BaseMessage[], so we use the UI format for serialization
            // We'll let the caller handle the conversion if needed, but for safety:
            const data = JSON.stringify(history, null, 2);
            await fs.promises.writeFile(this.historyFile, data, 'utf8');
        } catch (error) {
            console.error('Failed to save chat history to disk:', error);
        }
    }

    /**
     * Loads chat history from disk.
     * @returns Array of messages.
     */
    public async loadChatHistory(): Promise<any[]> {
        try {
            if (fs.existsSync(this.historyFile)) {
                const data = await fs.promises.readFile(this.historyFile, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error('Failed to load chat history from disk:', error);
        }
        return [];
    }

    /**
     * Saves extracted facts to disk.
     * @param facts Array of facts.
     */
    public async saveFacts(facts: string[]): Promise<void> {
        try {
            this.ensureStorageExists();
            const data = JSON.stringify(facts, null, 2);
            await fs.promises.writeFile(this.factsFile, data, 'utf8');
        } catch (error) {
            console.error('Failed to save facts to disk:', error);
        }
    }

    /**
     * Loads facts from disk.
     * @returns Array of facts or empty array if not found.
     */
    public async loadFacts(): Promise<string[]> {
        try {
            if (fs.existsSync(this.factsFile)) {
                const data = await fs.promises.readFile(this.factsFile, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error('Failed to load facts from disk:', error);
        }
        return [];
    }

    /**
     * Utility to clear all persistent memory (e.g. for a hard reset).
     */
    public async clearMemory(): Promise<void> {
        try {
            if (fs.existsSync(this.historyFile)) await fs.promises.unlink(this.historyFile);
            if (fs.existsSync(this.factsFile)) await fs.promises.unlink(this.factsFile);
        } catch (error) {
            console.error('Failed to clear persistent memory:', error);
        }
    }
}

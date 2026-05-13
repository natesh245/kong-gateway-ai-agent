import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryManager } from './MemoryManager';
import { IAppPlatform } from '../interfaces/ICoreInterfaces';

describe('MemoryManager', () => {
    let tempDir: string;
    let mockPlatform: IAppPlatform;
    let memoryManager: MemoryManager;

    beforeEach(() => {
        tempDir = path.join(os.tmpdir(), `kong-agent-test-${Date.now()}`);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        mockPlatform = {
            getStoragePath: () => tempDir,
            getAppName: () => 'TestApp',
            getAppReferer: () => 'TestReferer',
            openExternal: async () => {},
            showInformationMessage: () => {},
            showErrorMessage: () => {},
            openFileInEditor: async () => {},
            openDiffInEditor: async () => {},
            closeDiffEditor: async () => {}
        };

        memoryManager = new MemoryManager(mockPlatform);
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should save and load chat history', async () => {
        const history = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' }
        ];

        await memoryManager.saveChatHistory(history);
        const loadedHistory = await memoryManager.loadChatHistory();

        assert.strictEqual(loadedHistory.length, 2);
        assert.strictEqual(loadedHistory[0].content, 'Hello');
        assert.strictEqual(loadedHistory[1].content, 'Hi!');
    });

    it('should save and load facts', async () => {
        const facts = ['Fact 1', 'Fact 2'];

        await memoryManager.saveFacts(facts);
        const loadedFacts = await memoryManager.loadFacts();

        assert.strictEqual(loadedFacts.length, 2);
        assert.strictEqual(loadedFacts[0], 'Fact 1');
        assert.strictEqual(loadedFacts[1], 'Fact 2');
    });

    it('should clear memory', async () => {
        await memoryManager.saveChatHistory([{ role: 'user', content: 'test' }]);
        await memoryManager.saveFacts(['fact']);

        await memoryManager.clearMemory();

        const history = await memoryManager.loadChatHistory();
        const facts = await memoryManager.loadFacts();

        assert.strictEqual(history.length, 0);
        assert.strictEqual(facts.length, 0);
    });
});

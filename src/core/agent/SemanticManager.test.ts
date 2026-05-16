import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { SemanticManager } from './SemanticManager';
import { IAppPlatform, IConfig } from '../interfaces/ICoreInterfaces';

describe('SemanticManager', () => {
    let semanticManager: SemanticManager;
    let tempStorage: string;

    const mockConfig: any = {
        get: (key: string) => {
            if (key === 'provider') return 'openrouter';
            return '';
        }
    };

    const mockPlatform: any = {
        getStoragePath: () => tempStorage,
        getAppReferer: () => 'test',
        getAppName: () => 'test'
    };

    before(() => {
        tempStorage = path.join(__dirname, '../../test/temp_semantic_storage');
        if (!fs.existsSync(tempStorage)) fs.mkdirSync(tempStorage, { recursive: true });
        semanticManager = new SemanticManager(mockConfig, mockPlatform);
    });

    after(() => {
        if (fs.existsSync(tempStorage)) {
            fs.rmSync(tempStorage, { recursive: true, force: true });
        }
    });

    it('should calculate cosine similarity correctly', () => {
        const v1 = [1, 0, 0];
        const v2 = [1, 0, 0];
        const v3 = [0, 1, 0];
        
        const sim1 = (semanticManager as any).cosineSimilarity(v1, v2);
        const sim2 = (semanticManager as any).cosineSimilarity(v1, v3);
        
        assert.strictEqual(sim1, 1);
        assert.strictEqual(sim2, 0);
    });

    it('should handle empty index gracefully', async () => {
        const results = await semanticManager.search('test query');
        assert.strictEqual(results.length, 0);
    });

    it('should save and load entries from disk', async () => {
        // Mocking the embedding process for testing persistence logic
        (semanticManager as any).entries = [{
            embedding: [0.1, 0.2, 0.3],
            text: 'Historical configuration fact',
            metadata: { type: 'summary' },
            timestamp: Date.now()
        }];
        (semanticManager as any).saveIndex();

        const newManager = new SemanticManager(mockConfig, mockPlatform);
        assert.strictEqual((newManager as any).entries.length, 1);
        assert.strictEqual((newManager as any).entries[0].text, 'Historical configuration fact');
    });
});

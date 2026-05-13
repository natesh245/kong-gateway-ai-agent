import * as fs from 'fs';
import * as path from 'path';
import { IAppPlatform, IConfig } from '../interfaces/ICoreInterfaces';
import { AgentClient } from './AgentClient';

interface VectorEntry {
    embedding: number[];
    text: string;
    metadata: any;
    timestamp: number;
}

/**
 * SemanticManager handles local vector indexing and retrieval.
 * It uses a simple linear search for vector similarity.
 */
export class SemanticManager {
    private storagePath: string;
    private indexFile: string;
    private entries: VectorEntry[] = [];
    private embeddingsModel: any | null = null;

    constructor(private config: IConfig, private platform: IAppPlatform) {
        this.storagePath = this.platform.getStoragePath();
        this.indexFile = path.join(this.storagePath, 'vector_index.json');
        this.loadIndex();
    }

    private initEmbeddings() {
        if (!this.embeddingsModel) {
            this.embeddingsModel = AgentClient.initEmbeddings(this.config, this.platform);
        }
        return this.embeddingsModel;
    }

    private loadIndex() {
        try {
            if (fs.existsSync(this.indexFile)) {
                const data = fs.readFileSync(this.indexFile, 'utf8');
                this.entries = JSON.parse(data);
            }
        } catch (e) {
            console.error('[SemanticManager] Failed to load vector index:', e);
            this.entries = [];
        }
    }

    private saveIndex() {
        try {
            const data = JSON.stringify(this.entries, null, 2);
            fs.writeFileSync(this.indexFile, data, 'utf8');
        } catch (e) {
            console.error('[SemanticManager] Failed to save vector index:', e);
        }
    }

    /**
     * Adds a text snippet to the semantic index.
     */
    public async add(text: string, metadata: any = {}): Promise<void> {
        const model = this.initEmbeddings();
        if (!model) return;

        try {
            const embedding = await model.embedQuery(text);
            this.entries.push({
                embedding,
                text,
                metadata,
                timestamp: Date.now()
            });
            this.saveIndex();
        } catch (e) {
            console.error('[SemanticManager] Embedding generation failed:', e);
        }
    }

    /**
     * Searches the index for the most relevant snippets.
     */
    public async search(query: string, k: number = 3): Promise<any[]> {
        const model = this.initEmbeddings();
        if (!model || this.entries.length === 0) return [];

        try {
            const queryEmbedding = await model.embedQuery(query);
            
            // Linear search with cosine similarity
            const results = this.entries.map(entry => ({
                ...entry,
                similarity: this.cosineSimilarity(queryEmbedding, entry.embedding)
            }));

            // Sort by similarity descending
            results.sort((a, b) => b.similarity - a.similarity);

            return results.slice(0, k);
        } catch (e) {
            console.error('[SemanticManager] Search failed:', e);
            return [];
        }
    }

    private cosineSimilarity(v1: number[], v2: number[]): number {
        let dotProduct = 0;
        let mag1 = 0;
        let mag2 = 0;
        for (let i = 0; i < v1.length; i++) {
            dotProduct += v1[i] * v2[i];
            mag1 += v1[i] * v1[i];
            mag2 += v2[i] * v2[i];
        }
        const mag = Math.sqrt(mag1) * Math.sqrt(mag2);
        return mag === 0 ? 0 : dotProduct / mag;
    }

    /**
     * Clears the index.
     */
    public clear() {
        this.entries = [];
        if (fs.existsSync(this.indexFile)) {
            fs.unlinkSync(this.indexFile);
        }
    }
}

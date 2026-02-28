import * as fs from 'fs/promises';
import * as path from 'path';
import {
    Index, Codemodel, Target, TargetRef,
    CacheReply, CacheEntry,
    CmakeFilesReply,
    ToolchainsReply,
} from './types';

// ------------------------------------------------------------
// Query file names (empty files placed in query/)
// Their presence alone triggers reply generation
// ------------------------------------------------------------
const QUERY_FILES = [
    'codemodel-v2',
    'cache-v2',
    'cmakeFiles-v1',
    'toolchains-v1',
] as const;

// ------------------------------------------------------------
// Complete result of a load operation
// ------------------------------------------------------------
export interface CmakeReply {
    codemodel: Codemodel;
    targets: Target[];          // all targets, already loaded
    cache: CacheEntry[];
    cmakeFiles: CmakeFilesReply;
    toolchains: ToolchainsReply | null;  // optional, not always present
}

// ------------------------------------------------------------
// ApiClient
// ------------------------------------------------------------
export class ApiClient {
    private readonly queryDir: string;
    private readonly replyDir: string;

    constructor(private readonly aBuildDir: string) {
        const api_root = path.join(aBuildDir, '.cmake', 'api', 'v1');
        this.queryDir = path.join(api_root, 'query');
        this.replyDir = path.join(api_root, 'reply');
    }

    // Path to reply folder (useful for the watcher)
    get replyDirectory(): string {
        return this.replyDir;
    }

    // Checks that a reply already exists (configure already done)
    async hasReply(): Promise<boolean> {
        try {
            const files = await fs.readdir(this.replyDir);
            return files.some((f: string) => f.startsWith('index-'));
        } catch {
            return false;
        }
    }

    // Writes query files to query/
    // To be called before the first cmake configure
    async writeQueries(): Promise<void> {
        await fs.mkdir(this.queryDir, { recursive: true });
        await Promise.all(
            QUERY_FILES.map(name =>
                fs.writeFile(path.join(this.queryDir, name), '', { flag: 'w' })
            )
        );
    }

    // Loads the index (entry point for the entire reply)
    async readIndex(): Promise<Index> {
        const files = await fs.readdir(this.replyDir);
        const indexFile = files
            .filter((f: string) => f.startsWith('index-'))
            .sort()           // the most recent is last in lexicographic order
            .at(-1);
        if (!indexFile) {
            throw new Error(
                `No index file found in ${this.replyDir}.\n` +
                `Have you run CMake configure?`
            );
        }
        return this.readJson<Index>(indexFile);
    }

    // Loads everything at once
    async loadApiFiles(): Promise<CmakeReply> {
        const index = await this.readIndex();
        const codemodelRef = this.findObject(index, 'codemodel');
        const cacheRef = this.findObject(index, 'cache');
        const filesRef = this.findObject(index, 'cmakeFiles');
        const toolRef = this.findObjectOptional(index, 'toolchains');
        const codemodel = await this.readJson<Codemodel>(codemodelRef.jsonFile);
        const targets = await this.loadTargets(codemodel);
        const cacheReply = await this.readJson<CacheReply>(cacheRef.jsonFile);
        const cmakeFiles = await this.readJson<CmakeFilesReply>(filesRef.jsonFile);
        const toolchains = toolRef
            ? await this.readJson<ToolchainsReply>(toolRef.jsonFile)
            : null;
        return {
            codemodel,
            targets,
            cache: cacheReply.entries,
            cmakeFiles,
            toolchains,
        };
    }

    // Loads only the cache (for quick refresh after -D)
    async loadCache(): Promise<CacheEntry[]> {
        const index = await this.readIndex();
        const ref = this.findObject(index, 'cache');
        const reply = await this.readJson<CacheReply>(ref.jsonFile);
        return reply.entries;
    }

    // ------------------------------------------------------------
    // Private
    // ------------------------------------------------------------

    private async loadTargets(codemodel: Codemodel): Promise<Target[]> {
        // Deduplicate jsonFile (the same target can appear
        // in multiple configurations with the same file)
        const seen = new Set<string>();
        const refs: TargetRef[] = [];
        for (const config of codemodel.configurations) {
            for (const ref of config.targets) {
                if (!seen.has(ref.jsonFile)) {
                    seen.add(ref.jsonFile);
                    refs.push(ref);
                }
            }
        }
        return Promise.all(refs.map(ref => this.readJson<Target>(ref.jsonFile)));
    }

    private findObject(index: Index, kind: string) {
        const obj = index.objects.find(o => o.kind === kind);
        if (!obj) {
            throw new Error(`CMake API object '${kind}' not found in index.`);
        }
        return obj;
    }

    private findObjectOptional(index: Index, kind: string) {
        return index.objects.find(o => o.kind === kind) ?? null;
    }

    private async readJson<T>(filename: string): Promise<T> {
        const fullPath = path.join(this.replyDir, filename);
        try {
            const raw = await fs.readFile(fullPath, 'utf-8');
            return JSON.parse(raw) as T;
        } catch (err) {
            throw new Error(`Unable to read ${fullPath}: ${(err as Error).message}`);
        }
    }
}
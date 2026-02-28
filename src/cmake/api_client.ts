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
    private readonly m_queryDir: string;
    private readonly m_replyDir: string;

    constructor(private readonly aBuildDir: string) {
        const api_root = path.join(aBuildDir, '.cmake', 'api', 'v1');
        this.m_queryDir = path.join(api_root, 'query');
        this.m_replyDir = path.join(api_root, 'reply');
    }

    // Path to reply folder (useful for the watcher)
    get replyDirectory(): string {
        return this.m_replyDir;
    }

    // Checks that a reply already exists (configure already done)
    async hasReply(): Promise<boolean> {
        try {
            const files = await fs.readdir(this.m_replyDir);
            return files.some((f: string) => f.startsWith('index-'));
        } catch {
            return false;
        }
    }

    // Writes query files to query/
    // To be called before the first cmake configure
    async writeQueries(): Promise<void> {
        await fs.mkdir(this.m_queryDir, { recursive: true });
        await Promise.all(
            QUERY_FILES.map(aName =>
                fs.writeFile(path.join(this.m_queryDir, aName), '', { flag: 'w' })
            )
        );
    }

    // Loads the index (entry point for the entire reply)
    async readIndex(): Promise<Index> {
        const files = await fs.readdir(this.m_replyDir);
        const index_file = files
            .filter((f: string) => f.startsWith('index-'))
            .sort()           // the most recent is last in lexicographic order
            .at(-1);
        if (!index_file) {
            throw new Error(
                `No index file found in ${this.m_replyDir}.\n` +
                `Have you run CMake configure?`
            );
        }
        return this.readJson<Index>(index_file);
    }

    // Loads everything at once
    async loadApiFiles(): Promise<CmakeReply> {
        const index = await this.readIndex();
        const codemodel_ref = this.findObject(index, 'codemodel');
        const cache_ref = this.findObject(index, 'cache');
        const files_ref = this.findObject(index, 'cmakeFiles');
        const tool_ref = this.findObjectOptional(index, 'toolchains');
        const codemodel = await this.readJson<Codemodel>(codemodel_ref.jsonFile);
        const targets = await this.loadTargets(codemodel);
        const cache_reply = await this.readJson<CacheReply>(cache_ref.jsonFile);
        const cmake_files = await this.readJson<CmakeFilesReply>(files_ref.jsonFile);
        const toolchains = tool_ref
            ? await this.readJson<ToolchainsReply>(tool_ref.jsonFile)
            : null;
        return {
            codemodel,
            targets,
            cache: cache_reply.entries,
            cmakeFiles: cmake_files,
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

    private async loadTargets(aCodemodel: Codemodel): Promise<Target[]> {
        // Deduplicate jsonFile (the same target can appear
        // in multiple configurations with the same file)
        const seen = new Set<string>();
        const refs: TargetRef[] = [];
        for (const config of aCodemodel.configurations) {
            for (const ref of config.targets) {
                if (!seen.has(ref.jsonFile)) {
                    seen.add(ref.jsonFile);
                    refs.push(ref);
                }
            }
        }
        return Promise.all(refs.map(ref => this.readJson<Target>(ref.jsonFile)));
    }

    private findObject(aIndex: Index, aKind: string) {
        const obj = aIndex.objects.find(o => o.kind === aKind);
        if (!obj) {
            throw new Error(`CMake API object '${aKind}' not found in index.`);
        }
        return obj;
    }

    private findObjectOptional(aIndex: Index, aKind: string) {
        return aIndex.objects.find(o => o.kind === aKind) ?? null;
    }

    private async readJson<T>(aFilename: string): Promise<T> {
        const full_path = path.join(this.m_replyDir, aFilename);
        try {
            const raw = await fs.readFile(full_path, 'utf-8');
            return JSON.parse(raw) as T;
        } catch (err) {
            throw new Error(`Unable to read ${full_path}: ${(err as Error).message}`);
        }
    }
}

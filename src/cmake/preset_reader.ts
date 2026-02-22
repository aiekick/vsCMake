import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ------------------------------------------------------------
// Raw types (CMakePresets JSON structure)
// ------------------------------------------------------------

interface RawPresetFile {
    version: number;
    cmakeMinimumRequired?: { major: number; minor: number; patch: number };
    include?: string[];
    configurePresets?: RawConfigurePreset[];
    buildPresets?: RawBuildPreset[];
    testPresets?: RawTestPreset[];
    packagePresets?: RawPackagePreset[];
    workflowPresets?: RawWorkflowPreset[];
}

interface RawCondition {
    type: 'const' | 'equals' | 'notEquals' | 'inList' | 'notInList'
    | 'matches' | 'notMatches' | 'anyOf' | 'allOf' | 'not';
    value?: string;       // const
    lhs?: string;       // equals / notEquals / inList / notInList / matches / notMatches
    rhs?: string;       // equals / notEquals / matches / notMatches
    list?: string[];     // inList / notInList
    conditions?: RawCondition[]; // anyOf / allOf
    condition?: RawCondition;   // not
}

interface RawBase {
    name: string;
    displayName?: string;
    description?: string;
    hidden?: boolean;
    inherits?: string | string[];
    condition?: RawCondition;
    environment?: Record<string, string | null>;
    vendor?: Record<string, unknown>;
}

interface RawConfigurePreset extends RawBase {
    generator?: string;
    architecture?: string | { value?: string; strategy?: string };
    toolset?: string | { value?: string; strategy?: string };
    binaryDir?: string;
    installDir?: string;
    toolchainFile?: string;
    cacheVariables?: Record<string, string | { type: string; value: string } | null>;
    warnings?: Record<string, boolean>;
    errors?: Record<string, boolean>;
    debug?: Record<string, boolean>;
}

interface RawBuildPreset extends RawBase {
    configurePreset?: string;
    inheritConfigureEnvironment?: boolean;
    jobs?: number;
    targets?: string | string[];
    configuration?: string;
    cleanFirst?: boolean;
    verbose?: boolean;
    nativeToolOptions?: string[];
}

interface RawTestPreset extends RawBase {
    configurePreset?: string;
    inheritConfigureEnvironment?: boolean;
    configuration?: string;
    overrideConfigurePreset?: string;
    output?: Record<string, unknown>;
    filter?: Record<string, unknown>;
    execution?: Record<string, unknown>;
}

interface RawPackagePreset extends RawBase {
    configurePreset?: string;
    inheritConfigureEnvironment?: boolean;
    configuration?: string;
    generators?: string[];
    variables?: Record<string, string>;
    configFile?: string;
    output?: Record<string, unknown>;
}

interface RawWorkflowStep {
    type: 'configure' | 'build' | 'test' | 'package';
    name: string;
}

interface RawWorkflowPreset extends RawBase {
    steps?: RawWorkflowStep[];
}

// ------------------------------------------------------------
// Resolved types (exposed)
// ------------------------------------------------------------

export interface ConfigurePreset {
    name: string;
    displayName: string;
    description?: string;
    generator?: string;
    binaryDir?: string;
    installDir?: string;
    toolchainFile?: string;
    cacheVariables: Record<string, string>;
    environment: Record<string, string>;
}

export interface BuildPreset {
    name: string;
    displayName: string;
    description?: string;
    configurePreset?: string;
    targets?: string[];
    configuration?: string;
    cleanFirst?: boolean;
    jobs?: number;
    environment: Record<string, string>;
}

export interface TestPreset {
    name: string;
    displayName: string;
    description?: string;
    configurePreset?: string;
    configuration?: string;
    environment: Record<string, string>;
}

export interface PackagePreset {
    name: string;
    displayName: string;
    description?: string;
    configurePreset?: string;
    configuration?: string;
    generators?: string[];
    environment: Record<string, string>;
}

export interface WorkflowPreset {
    name: string;
    displayName: string;
    description?: string;
    steps: { type: string; name: string }[];
}

export interface ResolvedPresets {
    configurePresets: ConfigurePreset[];
    buildPresets: BuildPreset[];
    testPresets: TestPreset[];
    packagePresets: PackagePreset[];
    workflowPresets: WorkflowPreset[];
}

// ------------------------------------------------------------
// Context for macro and condition evaluation
// ------------------------------------------------------------

interface MacroContext {
    sourceDir: string;
    sourceParentDir: string;
    sourceDirName: string;
    presetName: string;
    generator?: string;
    hostSystemName: string;
    fileDir: string;
    pathListSep: string;
    dollar: string;
}

// ------------------------------------------------------------
// PresetReader
// ------------------------------------------------------------

export class PresetReader {

    /**
     * Main entry point.
     * Reads CMakePresets.json + CMakeUserPresets.json, merges, resolves inheritance,
     * macros and conditions. Returns null if no file exists.
     */
    static async read(sourceDir: string): Promise<ResolvedPresets | null> {
        const mainPath = path.join(sourceDir, 'CMakePresets.json');
        const userPath = path.join(sourceDir, 'CMakeUserPresets.json');

        const main = await PresetReader.loadFile(mainPath, sourceDir, new Set());
        const user = await PresetReader.loadFile(userPath, sourceDir, new Set());

        if (!main && !user) { return null; }

        const merged = PresetReader.mergeFiles(main, user);
        return PresetReader.resolveAll(merged, sourceDir);
    }

    // --------------------------------------------------------
    // Recursive loading (include)
    // --------------------------------------------------------

    private static async loadFile(
        filePath: string,
        sourceDir: string,
        visited: Set<string>
    ): Promise<RawPresetFile | null> {
        if (visited.has(filePath)) { return null; }
        visited.add(filePath);

        let raw: RawPresetFile;
        try {
            const text = await fs.readFile(filePath, 'utf-8');
            raw = JSON.parse(text) as RawPresetFile;
        } catch {
            return null;
        }

        // Include resolution (version >= 4)
        if (raw.version >= 4 && raw.include?.length) {
            const dir = path.dirname(filePath);
            for (const inc of raw.include) {
                const incPath = path.isAbsolute(inc) ? inc : path.join(dir, inc);
                const child = await PresetReader.loadFile(incPath, sourceDir, visited);
                if (child) { raw = PresetReader.mergeFiles(raw, child)!; }
            }
        }

        return raw;
    }

    // --------------------------------------------------------
    // Merging two files
    // --------------------------------------------------------

    private static mergeFiles(
        a: RawPresetFile | null,
        b: RawPresetFile | null
    ): RawPresetFile {
        if (!a) { return b ?? { version: 0 }; }
        if (!b) { return a; }

        const mergeList = <T extends RawBase>(x: T[] = [], y: T[] = []): T[] => {
            const map = new Map<string, T>();
            for (const p of x) { map.set(p.name, p); }
            for (const p of y) { map.set(p.name, p); }
            return [...map.values()];
        };

        return {
            version: Math.max(a.version, b.version),
            configurePresets: mergeList(a.configurePresets, b.configurePresets),
            buildPresets: mergeList(a.buildPresets, b.buildPresets),
            testPresets: mergeList(a.testPresets, b.testPresets),
            packagePresets: mergeList(a.packagePresets, b.packagePresets),
            workflowPresets: mergeList(a.workflowPresets, b.workflowPresets),
        };
    }

    // --------------------------------------------------------
    // Complete resolution
    // --------------------------------------------------------

    private static resolveAll(raw: RawPresetFile, sourceDir: string): ResolvedPresets {
        const configMap = new Map<string, RawConfigurePreset>();
        const buildMap = new Map<string, RawBuildPreset>();
        const testMap = new Map<string, RawTestPreset>();
        const pkgMap = new Map<string, RawPackagePreset>();
        const wfMap = new Map<string, RawWorkflowPreset>();

        for (const p of raw.configurePresets ?? []) { configMap.set(p.name, p); }
        for (const p of raw.buildPresets ?? []) { buildMap.set(p.name, p); }
        for (const p of raw.testPresets ?? []) { testMap.set(p.name, p); }
        for (const p of raw.packagePresets ?? []) { pkgMap.set(p.name, p); }
        for (const p of raw.workflowPresets ?? []) { wfMap.set(p.name, p); }

        // Generic helper: resolves inheritance + filters hidden + evaluates condition
        const resolveList = <R extends RawBase>(
            map: Map<string, R>,
            toResolved: (p: R, ctx: MacroContext) => unknown
        ): unknown[] => {
            return [...map.values()]
                .filter(p => !p.hidden)
                .map(p => {
                    const resolved = PresetReader.applyInherits(p, map) as R;
                    const ctx = PresetReader.makeContext(sourceDir, resolved.name,
                        (resolved as RawConfigurePreset).generator);
                    // Evaluate condition — if false, exclude
                    if (resolved.condition && !PresetReader.evalCondition(resolved.condition, ctx)) {
                        return null;
                    }
                    return toResolved(resolved, ctx);
                })
                .filter((x): x is NonNullable<typeof x> => x !== null);
        };

        return {
            configurePresets: resolveList(configMap, (p: RawConfigurePreset, ctx) => {
                const env = PresetReader.resolveEnv(p.environment, ctx);
                const cacheVars = PresetReader.resolveCacheVars(p.cacheVariables, ctx);
                return {
                    name: p.name,
                    displayName: PresetReader.expandMacros(p.displayName ?? p.name, ctx),
                    description: p.description ? PresetReader.expandMacros(p.description, ctx) : undefined,
                    generator: p.generator ? PresetReader.expandMacros(p.generator, ctx) : undefined,
                    binaryDir: p.binaryDir ? PresetReader.expandMacros(p.binaryDir, ctx) : undefined,
                    installDir: p.installDir ? PresetReader.expandMacros(p.installDir, ctx) : undefined,
                    toolchainFile: p.toolchainFile ? PresetReader.expandMacros(p.toolchainFile, ctx) : undefined,
                    cacheVariables: cacheVars,
                    environment: env,
                } as ConfigurePreset;
            }) as ConfigurePreset[],

            buildPresets: resolveList(buildMap, (p: RawBuildPreset, ctx) => ({
                name: p.name,
                displayName: PresetReader.expandMacros(p.displayName ?? p.name, ctx),
                description: p.description ? PresetReader.expandMacros(p.description, ctx) : undefined,
                configurePreset: p.configurePreset,
                targets: p.targets ? (Array.isArray(p.targets) ? p.targets : [p.targets]) : undefined,
                configuration: p.configuration,
                cleanFirst: p.cleanFirst,
                jobs: p.jobs,
                environment: PresetReader.resolveEnv(p.environment, ctx),
            } as BuildPreset)) as BuildPreset[],

            testPresets: resolveList(testMap, (p: RawTestPreset, ctx) => ({
                name: p.name,
                displayName: PresetReader.expandMacros(p.displayName ?? p.name, ctx),
                description: p.description ? PresetReader.expandMacros(p.description, ctx) : undefined,
                configurePreset: p.configurePreset,
                configuration: p.configuration,
                environment: PresetReader.resolveEnv(p.environment, ctx),
            } as TestPreset)) as TestPreset[],

            packagePresets: resolveList(pkgMap, (p: RawPackagePreset, ctx) => ({
                name: p.name,
                displayName: PresetReader.expandMacros(p.displayName ?? p.name, ctx),
                description: p.description ? PresetReader.expandMacros(p.description, ctx) : undefined,
                configurePreset: p.configurePreset,
                configuration: p.configuration,
                generators: p.generators,
                environment: PresetReader.resolveEnv(p.environment, ctx),
            } as PackagePreset)) as PackagePreset[],

            workflowPresets: resolveList(wfMap, (p: RawWorkflowPreset, _ctx) => ({
                name: p.name,
                displayName: p.displayName ?? p.name,
                description: p.description,
                steps: p.steps ?? [],
            } as WorkflowPreset)) as WorkflowPreset[],
        };
    }

    // --------------------------------------------------------
    // Inheritance (inherits) — recursive resolution
    // --------------------------------------------------------

    private static applyInherits<T extends RawBase>(
        preset: T,
        all: Map<string, T>,
        visited = new Set<string>()
    ): T {
        if (visited.has(preset.name)) { return preset; }
        visited.add(preset.name);

        const parentNames = preset.inherits
            ? (Array.isArray(preset.inherits) ? preset.inherits : [preset.inherits])
            : [];

        if (!parentNames.length) { return preset; }

        let base: Partial<T> = {};
        for (const name of parentNames) {
            const parent = all.get(name);
            if (!parent) { continue; }
            const resolved = PresetReader.applyInherits(parent, all, new Set(visited));
            base = PresetReader.deepMerge(base, resolved) as Partial<T>;
        }
        // Child overrides parent, remove inherits from result
        const result = PresetReader.deepMerge(base, preset) as T;
        delete (result as RawBase).inherits;
        return result;
    }

    /** Deep merge: b overrides a, except for objects which are merged recursively */
    private static deepMerge<T extends object>(a: Partial<T>, b: Partial<T>): T {
        const result: Record<string, unknown> = { ...(a as Record<string, unknown>) };
        for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
            if (v !== undefined && v !== null &&
                typeof v === 'object' && !Array.isArray(v) &&
                typeof result[k] === 'object' && result[k] !== null && !Array.isArray(result[k])) {
                result[k] = PresetReader.deepMerge(
                    result[k] as Record<string, unknown>,
                    v as Record<string, unknown>
                );
            } else if (v !== undefined) {
                result[k] = v;
            }
        }
        return result as T;
    }

    // --------------------------------------------------------
    // Macros ${...}
    // --------------------------------------------------------

    private static makeContext(sourceDir: string, presetName: string, generator?: string): MacroContext {
        const normalized = sourceDir.replace(/\\/g, '/');
        return {
            sourceDir: normalized,
            sourceParentDir: path.dirname(normalized).replace(/\\/g, '/'),
            sourceDirName: path.basename(normalized),
            presetName,
            generator,
            hostSystemName: PresetReader.platformName(),
            fileDir: normalized, // simplified: we don't track the origin file
            pathListSep: os.platform() === 'win32' ? ';' : ':',
            dollar: '$',
        };
    }

    private static platformName(): string {
        switch (os.platform()) {
            case 'win32': return 'Windows';
            case 'darwin': return 'Darwin';
            default: return 'Linux';
        }
    }

    /**
     * Expands all CMake macros in a string:
     *   ${sourceDir}, ${presetName}, $env{VAR}, $penv{VAR}, $vendor{...}
     */
    static expandMacros(value: string, ctx: MacroContext, env: Record<string, string> = {}): string {
        if (!value.includes('$')) { return value; }

        // Limit passes to avoid infinite loops
        let result = value;
        for (let i = 0; i < 10; i++) {
            const prev = result;
            result = result
                // ${sourceDir}, ${presetName}, etc.
                .replace(/\$\{sourceDir\}/g, ctx.sourceDir)
                .replace(/\$\{sourceParentDir\}/g, ctx.sourceParentDir)
                .replace(/\$\{sourceDirName\}/g, ctx.sourceDirName)
                .replace(/\$\{presetName\}/g, ctx.presetName)
                .replace(/\$\{generator\}/g, ctx.generator ?? '')
                .replace(/\$\{hostSystemName\}/g, ctx.hostSystemName)
                .replace(/\$\{fileDir\}/g, ctx.fileDir)
                .replace(/\$\{pathListSep\}/g, ctx.pathListSep)
                .replace(/\$\{dollar\}/g, '$')
                // $env{VAR} — first preset env, then process.env
                .replace(/\$env\{([^}]+)\}/g, (_, name: string) =>
                    env[name] ?? process.env[name] ?? '')
                // $penv{VAR} — process.env only
                .replace(/\$penv\{([^}]+)\}/g, (_, name: string) =>
                    process.env[name] ?? '')
                // $vendor{...} — leave as is (opaque)
                .replace(/\$vendor\{[^}]+\}/g, '');

            if (result === prev) { break; }
        }
        return result;
    }

    // --------------------------------------------------------
    // Environnement
    // --------------------------------------------------------

    private static resolveEnv(
        raw: Record<string, string | null> | undefined,
        ctx: MacroContext
    ): Record<string, string> {
        if (!raw) { return {}; }
        const result: Record<string, string> = {};
        // First pass: values without dependent macros
        for (const [k, v] of Object.entries(raw)) {
            if (v !== null) { result[k] = v; }
        }
        // Second pass: expand macros (including $env{} between them)
        for (const [k, v] of Object.entries(result)) {
            result[k] = PresetReader.expandMacros(v, ctx, result);
        }
        return result;
    }

    // --------------------------------------------------------
    // Cache variables
    // --------------------------------------------------------

    private static resolveCacheVars(
        raw: Record<string, string | { type: string; value: string } | null> | undefined,
        ctx: MacroContext
    ): Record<string, string> {
        if (!raw) { return {}; }
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
            if (v === null) { continue; }
            const strVal = typeof v === 'string' ? v : v.value;
            result[k] = PresetReader.expandMacros(strVal, ctx);
        }
        return result;
    }

    // --------------------------------------------------------
    // Condition evaluation
    // --------------------------------------------------------

    static evalCondition(cond: RawCondition, ctx: MacroContext, env: Record<string, string> = {}): boolean {
        const expand = (s: string) => PresetReader.expandMacros(s, ctx, env);

        switch (cond.type) {
            case 'const':
                return cond.value === 'true' || cond.value === true as unknown as string;

            case 'equals':
                return expand(cond.lhs ?? '') === expand(cond.rhs ?? '');

            case 'notEquals':
                return expand(cond.lhs ?? '') !== expand(cond.rhs ?? '');

            case 'inList':
                return (cond.list ?? []).map(expand).includes(expand(cond.lhs ?? ''));

            case 'notInList':
                return !(cond.list ?? []).map(expand).includes(expand(cond.lhs ?? ''));

            case 'matches':
                try {
                    return new RegExp(expand(cond.rhs ?? '')).test(expand(cond.lhs ?? ''));
                } catch { return false; }

            case 'notMatches':
                try {
                    return !new RegExp(expand(cond.rhs ?? '')).test(expand(cond.lhs ?? ''));
                } catch { return true; }

            case 'anyOf':
                return (cond.conditions ?? []).some(c => PresetReader.evalCondition(c, ctx, env));

            case 'allOf':
                return (cond.conditions ?? []).every(c => PresetReader.evalCondition(c, ctx, env));

            case 'not':
                return cond.condition ? !PresetReader.evalCondition(cond.condition, ctx, env) : true;

            default:
                return true; // unknown condition → don't filter
        }
    }
}

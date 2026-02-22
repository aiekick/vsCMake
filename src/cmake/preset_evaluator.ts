import { Runner, RunResult } from './runner';
import { PresetReader, ResolvedPresets } from './preset_reader';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export type PresetType = 'configure' | 'build' | 'test' | 'package' | 'workflow';

/** Preset discovered by the cmake CLI --list-presets */
export interface CliPresetInfo {
    name: string;
    displayName: string;   // the text after " - ", or name if absent
}

/** Evaluation result: enriched presets filtered by CLI */
export type EvaluatedPresets = ResolvedPresets;

// ------------------------------------------------------------
// CTest types (ctest --show-only=json-v1)
// ------------------------------------------------------------

export interface CtestBacktraceNode {
    file: number;
    command?: number;
    line?: number;
    parent?: number;
}

export interface CtestBacktraceGraph {
    commands: string[];
    files: string[];
    nodes: CtestBacktraceNode[];
}

export interface CtestProperty {
    name: string;
    value: unknown;
}

export interface CtestTestInfo {
    name: string;
    config?: string;
    command?: string[];
    backtrace: number;
    properties?: CtestProperty[];
}

export interface CtestShowOnlyResult {
    kind: 'ctestInfo';
    version: { major: number; minor: number };
    backtraceGraph: CtestBacktraceGraph;
    tests: CtestTestInfo[];
}

// ------------------------------------------------------------
// PresetEvaluator
//
// Uses the cmake CLI to discover available presets
// (after condition evaluation, inheritance, platform),
// then crosses with PresetReader for enriched data.
// ------------------------------------------------------------

export class PresetEvaluator {

    /**
     * Evaluates available presets for a given sourceDir.
     *
     * 1. Calls cmake --list-presets=<type> for each type
     *    → gets the list of visible presets (CMake evaluates conditions etc.)
     * 2. Loads enriched data via PresetReader
     * 3. Filters enriched data to keep only those confirmed by the CLI
     *
     * Returns null if no preset exists.
     */
    static async evaluate(
        sourceDir: string,
        runner: Runner,
        cmakePath = 'cmake'
    ): Promise<EvaluatedPresets | null> {
        // Step 1: discover via CLI which presets are available
        const cliConfigure = await PresetEvaluator.listPresets('configure', sourceDir, runner, cmakePath);

        // If no configure presets → no presets at all
        if (cliConfigure === null) { return null; }

        const cliBuild = await PresetEvaluator.listPresets('build', sourceDir, runner, cmakePath);
        const cliTest = await PresetEvaluator.listPresets('test', sourceDir, runner, cmakePath);
        const cliPackage = await PresetEvaluator.listPresets('package', sourceDir, runner, cmakePath);
        const cliWorkflow = await PresetEvaluator.listPresets('workflow', sourceDir, runner, cmakePath);

        // Step 2: load enriched data from JSON files
        const rich = await PresetReader.read(sourceDir);

        // If the reader also fails, build minimal presets from CLI alone
        if (!rich) {
            return PresetEvaluator.buildFromCliOnly(
                cliConfigure, cliBuild, cliTest, cliPackage, cliWorkflow
            );
        }

        // Step 3: cross-reference — keep only presets confirmed by CLI
        const cliConfigNames = new Set(cliConfigure.map(p => p.name));
        const cliBuildNames = new Set((cliBuild ?? []).map(p => p.name));
        const cliTestNames = new Set((cliTest ?? []).map(p => p.name));
        const cliPkgNames = new Set((cliPackage ?? []).map(p => p.name));
        const cliWfNames = new Set((cliWorkflow ?? []).map(p => p.name));

        return {
            configurePresets: rich.configurePresets.filter(p => cliConfigNames.has(p.name)),
            buildPresets: rich.buildPresets.filter(p => cliBuildNames.has(p.name)),
            testPresets: rich.testPresets.filter(p => cliTestNames.has(p.name)),
            packagePresets: rich.packagePresets.filter(p => cliPkgNames.has(p.name)),
            workflowPresets: rich.workflowPresets.filter(p => cliWfNames.has(p.name)),
        };
    }

    // --------------------------------------------------------
    // cmake --list-presets=<type>
    // --------------------------------------------------------

    /**
     * Calls cmake --list-presets=<type> and parses text output.
     *
     * Expected format:
     *   Available configure presets:
     *     "linux-gcc"   - gcc
     *     "linux-clang" - clang
     *
     * Returns null if no presets (error "File not found"
     * or "No presets found").
     */
    static async listPresets(
        type: PresetType,
        sourceDir: string,
        runner: Runner,
        cmakePath = 'cmake'
    ): Promise<CliPresetInfo[] | null> {
        const result = await runner.exec(
            cmakePath,
            ['--list-presets=' + type],
            sourceDir
        );

        // No CMakePresets.json file or error
        if (!result.success) {
            const combined = result.stdout + result.stderr;
            if (combined.includes('File not found') ||
                combined.includes('No presets found') ||
                combined.includes('Could not read presets')) {
                return null;
            }
            // Other error → return empty list rather than null
            return [];
        }

        return PresetEvaluator.parseListPresetsOutput(result.stdout);
    }

    /**
     * Parses the text output of cmake --list-presets.
     * Each preset line has the format:   "name"   - description
     * or just:   "name"
     */
    static parseListPresetsOutput(output: string): CliPresetInfo[] {
        const presets: CliPresetInfo[] = [];
        const lines = output.split('\n');

        // Regex: spaces, quote, name, quote, optional(spaces, dash, spaces, description)
        const re = /^\s+"([^"]+)"(?:\s+-\s+(.+))?$/;

        for (const line of lines) {
            const m = line.match(re);
            if (m) {
                presets.push({
                    name: m[1],
                    displayName: m[2]?.trim() || m[1],
                });
            }
        }

        return presets;
    }

    // --------------------------------------------------------
    // ctest --preset <preset> --show-only=json-v1
    // --------------------------------------------------------

    /**
     * Lists available tests for a given preset.
     * Returns parsed JSON result, or null if error.
     */
    static async listTestsForPreset(
        preset: string,
        sourceDir: string,
        runner: Runner,
        ctestPath = 'ctest'
    ): Promise<CtestShowOnlyResult | null> {
        const result = await runner.exec(
            ctestPath,
            ['--preset', preset, '--show-only=json-v1'],
            sourceDir
        );

        if (!result.success) { return null; }

        try {
            return JSON.parse(result.stdout) as CtestShowOnlyResult;
        } catch {
            return null;
        }
    }

    // --------------------------------------------------------
    // Fallback: build minimal presets from CLI alone
    // (if PresetReader fails for some reason)
    // --------------------------------------------------------

    private static buildFromCliOnly(
        configure: CliPresetInfo[],
        build: CliPresetInfo[] | null,
        test: CliPresetInfo[] | null,
        pkg: CliPresetInfo[] | null,
        workflow: CliPresetInfo[] | null
    ): EvaluatedPresets {
        return {
            configurePresets: configure.map(p => ({
                name: p.name,
                displayName: p.displayName,
                cacheVariables: {},
                environment: {},
            })),
            buildPresets: (build ?? []).map(p => ({
                name: p.name,
                displayName: p.displayName,
                environment: {},
            })),
            testPresets: (test ?? []).map(p => ({
                name: p.name,
                displayName: p.displayName,
                environment: {},
            })),
            packagePresets: (pkg ?? []).map(p => ({
                name: p.name,
                displayName: p.displayName,
                environment: {},
            })),
            workflowPresets: (workflow ?? []).map(p => ({
                name: p.name,
                displayName: p.displayName,
                steps: [],
            })),
        };
    }
}
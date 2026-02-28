import * as vscode from 'vscode';
import * as path from 'path';
import { Target, TargetType } from '../cmake/types';

// ------------------------------------------------------------
// Nodes
// ------------------------------------------------------------
type SectionId = 'libraries' | 'executables' | 'tests';

interface FilterNode { kind: 'impactedFilter'; }

interface SectionNode {
    kind: 'impactedSection';
    sectionId: SectionId;
    label: string;
    icon: string;
    targets: Target[];
    directIds: Set<string>;
}

interface TargetNode {
    kind: 'impactedTarget';
    target: Target;
    direct: boolean;
}

interface MessageNode { kind: 'message'; text: string; }

type TreeNode = FilterNode | SectionNode | TargetNode | MessageNode;

const TARGET_ICONS: Record<TargetType, string> = {
    EXECUTABLE: 'run',
    STATIC_LIBRARY: 'package',
    SHARED_LIBRARY: 'library',
    MODULE_LIBRARY: 'library',
    OBJECT_LIBRARY: 'file-binary',
    INTERFACE_LIBRARY: 'symbol-interface',
    UTILITY: 'tools',
};

const LIBRARY_TYPES = new Set<TargetType>([
    'STATIC_LIBRARY', 'SHARED_LIBRARY', 'MODULE_LIBRARY',
    'OBJECT_LIBRARY', 'INTERFACE_LIBRARY',
]);

// ------------------------------------------------------------
// ImpactedTargetsProvider
// ------------------------------------------------------------
export class ImpactedTargetsProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;

    /** Normalized absolute file path → all impacted targets (direct + transitive) */
    private fileToTargets = new Map<string, Target[]>();

    /** Normalized absolute file path → direct target ids */
    private fileToDirectIds = new Map<string, Set<string>>();

    /** Current active file path (normalized) */
    private activeFile: string | null = null;

    private projectSourceDir = '';

    /** Target id → Target object */
    private targetById = new Map<string, Target>();

    /** Reverse dependency graph: targetId → set of targetIds that depend on it */
    private reverseDeps = new Map<string, Set<string>>();

    // Parent tracking for getParent support
    private parentMap = new WeakMap<TreeNode, TreeNode>();

    /** targetName → list of ctest test names */
    private testsByTarget = new Map<string, string[]>();

    // Filter
    private filter = '';

    // ------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------

    /**
     * Rebuild the file→targets dictionary from loaded targets.
     * Resolves transitive reverse dependencies so that modifying
     * a file in libA also shows libB and bin_toto if the dependency
     * chain is libA ← libB ← bin_toto.
     */
    refresh(targets: Target[], projectSourceDir: string): void {
        this.projectSourceDir = projectSourceDir;
        this.fileToTargets.clear();
        this.fileToDirectIds.clear();
        this.targetById.clear();
        this.reverseDeps.clear();
        this.parentMap = new WeakMap();

        // 1. Index targets by id
        for (const t of targets) {
            this.targetById.set(t.id, t);
        }

        // 2. Build reverse dependency graph
        //    If target B has dependency A, then A ← B (A is depended upon by B)
        for (const t of targets) {
            for (const dep of t.dependencies ?? []) {
                let set = this.reverseDeps.get(dep.id);
                if (!set) {
                    set = new Set();
                    this.reverseDeps.set(dep.id, set);
                }
                set.add(t.id);
            }
        }

        // 3. For each target source file, compute all transitive dependents
        for (const target of targets) {
            const allImpacted = this.collectAllDependents(target.id);

            for (const source of target.sources) {
                const absPath = this.resolveSourcePath(target, source.path);
                const key = this.normalizeKey(absPath);

                // Direct target tracking
                let directSet = this.fileToDirectIds.get(key);
                if (!directSet) {
                    directSet = new Set();
                    this.fileToDirectIds.set(key, directSet);
                }
                directSet.add(target.id);

                // Full impacted list
                let list = this.fileToTargets.get(key);
                if (!list) {
                    list = [];
                    this.fileToTargets.set(key, list);
                }
                for (const impactedId of allImpacted) {
                    if (!list.some(t => t.id === impactedId)) {
                        const impactedTarget = this.targetById.get(impactedId);
                        if (impactedTarget) { list.push(impactedTarget); }
                    }
                }
            }
        }

        this._onDidChangeTreeData.fire();
    }

    clear(): void {
        this.fileToTargets.clear();
        this.fileToDirectIds.clear();
        this.targetById.clear();
        this.reverseDeps.clear();
        this.parentMap = new WeakMap();
        this.activeFile = null;
        this.filter = '';
        this._onDidChangeTreeData.fire();
    }

    /**
     * Update the pane for the given active editor file.
     */
    setActiveFile(filePath: string | null): void {
        const key = filePath ? this.normalizeKey(filePath) : null;
        if (key === this.activeFile) { return; }
        this.activeFile = key;
        this.parentMap = new WeakMap();
        this._onDidChangeTreeData.fire();
    }

    // ------------------------------------------------------------
    // Filter
    // ------------------------------------------------------------

    setFilter(pattern: string): void {
        this.filter = pattern.toLowerCase();
        this.parentMap = new WeakMap();
        this._onDidChangeTreeData.fire();
    }

    clearFilter(): void {
        this.filter = '';
        this.parentMap = new WeakMap();
        this._onDidChangeTreeData.fire();
    }

    get currentFilter(): string {
        return this.filter;
    }

    get hasFilter(): boolean {
        return this.filter.length > 0;
    }

    // ------------------------------------------------------------
    // Test map
    // ------------------------------------------------------------

    /**
     * Store the mapping targetName → ctest test names.
     * Used to separate test executables from normal executables
     * and to build regex patterns for running tests.
     */
    setTestMap(map: Map<string, string[]>): void {
        this.testsByTarget = map;
        this.parentMap = new WeakMap();
        this._onDidChangeTreeData.fire();
    }

    /** True if the given target name is a known test executable. */
    isTestTarget(targetName: string): boolean {
        return this.testsByTarget.has(targetName);
    }

    /**
     * Build a ctest -R regex that matches all tests of a given target.
     * Groups test names by first token (before first '_') and joins them.
     */
    getTestRegex(targetName: string): string {
        const tests = this.testsByTarget.get(targetName);
        if (!tests || tests.length === 0) { return escapeRegex(targetName); }
        return buildTestRegex(tests);
    }

    /**
     * Build a ctest -R regex that matches all tests of multiple targets.
     */
    getTestSectionRegex(targetNames: string[]): string {
        const allTests: string[] = [];
        for (const name of targetNames) {
            const tests = this.testsByTarget.get(name);
            if (tests) { allTests.push(...tests); }
        }
        if (allTests.length === 0) {
            return targetNames.map(n => escapeRegex(n)).join('|');
        }
        return buildTestRegex(allTests);
    }

    // ------------------------------------------------------------
    // TreeDataProvider
    // ------------------------------------------------------------

    getTreeItem(node: TreeNode): vscode.TreeItem {
        switch (node.kind) {
            case 'impactedFilter': {
                const label = this.filter
                    ? `Filter: ${this.filter}`
                    : 'Filter: (none)';
                const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('search');
                item.contextValue = this.filter ? 'impactedFilterActive' : 'impactedFilter';
                item.command = {
                    command: 'CMakeGraph.filterImpacted',
                    title: 'Filter',
                };
                return item;
            }
            case 'impactedSection': {
                const state = this.filter
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Expanded;
                const item = new vscode.TreeItem(node.label, state);
                item.id = `impactedSection:${node.sectionId}`;
                item.iconPath = new vscode.ThemeIcon(node.icon);
                item.description = `${node.targets.length}`;
                item.contextValue = `impactedSection_${node.sectionId}`;
                return item;
            }
            case 'impactedTarget': {
                const t = node.target;
                const isTest = this.testsByTarget.has(t.name);
                const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
                item.id = `impactedTarget:${t.id}`;
                item.iconPath = new vscode.ThemeIcon(isTest ? 'beaker' : (TARGET_ICONS[t.type] ?? 'circle-outline'));
                item.description = node.direct ? undefined : '(transitive)';
                item.tooltip = this.targetTooltip(t, node.direct);
                item.contextValue = isTest ? 'impactedTarget_TEST' : `impactedTarget_${t.type}`;
                return item;
            }
            case 'message': {
                const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('info');
                return item;
            }
        }
    }

    getChildren(node?: TreeNode): TreeNode[] {
        if (!node) {
            return this.getRootNodes();
        }
        if (node.kind === 'impactedSection') {
            return this.getSectionChildren(node);
        }
        return [];
    }

    getParent(node: TreeNode): TreeNode | null {
        return this.parentMap.get(node) ?? null;
    }

    // ------------------------------------------------------------
    // Root & section children
    // ------------------------------------------------------------

    private getRootNodes(): TreeNode[] {
        const filterNode: FilterNode = { kind: 'impactedFilter' };

        if (this.fileToTargets.size === 0) {
            return [filterNode, { kind: 'message', text: 'No CMake data loaded' }];
        }
        if (!this.activeFile) {
            return [filterNode, { kind: 'message', text: 'No active file' }];
        }
        let allTargets = this.fileToTargets.get(this.activeFile);
        if (!allTargets || allTargets.length === 0) {
            return [filterNode, { kind: 'message', text: 'No targets for this file' }];
        }

        // Apply filter on target name
        if (this.filter) {
            const f = this.filter;
            allTargets = allTargets.filter(t =>
                t.name.toLowerCase().includes(f) ||
                t.type.toLowerCase().includes(f)
            );
        }

        const directIds = this.fileToDirectIds.get(this.activeFile) ?? new Set<string>();

        // Split into libraries, executables, and tests (skip UTILITY)
        const libs = allTargets
            .filter(t => LIBRARY_TYPES.has(t.type))
            .sort((a, b) => a.name.localeCompare(b.name));
        const allExes = allTargets
            .filter(t => t.type === 'EXECUTABLE');
        const exes = allExes
            .filter(t => !this.testsByTarget.has(t.name))
            .sort((a, b) => a.name.localeCompare(b.name));
        const tests = allExes
            .filter(t => this.testsByTarget.has(t.name))
            .sort((a, b) => a.name.localeCompare(b.name));

        const sections: TreeNode[] = [];
        if (libs.length > 0) {
            sections.push({
                kind: 'impactedSection',
                sectionId: 'libraries',
                label: 'Libraries',
                icon: 'library',
                targets: libs,
                directIds,
            });
        }
        if (exes.length > 0) {
            sections.push({
                kind: 'impactedSection',
                sectionId: 'executables',
                label: 'Executables',
                icon: 'run',
                targets: exes,
                directIds,
            });
        }
        if (tests.length > 0) {
            sections.push({
                kind: 'impactedSection',
                sectionId: 'tests',
                label: 'Tests',
                icon: 'beaker',
                targets: tests,
                directIds,
            });
        }

        if (sections.length === 0) {
            return [filterNode, { kind: 'message', text: 'No matching targets' }];
        }
        return [filterNode, ...sections];
    }

    private getSectionChildren(section: SectionNode): TreeNode[] {
        const children: TreeNode[] = section.targets.map(t => {
            const node: TargetNode = {
                kind: 'impactedTarget',
                target: t,
                direct: section.directIds.has(t.id),
            };
            this.parentMap.set(node, section);
            return node;
        });
        return children;
    }

    // ------------------------------------------------------------
    // Dependency resolution
    // ------------------------------------------------------------

    /**
     * Collect a target and all its transitive reverse dependents (BFS).
     */
    private collectAllDependents(targetId: string): Set<string> {
        const result = new Set<string>();
        const queue = [targetId];
        while (queue.length > 0) {
            const current = queue.pop()!;
            if (result.has(current)) { continue; }
            result.add(current);
            const dependents = this.reverseDeps.get(current);
            if (dependents) {
                for (const depId of dependents) {
                    if (!result.has(depId)) { queue.push(depId); }
                }
            }
        }
        return result;
    }

    // ------------------------------------------------------------
    // Paths
    // ------------------------------------------------------------

    private resolveSourcePath(target: Target, sourcePath: string): string {
        const isAbs = /^([a-zA-Z]:[\\/]|\/)/.test(sourcePath);
        if (isAbs) { return path.normalize(sourcePath); }
        return path.normalize(path.join(this.projectSourceDir, sourcePath));
    }

    private normalizeKey(filePath: string): string {
        return path.normalize(filePath).toLowerCase();
    }

    private targetTooltip(t: Target, direct: boolean): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${t.name}** \`${t.type}\`\n\n`);
        if (!direct) {
            md.appendMarkdown(`*Transitively impacted via dependency chain*\n\n`);
        }
        if (t.nameOnDisk) { md.appendMarkdown(`File: \`${t.nameOnDisk}\`\n\n`); }
        if (t.artifacts?.length) {
            md.appendMarkdown(`Artifacts:\n`);
            for (const a of t.artifacts) { md.appendMarkdown(`- \`${a.path}\`\n`); }
        }
        const tests = this.testsByTarget.get(t.name);
        if (tests?.length) {
            md.appendMarkdown(`\nTests (${tests.length}):\n`);
            for (const tn of tests) { md.appendMarkdown(`- ${tn}\n`); }
        }
        return md;
    }
}

// ------------------------------------------------------------
// Regex helpers (module-level)
// ------------------------------------------------------------

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a ctest -R regex from a list of test names.
 * Groups tests by first token (before first '_') and uses those tokens as patterns.
 */
function buildTestRegex(tests: string[]): string {
    const tokens = new Set<string>();
    for (const name of tests) {
        const idx = name.indexOf('_');
        tokens.add(idx > 0 ? name.substring(0, idx) : name);
    }
    return Array.from(tokens).map(t => escapeRegex(t)).join('|');
}

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
    private readonly m_onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData: vscode.Event<void> = this.m_onDidChangeTreeData.event;

    /** Normalized absolute file path → all impacted targets (direct + transitive) */
    private m_fileToTargets = new Map<string, Target[]>();

    /** Normalized absolute file path → direct target ids */
    private m_fileToDirectIds = new Map<string, Set<string>>();

    /** Current active file path (normalized) */
    private m_activeFile: string | null = null;

    private m_projectSourceDir = '';

    /** Target id → Target object */
    private m_targetById = new Map<string, Target>();

    /** Reverse dependency graph: targetId → set of targetIds that depend on it */
    private m_reverseDeps = new Map<string, Set<string>>();

    // Parent tracking for getParent support
    private m_parentMap = new WeakMap<TreeNode, TreeNode>();

    /** targetName → list of ctest test names */
    private m_testsByTarget = new Map<string, string[]>();

    // Filter
    private m_filter = '';

    // ------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------

    /**
     * Rebuild the file→targets dictionary from loaded targets.
     * Resolves transitive reverse dependencies so that modifying
     * a file in libA also shows libB and bin_toto if the dependency
     * chain is libA ← libB ← bin_toto.
     */
    refresh(aTargets: Target[], aProjectSourceDir: string): void {
        this.m_projectSourceDir = aProjectSourceDir;
        this.m_fileToTargets.clear();
        this.m_fileToDirectIds.clear();
        this.m_targetById.clear();
        this.m_reverseDeps.clear();
        this.m_parentMap = new WeakMap();

        // 1. Index targets by id
        for (const t of aTargets) {
            this.m_targetById.set(t.id, t);
        }

        // 2. Build reverse dependency graph
        //    If target B has dependency A, then A ← B (A is depended upon by B)
        for (const t of aTargets) {
            for (const dep of t.dependencies ?? []) {
                let set = this.m_reverseDeps.get(dep.id);
                if (!set) {
                    set = new Set();
                    this.m_reverseDeps.set(dep.id, set);
                }
                set.add(t.id);
            }
        }

        // 3. For each target source file, compute all transitive dependents
        for (const target of aTargets) {
            const all_impacted = this.collectAllDependents(target.id);

            for (const source of target.sources) {
                const abs_path = this.resolveSourcePath(target, source.path);
                const key = this.normalizeKey(abs_path);

                // Direct target tracking
                let direct_set = this.m_fileToDirectIds.get(key);
                if (!direct_set) {
                    direct_set = new Set();
                    this.m_fileToDirectIds.set(key, direct_set);
                }
                direct_set.add(target.id);

                // Full impacted list
                let list = this.m_fileToTargets.get(key);
                if (!list) {
                    list = [];
                    this.m_fileToTargets.set(key, list);
                }
                for (const impactedId of all_impacted) {
                    if (!list.some(t => t.id === impactedId)) {
                        const impacted_target = this.m_targetById.get(impactedId);
                        if (impacted_target) { list.push(impacted_target); }
                    }
                }
            }
        }

        this.m_onDidChangeTreeData.fire();
    }

    clear(): void {
        this.m_fileToTargets.clear();
        this.m_fileToDirectIds.clear();
        this.m_targetById.clear();
        this.m_reverseDeps.clear();
        this.m_parentMap = new WeakMap();
        this.m_activeFile = null;
        this.m_filter = '';
        this.m_onDidChangeTreeData.fire();
    }

    /**
     * Update the pane for the given active editor file.
     */
    setActiveFile(aFilePath: string | null): void {
        const key = aFilePath ? this.normalizeKey(aFilePath) : null;
        if (key === this.m_activeFile) { return; }
        this.m_activeFile = key;
        this.m_parentMap = new WeakMap();
        this.m_onDidChangeTreeData.fire();
    }

    // ------------------------------------------------------------
    // Filter
    // ------------------------------------------------------------

    setFilter(aPattern: string): void {
        this.m_filter = aPattern.toLowerCase();
        this.m_parentMap = new WeakMap();
        this.m_onDidChangeTreeData.fire();
    }

    clearFilter(): void {
        this.m_filter = '';
        this.m_parentMap = new WeakMap();
        this.m_onDidChangeTreeData.fire();
    }

    get currentFilter(): string {
        return this.m_filter;
    }

    get hasFilter(): boolean {
        return this.m_filter.length > 0;
    }

    // ------------------------------------------------------------
    // Test map
    // ------------------------------------------------------------

    /**
     * Store the mapping targetName → ctest test names.
     * Used to separate test executables from normal executables
     * and to build regex patterns for running tests.
     */
    setTestMap(aMap: Map<string, string[]>): void {
        this.m_testsByTarget = aMap;
        this.m_parentMap = new WeakMap();
        this.m_onDidChangeTreeData.fire();
    }

    /** True if the given target name is a known test executable. */
    isTestTarget(aTargetName: string): boolean {
        return this.m_testsByTarget.has(aTargetName);
    }

    /**
     * Build a ctest -R regex that matches all tests of a given target.
     * Groups test names by first token (before first '_') and joins them.
     */
    getTestRegex(aTargetName: string): string {
        const tests = this.m_testsByTarget.get(aTargetName);
        if (!tests || tests.length === 0) { return escapeRegex(aTargetName); }
        return buildTestRegex(tests);
    }

    /**
     * Build a ctest -R regex that matches all tests of multiple targets.
     */
    getTestSectionRegex(aTargetNames: string[]): string {
        const all_tests: string[] = [];
        for (const name of aTargetNames) {
            const tests = this.m_testsByTarget.get(name);
            if (tests) { all_tests.push(...tests); }
        }
        if (all_tests.length === 0) {
            return aTargetNames.map(n => escapeRegex(n)).join('|');
        }
        return buildTestRegex(all_tests);
    }

    // ------------------------------------------------------------
    // TreeDataProvider
    // ------------------------------------------------------------

    getTreeItem(aNode: TreeNode): vscode.TreeItem {
        switch (aNode.kind) {
            case 'impactedFilter': {
                const label = this.m_filter
                    ? `Filter: ${this.m_filter}`
                    : 'Filter: (none)';
                const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('search');
                item.contextValue = this.m_filter ? 'impactedFilterActive' : 'impactedFilter';
                item.command = {
                    command: 'CMakeGraph.filterImpacted',
                    title: 'Filter',
                };
                return item;
            }
            case 'impactedSection': {
                const state = this.m_filter
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Expanded;
                const item = new vscode.TreeItem(aNode.label, state);
                item.id = `impactedSection:${aNode.sectionId}`;
                item.iconPath = new vscode.ThemeIcon(aNode.icon);
                item.description = `${aNode.targets.length}`;
                item.contextValue = `impactedSection_${aNode.sectionId}`;
                return item;
            }
            case 'impactedTarget': {
                const t = aNode.target;
                const is_test = this.m_testsByTarget.has(t.name);
                const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
                item.id = `impactedTarget:${t.id}`;
                item.iconPath = new vscode.ThemeIcon(is_test ? 'beaker' : (TARGET_ICONS[t.type] ?? 'circle-outline'));
                item.description = aNode.direct ? undefined : '(transitive)';
                item.tooltip = this.targetTooltip(t, aNode.direct);
                item.contextValue = is_test ? 'impactedTarget_TEST' : `impactedTarget_${t.type}`;
                return item;
            }
            case 'message': {
                const item = new vscode.TreeItem(aNode.text, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('info');
                return item;
            }
        }
    }

    getChildren(aNode?: TreeNode): TreeNode[] {
        if (!aNode) {
            return this.getRootNodes();
        }
        if (aNode.kind === 'impactedSection') {
            return this.getSectionChildren(aNode);
        }
        return [];
    }

    getParent(aNode: TreeNode): TreeNode | null {
        return this.m_parentMap.get(aNode) ?? null;
    }

    // ------------------------------------------------------------
    // Root & section children
    // ------------------------------------------------------------

    private getRootNodes(): TreeNode[] {
        const filter_node: FilterNode = { kind: 'impactedFilter' };

        if (this.m_fileToTargets.size === 0) {
            return [filter_node, { kind: 'message', text: 'No CMake data loaded' }];
        }
        if (!this.m_activeFile) {
            return [filter_node, { kind: 'message', text: 'No active file' }];
        }
        let all_targets = this.m_fileToTargets.get(this.m_activeFile);
        if (!all_targets || all_targets.length === 0) {
            return [filter_node, { kind: 'message', text: 'No targets for this file' }];
        }

        // Apply filter on target name
        if (this.m_filter) {
            const f = this.m_filter;
            all_targets = all_targets.filter(t =>
                t.name.toLowerCase().includes(f) ||
                t.type.toLowerCase().includes(f)
            );
        }

        const direct_ids = this.m_fileToDirectIds.get(this.m_activeFile) ?? new Set<string>();

        // Split into libraries, executables, and tests (skip UTILITY)
        const libs = all_targets
            .filter(t => LIBRARY_TYPES.has(t.type))
            .sort((a, b) => a.name.localeCompare(b.name));
        const all_exes = all_targets
            .filter(t => t.type === 'EXECUTABLE');
        const exes = all_exes
            .filter(t => !this.m_testsByTarget.has(t.name))
            .sort((a, b) => a.name.localeCompare(b.name));
        const tests = all_exes
            .filter(t => this.m_testsByTarget.has(t.name))
            .sort((a, b) => a.name.localeCompare(b.name));

        const sections: TreeNode[] = [];
        if (libs.length > 0) {
            sections.push({
                kind: 'impactedSection',
                sectionId: 'libraries',
                label: 'Libraries',
                icon: 'library',
                targets: libs,
                directIds: direct_ids,
            });
        }
        if (exes.length > 0) {
            sections.push({
                kind: 'impactedSection',
                sectionId: 'executables',
                label: 'Executables',
                icon: 'run',
                targets: exes,
                directIds: direct_ids,
            });
        }
        if (tests.length > 0) {
            sections.push({
                kind: 'impactedSection',
                sectionId: 'tests',
                label: 'Tests',
                icon: 'beaker',
                targets: tests,
                directIds: direct_ids,
            });
        }

        if (sections.length === 0) {
            return [filter_node, { kind: 'message', text: 'No matching targets' }];
        }
        return [filter_node, ...sections];
    }

    private getSectionChildren(aSection: SectionNode): TreeNode[] {
        const children: TreeNode[] = aSection.targets.map(t => {
            const node: TargetNode = {
                kind: 'impactedTarget',
                target: t,
                direct: aSection.directIds.has(t.id),
            };
            this.m_parentMap.set(node, aSection);
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
    private collectAllDependents(aTargetId: string): Set<string> {
        const result = new Set<string>();
        const queue = [aTargetId];
        while (queue.length > 0) {
            const current = queue.pop()!;
            if (result.has(current)) { continue; }
            result.add(current);
            const dependents = this.m_reverseDeps.get(current);
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

    private resolveSourcePath(aTarget: Target, aSourcePath: string): string {
        const is_abs = /^([a-zA-Z]:[\\/]|\/)/.test(aSourcePath);
        if (is_abs) { return path.normalize(aSourcePath); }
        return path.normalize(path.join(this.m_projectSourceDir, aSourcePath));
    }

    private normalizeKey(aFilePath: string): string {
        return path.normalize(aFilePath).toLowerCase();
    }

    private targetTooltip(aTarget: Target, aDirect: boolean): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${aTarget.name}** \`${aTarget.type}\`\n\n`);
        if (!aDirect) {
            md.appendMarkdown(`*Transitively impacted via dependency chain*\n\n`);
        }
        if (aTarget.nameOnDisk) { md.appendMarkdown(`File: \`${aTarget.nameOnDisk}\`\n\n`); }
        if (aTarget.artifacts?.length) {
            md.appendMarkdown(`Artifacts:\n`);
            for (const a of aTarget.artifacts) { md.appendMarkdown(`- \`${a.path}\`\n`); }
        }
        const tests = this.m_testsByTarget.get(aTarget.name);
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

function escapeRegex(aStr: string): string {
    return aStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a ctest -R regex from a list of test names.
 * Groups tests by first token (before first '_') and uses those tokens as patterns.
 */
function buildTestRegex(aTests: string[]): string {
    const tokens = new Set<string>();
    for (const name of aTests) {
        const idx = name.indexOf('_');
        tokens.add(idx > 0 ? name.substring(0, idx) : name);
    }
    return Array.from(tokens).map(t => escapeRegex(t)).join('|');
}

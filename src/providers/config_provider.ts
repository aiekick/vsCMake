import * as vscode from 'vscode';
import { CacheEntry, CacheEntryType } from '../cmake/types';

// ------------------------------------------------------------
// Tree nodes
// ------------------------------------------------------------
interface GroupNode { kind: 'group'; name: string; entries: CacheEntry[]; }
interface EntryNode { kind: 'entry'; entry: CacheEntry; }

interface FilterNode { kind: 'filter'; }

type TreeNode = FilterNode | GroupNode | EntryNode;

// ------------------------------------------------------------
// ConfigProvider
// ------------------------------------------------------------
export class ConfigProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly m_onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData: vscode.Event<void> = this.m_onDidChangeTreeData.event;

    private m_allEntries: CacheEntry[] = [];
    private m_groups: GroupNode[] = [];
    private m_filter = '';

    refresh(aEntries: CacheEntry[]): void {
        this.m_allEntries = aEntries;
        this.rebuildGroups();
    }

    clear(): void {
        this.m_allEntries = [];
        this.m_filter = '';
        this.m_groups = [];
        this.m_onDidChangeTreeData.fire();
    }

    getGroups(): GroupNode[] {
        return this.m_groups;
    }

    // ------------------------------------------------------------
    // Filter
    // ------------------------------------------------------------

    setFilter(aPattern: string): void {
        this.m_filter = aPattern.toLowerCase();
        this.rebuildGroups();
    }

    clearFilter(): void {
        this.m_filter = '';
        this.rebuildGroups();
    }

    get currentFilter(): string {
        return this.m_filter;
    }

    get hasFilter(): boolean {
        return this.m_filter.length > 0;
    }

    private rebuildGroups(): void {
        let entries = this.m_allEntries;

        // Apply filter (case insensitive, on name + value + helpstring)
        if (this.m_filter) {
            const f = this.m_filter;
            entries = entries.filter(e =>
                e.name.toLowerCase().includes(f) ||
                e.value.toLowerCase().includes(f) ||
                (e.properties.HELPSTRING ?? '').toLowerCase().includes(f)
            );
        }

        this.m_groups = this.buildGroups(entries);
        this.m_onDidChangeTreeData.fire();
    }

    // ------------------------------------------------------------
    // TreeDataProvider
    // ------------------------------------------------------------

    getTreeItem(aNode: TreeNode): vscode.TreeItem {
        if (aNode.kind === 'filter') { return this.filterItem(); }
        if (aNode.kind === 'group') { return this.groupItem(aNode); }
        return this.entryItem(aNode);
    }

    getChildren(aNode?: TreeNode): TreeNode[] {
        if (!aNode) {
            return [
                { kind: 'filter' as const },
                ...this.m_groups,
            ];
        }
        if (aNode.kind === 'group') {
            return aNode.entries.map(e => ({ kind: 'entry' as const, entry: e }));
        }
        return [];
    }

    getParent(aNode: TreeNode): TreeNode | null {
        if (aNode.kind === 'entry') {
            return this.m_groups.find(g => g.entries.includes(aNode.entry)) ?? null;
        }
        return null;
    }

    // ------------------------------------------------------------
    // Groups
    // ------------------------------------------------------------

    private buildGroups(aEntries: CacheEntry[]): GroupNode[] {
        const map = new Map<string, CacheEntry[]>();

        for (const entry of aEntries) {
            const prefix = this.extractPrefix(entry.name);
            if (!map.has(prefix)) { map.set(prefix, []); }
            map.get(prefix)!.push(entry);
        }

        const sorted = [...map.entries()].sort(([a], [b]) => {
            if (a === 'OTHER') { return 1; }
            if (b === 'OTHER') { return -1; }
            return a.localeCompare(b);
        });

        return sorted.map(([name, entries]) => ({ kind: 'group' as const, name, entries }));
    }

    private extractPrefix(aName: string): string {
        const idx = aName.indexOf('_');
        return idx > 0 ? aName.substring(0, idx) : 'OTHER';
    }

    // ------------------------------------------------------------
    // TreeItems
    // ------------------------------------------------------------

    private filterItem(): vscode.TreeItem {
        const label = this.m_filter
            ? `Filter: ${this.m_filter}`
            : 'Filter: (none)';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('search');
        item.contextValue = this.m_filter ? 'cmakeCacheFilterActive' : 'cmakeCacheFilter';
        item.command = {
            command: 'CMakeGraph.filterConfig',
            title: 'Filter',
        };
        return item;
    }

    private groupItem(aNode: GroupNode): vscode.TreeItem {
        // When a filter is active, expand groups by default
        const state = this.m_filter
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(aNode.name, state);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.description = `${aNode.entries.length}`;
        item.contextValue = 'cmakeCacheGroup';
        return item;
    }

    private entryItem(aNode: EntryNode): vscode.TreeItem {
        const e = aNode.entry;
        const item = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.None);

        item.description = e.value;
        item.tooltip = this.entryTooltip(e);
        item.iconPath = new vscode.ThemeIcon(this.iconForType(e.type));
        item.contextValue = 'cmakeCacheEntry';

        item.command = {
            command: 'CMakeGraph.editCacheEntry',
            title: 'Edit',
            arguments: [aNode.entry],
        };

        return item;
    }

    // ------------------------------------------------------------
    // Tooltip
    // ------------------------------------------------------------

    private entryTooltip(aEntry: CacheEntry): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${aEntry.name}** \`${aEntry.type}\`\n\n`);

        if (aEntry.properties.HELPSTRING) {
            md.appendMarkdown(`${aEntry.properties.HELPSTRING}\n\n`);
        }

        md.appendMarkdown(`Value: \`${aEntry.value}\`\n\n`);

        if (aEntry.properties.STRINGS) {
            const values = aEntry.properties.STRINGS.split(';');
            md.appendMarkdown(`Possible values: ${values.map(v => `\`${v}\``).join(', ')}\n`);
        }

        return md;
    }

    // ------------------------------------------------------------
    // Icons by type
    // ------------------------------------------------------------

    private iconForType(aType: CacheEntryType): string {
        switch (aType) {
            case 'BOOL': return 'symbol-boolean';
            case 'FILEPATH': return 'file';
            case 'PATH': return 'folder';
            case 'STRING': return 'symbol-string';
            default: return 'symbol-variable';
        }
    }
}

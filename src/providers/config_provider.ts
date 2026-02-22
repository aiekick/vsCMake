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
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;

    private allEntries: CacheEntry[] = [];
    private groups: GroupNode[] = [];
    private filter = '';

    refresh(entries: CacheEntry[]): void {
        this.allEntries = entries;
        this.rebuildGroups();
    }

    clear(): void {
        this.allEntries = [];
        this.filter = '';
        this.groups = [];
        this._onDidChangeTreeData.fire();
    }

    getGroups(): GroupNode[] {
        return this.groups;
    }

    // ------------------------------------------------------------
    // Filter
    // ------------------------------------------------------------

    setFilter(pattern: string): void {
        this.filter = pattern.toLowerCase();
        this.rebuildGroups();
    }

    clearFilter(): void {
        this.filter = '';
        this.rebuildGroups();
    }

    get currentFilter(): string {
        return this.filter;
    }

    get hasFilter(): boolean {
        return this.filter.length > 0;
    }

    private rebuildGroups(): void {
        let entries = this.allEntries;

        // Apply filter (case insensitive, on name + value + helpstring)
        if (this.filter) {
            const f = this.filter;
            entries = entries.filter(e =>
                e.name.toLowerCase().includes(f) ||
                e.value.toLowerCase().includes(f) ||
                (e.properties.HELPSTRING ?? '').toLowerCase().includes(f)
            );
        }

        this.groups = this.buildGroups(entries);
        this._onDidChangeTreeData.fire();
    }

    // ------------------------------------------------------------
    // TreeDataProvider
    // ------------------------------------------------------------

    getTreeItem(node: TreeNode): vscode.TreeItem {
        if (node.kind === 'filter') { return this.filterItem(); }
        if (node.kind === 'group') { return this.groupItem(node); }
        return this.entryItem(node);
    }

    getChildren(node?: TreeNode): TreeNode[] {
        if (!node) {
            return [
                { kind: 'filter' as const },
                ...this.groups,
            ];
        }
        if (node.kind === 'group') {
            return node.entries.map(e => ({ kind: 'entry' as const, entry: e }));
        }
        return [];
    }

    getParent(node: TreeNode): TreeNode | null {
        if (node.kind === 'entry') {
            return this.groups.find(g => g.entries.includes(node.entry)) ?? null;
        }
        return null;
    }

    // ------------------------------------------------------------
    // Groups
    // ------------------------------------------------------------

    private buildGroups(entries: CacheEntry[]): GroupNode[] {
        const map = new Map<string, CacheEntry[]>();

        for (const entry of entries) {
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

    private extractPrefix(name: string): string {
        const idx = name.indexOf('_');
        return idx > 0 ? name.substring(0, idx) : 'OTHER';
    }

    // ------------------------------------------------------------
    // TreeItems
    // ------------------------------------------------------------

    private filterItem(): vscode.TreeItem {
        const label = this.filter
            ? `Filter: ${this.filter}`
            : 'Filter: (none)';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('search');
        item.contextValue = this.filter ? 'cmakeCacheFilterActive' : 'cmakeCacheFilter';
        item.command = {
            command: 'vsCMake.filterConfig',
            title: 'Filter',
        };
        return item;
    }

    private groupItem(node: GroupNode): vscode.TreeItem {
        // When a filter is active, expand groups by default
        const state = this.filter
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(node.name, state);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.description = `${node.entries.length}`;
        item.contextValue = 'cmakeCacheGroup';
        return item;
    }

    private entryItem(node: EntryNode): vscode.TreeItem {
        const e = node.entry;
        const item = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.None);

        item.description = e.value;
        item.tooltip = this.entryTooltip(e);
        item.iconPath = new vscode.ThemeIcon(this.iconForType(e.type));
        item.contextValue = 'cmakeCacheEntry';

        item.command = {
            command: 'vsCMake.editCacheEntry',
            title: 'Edit',
            arguments: [node.entry],
        };

        return item;
    }

    // ------------------------------------------------------------
    // Tooltip
    // ------------------------------------------------------------

    private entryTooltip(e: CacheEntry): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${e.name}** \`${e.type}\`\n\n`);

        if (e.properties.HELPSTRING) {
            md.appendMarkdown(`${e.properties.HELPSTRING}\n\n`);
        }

        md.appendMarkdown(`Value: \`${e.value}\`\n\n`);

        if (e.properties.STRINGS) {
            const values = e.properties.STRINGS.split(';');
            md.appendMarkdown(`Possible values: ${values.map(v => `\`${v}\``).join(', ')}\n`);
        }

        return md;
    }

    // ------------------------------------------------------------
    // Icons by type
    // ------------------------------------------------------------

    private iconForType(type: CacheEntryType): string {
        switch (type) {
            case 'BOOL': return 'symbol-boolean';
            case 'FILEPATH': return 'file';
            case 'PATH': return 'folder';
            case 'STRING': return 'symbol-string';
            default: return 'symbol-variable';
        }
    }
}
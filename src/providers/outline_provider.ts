import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    Codemodel, Configuration, Target, TargetType,
    CompileGroup, Source,
} from '../cmake/types';

// ------------------------------------------------------------
// Nodes
// ------------------------------------------------------------
type SectionId = 'sources' | 'cmakeExtras';
type ExtrasId = 'includes' | 'compileFlags' | 'linkFlags' | 'libraries' | 'directLinks';

interface ProjectNode { kind: 'project'; name: string; }
interface RootFileNode { kind: 'rootFile'; target: Target | null; label: string; filePath: string; }
interface FolderNode { kind: 'folder'; name: string; fullPath: string; targets: Target[]; subFolders: FolderNode[]; }
interface TargetNode { kind: 'target'; target: Target; }
interface TargetCmakeNode { kind: 'targetCmake'; target: Target; filePath: string; line: number; }
interface SectionNode { kind: 'section'; label: string; icon: string; target: Target; sectionId: SectionId; }
interface ExtrasGroupNode { kind: 'extrasGroup'; label: string; icon: string; target: Target; extrasId: ExtrasId; }
interface SourceNode { kind: 'source'; target: Target; source: Source; compileGroup?: CompileGroup; }
interface IncludeNode { kind: 'include'; target: Target; path: string; isSystem: boolean; }
interface FlagNode { kind: 'flag'; target: Target; text: string; }
interface CmakeFileNode { kind: 'cmakefile'; target: Target; path: string; }
interface VirtualFolderNode { kind: 'virtualFolder'; name: string; fullPath: string; sources: { source: Source; compileGroup?: CompileGroup }[]; subFolders: VirtualFolderNode[]; target: Target; }
interface DirectLinkNode { kind: 'directLink'; target: Target; }
interface LibNode { kind: 'library'; target: Target; fragment: string; role: string; }
interface OutlineFilterNode { kind: 'outlineFilter'; }

type TreeNode =
    | OutlineFilterNode | ProjectNode
    | RootFileNode | FolderNode | TargetNode | TargetCmakeNode
    | SectionNode | ExtrasGroupNode
    | SourceNode | IncludeNode | FlagNode | CmakeFileNode
    | VirtualFolderNode | DirectLinkNode | LibNode;

const TARGET_ICONS: Record<TargetType, string> = {
    EXECUTABLE: 'run',
    STATIC_LIBRARY: 'package',
    SHARED_LIBRARY: 'library',
    MODULE_LIBRARY: 'library',
    OBJECT_LIBRARY: 'file-binary',
    INTERFACE_LIBRARY: 'symbol-interface',
    UTILITY: 'tools',
};

// ------------------------------------------------------------
// ProjectOutlineProvider
// ------------------------------------------------------------
export class ProjectOutlineProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;

    private config: Configuration | null = null;
    private targetMap = new Map<string, Target>();
    private rootNodes: TreeNode[] = [];
    private projectSourceDir = '';
    private filter = '';

    // keep raw data to rebuild on filter change
    private lastCodemodel: Codemodel | null = null;
    private lastTargets: Target[] = [];
    private lastActiveConfig = '';

    refresh(codemodel: Codemodel, targets: Target[], activeConfig: string): void {
        this.lastCodemodel = codemodel;
        this.lastTargets = targets;
        this.lastActiveConfig = activeConfig;
        this.rebuildTree();
    }

    clear(): void {
        this.config = null;
        this.targetMap.clear();
        this.rootNodes = [];
        this.projectSourceDir = '';
        this.filter = '';
        this.lastCodemodel = null;
        this.lastTargets = [];
        this.lastActiveConfig = '';
        this.parentMap = new WeakMap();
        this.childrenCache = new WeakMap();
        this._onDidChangeTreeData.fire();
    }

    // ------------------------------------------------------------
    // Filter
    // ------------------------------------------------------------

    setFilter(pattern: string): void {
        this.filter = pattern.toLowerCase();
        this.rebuildTree();
    }

    clearFilter(): void {
        this.filter = '';
        this.rebuildTree();
    }

    get currentFilter(): string {
        return this.filter;
    }

    get hasFilter(): boolean {
        return this.filter.length > 0;
    }

    private rebuildTree(): void {
        if (!this.lastCodemodel) { return; }
        this.targetMap.clear();
        for (const t of this.lastTargets) { this.targetMap.set(t.id, t); }

        this.projectSourceDir = this.lastCodemodel.paths.source;

        this.config = this.lastCodemodel.configurations.find(
            c => (c.name || '(default)') === this.lastActiveConfig
        ) ?? this.lastCodemodel.configurations[0] ?? null;

        this.rootNodes = this.buildRootNodes();
        this.parentMap = new WeakMap();
        this.childrenCache = new WeakMap();
        this._onDidChangeTreeData.fire();
    }

    // ------------------------------------------------------------
    // TreeDataProvider
    // ------------------------------------------------------------

    getTreeItem(node: TreeNode): vscode.TreeItem {
        switch (node.kind) {
            case 'outlineFilter': return this.outlineFilterItem();
            case 'project': return this.projectItem(node);
            case 'rootFile': return this.rootFileItem(node);
            case 'folder': return this.folderItem(node);
            case 'target': return this.targetItem(node);
            case 'targetCmake': return this.targetCmakeItem(node);
            case 'section': return this.sectionItem(node);
            case 'extrasGroup': return this.extrasGroupItem(node);
            case 'source': return this.sourceItem(node.target, node.source, node.compileGroup);
            case 'include': return this.includeItem(node);
            case 'flag': return this.flagItem(node);
            case 'cmakefile': return this.cmakeFileItem(node);
            case 'virtualFolder': return this.virtualFolderItem(node);
            case 'directLink': return this.directLinkItem(node);
            case 'library': return this.libItem(node);
        }
    }

    private parentMap = new WeakMap<TreeNode, TreeNode>();
    private childrenCache = new WeakMap<TreeNode, TreeNode[]>();

    getChildren(node?: TreeNode): TreeNode[] {
        if (!this.config) { return []; }
        if (!node) { return this.rootNodes; }
        if (node.kind === 'outlineFilter') { return []; }

        // Use cache if available
        if (this.childrenCache.has(node)) { return this.childrenCache.get(node)!; }

        let children: TreeNode[];
        switch (node.kind) {
            case 'project': children = this.projectChildren(); break;
            case 'folder': children = this.folderChildren(node); break;
            case 'target': children = this.targetChildren(node); break;
            case 'section': children = this.sectionChildren(node); break;
            case 'extrasGroup': children = this.extrasGroupChildren(node); break;
            case 'virtualFolder': children = this.virtualFolderChildren(node); break;
            default: children = [];
        }

        // Register parent links
        for (const child of children) { this.parentMap.set(child, node); }
        this.childrenCache.set(node, children);

        return children;
    }

    getParent(node: TreeNode): TreeNode | null {
        return this.parentMap.get(node) ?? null;
    }

    // ------------------------------------------------------------
    // Root construction
    // ------------------------------------------------------------

    private static readonly EXCLUDED_TARGETS = new Set([
        'ALL_BUILD', 'ZERO_CHECK', 'RUN_TESTS', 'INSTALL', 'PACKAGE',
    ]);

    private isExcluded(t: Target): boolean {
        return t.type === 'UTILITY' && ProjectOutlineProvider.EXCLUDED_TARGETS.has(t.name);
    }

    private pruneEmptyFolders(nodes: FolderNode[]): void {
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            this.pruneEmptyFolders(n.subFolders);
            if (n.targets.length === 0 && n.subFolders.length === 0) {
                nodes.splice(i, 1);
            }
        }
    }

    private buildRootNodes(): TreeNode[] {
        if (!this.config) { return []; }

        const filterNode: OutlineFilterNode = { kind: 'outlineFilter' };

        // Find root project name from codemodel
        const rootProject = this.config.projects?.find(p => p.parent === undefined)
            ?? this.config.projects?.[0];
        const projectName = rootProject?.name ?? 'Project';

        const projectNode: ProjectNode = { kind: 'project', name: projectName };

        return [filterNode, projectNode];
    }

    private projectChildren(): TreeNode[] {
        if (!this.config) { return []; }

        const seen = new Set<string>();
        let targets = this.config.targets
            .filter(ref => { if (seen.has(ref.id)) { return false; } seen.add(ref.id); return true; })
            .map(ref => this.targetMap.get(ref.id))
            .filter((t): t is Target => t !== undefined)
            .filter(t => !this.isExcluded(t));

        // Apply filter on target name
        if (this.filter) {
            const f = this.filter;
            targets = targets.filter(t =>
                t.name.toLowerCase().includes(f) ||
                t.type.toLowerCase().includes(f)
            );
        }

        const withFolder = targets.filter(t => t.folder?.name);
        const withoutFolder = targets.filter(t => !t.folder?.name);

        const folderNodes = this.buildFolderTree(withFolder);
        this.pruneEmptyFolders(folderNodes);

        // Root cmake files at the end
        const rootCMakeNodes = this.buildRootFileNodes();

        return [
            ...folderNodes,
            ...withoutFolder.map(t => ({ kind: 'target' as const, target: t })),
            ...rootCMakeNodes
        ];
    }

    /** Root-level CMake files (CMakeLists.txt, CMakePresets.json, CMakeUserPresets.json) */
    private buildRootFileNodes(): RootFileNode[] {
        const nodes: RootFileNode[] = [];
        const candidates = [
            'CMakeLists.txt',
            'CMakePresets.json',
            'CMakeUserPresets.json',
        ];
        for (const name of candidates) {
            const fullPath = path.join(this.projectSourceDir, name);
            if (fs.existsSync(fullPath)) {
                nodes.push({ kind: 'rootFile', target: null, label: name, filePath: fullPath });
            }
        }
        return nodes;
    }

    private buildFolderTree(targets: Target[]): FolderNode[] {
        const folderMap = new Map<string, FolderNode>();

        const getOrCreate = (fullPath: string): FolderNode => {
            if (folderMap.has(fullPath)) { return folderMap.get(fullPath)!; }
            const parts = fullPath.replace(/\\/g, '/').split('/');
            const name = parts.at(-1) ?? fullPath;
            const node: FolderNode = { kind: 'folder', name, fullPath, targets: [], subFolders: [] };
            folderMap.set(fullPath, node);
            if (parts.length > 1) {
                const parent = getOrCreate(parts.slice(0, -1).join('/'));
                if (!parent.subFolders.includes(node)) { parent.subFolders.push(node); }
            }
            return node;
        };

        for (const t of targets) {
            getOrCreate(t.folder!.name).targets.push(t);
        }

        const roots = [...folderMap.values()].filter(f => !f.fullPath.includes('/'));
        this.sortFolderTree(roots);
        return roots;
    }

    private sortFolderTree(nodes: FolderNode[]): void {
        nodes.sort((a, b) => a.name.localeCompare(b.name));
        for (const n of nodes) { this.sortFolderTree(n.subFolders); }
    }

    private folderChildren(node: FolderNode): TreeNode[] {
        return [
            ...node.subFolders,
            ...node.targets.map(t => ({ kind: 'target' as const, target: t })),
        ];
    }

    // ------------------------------------------------------------
    // Target children
    // ------------------------------------------------------------

    private targetChildren(node: TargetNode): TreeNode[] {
        const t = node.target;
        const children: TreeNode[] = [];

        // CMake Extras only if at least one sub-item exists
        if (this.hasAnyExtras(t)) {
            children.push({
                kind: 'section' as const,
                label: 'CMake Extras',
                icon: 'symbol-misc',
                target: t,
                sectionId: 'cmakeExtras' as SectionId,
            });
        }

        // Sources
        children.push(...this.buildSourceTree(t));

        // Target-specific CMake files at the end
        children.push(...this.buildTargetCmakeFileNodes(t));

        return children;
    }

    /** CMakeLists.txt where the target is defined (add_executable / add_library) */
    private buildTargetCmakeFileNodes(target: Target): TreeNode[] {
        const loc = this.resolveTargetLocation(target);
        if (!loc) { return []; }
        return [{ kind: 'targetCmake', target, filePath: loc.file, line: loc.line }];
    }

    // ------------------------------------------------------------
    // Target sections
    // ------------------------------------------------------------

    private sectionChildren(node: SectionNode): TreeNode[] {
        switch (node.sectionId) {
            case 'cmakeExtras': return this.extrasNodes(node.target);
            default: return [];
        }
    }

    // ------------------------------------------------------------
    // Source tree
    // ------------------------------------------------------------

    private buildSourceTree(target: Target): TreeNode[] {
        const hasSG = (target.sourceGroups?.length ?? 0) > 0;
        return hasSG
            ? this.buildTreeFromSourceGroups(target)
            : this.buildTreeFromPaths(target);
    }

    private buildTreeFromSourceGroups(target: Target): TreeNode[] {
        const folderMap = new Map<string, VirtualFolderNode>();

        const getOrCreate = (groupPath: string): VirtualFolderNode => {
            const normalized = groupPath.replace(/\\/g, '/');
            if (folderMap.has(normalized)) { return folderMap.get(normalized)!; }
            const parts = normalized.split('/').filter(Boolean);
            const name = parts.at(-1) ?? normalized;
            const node: VirtualFolderNode = { kind: 'virtualFolder', name, fullPath: normalized, sources: [], subFolders: [], target };
            folderMap.set(normalized, node);
            if (parts.length > 1) {
                const parentPath = parts.slice(0, -1).join('/');
                const parent = getOrCreate(parentPath);
                if (!parent.subFolders.includes(node)) { parent.subFolders.push(node); }
            }
            return node;
        };

        const rootSources: SourceNode[] = [];

        for (const sg of target.sourceGroups ?? []) {
            for (const idx of sg.sourceIndexes) {
                const source = target.sources[idx];
                const compileGroup = source.compileGroupIndex !== undefined
                    ? target.compileGroups?.[source.compileGroupIndex] : undefined;
                if (sg.name) {
                    getOrCreate(sg.name).sources.push({ source, compileGroup });
                } else {
                    rootSources.push({ kind: 'source', target, source, compileGroup });
                }
            }
        }

        const roots = [...folderMap.values()].filter(f => !f.fullPath.includes('/'));
        roots.sort((a, b) => a.name.localeCompare(b.name));
        return [...roots, ...rootSources];
    }

    private buildTreeFromPaths(target: Target): TreeNode[] {
        const folderMap = new Map<string, VirtualFolderNode>();

        const getOrCreate = (dirPath: string): VirtualFolderNode => {
            if (folderMap.has(dirPath)) { return folderMap.get(dirPath)!; }
            const parts = dirPath.replace(/\\/g, '/').split('/').filter(Boolean);
            const name = parts.at(-1) ?? dirPath;
            const node: VirtualFolderNode = { kind: 'virtualFolder', name, fullPath: dirPath, sources: [], subFolders: [], target };
            folderMap.set(dirPath, node);
            if (parts.length > 1) {
                const parentPath = parts.slice(0, -1).join('/');
                const parent = getOrCreate(parentPath);
                if (!parent.subFolders.includes(node)) { parent.subFolders.push(node); }
            }
            return node;
        };

        const rootSources: SourceNode[] = [];

        for (const source of target.sources ?? []) {
            const compileGroup = source.compileGroupIndex !== undefined
                ? target.compileGroups?.[source.compileGroupIndex] : undefined;
            const normalized = source.path.replace(/\\/g, '/');
            const lastSlash = normalized.lastIndexOf('/');

            if (lastSlash <= 0) {
                rootSources.push({ kind: 'source', target, source, compileGroup });
            } else {
                const dirPath = normalized.substring(0, lastSlash);
                getOrCreate(dirPath).sources.push({ source, compileGroup });
            }
        }

        const roots = [...folderMap.values()].filter(f => !f.fullPath.replace(/\\/g, '/').includes('/'));
        roots.sort((a, b) => a.name.localeCompare(b.name));
        return [...roots, ...rootSources];
    }

    private virtualFolderChildren(node: VirtualFolderNode): TreeNode[] {
        const subFolders = node.subFolders.sort((a, b) => a.name.localeCompare(b.name));
        const sources = node.sources.map(({ source, compileGroup }) => ({
            kind: 'source' as const, target: node.target, source, compileGroup,
        }));
        return [...subFolders, ...sources];
    }

    // ------------------------------------------------------------
    // CMake Extras
    // ------------------------------------------------------------

    private extrasNodes(target: Target): TreeNode[] {
        const groups: TreeNode[] = [];

        const extras: { id: ExtrasId; label: string; icon: string; show: boolean }[] = [
            { id: 'includes', label: 'Include Dirs', icon: 'file-symlink-directory', show: this.hasIncludes(target) },
            { id: 'compileFlags', label: 'Compile Flags', icon: 'symbol-operator', show: this.hasCompileFlags(target) },
            { id: 'linkFlags', label: 'Link Flags', icon: 'link', show: this.hasLinkFlags(target) },
            { id: 'libraries', label: 'Libraries', icon: 'references', show: this.hasLibraries(target) },
            { id: 'directLinks', label: 'Direct Links', icon: 'type-hierarchy', show: (target.directLinks?.length ?? 0) > 0 },
        ];
        for (const g of extras) {
            if (g.show) {
                groups.push({ kind: 'extrasGroup' as const, label: g.label, icon: g.icon, target, extrasId: g.id });
            }
        }

        return groups;
    }

    private extrasGroupChildren(node: ExtrasGroupNode): TreeNode[] {
        switch (node.extrasId) {
            case 'includes': return this.includeNodes(node.target);
            case 'compileFlags': return this.compileFlagNodes(node.target);
            case 'linkFlags': return this.linkFlagNodes(node.target);
            case 'libraries': return this.libraryNodes(node.target);
            case 'directLinks': return this.directLinkNodes(node.target);
        }
    }

    // ------------------------------------------------------------
    // Includes
    // ------------------------------------------------------------

    private includeNodes(target: Target): IncludeNode[] {
        const seen = new Set<string>();
        const result: IncludeNode[] = [];
        for (const cg of target.compileGroups ?? []) {
            for (const inc of cg.includes ?? []) {
                if (!seen.has(inc.path)) {
                    seen.add(inc.path);
                    result.push({ kind: 'include', target, path: inc.path, isSystem: inc.isSystem ?? false });
                }
            }
        }
        return result;
    }

    // ------------------------------------------------------------
    // Compile flags
    // ------------------------------------------------------------

    private compileFlagNodes(target: Target): FlagNode[] {
        const seen = new Set<string>();
        const result: FlagNode[] = [];
        for (const cg of target.compileGroups ?? []) {
            for (const f of cg.compileCommandFragments ?? []) {
                const text = f.fragment.trim();
                if (text && !seen.has(text)) { seen.add(text); result.push({ kind: 'flag', target, text }); }
            }
            for (const d of cg.defines ?? []) {
                const text = `-D${d.define}`;
                if (!seen.has(text)) { seen.add(text); result.push({ kind: 'flag', target, text }); }
            }
        }
        return result;
    }

    // ------------------------------------------------------------
    // Link flags
    // ------------------------------------------------------------

    private linkFlagNodes(target: Target): FlagNode[] {
        return (target.link?.commandFragments ?? [])
            .filter(f => f.role === 'flags')
            .map(f => ({ kind: 'flag' as const, target, text: f.fragment.trim() }))
            .filter(f => f.text.length > 0);
    }

    // ------------------------------------------------------------
    // Libraries
    // ------------------------------------------------------------

    private libraryNodes(target: Target): LibNode[] {
        return (target.link?.commandFragments ?? [])
            .filter(f => f.role === 'libraries' || f.role === 'libraryPath')
            .map(f => ({ kind: 'library' as const, target, fragment: f.fragment.trim(), role: f.role }))
            .filter(n => n.fragment.length > 0);
    }

    // ------------------------------------------------------------
    // Direct Links
    // ------------------------------------------------------------

    private directLinkNodes(target: Target): DirectLinkNode[] {
        return (target.directLinks ?? [])
            .map(link => this.targetMap.get(link))
            .filter((t): t is Target => t !== undefined)
            .map(t => ({ kind: 'directLink' as const, target: t }));
    }

    // ------------------------------------------------------------
    // TreeItems
    // ------------------------------------------------------------

    private outlineFilterItem(): vscode.TreeItem {
        const label = this.filter
            ? `Filter: ${this.filter}`
            : 'Filter: (none)';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('search');
        item.contextValue = this.filter ? 'outlineFilterActive' : 'outlineFilter';
        item.command = {
            command: 'CMakeGraph.filterOutline',
            title: 'Filter',
        };
        return item;
    }

    private projectItem(node: ProjectNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `project:${node.name}`;
        item.iconPath = new vscode.ThemeIcon('project');
        item.contextValue = 'outlineProject';
        return item;
    }

    private rootFileItem(node: RootFileNode): vscode.TreeItem {
        const uri = vscode.Uri.file(node.filePath);
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `rootFile:${node.target?.id ?? 'root'}:${node.label}`;
        item.resourceUri = uri;
        item.contextValue = 'outlineRootFile';
        item.command = { command: 'CMakeGraph.openFile', title: 'Open', arguments: [uri] };
        return item;
    }

    private folderItem(node: FolderNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `folder:${node.fullPath}`;
        item.resourceUri = vscode.Uri.file(path.join('/', node.name));
        item.description = `${node.subFolders.length + node.targets.length}`;
        item.contextValue = 'outlineFolder';
        return item;
    }

    private targetItem(node: TargetNode): vscode.TreeItem {
        const t = node.target;
        const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `target:${t.id}`;
        item.iconPath = new vscode.ThemeIcon(TARGET_ICONS[t.type] ?? 'circle-outline');
        item.description = t.type;
        item.contextValue = `outlineTarget_${t.type}`;
        item.tooltip = this.targetTooltip(t);
        return item;
    }

    private targetCmakeItem(node: TargetCmakeNode): vscode.TreeItem {
        const uri = vscode.Uri.file(node.filePath);
        const item = new vscode.TreeItem('CMakeLists.txt', vscode.TreeItemCollapsibleState.None);
        item.id = `targetCmake:${node.target.id}`;
        item.resourceUri = uri;
        item.description = `line ${node.line}`;
        item.contextValue = 'outlineTargetCmake';
        item.command = {
            command: 'CMakeGraph.openLocation',
            title: 'Open',
            arguments: [node.filePath, node.line],
        };
        return item;
    }

    private sectionItem(node: SectionNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `section:${node.sectionId}:${node.target.id}`;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.resourceUri = vscode.Uri.file(node.label);
        item.contextValue = `outlineSection_${node.sectionId}_${node.target.name}`;
        return item;
    }

    private extrasGroupItem(node: ExtrasGroupNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `extras:${node.extrasId}:${node.target.id}`;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.resourceUri = vscode.Uri.file(node.label);
        item.contextValue = `outlineExtras_${node.extrasId}_${node.target.name}`;
        return item;
    }

    private virtualFolderItem(node: VirtualFolderNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `vfolder:${node.target.id}:${node.fullPath}`;
        item.resourceUri = vscode.Uri.file(path.join('/', node.name));
        item.contextValue = 'outlineVirtualFolder';
        return item;
    }

    private absSourcePath(target: Target, sourcePath: string): string {
        const isAbs = /^([a-zA-Z]:[\\/]|\/)/.test(sourcePath);
        if (isAbs) { return path.normalize(sourcePath); }
        return path.normalize(path.join(this.projectSourceDir, sourcePath));
    }

    private sourceItem(target: Target, source: Source, compileGroup?: CompileGroup): vscode.TreeItem {
        const absPath = this.absSourcePath(target, source.path);
        const uri = vscode.Uri.file(absPath);
        const item = new vscode.TreeItem(path.basename(absPath), vscode.TreeItemCollapsibleState.None);
        item.id = `source:${target.id}:${source.path}`;
        item.resourceUri = uri;
        item.command = { command: 'CMakeGraph.openFile', title: 'Open', arguments: [uri] };
        item.tooltip = this.sourceTooltip(absPath, compileGroup);
        item.contextValue = `outlineSource_${target.name}`;

        const parts: string[] = [];
        if (compileGroup?.language) { parts.push(compileGroup.language); }
        if (source.isGenerated) { parts.push('generated'); }
        if (parts.length) { item.description = parts.join(' · '); }
        return item;
    }

    // Render items also for copy-click
    private includeItem(node: IncludeNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.path, vscode.TreeItemCollapsibleState.None);
        item.id = `include:${node.target.id}:${node.path}`;
        item.iconPath = new vscode.ThemeIcon('folder');
        item.resourceUri = vscode.Uri.file(node.path);
        item.description = node.isSystem ? 'system' : '';
        item.tooltip = node.path;
        item.contextValue = 'outlineCopyable';
        return item;
    }

    private flagItem(node: FlagNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('symbol-field');
        item.resourceUri = vscode.Uri.file(node.text);
        item.tooltip = node.text;
        item.contextValue = 'outlineCopyable';
        return item;
    }

    private cmakeFileItem(node: CmakeFileNode): vscode.TreeItem {
        const uri = vscode.Uri.file(node.path);
        const item = new vscode.TreeItem(path.basename(node.path), vscode.TreeItemCollapsibleState.None);
        item.resourceUri = uri;
        item.command = { command: 'CMakeGraph.openFile', title: 'Open', arguments: [uri] };
        item.contextValue = 'outlineCmakeFile';
        return item;
    }

    private directLinkItem(node: DirectLinkNode): vscode.TreeItem {
        const t = node.target;
        const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(TARGET_ICONS[t.type] ?? 'symbol-method');
        item.description = t.type;
        item.tooltip = `Direct Link: ${t.name} (${t.type})`;
        item.contextValue = 'outlineDirectLink';
        return item;
    }

    private libItem(node: LibNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.fragment, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.role === 'libraryPath' ? 'folder' : 'references');
        item.description = node.role;
        item.tooltip = node.fragment;
        item.contextValue = 'outlineCopyable';
        return item;
    }

    // ------------------------------------------------------------
    // Tooltips
    // ------------------------------------------------------------

    private targetTooltip(t: Target): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${t.name}** \`${t.type}\`\n\n`);
        const loc = this.resolveTargetLocation(t);
        if (loc) { md.appendMarkdown(`Defined in: \`${loc.file}:${loc.line}\`\n\n`); }
        if (t.nameOnDisk) { md.appendMarkdown(`File: \`${t.nameOnDisk}\`\n\n`); }
        if (t.artifacts?.length) {
            md.appendMarkdown(`Artifacts:\n`);
            for (const a of t.artifacts) { md.appendMarkdown(`- \`${a.path}\`\n`); }
        }
        return md;
    }

    private sourceTooltip(absPath: string, cg?: CompileGroup): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`\`${absPath}\`\n\n`);
        if (cg) {
            if (cg.language) { md.appendMarkdown(`Language: **${cg.language}**\n\n`); }
            if (cg.languageStandard) { md.appendMarkdown(`Standard: **${cg.languageStandard.standard}**\n\n`); }
            if (cg.defines?.length) {
                md.appendMarkdown(`Defines:\n`);
                for (const d of cg.defines) { md.appendMarkdown(`- \`${d.define}\`\n`); }
            }
        }
        return md;
    }

    // ------------------------------------------------------------
    // Target location resolution
    // ------------------------------------------------------------

    private resolveTargetLocation(t: Target): { file: string; line: number } | null {
        const graph = t.backtraceGraph;
        if (!graph || t.backtrace === undefined) { return null; }
        const node = graph.nodes[t.backtrace];
        if (!node) { return null; }
        const file = graph.files[node.file];
        if (!file) { return null; }
        const isAbs = /^([a-zA-Z]:[\\/]|\/)/.test(file);
        const absFile = isAbs ? file : path.join(this.projectSourceDir, file);
        return { file: absFile, line: node.line ?? 1 };
    }

    // ------------------------------------------------------------
    // Search for a target node by id (for reveal)
    // ------------------------------------------------------------

    findTargetNode(targetId: string): TreeNode | null {
        const search = (nodes: TreeNode[]): TreeNode | null => {
            for (const n of nodes) {
                if (n.kind === 'target' && n.target.id === targetId) { return n; }
                if (n.kind === 'folder' || n.kind === 'project') {
                    // Force getChildren to populate cache/parentMap
                    const children = this.getChildren(n);
                    const found = search(children);
                    if (found) { return found; }
                }
            }
            return null;
        };
        return search(this.rootNodes);
    }

    // ------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------

    private hasIncludes(t: Target): boolean {
        return (t.compileGroups ?? []).some(cg => (cg.includes?.length ?? 0) > 0);
    }

    private hasCompileFlags(t: Target): boolean {
        return (t.compileGroups ?? []).some(
            cg => (cg.compileCommandFragments?.length ?? 0) > 0 || (cg.defines?.length ?? 0) > 0
        );
    }

    private hasLinkFlags(t: Target): boolean {
        return (t.link?.commandFragments ?? []).some(f => f.role === 'flags');
    }

    private hasLibraries(t: Target): boolean {
        return (t.link?.commandFragments ?? []).some(
            f => f.role === 'libraries' || f.role === 'libraryPath'
        );
    }

    private hasAnyExtras(t: Target): boolean {
        return this.hasIncludes(t)
            || this.hasCompileFlags(t)
            || this.hasLinkFlags(t)
            || this.hasLibraries(t)
            || (t.dependencies?.length ?? 0) > 0;
    }
}
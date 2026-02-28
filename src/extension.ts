import * as vscode from 'vscode';
import * as path from 'path';
import { ApiClient, CmakeReply } from './cmake/api_client';
import { Runner } from './cmake/runner';
import { ReplyWatcher } from './watchers/reply_watcher';
import { ProjectOutlineProvider } from './providers/project_outline_provider';
import { ConfigProvider } from './providers/config_provider';
import { CacheEntry, CtestShowOnlyResult } from './cmake/types';
import { CMakeDiagnosticsManager } from './cmake/cmake_diagnostics_manager';
import { CMakeFileDecorationProvider } from './providers/cmake_file_decoration_provider';
import { ImpactedTargetsProvider } from './providers/impacted_targets_provider';
import { DependencyGraphProvider } from './providers/dependency_graph_provider';
import { CMakeToolsIntegrationManager } from './misc/cmake_tools_api';
import { computeDirectLinks } from './cmake/direct_links_converter';
import { debugDirectLinks, debugMissingLinks, debugSignatures } from './cmake/debug_direct_links';
// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
interface CtestInfo {
    name: string;
    command: string[];
}

// ------------------------------------------------------------
// Global State
// ------------------------------------------------------------
let runner: Runner | null = null;
let apiClient: ApiClient | null = null;
let replyWatcher: ReplyWatcher | null = null;
let outlineProvider: ProjectOutlineProvider | null = null;
let configProvider: ConfigProvider | null = null;
let impactedProvider: ImpactedTargetsProvider | null = null;
let graphProvider: DependencyGraphProvider | null = null;
let configView: vscode.TreeView<unknown> | null = null;
let outlineView: vscode.TreeView<unknown> | null = null;
let impactedView: vscode.TreeView<unknown> | null = null;
let lastReply: CmakeReply | null = null;
let buildDir: string | null = null;
let currentConfig: string = 'Release';
let availableConfigs: string[] = [];
let taskStatusBar: vscode.StatusBarItem | null = null;
let wsState: vscode.Memento | null = null;

const BUILD_DIR_STATE_KEY = 'CMakeGraph.buildDir';
const ACTIVE_CONFIG_STATE_KEY = 'CMakeGraph.activeConfig';

// ------------------------------------------------------------
// Activation
// ------------------------------------------------------------
export async function activate(context: vscode.ExtensionContext): Promise<void> {

    const diagnosticsManager = new CMakeDiagnosticsManager();
    const fileDecorationProvider = new CMakeFileDecorationProvider(diagnosticsManager);
    context.subscriptions.push(diagnosticsManager, fileDecorationProvider);

    runner = new Runner(context.workspaceState, diagnosticsManager);

    // Status bar — running tasks
    taskStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    taskStatusBar.command = 'CMakeGraph.cancelTask';
    taskStatusBar.hide();
    context.subscriptions.push(taskStatusBar);

    runner.onTasksChanged(tasks => {
        if (!taskStatusBar) { return; }
        if (tasks.length === 0) {
            taskStatusBar.hide();
        } else {
            taskStatusBar.text = `$(sync~spin) CMakeGraph: ${tasks.length} task${tasks.length > 1 ? 's' : ''} running`;
            taskStatusBar.tooltip = tasks.map(t => t.label).join('\n');
            taskStatusBar.show();
        }
    }, null, context.subscriptions);

    wsState = context.workspaceState;

    outlineProvider = new ProjectOutlineProvider();
    configProvider = new ConfigProvider();
    impactedProvider = new ImpactedTargetsProvider();

    outlineView = vscode.window.createTreeView('CMakeGraphOutline', {
        treeDataProvider: outlineProvider,
        showCollapseAll: true,
        canSelectMany: true,
    });

    configView = vscode.window.createTreeView('CMakeGraphConfig', {
        treeDataProvider: configProvider,
        showCollapseAll: false,
    });

    impactedView = vscode.window.createTreeView('CMakeGraphImpacted', {
        treeDataProvider: impactedProvider,
        showCollapseAll: false,
    });

    graphProvider = new DependencyGraphProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            DependencyGraphProvider.viewId,
            graphProvider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );

    // Update impacted targets when active editor changes
    impactedProvider.setActiveFile(
        vscode.window.activeTextEditor?.document.uri.fsPath ?? null
    );
    vscode.window.onDidChangeActiveTextEditor(editor => {
        impactedProvider!.setActiveFile(editor?.document.uri.fsPath ?? null);
    }, null, context.subscriptions);

    const cmds: [string, (...args: unknown[]) => unknown][] = [
        ['CMakeGraph.cancelTask', () => cmdCancelTask()],
        ['CMakeGraph.selectBuildDir', () => cmdSelectBuildDir(context)],
        ['CMakeGraph.selectConfig', cmdSelectConfig],
        ['CMakeGraph.build', cmdBuild],
        ['CMakeGraph.buildTarget', cmdBuildTarget],
        ['CMakeGraph.rebuildTarget', (node: unknown) => cmdRebuildTarget(node)],
        ['CMakeGraph.buildImpactedSection', (node: unknown) => cmdBuildImpactedSection(node)],
        ['CMakeGraph.rebuildImpactedSection', (node: unknown) => cmdRebuildImpactedSection(node)],
        ['CMakeGraph.expandAllImpacted', cmdExpandAllImpacted],
        ['CMakeGraph.collapseAllImpacted', cmdCollapseAllImpacted],
        ['CMakeGraph.filterImpacted', cmdFilterImpacted],
        ['CMakeGraph.clearFilterImpacted', cmdClearFilterImpacted],
        ['CMakeGraph.testImpactedTarget', (node: unknown) => cmdTestImpactedTarget(node)],
        ['CMakeGraph.testImpactedSection', (node: unknown) => cmdTestImpactedSection(node)],
        ['CMakeGraph.filterOutline', cmdFilterOutline],
        ['CMakeGraph.clearFilterOutline', cmdClearFilterOutline],
        ['CMakeGraph.expandAllOutline', cmdExpandAllOutline],
        ['CMakeGraph.clean', cmdClean],
        ['CMakeGraph.test', cmdTest],
        ['CMakeGraph.refresh', cmdRefresh],
        ['CMakeGraph.refreshOutline', cmdRefresh],
        ['CMakeGraph.refreshConfig', cmdRefresh],
        ['CMakeGraph.refreshImpacted', cmdRefresh],
        ['CMakeGraph.editCacheEntry', (e: unknown) => cmdEditCacheEntry(e as CacheEntry)],
        ['CMakeGraph.filterConfig', cmdFilterConfig],
        ['CMakeGraph.clearFilterConfig', cmdClearFilterConfig],
        ['CMakeGraph.expandAllConfig', cmdExpandAllConfig],
        ['CMakeGraph.collapseAllConfig', cmdCollapseAllConfig],
        ['CMakeGraph.openFile', (uri: unknown) => cmdOpenFile(uri as vscode.Uri)],
        ['CMakeGraph.openLocation', (file: unknown, line: unknown) => cmdOpenLocation(file as string, line as number)],
        ['CMakeGraph.copyToClipboard', (...args: unknown[]) => cmdCopyToClipboard(args)],
        ['CMakeGraph.copySectionToClipboard', (...args: unknown[]) => cmdCopySectionToClipboard(args)],
        ['CMakeGraph.revealDependency', (node: unknown) => cmdRevealDependency(node)],
        ['CMakeGraph.openSettings', cmdOpenSettings],
        ['CMakeGraph.toggleGraphLayout', () => graphProvider?.toggleLayout()],
        ['CMakeGraph.refreshDependencyGraph', cmdRefresh],
        ['CMakeGraph.graphSettings', () => graphProvider?.showSettings()],
        ['CMakeGraph.graphScreenshot', () => graphProvider?.screenshot()],
    ];

    for (const [id, handler] of cmds) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    context.subscriptions.push(outlineView, configView, impactedView, runner);

    const cmakeManager = new CMakeToolsIntegrationManager((buildDir, buildType) => {
        initBuildDir(buildDir, context);
        updateAllPanesWithConfig(buildType);
        console.log(`CMake new configure on ${buildDir} with Build Type : ${buildType}`);
    });
    cmakeManager.watch(context);
    context.subscriptions.push(cmakeManager);

    // Restore persisted config
    currentConfig = wsState.get<string>(ACTIVE_CONFIG_STATE_KEY) || 'Release';

    // ── Initialize buildDir ──
    const cfg = vscode.workspace.getConfiguration('CMakeGraph');
    const savedBuild = resolveSettingPath(cfg.get<string>('buildDir'))
        || wsState.get<string>(BUILD_DIR_STATE_KEY)
        || null;
    if (savedBuild) {
        await initBuildDir(savedBuild, context);
    }
}

// ------------------------------------------------------------
// Deactivation
// ------------------------------------------------------------
export function deactivate(): void {
    replyWatcher?.dispose();
}

// ------------------------------------------------------------
// Init buildDir
// ------------------------------------------------------------
async function initBuildDir(dir: string, context: vscode.ExtensionContext): Promise<void> {
    replyWatcher?.dispose();
    buildDir = dir;
    wsState?.update(BUILD_DIR_STATE_KEY, dir);
    apiClient = new ApiClient(dir);

    await apiClient.writeQueries();

    replyWatcher = new ReplyWatcher(dir);
    replyWatcher.onDidReply(loadReply, null, context.subscriptions);
    context.subscriptions.push(replyWatcher);

    if (await apiClient.hasReply()) {
        await loadReply();
    } else {
        vscode.window.showInformationMessage(
            'CMakeGraph: build dir configured. Waiting for CMake reply files.'
        );
    }
}

// ------------------------------------------------------------
// Load reply
// ------------------------------------------------------------
async function loadReply(): Promise<void> {
    if (!apiClient) { return; }
    try {
        lastReply = await apiClient.loadApiFiles();

        // compute direct links of targets
        // debugDirectLinks(lastReply);
        // debugMissingLinks(lastReply);
        // debugSignatures(lastReply);
        lastReply = computeDirectLinks(lastReply);

        // Detect available configurations
        availableConfigs = lastReply.codemodel.configurations.map(c => c.name || '(default)');
        currentConfig = detectConfig();

        // Show/hide config selector button based on multi-config
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.multiConfig', availableConfigs.length > 1);

        outlineProvider!.refresh(
            lastReply.codemodel,
            lastReply.targets,
            currentConfig
        );

        configProvider!.refresh(lastReply.cache);

        // Derive sourceDir from codemodel paths
        const src = lastReply.codemodel.paths?.source || '';
        impactedProvider!.refresh(lastReply.targets, src);

        graphProvider?.refresh(lastReply.targets);

        await refreshAvailableTests();

    } catch (err) {
        vscode.window.showErrorMessage(
            `CMakeGraph: reply read error — ${(err as Error).message}`
        );
    }
}

// ------------------------------------------------------------
// Config detection
// ------------------------------------------------------------
function detectConfig(): string {
    if (availableConfigs.length === 0) { return 'Release'; }
    if (availableConfigs.length === 1) { return availableConfigs[0]; }
    // Multi-config: use persisted selection if still valid
    const persisted = wsState?.get<string>(ACTIVE_CONFIG_STATE_KEY);
    if (persisted && availableConfigs.includes(persisted)) { return persisted; }
    return availableConfigs[0];
}

// ------------------------------------------------------------
// Commands — config selection
// ------------------------------------------------------------
async function cmdSelectConfig(): Promise<void> {
    if (!availableConfigs.length) {
        vscode.window.showWarningMessage('CMakeGraph: no configurations available. Load a build directory first.');
        return;
    }
    const items = availableConfigs.map(c => ({
        label: c,
        description: c === currentConfig ? '(current)' : '',
    }));
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select the active configuration',
    });
    if (!picked) { return; }
    updateAllPanesWithConfig(picked.label);
}

async function updateAllPanesWithConfig(config: string): Promise<void> {
    currentConfig = config;
    wsState?.update(ACTIVE_CONFIG_STATE_KEY, currentConfig);
    if (lastReply) {
        outlineProvider!.refresh(
            lastReply.codemodel,
            lastReply.targets,
            currentConfig
        );
        configProvider!.refresh(lastReply.cache);
        const src = lastReply.codemodel.paths?.source || '';
        impactedProvider!.refresh(lastReply.targets, src);

        graphProvider?.refresh(lastReply.targets);
    }

}

// ------------------------------------------------------------
// Commands — actions
// ------------------------------------------------------------

async function cmdSelectBuildDir(context: vscode.ExtensionContext): Promise<void> {
    const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Select build folder',
    });
    if (!folders?.length) { return; }
    const dir = folders[0].fsPath;
    await vscode.workspace.getConfiguration('CMakeGraph').update(
        'buildDir', dir, vscode.ConfigurationTarget.Workspace
    );
    await initBuildDir(dir, context);
}

function getCmakePath(): string {
    return resolveSettingPath(vscode.workspace.getConfiguration('CMakeGraph').get<string>('cmakePath')) || '';
}

function getCtestPath(): string {
    return resolveSettingPath(vscode.workspace.getConfiguration('CMakeGraph').get<string>('ctestPath')) || '';
}

function getDefaultJobs(): number {
    return vscode.workspace.getConfiguration('CMakeGraph').get<number>('defaultJobs', 0);
}

async function cmdBuild(): Promise<void> {
    if (!runner || !buildDir) {
        vscode.window.showWarningMessage('CMakeGraph: select a build folder first.');
        return;
    }
    const cmakePath = getCmakePath();
    const jobs = getDefaultJobs();
    const result = await runner.build(buildDir, undefined, currentConfig || undefined, undefined, cmakePath, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: build failed (code ${result.code})`);
    }
}

async function cmdBuildTarget(node?: unknown): Promise<void> {
    if (!runner || !buildDir) { return; }
    let targetName: string | undefined;
    if (node && typeof node === 'object' && 'kind' in node) {
        const kind = (node as { kind: string }).kind;
        if (kind === 'target' || kind === 'impactedTarget') {
            targetName = (node as unknown as { target: { name: string } }).target.name;
        }
    }
    if (!targetName) {
        targetName = await pickTarget();
    }
    if (!targetName) { return; }
    const cmakePath = getCmakePath();
    const jobs = getDefaultJobs();
    const result = await runner.build(buildDir, targetName, currentConfig || undefined, undefined, cmakePath, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: build of '${targetName}' failed (code ${result.code})`);
    }
}

async function cmdRebuildTarget(node?: unknown): Promise<void> {
    if (!runner || !buildDir) { return; }
    let targetName: string | undefined;
    if (node && typeof node === 'object' && 'kind' in node) {
        const kind = (node as { kind: string }).kind;
        if (kind === 'target' || kind === 'impactedTarget') {
            targetName = (node as unknown as { target: { name: string } }).target.name;
        }
    }
    if (!targetName) {
        targetName = await pickTarget();
    }
    if (!targetName) { return; }
    const cmakePath = getCmakePath();
    const result = await runner.cleanAndBuildTargets(buildDir, [targetName], currentConfig || undefined, cmakePath);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: rebuild of '${targetName}' failed (code ${result.code})`);
    }
}

async function cmdBuildImpactedSection(node?: unknown): Promise<void> {
    if (!runner || !buildDir) { return; }
    const targets = extractSectionTargetNames(node);
    if (!targets.length) { return; }
    const cmakePath = getCmakePath();
    const jobs = getDefaultJobs();
    const result = await runner.buildTargets(buildDir, targets, currentConfig || undefined, cmakePath, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: build of section failed (code ${result.code})`);
    }
}

async function cmdRebuildImpactedSection(node?: unknown): Promise<void> {
    if (!runner || !buildDir) { return; }
    const targets = extractSectionTargetNames(node);
    if (!targets.length) { return; }
    const cmakePath = getCmakePath();
    const jobs = getDefaultJobs();
    const result = await runner.cleanAndBuildTargets(buildDir, targets, currentConfig || undefined, cmakePath, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: rebuild of section failed (code ${result.code})`);
    }
}

function extractSectionTargetNames(node: unknown): string[] {
    if (!node || typeof node !== 'object') { return []; }
    if (!('kind' in node) || (node as { kind: string }).kind !== 'impactedSection') { return []; }
    const section = node as { targets?: { name: string }[] };
    return (section.targets ?? []).map(t => t.name);
}

async function cmdExpandAllImpacted(): Promise<void> {
    if (!impactedProvider || !impactedView) { return; }
    const roots = impactedProvider.getChildren();
    for (const node of roots) {
        if ('kind' in node && node.kind === 'impactedSection') {
            await (impactedView as vscode.TreeView<unknown>).reveal(node, {
                expand: true, select: false, focus: false,
            });
        }
    }
}

async function cmdCollapseAllImpacted(): Promise<void> {
    await vscode.commands.executeCommand('workbench.actions.treeView.CMakeGraphImpacted.collapseAll');
}

async function cmdFilterImpacted(): Promise<void> {
    if (!impactedProvider) { return; }
    const current = impactedProvider.currentFilter;
    const input = await vscode.window.showInputBox({
        title: 'Filter impacted targets',
        prompt: 'Search by target name or type',
        value: current,
        placeHolder: 'e.g.: mylib, EXECUTABLE, test...',
    });
    if (input === undefined) { return; }
    if (input === '') {
        impactedProvider.clearFilter();
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.impactedFilterActive', false);
    } else {
        impactedProvider.setFilter(input);
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.impactedFilterActive', true);
    }
}

async function cmdClearFilterImpacted(): Promise<void> {
    if (!impactedProvider) { return; }
    impactedProvider.clearFilter();
    await vscode.commands.executeCommand('setContext', 'CMakeGraph.impactedFilterActive', false);
}

// ------------------------------------------------------------
// Impacted — test commands
// ------------------------------------------------------------

async function cmdTestImpactedTarget(node?: unknown): Promise<void> {
    if (!runner || !buildDir) { return; }
    if (!node || typeof node !== 'object' || !('kind' in node)) { return; }
    if ((node as { kind: string }).kind !== 'impactedTarget') { return; }
    const targetName = (node as unknown as { target: { name: string } }).target.name;
    const ctestPath = getCtestPath();
    const jobs = getDefaultJobs();
    const regex = impactedProvider?.isTestTarget(targetName)
        ? impactedProvider.getTestRegex(targetName)
        : escapeRegex(targetName);
    const result = await runner.testByRegex(buildDir, regex, currentConfig || undefined, ctestPath, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: test '${targetName}' failed (code ${result.code})`);
    }
}

async function cmdTestImpactedSection(node?: unknown): Promise<void> {
    if (!runner || !buildDir) { return; }
    if (!node || typeof node !== 'object') { return; }
    const sectionId = (node as { sectionId?: string }).sectionId;
    const targets = extractSectionTargetNames(node);
    if (!targets.length) { return; }
    const ctestPath = getCtestPath();
    const jobs = getDefaultJobs();
    const regex = sectionId === 'tests' && impactedProvider
        ? impactedProvider.getTestSectionRegex(targets)
        : targets.map(n => escapeRegex(n)).join('|');
    const result = await runner.testByRegex(buildDir, regex, currentConfig || undefined, ctestPath, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: tests failed (code ${result.code})`);
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------------------------------------------------
// Outline — filter & expand
// ------------------------------------------------------------

async function cmdFilterOutline(): Promise<void> {
    if (!outlineProvider) { return; }
    const current = outlineProvider.currentFilter;
    const input = await vscode.window.showInputBox({
        title: 'Filter outline targets',
        prompt: 'Search by target name or type',
        value: current,
        placeHolder: 'e.g.: mylib, EXECUTABLE, test...',
    });
    if (input === undefined) { return; }
    if (input === '') {
        outlineProvider.clearFilter();
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.outlineFilterActive', false);
    } else {
        outlineProvider.setFilter(input);
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.outlineFilterActive', true);
    }
}

async function cmdClearFilterOutline(): Promise<void> {
    if (!outlineProvider) { return; }
    outlineProvider.clearFilter();
    await vscode.commands.executeCommand('setContext', 'CMakeGraph.outlineFilterActive', false);
}

async function cmdExpandAllOutline(): Promise<void> {
    if (!outlineProvider || !outlineView) { return; }
    const roots = outlineProvider.getChildren();
    for (const node of roots) {
        if (!('kind' in node)) { continue; }
        if (node.kind === 'project') {
            // Expand the project node and its children
            try {
                await (outlineView as vscode.TreeView<unknown>).reveal(node, {
                    expand: 2, select: false, focus: false,
                });
            } catch { /* node may not be revealable */ }
            for (const child of outlineProvider.getChildren(node)) {
                if ('kind' in child && (child.kind === 'folder' || child.kind === 'target')) {
                    try {
                        await (outlineView as vscode.TreeView<unknown>).reveal(child, {
                            expand: 2, select: false, focus: false,
                        });
                    } catch { /* node may not be revealable */ }
                }
            }
        }
    }
}

async function cmdClean(): Promise<void> {
    if (!runner || !buildDir) { return; }
    await runner.clean(buildDir);
}

// ------------------------------------------------------------
// Tests — discovery and execution
// ------------------------------------------------------------

let availableTests: CtestInfo[] = [];

async function refreshAvailableTests(): Promise<void> {
    if (!runner || !buildDir) { availableTests = []; return; }

    const ctestPath = getCtestPath();
    const result = await runner.listTests(buildDir, ctestPath);

    if (!result.success) {
        availableTests = [];
        impactedProvider?.setTestMap(new Map());
        return;
    }

    try {
        const json = JSON.parse(result.stdout) as CtestShowOnlyResult;
        availableTests = (json.tests ?? []).map(t => ({
            name: t.name,
            command: t.command ?? [],
        }));

        // Build targetName → testNames[] map from WORKING_DIRECTORY property.
        const buildPathToTarget = new Map<string, string>();
        if (lastReply && buildDir) {
            for (const t of lastReply.targets) {
                if (t.type === 'EXECUTABLE') {
                    const abs = path.isAbsolute(t.paths.build)
                        ? path.normalize(t.paths.build)
                        : path.normalize(path.join(buildDir, t.paths.build));
                    buildPathToTarget.set(abs.toLowerCase(), t.name);
                }
            }
        }
        const testsByTarget = new Map<string, string[]>();
        for (const t of json.tests ?? []) {
            const wdProp = t.properties?.find(p => p.name === 'WORKING_DIRECTORY');
            if (wdProp && typeof wdProp.value === 'string') {
                const normalizedWd = path.normalize(wdProp.value).toLowerCase();
                const targetName = buildPathToTarget.get(normalizedWd);
                if (targetName) {
                    let list = testsByTarget.get(targetName);
                    if (!list) {
                        list = [];
                        testsByTarget.set(targetName, list);
                    }
                    list.push(t.name);
                }
            }
        }
        impactedProvider?.setTestMap(testsByTarget);
    } catch {
        availableTests = [];
        impactedProvider?.setTestMap(new Map());
    }
}

async function cmdTest(): Promise<void> {
    if (!runner || !buildDir) {
        vscode.window.showWarningMessage('CMakeGraph: select a build folder first.');
        return;
    }
    const ctestPath = getCtestPath();
    const jobs = getDefaultJobs();
    const result = await runner.test(buildDir, currentConfig || undefined, undefined, ctestPath, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: test failed (code ${result.code})`);
    }
}

async function cmdCancelTask(): Promise<void> {
    if (!runner) { return; }
    const tasks = runner.getRunningTasks();
    if (!tasks.length) { return; }

    if (tasks.length === 1) {
        const ok = await vscode.window.showWarningMessage(
            `Cancel: ${tasks[0].label}?`,
            { modal: false },
            'Cancel task'
        );
        if (ok) { tasks[0].cancel(); }
        return;
    }

    const items = [
        { label: '$(stop-circle) Cancel all', description: `${tasks.length} tasks`, id: -1 },
        ...tasks.map(t => ({ label: `$(close) ${t.label}`, description: '', id: t.id })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a task to cancel',
    });
    if (!picked) { return; }
    if (picked.id === -1) {
        runner.cancelAll();
    } else {
        tasks.find(t => t.id === picked.id)?.cancel();
    }
}

async function cmdRefresh(): Promise<void> {
    await loadReply();
}

async function cmdOpenSettings(): Promise<void> {
    await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:aiekick.vscmake'
    );
}

/**
 * Switch between two cache-edit strategies:
 *  - false : write directly into CMakeCache.txt (no reconfigure)
 *  - true  : run cmake -D to reconfigure (classic behaviour)
 */
const EDIT_CACHE_VIA_CONFIGURE = true;

async function cmdEditCacheEntry(entry: CacheEntry): Promise<void> {
    if (!buildDir) { return; }
    let newValue: string | undefined;
    if (entry.type === 'BOOL') {
        newValue = await vscode.window.showQuickPick(['ON', 'OFF'], {
            title: entry.name,
            placeHolder: entry.properties.HELPSTRING ?? '',
        });
    } else if (entry.properties.STRINGS) {
        newValue = await vscode.window.showQuickPick(entry.properties.STRINGS.split(';'), {
            title: entry.name,
            placeHolder: entry.properties.HELPSTRING ?? '',
        });
    } else {
        newValue = await vscode.window.showInputBox({
            title: entry.name,
            prompt: entry.properties.HELPSTRING ?? '',
            value: entry.value,
        });
    }
    if (newValue === undefined || newValue === entry.value) { return; }

    if (EDIT_CACHE_VIA_CONFIGURE) {
        // ── Strategy A: reconfigure with cmake -D ──
        if (!runner) { return; }
        const src = lastReply?.codemodel.paths?.source || buildDir;
        const result = await runner.configure(src, buildDir, { [entry.name]: newValue });
        if (!result.success && !result.cancelled) {
            vscode.window.showErrorMessage(`CMakeGraph: reconfigure failed after modifying ${entry.name}`);
        }
    } else {
        // ── Strategy B: patch CMakeCache.txt directly ──
        const cachePath = path.join(buildDir, 'CMakeCache.txt');
        try {
            const fsP = await import('fs/promises');
            const content = await fsP.readFile(cachePath, 'utf-8');
            // Match the line:  NAME:TYPE=VALUE
            const regex = new RegExp(`^(${escapeRegex(entry.name)}:${escapeRegex(entry.type)}=)(.*)$`, 'm');
            if (!regex.test(content)) {
                vscode.window.showWarningMessage(`CMakeGraph: entry ${entry.name} not found in CMakeCache.txt`);
                return;
            }
            const updated = content.replace(regex, `$1${newValue}`);
            await fsP.writeFile(cachePath, updated, 'utf-8');
            vscode.window.showInformationMessage(`CMakeGraph: ${entry.name} set to ${newValue}`);

            // Update in-memory cache and refresh the config pane
            entry.value = newValue;
            if (lastReply) {
                configProvider!.refresh(lastReply.cache);
            }
        } catch (err) {
            vscode.window.showErrorMessage(
                `CMakeGraph: failed to update CMakeCache.txt — ${(err as Error).message}`
            );
        }
    }
}

async function cmdFilterConfig(): Promise<void> {
    if (!configProvider) { return; }
    const current = configProvider.currentFilter;
    const input = await vscode.window.showInputBox({
        title: 'Filter CMake variables',
        prompt: 'Search in name, value and description',
        value: current,
        placeHolder: 'e.g.: FOOBAR, CMAKE_CXX, path...',
    });
    if (input === undefined) { return; }
    if (input === '') {
        configProvider.clearFilter();
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.configFilterActive', false);
    } else {
        configProvider.setFilter(input);
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.configFilterActive', true);
    }
}

async function cmdClearFilterConfig(): Promise<void> {
    if (!configProvider) { return; }
    configProvider.clearFilter();
    await vscode.commands.executeCommand('setContext', 'CMakeGraph.configFilterActive', false);
}

async function cmdExpandAllConfig(): Promise<void> {
    if (!configProvider || !configView) { return; }
    for (const group of configProvider.getGroups()) {
        await (configView as vscode.TreeView<unknown>).reveal(group, {
            expand: true, select: false, focus: false,
        });
    }
}

async function cmdCollapseAllConfig(): Promise<void> {
    await vscode.commands.executeCommand('workbench.actions.treeView.CMakeGraphConfig.collapseAll');
}

async function cmdOpenFile(uri: vscode.Uri): Promise<void> {
    const safeUri = vscode.Uri.file(uri.fsPath);
    const existing = vscode.window.tabGroups.all
        .flatMap(g => g.tabs)
        .find(tab =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.fsPath === safeUri.fsPath
        );
    await vscode.window.showTextDocument(safeUri, { preview: !existing, preserveFocus: false });
}

async function cmdOpenLocation(file: string, line: number): Promise<void> {
    const uri = vscode.Uri.file(file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function cmdCopyToClipboard(args: unknown[]): Promise<void> {
    const nodes = Array.isArray(args[1]) && args[1].length > 0 ? args[1] : [args[0]];
    const texts = nodes.map((n: any) => extractNodeText(n)).filter(Boolean);
    if (!texts.length) { return; }
    const text = texts.join('\n');
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`CMakeGraph: ${texts.length} item${texts.length > 1 ? 's' : ''} copied`);
}

async function cmdCopySectionToClipboard(args: unknown[]): Promise<void> {
    const node = args[0] as any;
    if (!node || !outlineProvider) { return; }
    const children = outlineProvider.getChildren(node);
    const texts = children.map((n: any) => extractNodeText(n)).filter(Boolean);
    if (!texts.length) { return; }
    const text = texts.join('\n');
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`CMakeGraph: ${texts.length} item${texts.length > 1 ? 's' : ''} copied`);
}

function extractNodeText(node: any): string {
    if (!node || !node.kind) { return ''; }
    switch (node.kind) {
        case 'include': return node.path ?? '';
        case 'flag': return node.text ?? '';
        case 'library': return node.fragment ?? '';
        case 'directLink': return node.target?.name ?? '';
        case 'cmakefile': return node.path ?? '';
        case 'source': return node.source?.path ?? '';
        case 'rootFile': return node.filePath ?? '';
        case 'targetCmake': return `${node.filePath}:${node.line}`;
        default: return '';
    }
}

async function cmdRevealDependency(node: unknown): Promise<void> {
    if (!node || !outlineProvider || !outlineView) { return; }
    const dep = node as { kind: string; target?: { id: string } };
    if (dep.kind !== 'directLink' || !dep.target) { return; }
    const targetNode = outlineProvider.findTargetNode(dep.target.id);
    if (!targetNode) {
        vscode.window.showWarningMessage('CMakeGraph: target not found in outline.');
        return;
    }
    await outlineView.reveal(targetNode, { select: true, focus: true, expand: true });
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function getWorkspaceDir(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function resolveSettingPath(value: string | undefined): string | null {
    if (!value) { return null; }
    const ws = getWorkspaceDir();
    if (ws) {
        return value.replace(/\$\{workspaceFolder\}/g, ws);
    }
    if (value.includes('${workspaceFolder}')) { return null; }
    return value;
}

async function pickTarget(): Promise<string | undefined> {
    if (!lastReply) { return undefined; }
    const items = lastReply.targets.map(t => ({ label: t.name, description: t.type }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a target' });
    return pick?.label;
}

import * as vscode from 'vscode';
import * as path from 'path';
import { ApiClient, CmakeReply } from './cmake/api_client';
import { Runner } from './cmake/runner';
import { ReplyWatcher } from './watchers/reply_watcher';
import { ProjectOutlineProvider } from './providers/outline_provider';
import { ConfigProvider } from './providers/config_provider';
import { CacheEntry, CtestShowOnlyResult } from './cmake/types';
import { CMakeDiagnosticsManager } from './cmake/diagnostics_manager';
import { CMakeFileDecorationProvider } from './providers/decoration_provider';
import { ImpactedTargetsProvider } from './providers/impacted_provider';
import { DependencyGraphProvider } from './providers/graph_provider';
import { CMakeToolsIntegrationManager } from './cmake/cmake_tools_api';
import { computeDirectLinks } from './cmake/direct_links_converter';
import { debugDirectLinks, debugMissingLinks, debugSignatures } from './cmake/debug_direct_links';
import { wksConfigManager } from './config/workspace/manager';
import { appConfigManager } from './config/app/manager';

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
let api_client: ApiClient | null = null;
let reply_watcher: ReplyWatcher | null = null;
let outline_provider: ProjectOutlineProvider | null = null;
let config_provider: ConfigProvider | null = null;
let impacted_provider: ImpactedTargetsProvider | null = null;
let graph_provider: DependencyGraphProvider | null = null;
let config_view: vscode.TreeView<unknown> | null = null;
let outline_view: vscode.TreeView<unknown> | null = null;
let impacted_view: vscode.TreeView<unknown> | null = null;
let last_reply: CmakeReply | null = null;
let build_dir: string | null = null;
let current_config: string = 'Release';
let available_configs: string[] = [];
let task_status_bar: vscode.StatusBarItem | null = null;
let ws_state: vscode.Memento | null = null;

const BUILD_DIR_STATE_KEY = 'CMakeGraph.buildDir';
const ACTIVE_CONFIG_STATE_KEY = 'CMakeGraph.activeConfig';

let debugMode = false;

// ------------------------------------------------------------
// Activation
// ------------------------------------------------------------
export async function activate(aContext: vscode.ExtensionContext): Promise<void> {

    const diagnostics_manager = new CMakeDiagnosticsManager();
    const file_decoration_provider = new CMakeFileDecorationProvider(diagnostics_manager);
    aContext.subscriptions.push(diagnostics_manager, file_decoration_provider);

    runner = new Runner(aContext.workspaceState, diagnostics_manager);

    // Status bar — running tasks
    task_status_bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    task_status_bar.command = 'CMakeGraph.cancelTask';
    task_status_bar.hide();
    aContext.subscriptions.push(task_status_bar);

    runner.onTasksChanged(aTasks => {
        if (!task_status_bar) { return; }
        if (aTasks.length === 0) {
            task_status_bar.hide();
        } else {
            task_status_bar.text = `$(sync~spin) CMakeGraph: ${aTasks.length} task${aTasks.length > 1 ? 's' : ''} running`;
            task_status_bar.tooltip = aTasks.map(t => t.label).join('\n');
            task_status_bar.show();
        }
    }, null, aContext.subscriptions);

    ws_state = aContext.workspaceState;

    outline_provider = new ProjectOutlineProvider();
    config_provider = new ConfigProvider();
    impacted_provider = new ImpactedTargetsProvider();

    outline_view = vscode.window.createTreeView('CMakeGraphOutline', {
        treeDataProvider: outline_provider,
        showCollapseAll: true,
        canSelectMany: true,
    });

    config_view = vscode.window.createTreeView('CMakeGraphConfig', {
        treeDataProvider: config_provider,
        showCollapseAll: false,
    });

    impacted_view = vscode.window.createTreeView('CMakeGraphImpacted', {
        treeDataProvider: impacted_provider,
        showCollapseAll: false,
    });

    graph_provider = new DependencyGraphProvider(aContext.extensionUri);
    aContext.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            DependencyGraphProvider.viewId,
            graph_provider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );

    // Update impacted targets when active editor changes
    impacted_provider.setActiveFile(
        vscode.window.activeTextEditor?.document.uri.fsPath ?? null
    );
    vscode.window.onDidChangeActiveTextEditor(aEditor => {
        impacted_provider!.setActiveFile(aEditor?.document.uri.fsPath ?? null);
    }, null, aContext.subscriptions);

    const cmds: [string, (...args: unknown[]) => unknown][] = [
        ['CMakeGraph.cancelTask', () => cmdCancelTask()],
        ['CMakeGraph.selectBuildDir', () => cmdSelectBuildDir(aContext)],
        ['CMakeGraph.selectConfig', cmdSelectConfig],
        ['CMakeGraph.build', cmdBuild],
        ['CMakeGraph.buildTarget', cmdBuildTarget],
        ['CMakeGraph.rebuildTarget', (aNode: unknown) => cmdRebuildTarget(aNode)],
        ['CMakeGraph.buildImpactedSection', (aNode: unknown) => cmdBuildImpactedSection(aNode)],
        ['CMakeGraph.rebuildImpactedSection', (aNode: unknown) => cmdRebuildImpactedSection(aNode)],
        ['CMakeGraph.expandAllImpacted', cmdExpandAllImpacted],
        ['CMakeGraph.collapseAllImpacted', cmdCollapseAllImpacted],
        ['CMakeGraph.filterImpacted', cmdFilterImpacted],
        ['CMakeGraph.clearFilterImpacted', cmdClearFilterImpacted],
        ['CMakeGraph.testImpactedTarget', (aNode: unknown) => cmdTestImpactedTarget(aNode)],
        ['CMakeGraph.testImpactedSection', (aNode: unknown) => cmdTestImpactedSection(aNode)],
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
        ['CMakeGraph.openFile', (aUri: unknown) => cmdOpenFile(aUri as vscode.Uri)],
        ['CMakeGraph.openLocation', (aFile: unknown, aLine: unknown) => cmdOpenLocation(aFile as string, aLine as number)],
        ['CMakeGraph.copyToClipboard', (...aArgs: unknown[]) => cmdCopyToClipboard(aArgs)],
        ['CMakeGraph.copySectionToClipboard', (...aArgs: unknown[]) => cmdCopySectionToClipboard(aArgs)],
        ['CMakeGraph.revealDependency', (aNode: unknown) => cmdRevealDependency(aNode)],
        ['CMakeGraph.openSettings', cmdOpenSettings],
        ['CMakeGraph.toggleGraphLayout', () => graph_provider?.toggleLayout()],
        ['CMakeGraph.refreshDependencyGraph', cmdRefresh],
        ['CMakeGraph.graphSettings', () => graph_provider?.showSettings()],
        ['CMakeGraph.graphScreenshot', () => graph_provider?.screenshot()],
    ];

    for (const [id, handler] of cmds) {
        aContext.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    aContext.subscriptions.push(outline_view, config_view, impacted_view, runner);

    const cmake_manager = new CMakeToolsIntegrationManager((aBuildDir, aBuildType) => {
        initBuildDir(aBuildDir, aContext);
        updateAllPanesWithConfig(aBuildType);
        console.log(`CMake new configure on ${aBuildDir} with Build Type : ${aBuildType}`);
    });
    cmake_manager.watch(aContext);
    aContext.subscriptions.push(cmake_manager);

    aContext.subscriptions.push(wksConfigManager, appConfigManager);

    // Restore persisted config
    current_config = ws_state.get<string>(ACTIVE_CONFIG_STATE_KEY) || 'Release';

    // ── Initialize buildDir ──
    const saved_build = wksConfigManager.resolvedBuildDir
        || ws_state.get<string>(BUILD_DIR_STATE_KEY)
        || null;
    if (saved_build) {
        await initBuildDir(saved_build, aContext);
    }
}

// ------------------------------------------------------------
// Deactivation
// ------------------------------------------------------------
export function deactivate(): void {
    reply_watcher?.dispose();
}

// ------------------------------------------------------------
// Init buildDir
// ------------------------------------------------------------
async function initBuildDir(aDir: string, aContext: vscode.ExtensionContext): Promise<void> {
    reply_watcher?.dispose();
    build_dir = aDir;
    ws_state?.update(BUILD_DIR_STATE_KEY, aDir);
    api_client = new ApiClient(aDir);

    await api_client.writeQueries();

    reply_watcher = new ReplyWatcher(aDir);
    reply_watcher.onDidReply(loadReply, null, aContext.subscriptions);
    aContext.subscriptions.push(reply_watcher);

    if (await api_client.hasReply()) {
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
    if (!api_client) { return; }
    try {
        last_reply = await api_client.loadApiFiles();

        if (debugMode) {
            // show issue about direct links in the reply
            debugDirectLinks(last_reply);
            debugMissingLinks(last_reply);
            debugSignatures(last_reply);
        }

        // compute direct links of targets
        last_reply = computeDirectLinks(last_reply);

        // Detect available configurations
        available_configs = last_reply.codemodel.configurations.map(c => c.name || '(default)');
        current_config = detectConfig();

        // Show/hide config selector button based on multi-config
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.multiConfig', available_configs.length > 1);

        outline_provider!.refresh(
            last_reply.codemodel,
            last_reply.targets,
            current_config
        );

        config_provider!.refresh(last_reply.cache);

        // Derive sourceDir from codemodel paths
        const src = last_reply.codemodel.paths?.source || '';
        impacted_provider!.refresh(last_reply.targets, src);

        graph_provider?.refresh(last_reply.targets);

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
    if (available_configs.length === 0) { return 'Release'; }
    if (available_configs.length === 1) { return available_configs[0]; }
    // Multi-config: use persisted selection if still valid
    const persisted = ws_state?.get<string>(ACTIVE_CONFIG_STATE_KEY);
    if (persisted && available_configs.includes(persisted)) { return persisted; }
    return available_configs[0];
}

// ------------------------------------------------------------
// Commands — config selection
// ------------------------------------------------------------
async function cmdSelectConfig(): Promise<void> {
    if (!available_configs.length) {
        vscode.window.showWarningMessage('CMakeGraph: no configurations available. Load a build directory first.');
        return;
    }
    const items = available_configs.map(c => ({
        label: c,
        description: c === current_config ? '(current)' : '',
    }));
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select the active configuration',
    });
    if (!picked) { return; }
    updateAllPanesWithConfig(picked.label);
}

async function updateAllPanesWithConfig(aConfig: string): Promise<void> {
    current_config = aConfig;
    ws_state?.update(ACTIVE_CONFIG_STATE_KEY, current_config);
    if (last_reply) {
        outline_provider!.refresh(
            last_reply.codemodel,
            last_reply.targets,
            current_config
        );
        config_provider!.refresh(last_reply.cache);
        const src = last_reply.codemodel.paths?.source || '';
        impacted_provider!.refresh(last_reply.targets, src);

        graph_provider?.refresh(last_reply.targets);
    }

}

// ------------------------------------------------------------
// Commands — actions
// ------------------------------------------------------------

async function cmdSelectBuildDir(aContext: vscode.ExtensionContext): Promise<void> {
    const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Select build folder',
    });
    if (!folders?.length) { return; }
    const dir = folders[0].fsPath;
    await wksConfigManager.updateSetting('buildDir', dir);
    await initBuildDir(dir, aContext);
}

function getCmakePath(): string {
    return appConfigManager.resolvedCmakePath;
}

function getCtestPath(): string {
    return appConfigManager.resolvedCtestPath;
}

function getDefaultJobs(): number {
    return appConfigManager.settings.defaultJobs;
}

async function cmdBuild(): Promise<void> {
    if (!runner || !build_dir) {
        vscode.window.showWarningMessage('CMakeGraph: select a build folder first.');
        return;
    }
    const cmake_path = getCmakePath();
    const jobs = getDefaultJobs();
    const result = await runner.build(build_dir, undefined, current_config || undefined, undefined, cmake_path, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: build failed (code ${result.code})`);
    }
}

async function cmdBuildTarget(aNode?: unknown): Promise<void> {
    if (!runner || !build_dir) { return; }
    let target_name: string | undefined;
    if (aNode && typeof aNode === 'object' && 'kind' in aNode) {
        const kind = (aNode as { kind: string }).kind;
        if (kind === 'target' || kind === 'impactedTarget') {
            target_name = (aNode as unknown as { target: { name: string } }).target.name;
        }
    }
    if (!target_name) {
        target_name = await pickTarget();
    }
    if (!target_name) { return; }
    const cmake_path = getCmakePath();
    const jobs = getDefaultJobs();
    const result = await runner.build(build_dir, target_name, current_config || undefined, undefined, cmake_path, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: build of '${target_name}' failed (code ${result.code})`);
    }
}

async function cmdRebuildTarget(aNode?: unknown): Promise<void> {
    if (!runner || !build_dir) { return; }
    let target_name: string | undefined;
    if (aNode && typeof aNode === 'object' && 'kind' in aNode) {
        const kind = (aNode as { kind: string }).kind;
        if (kind === 'target' || kind === 'impactedTarget') {
            target_name = (aNode as unknown as { target: { name: string } }).target.name;
        }
    }
    if (!target_name) {
        target_name = await pickTarget();
    }
    if (!target_name) { return; }
    const cmake_path = getCmakePath();
    const result = await runner.cleanAndBuildTargets(build_dir, [target_name], current_config || undefined, cmake_path);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: rebuild of '${target_name}' failed (code ${result.code})`);
    }
}

async function cmdBuildImpactedSection(aNode?: unknown): Promise<void> {
    if (!runner || !build_dir) { return; }
    const targets = extractSectionTargetNames(aNode);
    if (!targets.length) { return; }
    const cmake_path = getCmakePath();
    const jobs = getDefaultJobs();
    const result = await runner.buildTargets(build_dir, targets, current_config || undefined, cmake_path, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: build of section failed (code ${result.code})`);
    }
}

async function cmdRebuildImpactedSection(aNode?: unknown): Promise<void> {
    if (!runner || !build_dir) { return; }
    const targets = extractSectionTargetNames(aNode);
    if (!targets.length) { return; }
    const cmake_path = getCmakePath();
    const jobs = getDefaultJobs();
    const result = await runner.cleanAndBuildTargets(build_dir, targets, current_config || undefined, cmake_path, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: rebuild of section failed (code ${result.code})`);
    }
}

function extractSectionTargetNames(aNode: unknown): string[] {
    if (!aNode || typeof aNode !== 'object') { return []; }
    if (!('kind' in aNode) || (aNode as { kind: string }).kind !== 'impactedSection') { return []; }
    const section = aNode as { targets?: { name: string }[] };
    return (section.targets ?? []).map(t => t.name);
}

async function cmdExpandAllImpacted(): Promise<void> {
    if (!impacted_provider || !impacted_view) { return; }
    const roots = impacted_provider.getChildren();
    for (const node of roots) {
        if ('kind' in node && node.kind === 'impactedSection') {
            await (impacted_view as vscode.TreeView<unknown>).reveal(node, {
                expand: true, select: false, focus: false,
            });
        }
    }
}

async function cmdCollapseAllImpacted(): Promise<void> {
    await vscode.commands.executeCommand('workbench.actions.treeView.CMakeGraphImpacted.collapseAll');
}

async function cmdFilterImpacted(): Promise<void> {
    if (!impacted_provider) { return; }
    const current = impacted_provider.currentFilter;
    const input = await vscode.window.showInputBox({
        title: 'Filter impacted targets',
        prompt: 'Search by target name or type',
        value: current,
        placeHolder: 'e.g.: mylib, EXECUTABLE, test...',
    });
    if (input === undefined) { return; }
    if (input === '') {
        impacted_provider.clearFilter();
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.impactedFilterActive', false);
    } else {
        impacted_provider.setFilter(input);
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.impactedFilterActive', true);
    }
}

async function cmdClearFilterImpacted(): Promise<void> {
    if (!impacted_provider) { return; }
    impacted_provider.clearFilter();
    await vscode.commands.executeCommand('setContext', 'CMakeGraph.impactedFilterActive', false);
}

// ------------------------------------------------------------
// Impacted — test commands
// ------------------------------------------------------------

async function cmdTestImpactedTarget(aNode?: unknown): Promise<void> {
    if (!runner || !build_dir) { return; }
    if (!aNode || typeof aNode !== 'object' || !('kind' in aNode)) { return; }
    if ((aNode as { kind: string }).kind !== 'impactedTarget') { return; }
    const target_name = (aNode as unknown as { target: { name: string } }).target.name;
    const ctest_path = getCtestPath();
    const jobs = getDefaultJobs();
    const regex = impacted_provider?.isTestTarget(target_name)
        ? impacted_provider.getTestRegex(target_name)
        : escapeRegex(target_name);
    const result = await runner.testByRegex(build_dir, regex, current_config || undefined, ctest_path, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: test '${target_name}' failed (code ${result.code})`);
    }
}

async function cmdTestImpactedSection(aNode?: unknown): Promise<void> {
    if (!runner || !build_dir) { return; }
    if (!aNode || typeof aNode !== 'object') { return; }
    const section_id = (aNode as { sectionId?: string }).sectionId;
    const targets = extractSectionTargetNames(aNode);
    if (!targets.length) { return; }
    const ctest_path = getCtestPath();
    const jobs = getDefaultJobs();
    const regex = section_id === 'tests' && impacted_provider
        ? impacted_provider.getTestSectionRegex(targets)
        : targets.map(n => escapeRegex(n)).join('|');
    const result = await runner.testByRegex(build_dir, regex, current_config || undefined, ctest_path, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`CMakeGraph: tests failed (code ${result.code})`);
    }
}

function escapeRegex(aStr: string): string {
    return aStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------------------------------------------------
// Outline — filter & expand
// ------------------------------------------------------------

async function cmdFilterOutline(): Promise<void> {
    if (!outline_provider) { return; }
    const current = outline_provider.currentFilter;
    const input = await vscode.window.showInputBox({
        title: 'Filter outline targets',
        prompt: 'Search by target name or type',
        value: current,
        placeHolder: 'e.g.: mylib, EXECUTABLE, test...',
    });
    if (input === undefined) { return; }
    if (input === '') {
        outline_provider.clearFilter();
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.outlineFilterActive', false);
    } else {
        outline_provider.setFilter(input);
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.outlineFilterActive', true);
    }
}

async function cmdClearFilterOutline(): Promise<void> {
    if (!outline_provider) { return; }
    outline_provider.clearFilter();
    await vscode.commands.executeCommand('setContext', 'CMakeGraph.outlineFilterActive', false);
}

async function cmdExpandAllOutline(): Promise<void> {
    if (!outline_provider || !outline_view) { return; }
    const roots = outline_provider.getChildren();
    for (const node of roots) {
        if (!('kind' in node)) { continue; }
        if (node.kind === 'project') {
            // Expand the project node and its children
            try {
                await (outline_view as vscode.TreeView<unknown>).reveal(node, {
                    expand: 2, select: false, focus: false,
                });
            } catch { /* node may not be revealable */ }
            for (const child of outline_provider.getChildren(node)) {
                if ('kind' in child && (child.kind === 'folder' || child.kind === 'target')) {
                    try {
                        await (outline_view as vscode.TreeView<unknown>).reveal(child, {
                            expand: 2, select: false, focus: false,
                        });
                    } catch { /* node may not be revealable */ }
                }
            }
        }
    }
}

async function cmdClean(): Promise<void> {
    if (!runner || !build_dir) { return; }
    await runner.clean(build_dir);
}

// ------------------------------------------------------------
// Tests — discovery and execution
// ------------------------------------------------------------

let available_tests: CtestInfo[] = [];

async function refreshAvailableTests(): Promise<void> {
    if (!runner || !build_dir) { available_tests = []; return; }

    const ctest_path = getCtestPath();
    const result = await runner.listTests(build_dir, ctest_path);

    if (!result.success) {
        available_tests = [];
        impacted_provider?.setTestMap(new Map());
        return;
    }

    try {
        const json = JSON.parse(result.stdout) as CtestShowOnlyResult;
        available_tests = (json.tests ?? []).map(t => ({
            name: t.name,
            command: t.command ?? [],
        }));

        // Build targetName → testNames[] map from WORKING_DIRECTORY property.
        const build_path_to_target = new Map<string, string>();
        if (last_reply && build_dir) {
            for (const t of last_reply.targets) {
                if (t.type === 'EXECUTABLE') {
                    const abs = path.isAbsolute(t.paths.build)
                        ? path.normalize(t.paths.build)
                        : path.normalize(path.join(build_dir, t.paths.build));
                    build_path_to_target.set(abs.toLowerCase(), t.name);
                }
            }
        }
        const tests_by_target = new Map<string, string[]>();
        for (const t of json.tests ?? []) {
            const wd_prop = t.properties?.find(p => p.name === 'WORKING_DIRECTORY');
            if (wd_prop && typeof wd_prop.value === 'string') {
                const normalized_wd = path.normalize(wd_prop.value).toLowerCase();
                const target_name = build_path_to_target.get(normalized_wd);
                if (target_name) {
                    let list = tests_by_target.get(target_name);
                    if (!list) {
                        list = [];
                        tests_by_target.set(target_name, list);
                    }
                    list.push(t.name);
                }
            }
        }
        impacted_provider?.setTestMap(tests_by_target);
    } catch {
        available_tests = [];
        impacted_provider?.setTestMap(new Map());
    }
}

async function cmdTest(): Promise<void> {
    if (!runner || !build_dir) {
        vscode.window.showWarningMessage('CMakeGraph: select a build folder first.');
        return;
    }
    const ctest_path = getCtestPath();
    const jobs = getDefaultJobs();
    const result = await runner.test(build_dir, current_config || undefined, undefined, ctest_path, jobs);
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
        '@ext:aiekick.cmakegraph'
    );
}

/**
 * Switch between two cache-edit strategies:
 *  - false : write directly into CMakeCache.txt (no reconfigure)
 *  - true  : run cmake -D to reconfigure (classic behaviour)
 */
const EDIT_CACHE_VIA_CONFIGURE = true;

async function cmdEditCacheEntry(aEntry: CacheEntry): Promise<void> {
    if (!build_dir) { return; }
    let new_value: string | undefined;
    if (aEntry.type === 'BOOL') {
        new_value = await vscode.window.showQuickPick(['ON', 'OFF'], {
            title: aEntry.name,
            placeHolder: aEntry.properties.HELPSTRING ?? '',
        });
    } else if (aEntry.properties.STRINGS) {
        new_value = await vscode.window.showQuickPick(aEntry.properties.STRINGS.split(';'), {
            title: aEntry.name,
            placeHolder: aEntry.properties.HELPSTRING ?? '',
        });
    } else {
        new_value = await vscode.window.showInputBox({
            title: aEntry.name,
            prompt: aEntry.properties.HELPSTRING ?? '',
            value: aEntry.value,
        });
    }
    if (new_value === undefined || new_value === aEntry.value) { return; }

    if (EDIT_CACHE_VIA_CONFIGURE) {
        // ── Strategy A: reconfigure with cmake -D ──
        if (!runner) { return; }
        const src = last_reply?.codemodel.paths?.source || build_dir;
        const result = await runner.configure(src, build_dir, { [aEntry.name]: new_value });
        if (!result.success && !result.cancelled) {
            vscode.window.showErrorMessage(`CMakeGraph: reconfigure failed after modifying ${aEntry.name}`);
        }
    } else {
        // ── Strategy B: patch CMakeCache.txt directly ──
        const cache_path = path.join(build_dir, 'CMakeCache.txt');
        try {
            const fs_p = await import('fs/promises');
            const content = await fs_p.readFile(cache_path, 'utf-8');
            // Match the line:  NAME:TYPE=VALUE
            const regex = new RegExp(`^(${escapeRegex(aEntry.name)}:${escapeRegex(aEntry.type)}=)(.*)$`, 'm');
            if (!regex.test(content)) {
                vscode.window.showWarningMessage(`CMakeGraph: entry ${aEntry.name} not found in CMakeCache.txt`);
                return;
            }
            const updated = content.replace(regex, `$1${new_value}`);
            await fs_p.writeFile(cache_path, updated, 'utf-8');
            vscode.window.showInformationMessage(`CMakeGraph: ${aEntry.name} set to ${new_value}`);

            // Update in-memory cache and refresh the config pane
            aEntry.value = new_value;
            if (last_reply) {
                config_provider!.refresh(last_reply.cache);
            }
        } catch (err) {
            vscode.window.showErrorMessage(
                `CMakeGraph: failed to update CMakeCache.txt — ${(err as Error).message}`
            );
        }
    }
}

async function cmdFilterConfig(): Promise<void> {
    if (!config_provider) { return; }
    const current = config_provider.currentFilter;
    const input = await vscode.window.showInputBox({
        title: 'Filter CMake variables',
        prompt: 'Search in name, value and description',
        value: current,
        placeHolder: 'e.g.: FOOBAR, CMAKE_CXX, path...',
    });
    if (input === undefined) { return; }
    if (input === '') {
        config_provider.clearFilter();
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.configFilterActive', false);
    } else {
        config_provider.setFilter(input);
        await vscode.commands.executeCommand('setContext', 'CMakeGraph.configFilterActive', true);
    }
}

async function cmdClearFilterConfig(): Promise<void> {
    if (!config_provider) { return; }
    config_provider.clearFilter();
    await vscode.commands.executeCommand('setContext', 'CMakeGraph.configFilterActive', false);
}

async function cmdExpandAllConfig(): Promise<void> {
    if (!config_provider || !config_view) { return; }
    for (const group of config_provider.getGroups()) {
        await (config_view as vscode.TreeView<unknown>).reveal(group, {
            expand: true, select: false, focus: false,
        });
    }
}

async function cmdCollapseAllConfig(): Promise<void> {
    await vscode.commands.executeCommand('workbench.actions.treeView.CMakeGraphConfig.collapseAll');
}

async function cmdOpenFile(aUri: vscode.Uri): Promise<void> {
    const safe_uri = vscode.Uri.file(aUri.fsPath);
    const existing = vscode.window.tabGroups.all
        .flatMap(g => g.tabs)
        .find(tab =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.fsPath === safe_uri.fsPath
        );
    await vscode.window.showTextDocument(safe_uri, { preview: !existing, preserveFocus: false });
}

async function cmdOpenLocation(aFile: string, aLine: number): Promise<void> {
    const uri = vscode.Uri.file(aFile);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(Math.max(0, aLine - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function cmdCopyToClipboard(aArgs: unknown[]): Promise<void> {
    const nodes = Array.isArray(aArgs[1]) && aArgs[1].length > 0 ? aArgs[1] : [aArgs[0]];
    const texts = nodes.map((n: any) => extractNodeText(n)).filter(Boolean);
    if (!texts.length) { return; }
    const text = texts.join('\n');
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`CMakeGraph: ${texts.length} item${texts.length > 1 ? 's' : ''} copied`);
}

async function cmdCopySectionToClipboard(aArgs: unknown[]): Promise<void> {
    const node = aArgs[0] as any;
    if (!node || !outline_provider) { return; }
    const children = outline_provider.getChildren(node);
    const texts = children.map((n: any) => extractNodeText(n)).filter(Boolean);
    if (!texts.length) { return; }
    const text = texts.join('\n');
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`CMakeGraph: ${texts.length} item${texts.length > 1 ? 's' : ''} copied`);
}

function extractNodeText(aNode: any): string {
    if (!aNode || !aNode.kind) { return ''; }
    switch (aNode.kind) {
        case 'include': return aNode.path ?? '';
        case 'flag': return aNode.text ?? '';
        case 'library': return aNode.fragment ?? '';
        case 'directLink': return aNode.target?.name ?? '';
        case 'cmakefile': return aNode.path ?? '';
        case 'source': return aNode.source?.path ?? '';
        case 'rootFile': return aNode.filePath ?? '';
        case 'targetCmake': return `${aNode.filePath}:${aNode.line}`;
        default: return '';
    }
}

async function cmdRevealDependency(aNode: unknown): Promise<void> {
    if (!aNode || !outline_provider || !outline_view) { return; }
    const dep = aNode as { kind: string; target?: { id: string } };
    if (dep.kind !== 'dependency' || !dep.target) { return; }
    const target_node = outline_provider.findTargetNode(dep.target.id);
    if (!target_node) {
        vscode.window.showWarningMessage('CMakeGraph: target not found in outline.');
        return;
    }
    await outline_view.reveal(target_node, { select: true, focus: true, expand: true });
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

async function pickTarget(): Promise<string | undefined> {
    if (!last_reply) { return undefined; }
    const items = last_reply.targets.map(t => ({ label: t.name, description: t.type }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a target' });
    return pick?.label;
}

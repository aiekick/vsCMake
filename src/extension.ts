import * as vscode from 'vscode';
import * as path from 'path';
import { ApiClient, CmakeReply } from './cmake/api_client';
import { Runner, RunResult } from './cmake/runner';
import { ReplyWatcher } from './watchers/reply_watcher';
import { ProjectStatusProvider } from './providers/project_status_provider';
import { ProjectOutlineProvider } from './providers/project_outline_provider';
import { ConfigProvider } from './providers/config_provider';
import { PresetReader, ResolvedPresets } from './cmake/preset_reader';
import { CacheEntry, CtestShowOnlyResult } from './cmake/types';
import { Kit, scanKits } from './cmake/kit_scanner';
import { clearMsvcEnvCache } from './cmake/msvc_env';
import { CMakeDiagnosticsManager } from './cmake/cmake_diagnostics_manager';
import { CMakeFileDecorationProvider } from './providers/cmake_file_decoration_provider';

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
let statusProvider: ProjectStatusProvider | null = null;
let outlineProvider: ProjectOutlineProvider | null = null;
let configProvider: ConfigProvider | null = null;
let configView: vscode.TreeView<unknown> | null = null;
let outlineView: vscode.TreeView<unknown> | null = null;
let lastReply: CmakeReply | null = null;
let currentPresets: ResolvedPresets | null = null;
let sourceDir: string | null = null;
let buildDir: string | null = null;
let taskStatusBar: vscode.StatusBarItem | null = null;
let availableKits: Kit[] = [];

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
    taskStatusBar.command = 'vsCMake.cancelTask';
    taskStatusBar.hide();
    context.subscriptions.push(taskStatusBar);

    runner.onTasksChanged(tasks => {
        if (!taskStatusBar) { return; }
        if (tasks.length === 0) {
            taskStatusBar.hide();
        } else {
            taskStatusBar.text = `$(sync~spin) vsCMake: ${tasks.length} task${tasks.length > 1 ? 's' : ''} running`;
            taskStatusBar.tooltip = tasks.map(t => t.label).join('\n');
            taskStatusBar.show();
        }
    }, null, context.subscriptions);

    statusProvider = new ProjectStatusProvider();
    outlineProvider = new ProjectOutlineProvider();
    configProvider = new ConfigProvider();

    // Restore persisted state
    statusProvider.initPersistence(context.workspaceState);

    const statusView = vscode.window.createTreeView('vsCMakeStatus', {
        treeDataProvider: statusProvider,
        showCollapseAll: false,
    });

    outlineView = vscode.window.createTreeView('vsCMakeOutline', {
        treeDataProvider: outlineProvider,
        showCollapseAll: true,
        canSelectMany: true,
    });

    configView = vscode.window.createTreeView('vsCMakeConfig', {
        treeDataProvider: configProvider,
        showCollapseAll: false,
    });

    statusProvider.onActiveConfigChanged(cfg => {
        if (lastReply) {
            outlineProvider!.refresh(
                lastReply.codemodel,
                lastReply.targets,
                cfg,
                lastReply.cmakeFiles.inputs.map(i => i.path)
            );
        }
    }, null, context.subscriptions);

    const cmds: [string, (...args: unknown[]) => unknown][] = [
        ['vsCMake.cancelTask', () => cmdCancelTask()],
        ['vsCMake.deleteCacheAndReconfigure', () => cmdDeleteCacheAndReconfigure()],
        ['vsCMake.pick_folder', () => cmdPickFolder(context)],
        ['vsCMake.pick_configChoice', () => statusProvider!.pickConfigChoice()],
        ['vsCMake.pick_configure', () => statusProvider!.pickConfigure()],
        ['vsCMake.pick_build', () => statusProvider!.pickBuild()],
        ['vsCMake.pick_buildConfig', () => statusProvider!.pickBuildConfig()],
        ['vsCMake.pick_buildTarget', () => statusProvider!.pickBuildTarget()],
        ['vsCMake.pick_buildJobs', () => statusProvider!.pickBuildJobs()],
        ['vsCMake.pick_test', () => cmdPickTestPreset()],
        ['vsCMake.pick_testTarget', () => cmdPickTestTarget()],
        ['vsCMake.pick_testJobs', () => statusProvider!.pickTestJobs()],
        ['vsCMake.pick_package', () => statusProvider!.pickPackage()],
        ['vsCMake.pick_debug', () => statusProvider!.pickDebug()],
        ['vsCMake.pick_launch', () => statusProvider!.pickLaunch()],
        ['vsCMake.pick_kit', () => statusProvider!.pickKit()],
        ['vsCMake.scanKits', cmdScanKits],
        ['vsCMake.selectBuildDir', () => cmdSelectBuildDir(context)],
        ['vsCMake.configure', cmdConfigure],
        ['vsCMake.build', cmdBuild],
        ['vsCMake.buildTarget', cmdBuildTarget],
        ['vsCMake.rebuildTarget', (node: unknown) => cmdRebuildTarget(node)],
        ['vsCMake.clean', cmdClean],
        ['vsCMake.install', cmdInstall],
        ['vsCMake.test', cmdTest],
        ['vsCMake.debug', cmdDebug],
        ['vsCMake.launch', cmdLaunch],
        ['vsCMake.refresh', cmdRefresh],
        ['vsCMake.editCacheEntry', (e: unknown) => cmdEditCacheEntry(e as CacheEntry)],
        ['vsCMake.filterConfig', cmdFilterConfig],
        ['vsCMake.clearFilterConfig', cmdClearFilterConfig],
        ['vsCMake.expandAllConfig', cmdExpandAllConfig],
        ['vsCMake.collapseAllConfig', cmdCollapseAllConfig],
        ['vsCMake.openFile', (uri: unknown) => cmdOpenFile(uri as vscode.Uri)],
        ['vsCMake.openLocation', (file: unknown, line: unknown) => cmdOpenLocation(file as string, line as number)],
        ['vsCMake.copyToClipboard', (...args: unknown[]) => cmdCopyToClipboard(args)],
        ['vsCMake.copySectionToClipboard', (...args: unknown[]) => cmdCopySectionToClipboard(args)],
        ['vsCMake.revealDependency', (node: unknown) => cmdRevealDependency(node)],
    ];

    for (const [id, handler] of cmds) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    context.subscriptions.push(statusView, outlineView, configView, runner);

    // ── Initialize sourceDir ──
    const cfg = vscode.workspace.getConfiguration('vsCMake');
    const savedSource = statusProvider.savedSourceDir
        || resolveSettingPath(cfg.get<string>('sourceDir'))
        || getWorkspaceDir();
    sourceDir = savedSource ?? null;

    if (sourceDir) {
        statusProvider.updateSourceDir(sourceDir);
    }

    // ── Initialize buildDir ──
    const savedBuild = resolveSettingPath(cfg.get<string>('buildDir'));
    if (savedBuild) {
        await initBuildDir(savedBuild, context);
    } else {
        await loadPresets();
    }

    // ── Scan kits if no presets ──
    if (!currentPresets?.configurePresets.length) {
        await cmdScanKits();
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
    apiClient = new ApiClient(dir);
    await apiClient.writeQueries();

    await loadPresets();

    replyWatcher = new ReplyWatcher(dir);
    replyWatcher.onDidReply(loadReply, null, context.subscriptions);
    context.subscriptions.push(replyWatcher);

    if (await apiClient.hasReply()) {
        await loadReply();
    } else {
        vscode.window.showInformationMessage(
            'vsCMake: build dir configured. Run "CMake: Configure" to get started.'
        );
    }
}

// ------------------------------------------------------------
// Load presets
// ------------------------------------------------------------
async function loadPresets(): Promise<void> {
    const src = sourceDir ?? getWorkspaceDir();
    if (!src) { return; }
    currentPresets = await PresetReader.read(src);
    statusProvider!.setPresets(currentPresets);
}

// ------------------------------------------------------------
// Load reply
// ------------------------------------------------------------
async function loadReply(): Promise<void> {
    if (!apiClient) { return; }
    try {
        lastReply = await apiClient.loadAll();
        const src = sourceDir ?? getWorkspaceDir() ?? '';

        const cmakeInputs = lastReply.cmakeFiles.inputs.map(i => i.path);

        statusProvider!.refreshFromCodemodel(src, lastReply.codemodel, lastReply.targets, cmakeInputs, buildDir ?? undefined);

        outlineProvider!.refresh(
            lastReply.codemodel,
            lastReply.targets,
            statusProvider!.currentConfig,
            cmakeInputs
        );

        configProvider!.refresh(lastReply.cache);

        await refreshAvailableTests();

    } catch (err) {
        vscode.window.showErrorMessage(
            `vsCMake: reply read error — ${(err as Error).message}`
        );
    }
}

// ------------------------------------------------------------
// Commands — pickers
// ------------------------------------------------------------

async function cmdPickFolder(context: vscode.ExtensionContext): Promise<void> {
    const dir = await pickSourceDir();
    if (!dir) { return; }
    sourceDir = dir;
    await vscode.workspace.getConfiguration('vsCMake').update(
        'sourceDir', dir, vscode.ConfigurationTarget.Workspace
    );
    statusProvider!.updateSourceDir(dir);
    await loadPresets();

    if (lastReply) {
        const cmakeInputs = lastReply.cmakeFiles.inputs.map(i => i.path);
        statusProvider!.refreshFromCodemodel(dir, lastReply.codemodel, lastReply.targets, cmakeInputs, buildDir ?? undefined);
    }

    if (!buildDir) {
        const defaultBuild = path.join(dir, 'build');
        const choice = await vscode.window.showQuickPick([
            { label: `$(folder) ${defaultBuild}`, description: 'Default build/ subfolder', value: defaultBuild },
            { label: '$(folder-opened) Choose another folder…', description: '', value: '__pick__' },
        ], { placeHolder: 'Where to place the build folder?' });

        if (!choice) { return; }

        const selectedBuild = choice.value === '__pick__'
            ? await pickBuildDir()
            : choice.value;

        if (!selectedBuild) { return; }

        await vscode.workspace.getConfiguration('vsCMake').update(
            'buildDir', selectedBuild, vscode.ConfigurationTarget.Workspace
        );
        await initBuildDir(selectedBuild, context);
    }
}

// ------------------------------------------------------------
// Commands — Kit scan
// ------------------------------------------------------------

async function cmdScanKits(): Promise<void> {
    const extraPaths = vscode.workspace
        .getConfiguration('vsCMake')
        .get<string[]>('kitSearchPaths', []);

    statusProvider!.setKitScanning(true);

    try {
        availableKits = await scanKits(extraPaths, (msg) => {
            statusProvider!.setKitScanMessage(msg);
        });
        statusProvider!.setKits(availableKits);
    } finally {
        statusProvider!.setKitScanning(false);
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
    await vscode.workspace.getConfiguration('vsCMake').update(
        'buildDir', dir, vscode.ConfigurationTarget.Workspace
    );
    await initBuildDir(dir, context);
}

function getCmakePath(): string {
    return vscode.workspace.getConfiguration('vsCMake').get<string>('cmakePath') || 'cmake';
}

function getCtestPath(): string {
    return vscode.workspace.getConfiguration('vsCMake').get<string>('ctestPath') || 'ctest';
}

function getCpackPath(): string {
    return vscode.workspace.getConfiguration('vsCMake').get<string>('cpackPath') || 'cpack';
}

async function cmdConfigure(): Promise<void> {
    if (!runner) {
        vscode.window.showWarningMessage('vsCMake: runner not initialized.');
        return;
    }
    const src = sourceDir ?? getWorkspaceDir();
    if (!src) {
        vscode.window.showWarningMessage('vsCMake: no source folder defined.');
        return;
    }

    await loadPresets();

    const cmakePath = getCmakePath();
    const presetName = statusProvider?.currentConfigurePreset;

    if (presetName) {
        // The preset can override the buildDir
        const presetBuildDir = resolvePresetBuildDir(presetName, src);
        if (presetBuildDir) {
            await ensureBuildDir(presetBuildDir);
        } else if (!buildDir) {
            vscode.window.showWarningMessage('vsCMake: no build folder defined (neither in settings nor in preset).');
            return;
        }

        const result = await runner.configure(src, undefined, {}, presetName, cmakePath);
        if (!result.success && !result.cancelled) {
            vscode.window.showErrorMessage(`vsCMake: configure failed (code ${result.code})`);
        }
    } else {
        if (!buildDir) {
            vscode.window.showWarningMessage('vsCMake: select a build folder first.');
            return;
        }
        const defs: Record<string, string> = {};
        const config = statusProvider?.currentConfig;
        if (config) {
            defs['CMAKE_BUILD_TYPE'] = config;
        }

        // Kit injection
        const kit = statusProvider?.currentKit;
        if (kit) {
            if (kit.compilers.c) { defs['CMAKE_C_COMPILER'] = kit.compilers.c; }
            if (kit.compilers.cxx) { defs['CMAKE_CXX_COMPILER'] = kit.compilers.cxx; }
            runner.setActiveKit(kit);
        }

        const result = await runner.configure(src, buildDir, defs, undefined, cmakePath);
        if (!result.success && !result.cancelled) {
            vscode.window.showErrorMessage(`vsCMake: configure failed (code ${result.code})`);
        }
    }
}

/**
 * Resolves the binaryDir of a configure preset.
 * Returns the absolute path or null if not found.
 */
function resolvePresetBuildDir(presetName: string, src: string): string | null {
    if (!currentPresets) { return null; }
    const preset = currentPresets.configurePresets.find(p => p.name === presetName);
    if (!preset?.binaryDir) { return null; }

    const resolved = preset.binaryDir;
    // The binaryDir is already resolved by PresetReader (macros expanded)
    // but it may be relative to sourceDir
    const { isAbsolute, join } = require('path') as typeof import('path');
    return isAbsolute(resolved) ? resolved : join(src, resolved);
}

/**
 * Initializes the buildDir for a preset.
 * Writes query files and sets up the watcher if needed.
 */
async function ensureBuildDir(dir: string): Promise<void> {
    // Avoid reinitializing if it's already the correct folder
    if (buildDir === dir && apiClient) { return; }

    replyWatcher?.dispose();
    buildDir = dir;
    apiClient = new ApiClient(dir);
    await apiClient.writeQueries();

    // The watcher must be created with the extension context
    // We recreate it here — it will be added to subscriptions
    replyWatcher = new ReplyWatcher(dir);
    replyWatcher.onDidReply(loadReply);

    // If a reply already exists (reconfigure), load it
    if (await apiClient.hasReply()) {
        await loadReply();
    }
}

async function cmdBuild(): Promise<void> {
    if (!runner || !buildDir) {
        vscode.window.showWarningMessage('vsCMake: select a build folder first.');
        return;
    }
    const cmakePath = getCmakePath();
    const jobs = statusProvider?.currentBuildJobs || 0;
    const presetName = statusProvider?.currentBuildPreset;
    if (presetName) {
        const buildConfig = statusProvider?.currentBuildConfig || undefined;
        const src = sourceDir ?? getWorkspaceDir() ?? '.';
        const result = await runner.build(src, undefined, buildConfig, presetName, cmakePath, jobs);
        if (!result.success && !result.cancelled) {
            vscode.window.showErrorMessage(`vsCMake: build failed (code ${result.code})`);
        }
    } else {
        const target = statusProvider?.currentBuildTarget;
        const config = statusProvider?.currentBuildConfig || statusProvider?.currentConfig;
        const result = await runner.build(
            buildDir,
            target && target !== 'all' ? target : undefined,
            config || undefined,
            undefined,
            cmakePath,
            jobs
        );
        if (!result.success && !result.cancelled) {
            vscode.window.showErrorMessage(`vsCMake: build failed (code ${result.code})`);
        }
    }
}

async function cmdBuildTarget(node?: unknown): Promise<void> {
    if (!runner || !buildDir) { return; }
    let targetName: string | undefined;
    if (node && typeof node === 'object' && 'kind' in node &&
        (node as { kind: string }).kind === 'target') {
        targetName = (node as unknown as { target: { name: string } }).target.name;
    } else {
        targetName = await pickTarget();
    }
    if (!targetName) { return; }
    const config = statusProvider?.currentConfig;
    const result = await runner.build(buildDir, targetName, config || undefined);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`vsCMake: build of '${targetName}' failed (code ${result.code})`);
    }
}

async function cmdRebuildTarget(node?: unknown): Promise<void> {
    if (!runner || !buildDir) { return; }
    let targetName: string | undefined;
    if (node && typeof node === 'object' && 'kind' in node &&
        (node as { kind: string }).kind === 'target') {
        targetName = (node as unknown as { target: { name: string } }).target.name;
    } else {
        targetName = await pickTarget();
    }
    if (!targetName) { return; }
    const cmakePath = getCmakePath();
    const config = statusProvider?.currentConfig;
    const result = await runner.cleanAndBuildTarget(buildDir, targetName, config || undefined, cmakePath);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`vsCMake: rebuild of '${targetName}' failed (code ${result.code})`);
    }
}

async function cmdClean(): Promise<void> {
    if (!runner || !buildDir) { return; }
    await runner.clean(buildDir);
}

async function cmdInstall(): Promise<void> {
    if (!runner || !buildDir) { return; }
    await runner.install(buildDir);
}

// ------------------------------------------------------------
// Tests — discovery and selection
// ------------------------------------------------------------

let availableTests: CtestInfo[] = [];

async function refreshAvailableTests(): Promise<void> {
    if (!runner) { availableTests = []; return; }

    const testPreset = statusProvider?.currentTestPreset;
    const ctestPath = getCtestPath();
    let result: RunResult;

    if (testPreset) {
        const src = sourceDir ?? getWorkspaceDir() ?? '.';
        result = await runner.listTestsWithPreset(testPreset, src, ctestPath);
    } else if (buildDir) {
        result = await runner.listTests(buildDir, ctestPath);
    } else {
        availableTests = [];
        statusProvider?.setTestCount(0);
        return;
    }

    if (!result.success) {
        availableTests = [];
        statusProvider?.setTestCount(0);
        return;
    }

    try {
        const json = JSON.parse(result.stdout) as CtestShowOnlyResult;
        availableTests = (json.tests ?? []).map(t => ({
            name: t.name,
            command: t.command ?? [],
        }));
    } catch {
        availableTests = [];
    }

    statusProvider?.setTestCount(availableTests.length);
}

async function cmdPickTestPreset(): Promise<void> {
    await statusProvider!.pickTest();
    await refreshAvailableTests();
}

async function cmdPickTestTarget(): Promise<void> {
    await statusProvider!.pickTestTarget(availableTests);
}

async function cmdTest(): Promise<void> {
    if (!runner || !buildDir) {
        vscode.window.showWarningMessage('vsCMake: select a build folder first.');
        return;
    }
    const ctestPath = getCtestPath();
    const jobs = statusProvider?.currentTestJobs || 0;
    const presetName = statusProvider?.currentTestPreset;
    if (presetName) {
        const src = sourceDir ?? getWorkspaceDir() ?? '.';
        const result = await runner.test(src, undefined, presetName, ctestPath, jobs);
        if (!result.success && !result.cancelled) {
            vscode.window.showErrorMessage(`vsCMake: test failed (code ${result.code})`);
        }
    } else {
        const config = statusProvider?.currentConfig;
        const selected = statusProvider?.currentSelectedTest ?? 'all';
        if (selected === 'all') {
            const result = await runner.test(buildDir, config || undefined, undefined, ctestPath, jobs);
            if (!result.success && !result.cancelled) {
                vscode.window.showErrorMessage(`vsCMake: test failed (code ${result.code})`);
            }
        } else {
            const result = await runner.testFiltered(buildDir, selected, config || undefined, ctestPath, jobs);
            if (!result.success && !result.cancelled) {
                vscode.window.showErrorMessage(`vsCMake: test '${selected}' failed (code ${result.code})`);
            }
        }
    }
}

async function cmdDebug(): Promise<void> {
    const target = statusProvider?.currentDebugTarget;
    if (!target) {
        vscode.window.showWarningMessage('vsCMake: no debug target selected.');
        return;
    }
    vscode.window.showInformationMessage(`vsCMake: Debug '${target}' — not yet implemented.`);
}

async function cmdLaunch(): Promise<void> {
    const target = statusProvider?.currentLaunchTarget;
    if (!target) {
        vscode.window.showWarningMessage('vsCMake: no launch target selected.');
        return;
    }
    vscode.window.showInformationMessage(`vsCMake: Launch '${target}' — not yet implemented.`);
}

async function cmdDeleteCacheAndReconfigure(): Promise<void> {
    if (!buildDir) {
        vscode.window.showWarningMessage('vsCMake: no build folder defined.');
        return;
    }
    const src = sourceDir ?? getWorkspaceDir();
    if (!src) {
        vscode.window.showWarningMessage('vsCMake: no source folder defined.');
        return;
    }

    const ok = await vscode.window.showWarningMessage(
        `Delete CMake cache and reconfigure?\n${buildDir}`,
        { modal: true },
        'Delete and reconfigure'
    );
    if (!ok) { return; }

    try {
        const fs = await import('fs/promises');
        const { join } = await import('path');

        async function cleanCmakeCache(dir: string): Promise<void> {
            let entries;
            try { entries = await fs.readdir(dir, { withFileTypes: true }); }
            catch { return; }
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (entry.isFile() && entry.name === 'CMakeCache.txt') {
                    await fs.rm(full, { force: true }).catch(() => { });
                } else if (entry.isDirectory() && entry.name === 'CMakeFiles') {
                    await fs.rm(full, { recursive: true, force: true }).catch(() => { });
                } else if (entry.isDirectory()) {
                    await cleanCmakeCache(full);
                }
            }
        }

        await cleanCmakeCache(buildDir);
    } catch (err) {
        vscode.window.showErrorMessage(
            `vsCMake: failed to delete cache — ${(err as Error).message}`
        );
        return;
    }

    // Clear persisted MSVC env to force re-resolution
    runner!.clearPersistedMsvcEnv();
    clearMsvcEnvCache();

    await cmdConfigure();
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

async function cmdEditCacheEntry(entry: CacheEntry): Promise<void> {
    if (!runner || !buildDir) { return; }
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
    const src = sourceDir ?? getWorkspaceDir();
    if (!src) { return; }
    const result = await runner.configure(src, buildDir, { [entry.name]: newValue });
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`vsCMake: reconfigure failed after modifying ${entry.name}`);
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
        await vscode.commands.executeCommand('setContext', 'vsCMake.configFilterActive', false);
    } else {
        configProvider.setFilter(input);
        await vscode.commands.executeCommand('setContext', 'vsCMake.configFilterActive', true);
    }
}

async function cmdClearFilterConfig(): Promise<void> {
    if (!configProvider) { return; }
    configProvider.clearFilter();
    await vscode.commands.executeCommand('setContext', 'vsCMake.configFilterActive', false);
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
    await vscode.commands.executeCommand('workbench.actions.treeView.vsCMakeConfig.collapseAll');
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
    vscode.window.showInformationMessage(`vsCMake: ${texts.length} item${texts.length > 1 ? 's' : ''} copied`);
}

async function cmdCopySectionToClipboard(args: unknown[]): Promise<void> {
    const node = args[0] as any;
    if (!node || !outlineProvider) { return; }
    const children = outlineProvider.getChildren(node);
    const texts = children.map((n: any) => extractNodeText(n)).filter(Boolean);
    if (!texts.length) { return; }
    const text = texts.join('\n');
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`vsCMake: ${texts.length} item${texts.length > 1 ? 's' : ''} copied`);
}

function extractNodeText(node: any): string {
    if (!node || !node.kind) { return ''; }
    switch (node.kind) {
        case 'include': return node.path ?? '';
        case 'flag': return node.text ?? '';
        case 'library': return node.fragment ?? '';
        case 'dependency': return node.target?.name ?? '';
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
    if (dep.kind !== 'dependency' || !dep.target) { return; }
    const targetNode = outlineProvider.findTargetNode(dep.target.id);
    if (!targetNode) {
        vscode.window.showWarningMessage('vsCMake: target not found in outline.');
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

async function pickSourceDir(): Promise<string | null> {
    const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Select source folder',
    });
    return folders?.[0]?.fsPath ?? null;
}

async function pickBuildDir(): Promise<string | null> {
    const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Select build folder',
    });
    return folders?.[0]?.fsPath ?? null;
}

async function pickTarget(): Promise<string | undefined> {
    if (!lastReply) { return undefined; }
    const items = lastReply.targets.map(t => ({ label: t.name, description: t.type }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a target' });
    return pick?.label;
}
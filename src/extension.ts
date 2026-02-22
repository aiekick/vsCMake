import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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
import { ImpactedTargetsProvider } from './providers/impacted_targets_provider';

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
let impactedProvider: ImpactedTargetsProvider | null = null;
let configView: vscode.TreeView<unknown> | null = null;
let outlineView: vscode.TreeView<unknown> | null = null;
let impactedView: vscode.TreeView<unknown> | null = null;
let lastReply: CmakeReply | null = null;
let currentPresets: ResolvedPresets | null = null;
let sourceDir: string | null = null;
let buildDir: string | null = null;
let taskStatusBar: vscode.StatusBarItem | null = null;
let availableKits: Kit[] = [];
let wsState: vscode.Memento | null = null;

const BUILD_DIR_STATE_KEY = 'vsCMake.buildDir';

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

    wsState = context.workspaceState;

    statusProvider = new ProjectStatusProvider();
    outlineProvider = new ProjectOutlineProvider();
    configProvider = new ConfigProvider();
    impactedProvider = new ImpactedTargetsProvider();

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

    impactedView = vscode.window.createTreeView('vsCMakeImpacted', {
        treeDataProvider: impactedProvider,
        showCollapseAll: false,
    });

    // Update impacted targets when active editor changes
    impactedProvider.setActiveFile(
        vscode.window.activeTextEditor?.document.uri.fsPath ?? null
    );
    vscode.window.onDidChangeActiveTextEditor(editor => {
        impactedProvider!.setActiveFile(editor?.document.uri.fsPath ?? null);
    }, null, context.subscriptions);

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
        ['vsCMake.buildImpactedSection', (node: unknown) => cmdBuildImpactedSection(node)],
        ['vsCMake.rebuildImpactedSection', (node: unknown) => cmdRebuildImpactedSection(node)],
        ['vsCMake.expandAllImpacted', cmdExpandAllImpacted],
        ['vsCMake.collapseAllImpacted', cmdCollapseAllImpacted],
        ['vsCMake.filterImpacted', cmdFilterImpacted],
        ['vsCMake.clearFilterImpacted', cmdClearFilterImpacted],
        ['vsCMake.testImpactedTarget', (node: unknown) => cmdTestImpactedTarget(node)],
        ['vsCMake.testImpactedSection', (node: unknown) => cmdTestImpactedSection(node)],
        ['vsCMake.filterOutline', cmdFilterOutline],
        ['vsCMake.clearFilterOutline', cmdClearFilterOutline],
        ['vsCMake.expandAllOutline', cmdExpandAllOutline],
        ['vsCMake.clean', cmdClean],
        ['vsCMake.install', cmdInstall],
        ['vsCMake.test', cmdTest],
        ['vsCMake.debug', cmdDebug],
        ['vsCMake.launch', cmdLaunch],
        ['vsCMake.refresh', cmdRefresh],
        ['vsCMake.refreshOutline', cmdRefreshOutline],
        ['vsCMake.refreshConfig', cmdRefreshConfig],
        ['vsCMake.refreshImpacted', cmdRefreshImpacted],
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
        ['vsCMake.openSettings', cmdOpenSettings],
    ];

    for (const [id, handler] of cmds) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    context.subscriptions.push(statusView, outlineView, configView, impactedView, runner);

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
    // Priority: settings > persisted state (handles preset-resolved paths)
    const savedBuild = resolveSettingPath(cfg.get<string>('buildDir'))
        || wsState.get<string>(BUILD_DIR_STATE_KEY)
        || null;
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
    wsState?.update(BUILD_DIR_STATE_KEY, dir);
    apiClient = new ApiClient(dir);

    if (!hasCMakeLists()) {
        await loadPresets();
        return;
    }

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

        impactedProvider!.refresh(lastReply.targets, src);

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

    // Only use preset mode if the preset actually exists in the loaded presets
    if (presetName && currentPresets?.configurePresets.find(p => p.name === presetName)) {
        // The preset can override the buildDir
        const presetBuildDir = resolvePresetBuildDir(presetName, src);
        if (presetBuildDir) {
            if (checkInSourceBuild(presetBuildDir, src)) { return; }
            await ensureBuildDir(presetBuildDir);
        } else if (!buildDir) {
            vscode.window.showWarningMessage('vsCMake: no build folder defined (neither in settings nor in preset).');
            return;
        } else if (checkInSourceBuild(buildDir, src)) {
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
        if (checkInSourceBuild(buildDir, src)) { return; }
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
    wsState?.update(BUILD_DIR_STATE_KEY, dir);
    apiClient = new ApiClient(dir);

    if (!hasCMakeLists()) { return; }

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
    const config = statusProvider?.currentConfig;
    const result = await runner.build(buildDir, targetName, config || undefined);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`vsCMake: build of '${targetName}' failed (code ${result.code})`);
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
    const config = statusProvider?.currentConfig;
    const result = await runner.cleanAndBuildTarget(buildDir, targetName, config || undefined, cmakePath);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`vsCMake: rebuild of '${targetName}' failed (code ${result.code})`);
    }
}

async function cmdBuildImpactedSection(node?: unknown): Promise<void> {
    if (!runner || !buildDir) { return; }
    const targets = extractSectionTargetNames(node);
    if (!targets.length) { return; }
    const cmakePath = getCmakePath();
    const config = statusProvider?.currentConfig;
    const jobs = statusProvider?.currentBuildJobs || 0;
    const result = await runner.buildTargets(buildDir, targets, config || undefined, cmakePath, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`vsCMake: build of section failed (code ${result.code})`);
    }
}

async function cmdRebuildImpactedSection(node?: unknown): Promise<void> {
    if (!runner || !buildDir) { return; }
    const targets = extractSectionTargetNames(node);
    if (!targets.length) { return; }
    const cmakePath = getCmakePath();
    const config = statusProvider?.currentConfig;
    const result = await runner.cleanAndBuildTargets(buildDir, targets, config || undefined, cmakePath);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`vsCMake: rebuild of section failed (code ${result.code})`);
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
    await vscode.commands.executeCommand('workbench.actions.treeView.vsCMakeImpacted.collapseAll');
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
        await vscode.commands.executeCommand('setContext', 'vsCMake.impactedFilterActive', false);
    } else {
        impactedProvider.setFilter(input);
        await vscode.commands.executeCommand('setContext', 'vsCMake.impactedFilterActive', true);
    }
}

async function cmdClearFilterImpacted(): Promise<void> {
    if (!impactedProvider) { return; }
    impactedProvider.clearFilter();
    await vscode.commands.executeCommand('setContext', 'vsCMake.impactedFilterActive', false);
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
    const config = statusProvider?.currentConfig;
    const jobs = statusProvider?.currentTestJobs || 0;
    const regex = impactedProvider?.isTestTarget(targetName)
        ? impactedProvider.getTestRegex(targetName)
        : escapeRegex(targetName);
    const result = await runner.testByRegex(buildDir, regex, config || undefined, ctestPath, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`vsCMake: test '${targetName}' failed (code ${result.code})`);
    }
}

async function cmdTestImpactedSection(node?: unknown): Promise<void> {
    if (!runner || !buildDir) { return; }
    if (!node || typeof node !== 'object') { return; }
    const sectionId = (node as { sectionId?: string }).sectionId;
    const targets = extractSectionTargetNames(node);
    if (!targets.length) { return; }
    const ctestPath = getCtestPath();
    const config = statusProvider?.currentConfig;
    const jobs = statusProvider?.currentTestJobs || 0;
    const regex = sectionId === 'tests' && impactedProvider
        ? impactedProvider.getTestSectionRegex(targets)
        : targets.map(n => escapeRegex(n)).join('|');
    const result = await runner.testByRegex(buildDir, regex, config || undefined, ctestPath, jobs);
    if (!result.success && !result.cancelled) {
        vscode.window.showErrorMessage(`vsCMake: tests failed (code ${result.code})`);
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
        await vscode.commands.executeCommand('setContext', 'vsCMake.outlineFilterActive', false);
    } else {
        outlineProvider.setFilter(input);
        await vscode.commands.executeCommand('setContext', 'vsCMake.outlineFilterActive', true);
    }
}

async function cmdClearFilterOutline(): Promise<void> {
    if (!outlineProvider) { return; }
    outlineProvider.clearFilter();
    await vscode.commands.executeCommand('setContext', 'vsCMake.outlineFilterActive', false);
}

async function cmdExpandAllOutline(): Promise<void> {
    if (!outlineProvider || !outlineView) { return; }
    const roots = outlineProvider.getChildren();
    for (const node of roots) {
        if ('kind' in node && (node.kind === 'folder' || node.kind === 'target')) {
            try {
                await (outlineView as vscode.TreeView<unknown>).reveal(node, {
                    expand: 2, select: false, focus: false,
                });
            } catch { /* node may not be revealable */ }
        }
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
        // Match WORKING_DIRECTORY against each EXECUTABLE target's paths.build.
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

/** Refresh Outline + Impacted from reply files (codemodel + targets) */
async function cmdRefreshOutline(): Promise<void> {
    await loadReply();
}

/** Refresh Config pane from cache file only */
async function cmdRefreshConfig(): Promise<void> {
    if (!apiClient) { return; }
    try {
        const cache = await apiClient.loadCache();
        configProvider!.refresh(cache);
    } catch (err) {
        vscode.window.showErrorMessage(
            `vsCMake: cache read error — ${(err as Error).message}`
        );
    }
}

/** Refresh Impacted Targets from reply files (codemodel + targets) */
async function cmdRefreshImpacted(): Promise<void> {
    await loadReply();
}

async function cmdOpenSettings(): Promise<void> {
    await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:aiekick.vscmake'
    );
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

function hasCMakeLists(): boolean {
    const src = sourceDir ?? getWorkspaceDir();
    if (!src) { return false; }
    return fs.existsSync(path.join(src, 'CMakeLists.txt'));
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

/** Returns true if both paths resolve to the same directory. */
function isSameDirectory(a: string, b: string): boolean {
    return path.resolve(a) === path.resolve(b);
}

/**
 * Checks if an in-source build should be blocked (build dir == source dir).
 * Returns true if the build was rejected (caller should abort).
 * Respects the vsCMake.preventInSourceBuild setting.
 */
function checkInSourceBuild(effectiveBuildDir: string, src: string): boolean {
    if (!vscode.workspace.getConfiguration('vsCMake').get<boolean>('preventInSourceBuild', true)) {
        return false;
    }
    if (!isSameDirectory(effectiveBuildDir, src)) {
        return false;
    }
    const msg = `In-source build rejected: build directory is the same as source directory (${src}). `
        + 'Please set a different build directory in settings (vsCMake.buildDir) or in your CMake preset (binaryDir). '
        + 'You can disable this check with the setting vsCMake.preventInSourceBuild.';
    runner?.logToOutput(`✗ ${msg}`);
    vscode.window.showErrorMessage(`vsCMake: ${msg}`);
    return true;
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
import * as vscode from 'vscode';
import { Codemodel, Target } from '../cmake/types';
import { ResolvedPresets } from '../cmake/preset_reader';
import { Kit } from '../cmake/kit_scanner';

// ------------------------------------------------------------
// Node types
// ------------------------------------------------------------
export type SectionId =
  | 'folder' | 'kit' | 'configure'
  | 'build' | 'test' | 'package'
  | 'debug' | 'launch';

export interface SectionNode {
  kind: 'section';
  id: SectionId;
  label: string;
}

export interface ValueNode {
  kind: 'value';
  parentId: SectionId;
  value: string;
  subKind?: 'configChoice' | 'buildConfig' | 'configurePreset' | 'buildPreset'
  | 'testPreset' | 'packagePreset' | 'buildTarget' | 'buildJobs'
  | 'testTarget' | 'testJobs' | 'kitName';
}

export type StatusNode = SectionNode | ValueNode;

// ------------------------------------------------------------
// État interne (persistable)
// ------------------------------------------------------------
type ConfigMode = 'none' | 'single' | 'multi';

const DEFAULT_CONFIGS = ['Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel'];
const DEFAULT_CONFIG = 'Release';

const STATE_KEY = 'vsCMake.statusState';

export interface StatusState {
  sourceDir: string;
  config: string;
  buildConfig: string;
  configurePreset: string;
  buildPreset: string;
  testPreset: string;
  packagePreset: string;
  buildTarget: string;
  buildJobs: number;
  selectedTest: string;
  testJobs: number;
  debug: string;
  launch: string;
  kitName: string;
}

function defaultState(): StatusState {
  return {
    sourceDir: '',
    config: DEFAULT_CONFIG,
    buildConfig: '',
    configurePreset: '',
    buildPreset: '',
    testPreset: '',
    packagePreset: '',
    buildTarget: 'all',
    buildJobs: 0,
    selectedTest: 'all',
    testJobs: 0,
    debug: '',
    launch: '',
    kitName: '',
  };
}

// ------------------------------------------------------------
// ProjectStatusProvider
// ------------------------------------------------------------
export class ProjectStatusProvider implements vscode.TreeDataProvider<StatusNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;

  private readonly _onActiveConfigChanged = new vscode.EventEmitter<string>();
  readonly onActiveConfigChanged: vscode.Event<string> = this._onActiveConfigChanged.event;

  private configs: string[] = [];
  private targets: Target[] = [];
  private execTargets: Target[] = [];
  private presets: ResolvedPresets | null = null;
  private configMode: ConfigMode = 'none';

  private hasPackage = false;
  private hasTests = false;
  private testCount = 0;

  private state: StatusState = defaultState();
  private wsState: vscode.Memento | null = null;

  // Kit
  private kits: Kit[] = [];
  private kitScanning = false;
  private kitScanMessage = '';

  // --------------------------------------------------------
  // Persistance
  // --------------------------------------------------------

  private get showJobs(): boolean {
    return vscode.workspace.getConfiguration('vsCMake').get<boolean>('showJobsOption', false);
  }

  private get defaultJobsCount(): number {
    return vscode.workspace.getConfiguration('vsCMake').get<number>('defaultJobs', 0);
  }

  initPersistence(wsState: vscode.Memento): void {
    this.wsState = wsState;
    const saved = wsState.get<StatusState>(STATE_KEY);
    if (saved) {
      this.state = { ...defaultState(), ...saved };
    }
  }

  private persist(): void {
    if (this.wsState) {
      this.wsState.update(STATE_KEY, this.state);
    }
  }

  get savedSourceDir(): string { return this.state.sourceDir; }

  // --------------------------------------------------------
  // Mise à jour depuis extension.ts
  // --------------------------------------------------------

  updateSourceDir(dir: string): void {
    this.state.sourceDir = dir;
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  setPresets(p: ResolvedPresets | null): void {
    this.presets = p;
    if (p) {
      if (!p.configurePresets.find(x => x.name === this.state.configurePreset)) {
        this.state.configurePreset = p.configurePresets[0]?.name ?? '';
      }
      if (!p.buildPresets.find(x => x.name === this.state.buildPreset)) {
        this.state.buildPreset = p.buildPresets[0]?.name ?? '';
      }
      if (!p.testPresets.find(x => x.name === this.state.testPreset)) {
        this.state.testPreset = p.testPresets[0]?.name ?? '';
      }
      if (!p.packagePresets.find(x => x.name === this.state.packagePreset)) {
        this.state.packagePreset = p.packagePresets[0]?.name ?? '';
      }
    } else {
      // No preset file found — clear all preset selections to avoid stale references
      this.state.configurePreset = '';
      this.state.buildPreset = '';
      this.state.testPreset = '';
      this.state.packagePreset = '';
    }
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  refreshFromCodemodel(sourceDir: string, codemodel: Codemodel, targets: Target[], cmakeInputs?: string[], buildDir?: string): void {
    this.state.sourceDir = sourceDir;
    this.targets = targets;
    this.execTargets = targets.filter(t => t.type === 'EXECUTABLE');

    this.hasPackage = targets.some(t => t.type === 'UTILITY' && t.name === 'package')
      || (cmakeInputs ?? []).some(f => /CPackConfig\.cmake$|CPack[^/\\]*\.cmake$/.test(f));

    this.configs = codemodel.configurations.map(c => c.name || '(default)');
    this.configMode = this.detectConfigMode(codemodel);

    if (this.configMode === 'multi') {
      if (!this.configs.includes(this.state.buildConfig)) {
        this.state.buildConfig = this.configs[0] ?? DEFAULT_CONFIG;
      }
    }

    if (!this.state.buildTarget) { this.state.buildTarget = 'all'; }
    if (!this.state.debug && this.execTargets.length) { this.state.debug = this.execTargets[0].name; }
    if (!this.state.launch && this.execTargets.length) { this.state.launch = this.execTargets[0].name; }

    this.persist();
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.configs = [];
    this.targets = [];
    this.execTargets = [];
    this.presets = null;
    this.configMode = 'none';
    this.hasPackage = false;
    this.hasTests = false;
    this.kits = [];
    this.state = defaultState();
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  // --------------------------------------------------------
  // Getters
  // --------------------------------------------------------

  get currentConfig(): string {
    if (this.configMode === 'multi') { return this.state.buildConfig || DEFAULT_CONFIG; }
    return this.state.config || DEFAULT_CONFIG;
  }
  get currentBuildTarget(): string { return this.state.buildTarget || 'all'; }
  get currentBuildConfig(): string { return this.state.buildConfig; }
  get currentDebugTarget(): string { return this.state.debug; }
  get currentLaunchTarget(): string { return this.state.launch; }
  get currentConfigurePreset(): string | undefined { return this.state.configurePreset || undefined; }
  get currentBuildPreset(): string | undefined { return this.state.buildPreset || undefined; }
  get currentTestPreset(): string | undefined { return this.state.testPreset || undefined; }
  get currentPackagePreset(): string | undefined { return this.state.packagePreset || undefined; }
  get currentSelectedTest(): string { return this.state.selectedTest || 'all'; }
  get currentBuildJobs(): number {
    return this.state.buildJobs || this.presetBuildJobs || this.defaultJobsCount;
  }
  get currentTestJobs(): number {
    return this.state.testJobs || this.presetTestJobs || this.defaultJobsCount;
  }

  private get presetBuildJobs(): number {
    if (!this.presets?.buildPresets.length) { return 0; }
    const p = this.presets.buildPresets.find(x => x.name === this.state.buildPreset);
    return p?.jobs ?? 0;
  }

  private get presetTestJobs(): number {
    return 0;
  }

  setTestCount(count: number): void {
    this.testCount = count;
    this._onDidChangeTreeData.fire();
  }

  setSelectedTest(name: string): void {
    this.state.selectedTest = name;
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  // --------------------------------------------------------
  // Kit
  // --------------------------------------------------------

  get currentKit(): Kit | undefined {
    return this.kits.find(k => k.name === this.state.kitName);
  }

  get currentKitName(): string { return this.state.kitName; }

  setKits(kits: Kit[]): void {
    this.kits = kits;
    if (kits.length && !kits.find(k => k.name === this.state.kitName)) {
      this.state.kitName = kits[0].name;
    }
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  setKitScanning(scanning: boolean): void {
    this.kitScanning = scanning;
    if (!scanning) { this.kitScanMessage = ''; }
    this._onDidChangeTreeData.fire();
  }

  setKitScanMessage(msg: string): void {
    this.kitScanMessage = msg;
    this._onDidChangeTreeData.fire();
  }

  async pickKit(): Promise<void> {
    if (!this.kits.length) {
      vscode.window.showWarningMessage('vsCMake: no kit detected. Run "Scan for Compilers".');
      return;
    }
    const items = this.kits.map(k => ({
      label: k.name,
      description: k.description,
      detail: k.compilers.cxx ? `C++: ${k.compilers.cxx}` : undefined,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a kit (compiler)',
    });
    if (!picked) { return; }
    this.state.kitName = picked.label;
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  // --------------------------------------------------------
  // TreeDataProvider
  // --------------------------------------------------------

  getTreeItem(node: StatusNode): vscode.TreeItem {
    return node.kind === 'section' ? this.sectionItem(node) : this.valueItem(node);
  }

  getChildren(node?: StatusNode): StatusNode[] {
    if (!node) {
      const ids = this.visibleSections();
      return ids.map(id => ({ kind: 'section' as const, id, label: this.labelFor(id) }));
    }
    if (node.kind === 'section') {
      return this.sectionChildren(node);
    }
    return [];
  }

  getParent(node: StatusNode): StatusNode | null {
    if (node.kind === 'value') {
      return { kind: 'section', id: node.parentId, label: this.labelFor(node.parentId) };
    }
    return null;
  }

  // --------------------------------------------------------
  // Enfants par section
  // --------------------------------------------------------

  private sectionChildren(node: SectionNode): ValueNode[] {
    const hasConfigurePresets = !!this.presets?.configurePresets.length;
    const hasBuildPresets = !!this.presets?.buildPresets.length;

    if (node.id === 'kit') {
      if (this.kitScanning) {
        const msg = this.kitScanMessage || 'Scan en cours…';
        return [{ kind: 'value', parentId: 'kit', value: `$(sync~spin) ${msg}` }];
      }
      const label = this.state.kitName || '[Unspecified]';
      return [{ kind: 'value', parentId: 'kit', value: `Kit : ${label}`, subKind: 'kitName' }];
    }

    if (node.id === 'configure') {
      if (hasConfigurePresets) {
        return [{ kind: 'value', parentId: 'configure', value: `Preset : ${this.configurePresetLabel()}`, subKind: 'configurePreset' }];
      }
      return [{ kind: 'value', parentId: 'configure', value: `Config : ${this.state.config || DEFAULT_CONFIG}`, subKind: 'configChoice' }];
    }

    if (node.id === 'build') {
      const children: ValueNode[] = [];
      if (hasBuildPresets) {
        children.push({ kind: 'value', parentId: 'build', value: `Preset : ${this.buildPresetLabel()}`, subKind: 'buildPreset' });
        if (this.isCurrentPresetMultiConfig() && !this.currentBuildPresetHasConfig()) {
          children.push({ kind: 'value', parentId: 'build', value: `Config : ${this.state.buildConfig || DEFAULT_CONFIG}`, subKind: 'buildConfig' });
        }
      } else {
        children.push({ kind: 'value', parentId: 'build', value: `Config : ${this.state.buildConfig || this.state.config || DEFAULT_CONFIG}`, subKind: 'buildConfig' });
      }
      children.push({ kind: 'value', parentId: 'build', value: `Target : ${this.state.buildTarget || 'all'}`, subKind: 'buildTarget' });
      if (this.showJobs) {
        const jobs = this.state.buildJobs || this.presetBuildJobs || this.defaultJobsCount;
        children.push({ kind: 'value', parentId: 'build', value: `Jobs : ${jobs || 'auto'}`, subKind: 'buildJobs' });
      }
      return children;
    }

    if (node.id === 'test') {
      const children: ValueNode[] = [];
      if (this.presets?.testPresets.length) {
        const p = this.presets.testPresets.find(x => x.name === this.state.testPreset);
        const label = p?.displayName ?? this.presets.testPresets[0]?.displayName ?? '—';
        children.push({ kind: 'value', parentId: 'test', value: `Preset : ${label}`, subKind: 'testPreset' });
      }
      children.push({ kind: 'value', parentId: 'test', value: `Test : ${this.state.selectedTest || 'all'}`, subKind: 'testTarget' as any });
      if (this.showJobs) {
        const jobs = this.state.testJobs || this.presetTestJobs || this.defaultJobsCount;
        children.push({ kind: 'value', parentId: 'test', value: `Jobs : ${jobs || 'auto'}`, subKind: 'testJobs' as any });
      }
      return children;
    }

    return [{ kind: 'value', parentId: node.id, value: this.valueFor(node.id) }];
  }

  // --------------------------------------------------------
  // TreeItems
  // --------------------------------------------------------

  private sectionItem(node: SectionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = new vscode.ThemeIcon(this.iconFor(node.id));
    item.contextValue = `statusSection_${node.id}`;
    return item;
  }

  private valueItem(node: ValueNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.value || '—', vscode.TreeItemCollapsibleState.None);

    if (node.subKind === 'kitName') {
      item.iconPath = new vscode.ThemeIcon('tools');
      item.contextValue = 'statusValue_kitName';
    } else if (node.subKind === 'configChoice') {
      item.iconPath = new vscode.ThemeIcon('symbol-interface');
      item.contextValue = 'statusValue_configChoice';
    } else if (node.subKind === 'buildConfig') {
      item.iconPath = new vscode.ThemeIcon('symbol-interface');
      item.contextValue = 'statusValue_buildConfig';
    } else if (node.subKind === 'buildTarget') {
      item.iconPath = new vscode.ThemeIcon('build');
      item.contextValue = 'statusValue_buildTarget';
    } else if (node.subKind === 'testTarget') {
      item.iconPath = new vscode.ThemeIcon('beaker');
      item.contextValue = 'statusValue_testTarget';
    } else if (node.subKind === 'buildJobs') {
      item.iconPath = new vscode.ThemeIcon('versions');
      item.contextValue = 'statusValue_buildJobs';
    } else if (node.subKind === 'testJobs') {
      item.iconPath = new vscode.ThemeIcon('versions');
      item.contextValue = 'statusValue_testJobs';
    } else {
      if (node.subKind === 'configurePreset' || node.subKind === 'buildPreset' || node.subKind === 'testPreset' || node.subKind === 'packagePreset') {
        item.iconPath = new vscode.ThemeIcon('json');
      } else {
        item.iconPath = new vscode.ThemeIcon('circle-small-filled');
      }
      item.contextValue = `statusValue_${node.parentId}`;
      item.command = { command: `vsCMake.pick_${node.parentId}`, title: 'Modifier', arguments: [] };
    }
    return item;
  }

  // --------------------------------------------------------
  // Pickers
  // --------------------------------------------------------

  async pickConfigChoice(): Promise<void> {
    const fromCodemodel = this.configs.filter(c => c && c !== '(default)' && !DEFAULT_CONFIGS.includes(c));
    const all = [...new Set([...DEFAULT_CONFIGS, ...fromCodemodel])];
    const items = all.map(c => ({
      label: c,
      description: c === this.state.config ? '(current)' : '',
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select CMAKE_BUILD_TYPE',
    });
    if (!picked) { return; }
    this.state.config = picked.label;
    this.persist();
    this._onDidChangeTreeData.fire();
    this._onActiveConfigChanged.fire(picked.label);
  }

  async pickBuildConfig(): Promise<void> {
    const fromCodemodel = this.configs.filter(c => c && c !== '(default)' && !DEFAULT_CONFIGS.includes(c));
    const all = [...new Set([...DEFAULT_CONFIGS, ...fromCodemodel])];
    const items = all.map(c => ({
      label: c,
      description: c === this.state.buildConfig ? '(current)' : '',
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select build configuration (Debug, Release…)',
    });
    if (!picked) { return; }
    this.state.buildConfig = picked.label;
    this.persist();
    this._onDidChangeTreeData.fire();
    this._onActiveConfigChanged.fire(picked.label);
  }

  async pickConfigure(): Promise<void> {
    if (this.presets?.configurePresets.length) {
      const items = this.presets.configurePresets.map(p => ({
        label: p.displayName,
        description: p.name,
        detail: [p.generator, p.binaryDir].filter(Boolean).join('  →  '),
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a configure preset' });
      if (!picked) { return; }
      this.state.configurePreset = picked.description!;
      this.cascadeFromConfigurePreset();
      this.persist();
      this._onDidChangeTreeData.fire();
    } else {
      await this.pickConfigChoice();
      return;
    }
  }

  async pickBuild(): Promise<void> {
    if (this.presets?.buildPresets.length) {
      const compatible = this.compatibleBuildPresets();
      const items = compatible.map(p => ({
        label: p.displayName,
        description: p.name,
        detail: p.targets ? `targets: ${p.targets.join(', ')}` : undefined,
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a build preset' });
      if (!picked) { return; }
      this.state.buildPreset = picked.description!;
      if (this.currentBuildPresetHasConfig()) { this.state.buildConfig = ''; }
    }
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  private static readonly EXCLUDED_TARGETS = new Set([
    'ALL_BUILD', 'ZERO_CHECK', 'RUN_TESTS', 'INSTALL', 'PACKAGE',
  ]);

  async pickBuildTarget(): Promise<void> {
    const seen = new Set<string>();
    const targetItems = this.targets
      .filter(t => {
        if (t.type === 'UTILITY') { return false; }
        if (ProjectStatusProvider.EXCLUDED_TARGETS.has(t.name)) { return false; }
        if (seen.has(t.name)) { return false; }
        seen.add(t.name);
        return true;
      })
      .map(t => ({ label: t.name, description: t.type }));

    const items = [
      { label: 'all', description: 'Build all' },
      { label: 'install', description: 'cmake --install' },
      ...targetItems,
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select the build target' });
    if (!picked) { return; }
    this.state.buildTarget = picked.label;
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  async pickTest(): Promise<void> {
    if (this.presets?.testPresets.length) {
      const compatible = this.compatibleTestPresets();
      const items = compatible.map(p => ({
        label: p.displayName,
        description: p.name,
        detail: p.configurePreset ? `configure: ${p.configurePreset}` : undefined,
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a test preset' });
      if (!picked) { return; }
      this.state.testPreset = picked.description!;
    }
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  async pickTestTarget(availableTests: { name: string }[]): Promise<void> {
    const items = [
      { label: 'all', description: 'All tests' },
      ...availableTests.map(t => ({ label: t.name, description: '' })),
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select the test to run' });
    if (!picked) { return; }
    this.state.selectedTest = picked.label;
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  async pickPackage(): Promise<void> {
    if (this.presets?.packagePresets.length) {
      const compatible = this.compatiblePackagePresets();
      const items = compatible.map(p => ({
        label: p.displayName,
        description: p.name,
        detail: p.generators?.join(', '),
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a package preset' });
      if (!picked) { return; }
      this.state.packagePreset = picked.description!;
    } else {
      const items = [
        { label: 'install', description: 'cmake --install' },
        { label: 'all', description: 'Build all then install' },
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select the package target' });
      if (!picked) { return; }
      this.state.packagePreset = picked.label;
    }
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  async pickBuildJobs(): Promise<void> {
    const presetJobs = this.presetBuildJobs;
    const current = this.state.buildJobs || presetJobs || this.defaultJobsCount;
    const hint = presetJobs ? `(preset: ${presetJobs}) ` : '';
    const input = await vscode.window.showInputBox({
      title: 'Nombre de jobs (build)',
      prompt: `${hint}0 = automatique`,
      value: String(current),
      validateInput: v => /^\d+$/.test(v) ? null : 'Entrez un nombre entier positif',
    });
    if (input === undefined) { return; }
    this.state.buildJobs = parseInt(input, 10);
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  async pickTestJobs(): Promise<void> {
    const presetJobs = this.presetTestJobs;
    const current = this.state.testJobs || presetJobs || this.defaultJobsCount;
    const hint = presetJobs ? `(preset: ${presetJobs}) ` : '';
    const input = await vscode.window.showInputBox({
      title: 'Nombre de jobs (test)',
      prompt: `${hint}0 = automatique`,
      value: String(current),
      validateInput: v => /^\d+$/.test(v) ? null : 'Entrez un nombre entier positif',
    });
    if (input === undefined) { return; }
    this.state.testJobs = parseInt(input, 10);
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  async pickDebug(): Promise<void> {
    if (!this.execTargets.length) {
      vscode.window.showWarningMessage('vsCMake: no executable available.');
      return;
    }
    const items = this.execTargets.map(t => ({ label: t.name, description: t.nameOnDisk ?? '' }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select the binary to debug' });
    if (!picked) { return; }
    this.state.debug = picked.label;
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  async pickLaunch(): Promise<void> {
    if (!this.execTargets.length) {
      vscode.window.showWarningMessage('vsCMake: no executable available.');
      return;
    }
    const items = this.execTargets.map(t => ({ label: t.name, description: t.nameOnDisk ?? '' }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select the binary to launch' });
    if (!picked) { return; }
    this.state.launch = picked.label;
    this.persist();
    this._onDidChangeTreeData.fire();
  }

  // --------------------------------------------------------
  // Helpers — labels
  // --------------------------------------------------------

  private labelFor(id: SectionId): string {
    switch (id) {
      case 'folder': return 'Folder';
      case 'kit': return 'Kit';
      case 'configure': return 'Configure';
      case 'build': return 'Build';
      case 'test': return 'Test';
      case 'package': return 'Package';
      case 'debug': return 'Debug';
      case 'launch': return 'Launch';
    }
  }

  private valueFor(id: SectionId): string {
    switch (id) {
      case 'folder': return `Folder : ${this.shortPath(this.state.sourceDir)}`;
      case 'kit': return `Kit : ${this.state.kitName || '[Unspecified]'}`;
      case 'configure': {
        if (this.presets?.configurePresets.length) {
          return `Preset : ${this.configurePresetLabel()}`;
        }
        return `Config : ${this.state.config || DEFAULT_CONFIG}`;
      }
      case 'build': return this.buildValueLabel();
      case 'debug': return `Target : ${this.state.debug || '—'}`;
      case 'launch': return `Target : ${this.state.launch || '—'}`;
      case 'test': {
        if (this.presets?.testPresets.length) {
          const p = this.presets.testPresets.find(x => x.name === this.state.testPreset);
          const label = p?.displayName ?? this.presets.testPresets[0]?.displayName ?? '—';
          return `Preset : ${label}`;
        }
        return this.state.selectedTest || 'all';
      }
      case 'package': {
        if (this.presets?.packagePresets.length) {
          const p = this.presets.packagePresets.find(x => x.name === this.state.packagePreset);
          const label = p?.displayName ?? this.presets.packagePresets[0]?.displayName ?? '—';
          return `Preset : ${label}`;
        }
        return this.state.packagePreset || 'install';
      }
    }
  }

  private configurePresetLabel(): string {
    const p = this.presets?.configurePresets.find(x => x.name === this.state.configurePreset);
    return p?.displayName ?? this.presets?.configurePresets[0]?.displayName ?? '—';
  }

  private buildPresetLabel(): string {
    const p = this.presets?.buildPresets.find(x => x.name === this.state.buildPreset);
    return p?.displayName ?? this.presets?.buildPresets[0]?.displayName ?? '—';
  }

  private buildValueLabel(): string {
    if (this.presets?.buildPresets.length) {
      return this.buildPresetLabel();
    }
    return this.state.buildTarget || 'all';
  }

  private iconFor(id: SectionId): string {
    switch (id) {
      case 'folder': return 'window';
      case 'kit': return 'tools';
      case 'configure': return 'tools';
      case 'build': return 'build';
      case 'test': return 'beaker';
      case 'package': return 'package';
      case 'debug': return 'debug';
      case 'launch': return 'run';
    }
  }

  // --------------------------------------------------------
  // Sections visibles
  // --------------------------------------------------------

  private visibleSections(): SectionId[] {
    const sections: SectionId[] = ['folder'];
    if (!this.presets || !this.presets.configurePresets.length) {
      sections.push('kit');
    }
    sections.push('configure', 'build', 'debug', 'launch');
    if (this.testCount > 0 || (this.presets?.testPresets.length ?? 0) > 0) {
      sections.push('test');
    }
    if (this.hasPackage || (this.presets?.packagePresets.length ?? 0) > 0) {
      sections.push('package');
    }
    return sections;
  }

  // --------------------------------------------------------
  // Detection single / multi config
  // --------------------------------------------------------

  private static readonly MULTI_CONFIG_GENERATORS = [
    'ninja multi-config', 'visual studio', 'xcode',
  ];

  private detectConfigMode(codemodel: Codemodel): ConfigMode {
    if (!codemodel.configurations?.length) { return 'none'; }
    if (codemodel.configurations.length > 1) { return 'multi'; }
    const preset = this.presets?.configurePresets.find(
      p => p.name === this.state.configurePreset
    );
    if (preset?.generator) {
      const gen = preset.generator.toLowerCase();
      const isMulti = ProjectStatusProvider.MULTI_CONFIG_GENERATORS.some(m => gen.includes(m));
      return isMulti ? 'multi' : 'single';
    }
    return 'single';
  }

  private isCurrentPresetMultiConfig(): boolean {
    const preset = this.presets?.configurePresets.find(
      p => p.name === this.state.configurePreset
    );
    if (!preset?.generator) { return this.configMode === 'multi'; }
    const gen = preset.generator.toLowerCase();
    return ProjectStatusProvider.MULTI_CONFIG_GENERATORS.some(m => gen.includes(m));
  }

  private currentBuildPresetHasConfig(): boolean {
    const preset = this.presets?.buildPresets.find(
      p => p.name === this.state.buildPreset
    );
    return !!preset?.configuration;
  }

  // --------------------------------------------------------
  // Filtrage par configure preset
  // --------------------------------------------------------

  private isCompatible(configurePreset?: string): boolean {
    if (!configurePreset) { return true; }
    return configurePreset === this.state.configurePreset;
  }

  private compatibleBuildPresets() {
    return (this.presets?.buildPresets ?? []).filter(p => this.isCompatible(p.configurePreset));
  }

  private compatibleTestPresets() {
    return (this.presets?.testPresets ?? []).filter(p => this.isCompatible(p.configurePreset));
  }

  private compatiblePackagePresets() {
    return (this.presets?.packagePresets ?? []).filter(p => this.isCompatible(p.configurePreset));
  }

  private cascadeFromConfigurePreset(): void {
    if (!this.compatibleBuildPresets().find(p => p.name === this.state.buildPreset)) {
      this.state.buildPreset = this.compatibleBuildPresets()[0]?.name ?? '';
    }
    if (!this.compatibleTestPresets().find(p => p.name === this.state.testPreset)) {
      this.state.testPreset = this.compatibleTestPresets()[0]?.name ?? '';
    }
    if (!this.compatiblePackagePresets().find(p => p.name === this.state.packagePreset)) {
      this.state.packagePreset = this.compatiblePackagePresets()[0]?.name ?? '';
    }
  }

  private shortPath(p: string): string {
    if (!p) { return '—'; }
    return p.replace(/\\/g, '/').split('/').at(-1) ?? p;
  }
}
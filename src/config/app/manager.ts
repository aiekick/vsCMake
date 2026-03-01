import * as vscode from 'vscode';
import { AppConfig as AppConfigTypes } from './types';
import { AppConfigDefault as DefaultConfig } from './default';

const CONFIG_SECTION = 'CMakeGraph';

// The AppConfigManager is responsible for loading, storing and updating
// the application-level (global/user) settings and providing a centralized
// API to access these settings in the extension.
export class AppConfigManager implements vscode.Disposable {
    private _settings: AppConfigTypes.Settings;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

    constructor() {
        this._settings = DefaultConfig;
        this.loadConfig();
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(aEvent => {
                if (aEvent.affectsConfiguration(CONFIG_SECTION)) {
                    this.loadConfig();
                    this._onDidChange.fire();
                }
            }),
        );
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._onDidChange.dispose();
    }

    // ---- Read ----

    get settings(): AppConfigTypes.Settings {
        return this._settings;
    }

    // ---- Write ----

    // Update a single app-level setting (stored in user/global settings).
    async updateSetting(aKey: string, aValue: unknown): Promise<void> {
        await vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .update(aKey, aValue, vscode.ConfigurationTarget.Global);
        // loadConfig() will be triggered automatically by onDidChangeConfiguration
    }

    // ---- Path resolution ----

    resolvePath(aValue: string | undefined): string | null {
        if (!aValue) { return null; }
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (ws) {
            return aValue.replace(/\$\{workspaceFolder\}/g, ws);
        }
        if (aValue.includes('${workspaceFolder}')) { return null; }
        return aValue;
    }

    get resolvedCmakePath(): string {
        return this.resolvePath(this._settings.cmakePath) || '';
    }

    get resolvedCtestPath(): string {
        return this.resolvePath(this._settings.ctestPath) || '';
    }

    get resolvedCpackPath(): string {
        return this.resolvePath(this._settings.cpackPath) || '';
    }

    // ---- Internal ----

    private loadConfig(): void {
        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        this._settings = {
            cmakePath: cfg.get<string>('cmakePath', DefaultConfig.cmakePath),
            ctestPath: cfg.get<string>('ctestPath', DefaultConfig.ctestPath),
            cpackPath: cfg.get<string>('cpackPath', DefaultConfig.cpackPath),
            clearOutputBeforeRun: cfg.get<boolean>('clearOutputBeforeRun', DefaultConfig.clearOutputBeforeRun),
            colorizeOutput: cfg.get<boolean>('colorizeOutput', DefaultConfig.colorizeOutput),
            defaultJobs: cfg.get<number>('defaultJobs', DefaultConfig.defaultJobs),
        };
    }
}

export const appConfigManager = new AppConfigManager();

import * as vscode from 'vscode';
import { WorkspaceConfig as WorkspaceConfigTypes } from './types';
import { WorkspaceConfigDefault as DefaultConfig } from './default';

// the ConfigManager is responsible for loading, storing and updating the workspace configuration settings
// in .vscode/settings.json and providing an API to access these settings in the extension
export class WorkspaceConfigManager {
    private _settings: WorkspaceConfigTypes.Settings;

    constructor() {
        this._settings = { ...DefaultConfig };
        this.loadConfig();
    }

    public loadConfig(): void {

    }

    public get settings(): WorkspaceConfigTypes.Settings {
        return this._settings;
    }

    public async updateSetting(section: string, value: any): Promise<void> {
        const vscodeConfig = vscode.workspace.getConfiguration('cmake-graph');
        await vscodeConfig.update(section, value, vscode.ConfigurationTarget.Global);
        this.loadConfig();
    }
}

export const wksConfigManager = new WorkspaceConfigManager();

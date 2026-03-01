import * as vscode from 'vscode';
import { WorkspaceConfig as WorkspaceConfigTypes } from './types';
import { WorkspaceConfigDefault as DefaultConfig } from './default';

const CONFIG_SECTION = 'CMakeGraph';

// The WorkspaceConfigManager is responsible for loading, storing and updating
// the per-project workspace configuration settings from .vscode/settings.json
// and providing a centralized API to access these settings in the extension.
export class WorkspaceConfigManager implements vscode.Disposable {
    private _settings: WorkspaceConfigTypes.Settings;
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

    get settings(): WorkspaceConfigTypes.Settings {
        return this._settings;
    }

    // ---- Write ----

    // Update a single setting in .vscode/settings.json.
    // The key is the flat VS Code setting name (e.g. 'buildDir', 'graphEdgeDirection').
    async updateSetting(aKey: string, aValue: unknown): Promise<void> {
        await vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .update(aKey, aValue, vscode.ConfigurationTarget.Workspace);
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

    get resolvedBuildDir(): string | null {
        return this.resolvePath(this._settings.general.buildDirectory);
    }

    // ---- Internal ----

    private loadConfig(): void {
        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        this._settings = {
            general: {
                buildDirectory: cfg.get<string>('buildDir', DefaultConfig.general.buildDirectory),
                configType: cfg.get<string>('configType', DefaultConfig.general.configType),
            },
            graph: {
                colors: {
                    ...DefaultConfig.graph.colors,
                    ...cfg.get<Record<string, string>>('graphNodeColors', {}),
                },
                edges: {
                    edgeDirection: cfg.get<WorkspaceConfigTypes.Graph.EdgeDirection>(
                        'graphEdgeDirection', DefaultConfig.graph.edges.edgeDirection),
                    edgeStyle: cfg.get<WorkspaceConfigTypes.Graph.EdgeStyle>(
                        'graphEdgeStyle', DefaultConfig.graph.edges.edgeStyle),
                    taperedWidth: cfg.get<number>('graphTaperedWidth', DefaultConfig.graph.edges.taperedWidth),
                },
                simulation: {
                    params: {
                        repulsion: cfg.get<number>('graphSimRepulsion', DefaultConfig.graph.simulation.params.repulsion),
                        attraction: cfg.get<number>('graphSimAttraction', DefaultConfig.graph.simulation.params.attraction),
                        gravity: cfg.get<number>('graphSimGravity', DefaultConfig.graph.simulation.params.gravity),
                        linkLength: cfg.get<number>('graphSimLinkLength', DefaultConfig.graph.simulation.params.linkLength),
                        minDistance: cfg.get<number>('graphSimMinDistance', DefaultConfig.graph.simulation.params.minDistance),
                        stepsPerFrame: cfg.get<number>('graphSimStepsPerFrame', DefaultConfig.graph.simulation.params.stepsPerFrame),
                        threshold: cfg.get<number>('graphSimThreshold', DefaultConfig.graph.simulation.params.threshold),
                        damping: cfg.get<number>('graphSimDamping', DefaultConfig.graph.simulation.params.damping),
                    },
                    controls: {
                        minimap: cfg.get<boolean>('graphMinimap', DefaultConfig.graph.simulation.controls.minimap),
                        autoPauseDrag: cfg.get<boolean>('graphAutoPauseDrag', DefaultConfig.graph.simulation.controls.autoPauseDrag),
                        simEnabled: cfg.get<boolean>('graphSimEnabled', DefaultConfig.graph.simulation.controls.simEnabled),
                        settingsCollapse: cfg.get<Record<string, boolean>>(
                            'graphSettingsCollapse', DefaultConfig.graph.simulation.controls.settingsCollapse),
                        settingsVisible: cfg.get<boolean>('graphSettingsVisible', DefaultConfig.graph.simulation.controls.settingsVisible),
                    },
                },
            },
        };
    }
}

export const wksConfigManager = new WorkspaceConfigManager();

import * as vscode from 'vscode';
import { Target, TargetType } from '../cmake/types';

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

const TARGET_COLORS: Record<TargetType, string> = {
    EXECUTABLE: '#4CAF50',
    STATIC_LIBRARY: '#2196F3',
    SHARED_LIBRARY: '#FF9800',
    MODULE_LIBRARY: '#9C27B0',
    OBJECT_LIBRARY: '#607D8B',
    INTERFACE_LIBRARY: '#00BCD4',
    UTILITY: '#795548',
};

const TARGET_SHAPES: Record<TargetType, string> = {
    EXECUTABLE: 'diamond',
    STATIC_LIBRARY: 'box',
    SHARED_LIBRARY: 'box',
    MODULE_LIBRARY: 'box',
    OBJECT_LIBRARY: 'box',
    INTERFACE_LIBRARY: 'ellipse',
    UTILITY: 'triangle',
};

/** CMake-generated utility targets that clutter the graph */
const EXCLUDED_TARGETS = new Set([
    'ALL_BUILD', 'ZERO_CHECK', 'RUN_TESTS', 'INSTALL', 'PACKAGE',
]);

// ------------------------------------------------------------
// Graph data sent to webview
// ------------------------------------------------------------
interface GraphNode {
    id: string;
    label: string;
    type: TargetType;
    color: string;
    shape: string;
    sourcePath: string;
}

interface GraphEdge {
    from: string;
    to: string;
}

// ------------------------------------------------------------
// DependencyGraphProvider
// ------------------------------------------------------------
export class DependencyGraphProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'CMakeGraphDependencyGraph';

    private m_view?: vscode.WebviewView;
    private m_targets: Target[] = [];
    private m_pendingUpdate = false;

    constructor(private readonly m_extensionUri: vscode.Uri) { }

    // ---- WebviewViewProvider ----

    resolveWebviewView(
        aWebviewView: vscode.WebviewView,
        aContext: vscode.WebviewViewResolveContext,
        aToken: vscode.CancellationToken,
    ): void {
        this.m_view = aWebviewView;

        aWebviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.m_extensionUri, 'out'),
                vscode.Uri.joinPath(this.m_extensionUri, 'dist'),
                vscode.Uri.joinPath(this.m_extensionUri, 'medias'),
            ],
        };

        aWebviewView.webview.html = this.getHtml(aWebviewView.webview);

        aWebviewView.webview.onDidReceiveMessage(aMsg => this.handleMessage(aMsg));

        // Send pending data if refresh() was called before the view opened
        if (this.m_pendingUpdate) {
            this.sendGraphData();
            this.m_pendingUpdate = false;
        }
    }

    // ---- Public API ----

    refresh(aTargets: Target[]): void {
        this.m_targets = aTargets;
        if (this.m_view) {
            this.sendGraphData();
        } else {
            this.m_pendingUpdate = true;
        }
    }

    toggleLayout(): void {
        this.m_view?.webview.postMessage({ type: 'toggleLayout' });
    }

    showSettings(): void {
        this.m_view?.webview.postMessage({ type: 'showSettings' });
    }

    screenshot(): void {
        this.m_view?.webview.postMessage({ type: 'screenshot' });
    }

    // ---- Data conversion ----

    private sendGraphData(): void {
        const config = vscode.workspace.getConfiguration('CMakeGraph');

        // Merge custom colors onto defaults
        const custom_colors = config.get<Record<string, string>>('graphNodeColors', {});
        const effective_colors: Record<string, string> = { ...TARGET_COLORS };
        for (const [type, color] of Object.entries(custom_colors)) {
            if (color && type in effective_colors) {
                effective_colors[type as keyof typeof effective_colors] = color;
            }
        }

        const filtered = this.m_targets.filter(t => t.type !== 'UTILITY');
        const valid_ids = new Set(filtered.map(t => t.id));

        const nodes: GraphNode[] = filtered.map(t => ({
            id: t.id,
            label: t.name,
            type: t.type,
            color: effective_colors[t.type] ?? TARGET_COLORS[t.type],
            shape: TARGET_SHAPES[t.type],
            sourcePath: t.paths.source,
        }));

        const edges: GraphEdge[] = filtered.flatMap(t =>
            (t.directLinks ?? [])
                .filter(id => valid_ids.has(id))
                .map(id => ({ from: t.id, to: id })),
        );

        const settings = {
            edgeDirection: config.get<GraphEdgeDirection>('graphEdgeDirection', GraphEdgeDirection.TARGETS_USED_BY),
            edgeStyle: config.get<string>('graphEdgeStyle', 'tapered'),
            taperedWidth: config.get<number>('graphTaperedWidth', 1.0),
            simRepulsion: config.get<number>('graphSimRepulsion', 10000),
            simAttraction: config.get<number>('graphSimAttraction', 0.1),
            simGravity: config.get<number>('graphSimGravity', 0.001),
            simLinkLength: config.get<number>('graphSimLinkLength', 0.1),
            simMinDistance: config.get<number>('graphSimMinDistance', 50),
            simStepsPerFrame: config.get<number>('graphSimStepsPerFrame', 2),
            simThreshold: config.get<number>('graphSimThreshold', 0.1),
            simDamping: config.get<number>('graphSimDamping', 0.85),
            minimap: config.get<boolean>('graphMinimap', true),
            autoPauseDrag: config.get<boolean>('graphAutoPauseDrag', false),
            simEnabled: config.get<boolean>('graphSimEnabled', true),
            settingsCollapse: config.get<Record<string, boolean>>('graphSettingsCollapse', { edges: false, colors: true, simulation: true, display: false, controls: false }),
            settingsVisible: config.get<boolean>('graphSettingsVisible', false),
        };

        this.m_view?.webview.postMessage({ type: 'update', nodes, edges, settings });
    }

    // ---- Message handling ----

    private handleMessage(aMsg: any): void {
        switch (aMsg.type) {
            case 'ready':
                this.sendGraphData();
                break;

            case 'nodeClick': {
                // Reveal in Project Outline (reuse existing revealDependency command)
                vscode.commands.executeCommand('CMakeGraph.revealDependency', {
                    kind: 'dependency',
                    target: { id: aMsg.targetId as string },
                });
                break;
            }

            case 'saveScreenshot': {
                this.saveScreenshot(aMsg.dataUri as string);
                break;
            }

            case 'updateSetting': {
                const key = aMsg.key as string;
                const value = aMsg.value;
                vscode.workspace.getConfiguration('CMakeGraph').update(key, value, vscode.ConfigurationTarget.Workspace);
                break;
            }
        }
    }

    private async saveScreenshot(aDataUri: string): Promise<void> {
        const workspace_name = vscode.workspace.name ?? 'project';
        const now = new Date();
        const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        const default_name = `${workspace_name}_dependency_graph_${timestamp}.png`;
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(default_name),
            filters: { 'PNG Image': ['png'] },
        });
        if (!uri) { return; }
        const base64 = aDataUri.replace(/^data:image\/png;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        await vscode.workspace.fs.writeFile(uri, buffer);
        vscode.window.showInformationMessage(`Screenshot saved to ${uri.fsPath}`);
    }

    // ---- HTML ----

    private getHtml(aWebview: vscode.Webview): string {
        const nonce = getNonce();
        const script_uri = aWebview.asWebviewUri(
            vscode.Uri.joinPath(this.m_extensionUri, 'out', 'webview', 'dependency_graph_webview.js'),
        );
        const style_uri = aWebview.asWebviewUri(
            vscode.Uri.joinPath(this.m_extensionUri, 'medias', 'css', 'dependency_graph.css'),
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${aWebview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';
                   img-src ${aWebview.cspSource} blob: data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${style_uri}">
    <title>Dependency Graph</title>
</head>
<body>
    <div id="toolbar">
        <div id="filters"></div>
    </div>
    <div id="breadcrumb-bar"></div>
    <div id="graph-container" style="display:none"></div>
    <div id="empty-message">Waiting for CMake data\u2026</div>
    <div id="footer"></div>
    <script nonce="${nonce}" src="${script_uri}"></script>
</body>
</html>`;
    }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

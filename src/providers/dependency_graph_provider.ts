import * as vscode from 'vscode';
import * as path from 'path';
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
    public static readonly viewId = 'vsCMakeDependencyGraph';

    private view?: vscode.WebviewView;
    private targets: Target[] = [];
    private pendingUpdate = false;

    constructor(private readonly extensionUri: vscode.Uri) { }

    // ---- WebviewViewProvider ----

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'out'),
                vscode.Uri.joinPath(this.extensionUri, 'dist'),
                vscode.Uri.joinPath(this.extensionUri, 'medias'),
            ],
        };

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));

        // Send pending data if refresh() was called before the view opened
        if (this.pendingUpdate) {
            this.sendGraphData();
            this.pendingUpdate = false;
        }
    }

    // ---- Public API ----

    refresh(targets: Target[]): void {
        this.targets = targets;
        if (this.view) {
            this.sendGraphData();
        } else {
            this.pendingUpdate = true;
        }
    }

    toggleLayout(): void {
        this.view?.webview.postMessage({ type: 'toggleLayout' });
    }

    showSettings(): void {
        this.view?.webview.postMessage({ type: 'showSettings' });
    }

    screenshot(): void {
        this.view?.webview.postMessage({ type: 'screenshot' });
    }

    // ---- Data conversion ----

    private sendGraphData(): void {
        const filtered = this.targets.filter(t => t.type !== 'UTILITY');
        const validIds = new Set(filtered.map(t => t.id));

        const nodes: GraphNode[] = filtered.map(t => ({
            id: t.id,
            label: t.name,
            type: t.type,
            color: TARGET_COLORS[t.type],
            shape: TARGET_SHAPES[t.type],
            sourcePath: t.paths.source,
        }));

        const edges: GraphEdge[] = filtered.flatMap(t =>
            (t.dependencies ?? [])
                .filter(d => validIds.has(d.id))
                .map(d => ({ from: t.id, to: d.id })),
        );

        const edgeDirection = vscode.workspace.getConfiguration('vsCMake').get<string>('graphEdgeDirection', 'dependency');
        this.view?.webview.postMessage({ type: 'update', nodes, edges, edgeDirection });
    }

    // ---- Message handling ----

    private handleMessage(msg: any): void {
        switch (msg.type) {
            case 'ready':
                this.sendGraphData();
                break;

            case 'nodeClick': {
                // Reveal in Project Outline (reuse existing revealDependency command)
                vscode.commands.executeCommand('vsCMake.revealDependency', {
                    kind: 'dependency',
                    target: { id: msg.targetId as string },
                });
                break;
            }

            case 'nodeDoubleClick': {
                const target = this.targets.find(t => t.id === msg.targetId);
                if (target) {
                    this.openTargetDefinition(target);
                }
                break;
            }

            case 'saveScreenshot': {
                this.saveScreenshot(msg.dataUri as string);
                break;
            }

            case 'updateSetting': {
                const key = msg.key as string;
                const value = msg.value;
                vscode.workspace.getConfiguration('vsCMake').update(key, value, vscode.ConfigurationTarget.Workspace);
                break;
            }
        }
    }

    private async saveScreenshot(dataUri: string): Promise<void> {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('dependency_graph.png'),
            filters: { 'PNG Image': ['png'] },
        });
        if (!uri) { return; }
        const base64 = dataUri.replace(/^data:image\/png;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        await vscode.workspace.fs.writeFile(uri, buffer);
        vscode.window.showInformationMessage(`Screenshot saved to ${uri.fsPath}`);
    }

    private openTargetDefinition(target: Target): void {
        const graph = target.backtraceGraph;
        if (!graph || target.backtrace === undefined) { return; }
        const node = graph.nodes[target.backtrace];
        if (!node) { return; }
        const file = graph.files[node.file];
        if (!file) { return; }
        const isAbs = /^([a-zA-Z]:[\\/]|\/)/.test(file);
        const absFile = isAbs ? file : path.join(target.paths.source, file);
        vscode.commands.executeCommand('vsCMake.openLocation', absFile, node.line ?? 1);
    }

    // ---- HTML ----

    private getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'dependency_graph_webview.js'),
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'medias', 'css', 'dependency_graph.css'),
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';
                   img-src ${webview.cspSource} blob: data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${styleUri}">
    <title>Dependency Graph</title>
</head>
<body>
    <div id="toolbar">
        <div id="filters"></div>
    </div>
    <div id="graph-container" style="display:none"></div>
    <div id="empty-message">Waiting for CMake data\u2026</div>
    <div id="legend"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
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

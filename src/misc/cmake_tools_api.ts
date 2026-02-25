import * as vscode from 'vscode';
import { Version, getCMakeToolsApi, Project } from 'vscode-cmake-tools';

export class CMakeToolsIntegrationManager {
    private _project: Project | undefined;
    private _disposables: vscode.Disposable[] = [];

    constructor(private readonly onConfigureDone: (buildDir: string, buildType: string) => void) { }

    public async watch(context: vscode.ExtensionContext): Promise<void> {
        // 1. init at start
        await this.init();

        // 2. security : re connect if user change the folder
        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.init())
        );

        // 3. security : reconnection if cmake-tools is activated after us
        context.subscriptions.push(
            vscode.extensions.onDidChange(() => this.init())
        );

        context.subscriptions.push(this);
    }

    private async init(): Promise<void> {
        // clearing old connection
        this.disposeProject();

        try {
            const api = await getCMakeToolsApi(Version.v1);
            if (!api) {
                return;
            }

            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                return;
            }

            this._project = await api.getProject(folder.uri);

            if (this._project) {
                const sub = this._project.onCodeModelChanged(async () => {
                    const generator = this._project?.configurePreset?.generator;
                    const buildDir = await this._project?.getBuildDirectory();
                    let buildType = generator === "Ninja Multi-Config"
                        ? undefined
                        : await this._project?.getActiveBuildType();
                    if (buildDir) {
                        this.onConfigureDone(buildDir, buildType ?? '');
                    }
                });
                this._disposables.push(sub);
            }
        } catch (err) {
            // cmake-tools is maybe not ready
        }
    }

    private disposeProject() {
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
        this._project = undefined;
    }

    public dispose() {
        this.disposeProject();
    }
}

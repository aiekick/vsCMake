import * as vscode from 'vscode';
import { Version, getCMakeToolsApi, Project } from 'vscode-cmake-tools';

export class CMakeToolsIntegrationManager {
    private m_project: Project | undefined;
    private m_disposables: vscode.Disposable[] = [];

    constructor(private readonly m_onConfigureDone: (aBuildDir: string, aBuildType: string) => void) { }

    public async watch(aContext: vscode.ExtensionContext): Promise<void> {
        // 1. init at start
        await this.init();

        // 2. security : re connect if user change the folder
        aContext.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.init())
        );

        // 3. security : reconnection if cmake-tools is activated after us
        aContext.subscriptions.push(
            vscode.extensions.onDidChange(() => this.init())
        );

        aContext.subscriptions.push(this);
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

            this.m_project = await api.getProject(folder.uri);

            if (this.m_project) {
                const sub = this.m_project.onCodeModelChanged(async () => {
                    const generator = this.m_project?.configurePreset?.generator;
                    const build_dir = await this.m_project?.getBuildDirectory();
                    let build_type = generator === "Ninja Multi-Config"
                        ? undefined
                        : await this.m_project?.getActiveBuildType();
                    if (build_dir) {
                        this.m_onConfigureDone(build_dir, build_type ?? '');
                    }
                });
                this.m_disposables.push(sub);
            }
        } catch (err) {
            // cmake-tools is maybe not ready
        }
    }

    private disposeProject() {
        this.m_disposables.forEach(d => d.dispose());
        this.m_disposables = [];
        this.m_project = undefined;
    }

    public dispose() {
        this.disposeProject();
    }
}

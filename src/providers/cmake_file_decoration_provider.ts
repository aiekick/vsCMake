import * as vscode from 'vscode';
import { CMakeDiagnosticsManager, CMakeDiagnosticSeverity } from '../cmake/cmake_diagnostics_manager';

/**
 * Provides file decorations (colored labels) for files and folders
 * that have CMake diagnostics. This colors items in:
 * - The Explorer view
 * - Our ProjectOutlineProvider tree view
 * - Any other tree view that uses resource URIs
 *
 * Works exactly like Git decorations (green for modified, etc.)
 * but uses red for errors, yellow for warnings.
 */
export class CMakeFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly m_onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    public readonly onDidChangeFileDecorations = this.m_onDidChangeFileDecorations.event;

    private readonly m_disposables: vscode.Disposable[] = [];

    constructor(private readonly m_diagnosticsManager: CMakeDiagnosticsManager) {
        // Listen for diagnostic changes and refresh decorations
        this.m_disposables.push(
            this.m_diagnosticsManager.onDidChangeDiagnostics(() => {
                // undefined = refresh all decorations
                this.m_onDidChangeFileDecorations.fire(undefined);
            })
        );

        // Register ourselves as a decoration provider
        this.m_disposables.push(
            vscode.window.registerFileDecorationProvider(this)
        );
    }

    dispose(): void {
        this.m_disposables.forEach(d => d.dispose());
        this.m_onDidChangeFileDecorations.dispose();
    }

    provideFileDecoration(
        aUri: vscode.Uri,
        aToken: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.FileDecoration> {
        // Check if this is a file with diagnostics
        const file_severity = this.m_diagnosticsManager.getFileSeverity(aUri);
        if (file_severity) {
            return this._createDecoration(file_severity, false);
        }

        // Check if this is a directory containing files with diagnostics
        const dir_severity = this.m_diagnosticsManager.getDirectorySeverity(aUri);
        if (dir_severity) {
            return this._createDecoration(dir_severity, true);
        }

        return undefined;
    }

    private _createDecoration(aSeverity: CMakeDiagnosticSeverity, aIsDirectory: boolean): vscode.FileDecoration {
        switch (aSeverity) {
            case CMakeDiagnosticSeverity.Error:
                return new vscode.FileDecoration(
                    'E',
                    aIsDirectory ? 'Contains CMake errors' : 'CMake error',
                    new vscode.ThemeColor('list.errorForeground')
                );
            case CMakeDiagnosticSeverity.Warning:
                return new vscode.FileDecoration(
                    'W',
                    aIsDirectory ? 'Contains CMake warnings' : 'CMake warning',
                    new vscode.ThemeColor('list.warningForeground')
                );
            case CMakeDiagnosticSeverity.Deprecation:
                return new vscode.FileDecoration(
                    'D',
                    aIsDirectory ? 'Contains CMake deprecation warnings' : 'CMake deprecation warning',
                    new vscode.ThemeColor('list.warningForeground')
                );
        }
    }
}

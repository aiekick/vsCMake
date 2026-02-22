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
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    public readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private readonly _disposables: vscode.Disposable[] = [];

    constructor(private readonly _diagnosticsManager: CMakeDiagnosticsManager) {
        // Listen for diagnostic changes and refresh decorations
        this._disposables.push(
            this._diagnosticsManager.onDidChangeDiagnostics(() => {
                // undefined = refresh all decorations
                this._onDidChangeFileDecorations.fire(undefined);
            })
        );

        // Register ourselves as a decoration provider
        this._disposables.push(
            vscode.window.registerFileDecorationProvider(this)
        );
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
        this._onDidChangeFileDecorations.dispose();
    }

    provideFileDecoration(
        uri: vscode.Uri,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.FileDecoration> {
        // Check if this is a file with diagnostics
        const fileSeverity = this._diagnosticsManager.getFileSeverity(uri);
        if (fileSeverity) {
            return this._createDecoration(fileSeverity, false);
        }

        // Check if this is a directory containing files with diagnostics
        const dirSeverity = this._diagnosticsManager.getDirectorySeverity(uri);
        if (dirSeverity) {
            return this._createDecoration(dirSeverity, true);
        }

        return undefined;
    }

    private _createDecoration(severity: CMakeDiagnosticSeverity, isDirectory: boolean): vscode.FileDecoration {
        switch (severity) {
            case CMakeDiagnosticSeverity.Error:
                return new vscode.FileDecoration(
                    'E',
                    isDirectory ? 'Contains CMake errors' : 'CMake error',
                    new vscode.ThemeColor('list.errorForeground')
                );
            case CMakeDiagnosticSeverity.Warning:
                return new vscode.FileDecoration(
                    'W',
                    isDirectory ? 'Contains CMake warnings' : 'CMake warning',
                    new vscode.ThemeColor('list.warningForeground')
                );
            case CMakeDiagnosticSeverity.Deprecation:
                return new vscode.FileDecoration(
                    'D',
                    isDirectory ? 'Contains CMake deprecation warnings' : 'CMake deprecation warning',
                    new vscode.ThemeColor('list.warningForeground')
                );
        }
    }
}
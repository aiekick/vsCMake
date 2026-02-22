import * as vscode from 'vscode';
import * as path from 'path';

export enum CMakeDiagnosticSeverity {
    Error = 'error',
    Warning = 'warning',
    Deprecation = 'deprecation',
}

export interface CMakeDiagnosticInfo {
    file: string;           // Absolute path to the file
    line: number;           // 1-based line number
    command?: string;       // CMake command that triggered the diagnostic
    severity: CMakeDiagnosticSeverity;
    message: string;        // Full message text
}

/**
 * Manages CMake diagnostics parsed from configure output.
 * Provides VSCode diagnostics (Problems panel + editor squiggles)
 * and exposes diagnostic state for FileDecorationProvider.
 */
export class CMakeDiagnosticsManager implements vscode.Disposable {
    private readonly _diagnosticCollection: vscode.DiagnosticCollection;
    private readonly _onDidChangeDiagnostics = new vscode.EventEmitter<void>();
    public readonly onDidChangeDiagnostics = this._onDidChangeDiagnostics.event;

    // Map of absolute file path -> diagnostics for that file
    private _fileDiagnostics: Map<string, CMakeDiagnosticInfo[]> = new Map();

    // Set of directories that contain files with diagnostics (for parent propagation)
    private _affectedDirectories: Map<string, CMakeDiagnosticSeverity> = new Map();

    // Buffer for multi-line parsing
    private _parseBuffer: string[] = [];
    private _currentDiagnostic: Partial<CMakeDiagnosticInfo> | null = null;

    constructor() {
        this._diagnosticCollection = vscode.languages.createDiagnosticCollection('cmake');
    }

    dispose(): void {
        this._diagnosticCollection.dispose();
        this._onDidChangeDiagnostics.dispose();
    }

    /**
     * Clear all diagnostics. Call this at the start of each configure.
     */
    clear(): void {
        this._fileDiagnostics.clear();
        this._affectedDirectories.clear();
        this._diagnosticCollection.clear();
        this._currentDiagnostic = null;
        this._parseBuffer = [];
        this._onDidChangeDiagnostics.fire();
    }

    /**
     * Feed a line of CMake output for parsing.
     * Call this for each line of stdout/stderr during configure.
     */
    parseLine(line: string, sourceDir: string): void {
        // Patterns for CMake diagnostic headers:
        // CMake Error at path/to/CMakeLists.txt:42 (command):
        // CMake Warning at path/to/CMakeLists.txt:42 (command):
        // CMake Warning (dev) at path/to/CMakeLists.txt:42 (command):
        // CMake Deprecation Warning at path/to/CMakeLists.txt:42:
        // CMake Error in path/to/CMakeLists.txt:
        const headerPattern = /^CMake\s+(Error|Warning|Deprecation Warning|Warning \(dev\))\s+(?:at|in)\s+(.+?)(?::(\d+))?\s*(?:\((\w+)\))?:\s*$/;

        const match = line.match(headerPattern);

        if (match) {
            // Flush any previous diagnostic being built
            this._flushCurrentDiagnostic(sourceDir);

            const severityStr = match[1];
            const filePath = match[2];
            const lineNum = match[3] ? parseInt(match[3], 10) : 1;
            const command = match[4] || undefined;

            let severity: CMakeDiagnosticSeverity;
            if (severityStr === 'Error') {
                severity = CMakeDiagnosticSeverity.Error;
            } else if (severityStr === 'Deprecation Warning') {
                severity = CMakeDiagnosticSeverity.Deprecation;
            } else {
                severity = CMakeDiagnosticSeverity.Warning;
            }

            this._currentDiagnostic = {
                file: filePath,
                line: lineNum,
                command,
                severity,
            };
            this._parseBuffer = [];
        } else if (this._currentDiagnostic) {
            // Blank line or next CMake message ends the current diagnostic
            const trimmed = line.trim();
            if (trimmed === '' && this._parseBuffer.length > 0) {
                this._flushCurrentDiagnostic(sourceDir);
            } else if (trimmed !== '') {
                this._parseBuffer.push(trimmed);
            }
        }
    }

    /**
     * Call when cmake process finishes to flush any remaining diagnostic.
     */
    finalize(sourceDir: string): void {
        this._flushCurrentDiagnostic(sourceDir);
        this._updateVSCodeDiagnostics();
        this._computeAffectedDirectories();
        this._onDidChangeDiagnostics.fire();
    }

    /**
     * Get the worst severity for a given file URI, or undefined if no diagnostics.
     */
    getFileSeverity(uri: vscode.Uri): CMakeDiagnosticSeverity | undefined {
        const diags = this._fileDiagnostics.get(uri.fsPath);
        if (!diags || diags.length === 0) {
            return undefined;
        }
        if (diags.some(d => d.severity === CMakeDiagnosticSeverity.Error)) {
            return CMakeDiagnosticSeverity.Error;
        }
        if (diags.some(d => d.severity === CMakeDiagnosticSeverity.Warning)) {
            return CMakeDiagnosticSeverity.Warning;
        }
        return CMakeDiagnosticSeverity.Deprecation;
    }

    /**
     * Get the worst severity for a directory URI (propagated from children).
     */
    getDirectorySeverity(uri: vscode.Uri): CMakeDiagnosticSeverity | undefined {
        return this._affectedDirectories.get(uri.fsPath);
    }

    /**
     * Check if a file or directory has any diagnostics.
     */
    hasDiagnostics(uri: vscode.Uri): boolean {
        return this._fileDiagnostics.has(uri.fsPath) || this._affectedDirectories.has(uri.fsPath);
    }

    /**
     * Get all files that have diagnostics.
     */
    getAffectedFiles(): vscode.Uri[] {
        return Array.from(this._fileDiagnostics.keys()).map(f => vscode.Uri.file(f));
    }

    /**
     * Get all affected directories.
     */
    getAffectedDirectories(): vscode.Uri[] {
        return Array.from(this._affectedDirectories.keys()).map(d => vscode.Uri.file(d));
    }

    // --- Private ---

    private _flushCurrentDiagnostic(sourceDir: string): void {
        if (!this._currentDiagnostic || this._parseBuffer.length === 0) {
            this._currentDiagnostic = null;
            this._parseBuffer = [];
            return;
        }

        const message = this._parseBuffer.join('\n');
        let filePath = this._currentDiagnostic.file!;

        // Resolve relative paths against source directory
        if (!path.isAbsolute(filePath)) {
            filePath = path.resolve(sourceDir, filePath);
        }

        const diagnostic: CMakeDiagnosticInfo = {
            file: filePath,
            line: this._currentDiagnostic.line || 1,
            command: this._currentDiagnostic.command,
            severity: this._currentDiagnostic.severity!,
            message,
        };

        const existing = this._fileDiagnostics.get(filePath) || [];
        existing.push(diagnostic);
        this._fileDiagnostics.set(filePath, existing);

        this._currentDiagnostic = null;
        this._parseBuffer = [];
    }

    private _updateVSCodeDiagnostics(): void {
        this._diagnosticCollection.clear();

        for (const [filePath, diags] of this._fileDiagnostics) {
            const uri = vscode.Uri.file(filePath);
            const vscodeDiags = diags.map(d => {
                const range = new vscode.Range(
                    Math.max(0, d.line - 1), 0,
                    Math.max(0, d.line - 1), Number.MAX_SAFE_INTEGER
                );

                let severity: vscode.DiagnosticSeverity;
                switch (d.severity) {
                    case CMakeDiagnosticSeverity.Error:
                        severity = vscode.DiagnosticSeverity.Error;
                        break;
                    case CMakeDiagnosticSeverity.Warning:
                        severity = vscode.DiagnosticSeverity.Warning;
                        break;
                    case CMakeDiagnosticSeverity.Deprecation:
                        severity = vscode.DiagnosticSeverity.Warning;
                        break;
                }

                const diag = new vscode.Diagnostic(range, d.message, severity);
                diag.source = 'CMake';

                if (d.severity === CMakeDiagnosticSeverity.Deprecation) {
                    diag.tags = [vscode.DiagnosticTag.Deprecated];
                }

                if (d.command) {
                    diag.code = d.command;
                }

                return diag;
            });

            this._diagnosticCollection.set(uri, vscodeDiags);
        }
    }

    private _computeAffectedDirectories(): void {
        this._affectedDirectories.clear();

        for (const [filePath, diags] of this._fileDiagnostics) {
            // Determine worst severity for this file
            let worstSeverity = CMakeDiagnosticSeverity.Deprecation;
            for (const d of diags) {
                if (d.severity === CMakeDiagnosticSeverity.Error) {
                    worstSeverity = CMakeDiagnosticSeverity.Error;
                    break;
                }
                if (d.severity === CMakeDiagnosticSeverity.Warning) {
                    worstSeverity = CMakeDiagnosticSeverity.Warning;
                }
            }

            // Propagate up the directory tree
            let dir = path.dirname(filePath);
            while (dir && dir !== path.dirname(dir)) {
                const existing = this._affectedDirectories.get(dir);
                const merged = this._mergeSeverity(existing, worstSeverity);
                if (existing === merged) {
                    break; // No change, ancestors already have same or worse severity
                }
                this._affectedDirectories.set(dir, merged);
                dir = path.dirname(dir);
            }
        }
    }

    private _mergeSeverity(
        existing: CMakeDiagnosticSeverity | undefined,
        incoming: CMakeDiagnosticSeverity
    ): CMakeDiagnosticSeverity {
        if (!existing) { return incoming; }
        if (existing === CMakeDiagnosticSeverity.Error || incoming === CMakeDiagnosticSeverity.Error) {
            return CMakeDiagnosticSeverity.Error;
        }
        if (existing === CMakeDiagnosticSeverity.Warning || incoming === CMakeDiagnosticSeverity.Warning) {
            return CMakeDiagnosticSeverity.Warning;
        }
        return CMakeDiagnosticSeverity.Deprecation;
    }
}
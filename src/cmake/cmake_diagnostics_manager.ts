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
    private readonly m_diagnosticCollection: vscode.DiagnosticCollection;
    private readonly m_onDidChangeDiagnostics = new vscode.EventEmitter<void>();
    public readonly onDidChangeDiagnostics = this.m_onDidChangeDiagnostics.event;

    // Map of absolute file path -> diagnostics for that file
    private m_fileDiagnostics: Map<string, CMakeDiagnosticInfo[]> = new Map();

    // Set of directories that contain files with diagnostics (for parent propagation)
    private m_affectedDirectories: Map<string, CMakeDiagnosticSeverity> = new Map();

    // Buffer for multi-line parsing
    private m_parseBuffer: string[] = [];
    private m_currentDiagnostic: Partial<CMakeDiagnosticInfo> | null = null;

    constructor() {
        this.m_diagnosticCollection = vscode.languages.createDiagnosticCollection('cmake');
    }

    dispose(): void {
        this.m_diagnosticCollection.dispose();
        this.m_onDidChangeDiagnostics.dispose();
    }

    /**
     * Clear all diagnostics. Call this at the start of each configure.
     */
    clear(): void {
        this.m_fileDiagnostics.clear();
        this.m_affectedDirectories.clear();
        this.m_diagnosticCollection.clear();
        this.m_currentDiagnostic = null;
        this.m_parseBuffer = [];
        this.m_onDidChangeDiagnostics.fire();
    }

    /**
     * Feed a line of CMake output for parsing.
     * Call this for each line of stdout/stderr during configure.
     */
    parseLine(aLine: string, aSourceDir: string): void {
        // Patterns for CMake diagnostic headers:
        // CMake Error at path/to/CMakeLists.txt:42 (command):
        // CMake Warning at path/to/CMakeLists.txt:42 (command):
        // CMake Warning (dev) at path/to/CMakeLists.txt:42 (command):
        // CMake Deprecation Warning at path/to/CMakeLists.txt:42:
        // CMake Error in path/to/CMakeLists.txt:
        const header_pattern = /^CMake\s+(Error|Warning|Deprecation Warning|Warning \(dev\))\s+(?:at|in)\s+(.+?)(?::(\d+))?\s*(?:\((\w+)\))?:\s*$/;

        const match = aLine.match(header_pattern);

        if (match) {
            // Flush any previous diagnostic being built
            this.flushCurrentDiagnostic(aSourceDir);

            const severity_str = match[1];
            const file_path = match[2];
            const line_num = match[3] ? parseInt(match[3], 10) : 1;
            const command = match[4] || undefined;

            let severity: CMakeDiagnosticSeverity;
            if (severity_str === 'Error') {
                severity = CMakeDiagnosticSeverity.Error;
            } else if (severity_str === 'Deprecation Warning') {
                severity = CMakeDiagnosticSeverity.Deprecation;
            } else {
                severity = CMakeDiagnosticSeverity.Warning;
            }

            this.m_currentDiagnostic = {
                file: file_path,
                line: line_num,
                command,
                severity,
            };
            this.m_parseBuffer = [];
        } else if (this.m_currentDiagnostic) {
            // Blank line or next CMake message ends the current diagnostic
            const trimmed = aLine.trim();
            if (trimmed === '' && this.m_parseBuffer.length > 0) {
                this.flushCurrentDiagnostic(aSourceDir);
            } else if (trimmed !== '') {
                this.m_parseBuffer.push(trimmed);
            }
        }
    }

    /**
     * Call when cmake process finishes to flush any remaining diagnostic.
     */
    finalize(aSourceDir: string): void {
        this.flushCurrentDiagnostic(aSourceDir);
        this.updateVSCodeDiagnostics();
        this.computeAffectedDirectories();
        this.m_onDidChangeDiagnostics.fire();
    }

    /**
     * Get the worst severity for a given file URI, or undefined if no diagnostics.
     */
    getFileSeverity(aUri: vscode.Uri): CMakeDiagnosticSeverity | undefined {
        const diags = this.m_fileDiagnostics.get(aUri.fsPath);
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
    getDirectorySeverity(aUri: vscode.Uri): CMakeDiagnosticSeverity | undefined {
        return this.m_affectedDirectories.get(aUri.fsPath);
    }

    /**
     * Check if a file or directory has any diagnostics.
     */
    hasDiagnostics(aUri: vscode.Uri): boolean {
        return this.m_fileDiagnostics.has(aUri.fsPath) || this.m_affectedDirectories.has(aUri.fsPath);
    }

    /**
     * Get all files that have diagnostics.
     */
    getAffectedFiles(): vscode.Uri[] {
        return Array.from(this.m_fileDiagnostics.keys()).map(f => vscode.Uri.file(f));
    }

    /**
     * Get all affected directories.
     */
    getAffectedDirectories(): vscode.Uri[] {
        return Array.from(this.m_affectedDirectories.keys()).map(d => vscode.Uri.file(d));
    }

    // --- Private ---

    private flushCurrentDiagnostic(aSourceDir: string): void {
        if (!this.m_currentDiagnostic || this.m_parseBuffer.length === 0) {
            this.m_currentDiagnostic = null;
            this.m_parseBuffer = [];
            return;
        }

        const message = this.m_parseBuffer.join('\n');
        let file_path = this.m_currentDiagnostic.file!;

        // Resolve relative paths against source directory
        if (!path.isAbsolute(file_path)) {
            file_path = path.resolve(aSourceDir, file_path);
        }

        const diagnostic: CMakeDiagnosticInfo = {
            file: file_path,
            line: this.m_currentDiagnostic.line || 1,
            command: this.m_currentDiagnostic.command,
            severity: this.m_currentDiagnostic.severity!,
            message,
        };

        const existing = this.m_fileDiagnostics.get(file_path) || [];
        existing.push(diagnostic);
        this.m_fileDiagnostics.set(file_path, existing);

        this.m_currentDiagnostic = null;
        this.m_parseBuffer = [];
    }

    private updateVSCodeDiagnostics(): void {
        this.m_diagnosticCollection.clear();

        for (const [file_path, diags] of this.m_fileDiagnostics) {
            const uri = vscode.Uri.file(file_path);
            const vscode_diags = diags.map(d => {
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

            this.m_diagnosticCollection.set(uri, vscode_diags);
        }
    }

    private computeAffectedDirectories(): void {
        this.m_affectedDirectories.clear();

        for (const [file_path, diags] of this.m_fileDiagnostics) {
            // Determine worst severity for this file
            let worst_severity = CMakeDiagnosticSeverity.Deprecation;
            for (const d of diags) {
                if (d.severity === CMakeDiagnosticSeverity.Error) {
                    worst_severity = CMakeDiagnosticSeverity.Error;
                    break;
                }
                if (d.severity === CMakeDiagnosticSeverity.Warning) {
                    worst_severity = CMakeDiagnosticSeverity.Warning;
                }
            }

            // Propagate up the directory tree
            let dir = path.dirname(file_path);
            while (dir && dir !== path.dirname(dir)) {
                const existing = this.m_affectedDirectories.get(dir);
                const merged = this.mergeSeverity(existing, worst_severity);
                if (existing === merged) {
                    break; // No change, ancestors already have same or worse severity
                }
                this.m_affectedDirectories.set(dir, merged);
                dir = path.dirname(dir);
            }
        }
    }

    private mergeSeverity(
        aExisting: CMakeDiagnosticSeverity | undefined,
        aIncoming: CMakeDiagnosticSeverity
    ): CMakeDiagnosticSeverity {
        if (!aExisting) { return aIncoming; }
        if (aExisting === CMakeDiagnosticSeverity.Error || aIncoming === CMakeDiagnosticSeverity.Error) {
            return CMakeDiagnosticSeverity.Error;
        }
        if (aExisting === CMakeDiagnosticSeverity.Warning || aIncoming === CMakeDiagnosticSeverity.Warning) {
            return CMakeDiagnosticSeverity.Warning;
        }
        return CMakeDiagnosticSeverity.Deprecation;
    }
}

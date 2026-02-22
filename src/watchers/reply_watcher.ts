import * as vscode from 'vscode';
import * as path from 'path';

// ------------------------------------------------------------
// ReplyWatcher
// Watches for the appearance of a new index in reply/
// CMake generates a new index-<timestamp>.json on each configure
// ------------------------------------------------------------
export class ReplyWatcher implements vscode.Disposable {

    private watcher: vscode.FileSystemWatcher;
    private readonly _onDidReply = new vscode.EventEmitter<void>();

    // Event emitted when a new reply is available
    readonly onDidReply: vscode.Event<void> = this._onDidReply.event;

    constructor(buildDir: string) {
        // Watch only index-*.json files
        // because it's the last file written by CMake after a configure
        const pattern = new vscode.RelativePattern(
            path.join(buildDir, '.cmake', 'api', 'v1', 'reply'),
            'index-*.json'
        );

        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

        // New configure → new index file
        this.watcher.onDidCreate(() => this._onDidReply.fire());
        // Reconfigure in place (rare but possible)
        this.watcher.onDidChange(() => this._onDidReply.fire());
    }

    dispose() {
        this.watcher.dispose();
        this._onDidReply.dispose();
    }
}
import * as vscode from 'vscode';
import * as path from 'path';

// ------------------------------------------------------------
// ReplyWatcher
// Watches for the appearance of a new index in reply/
// CMake generates a new index-<timestamp>.json on each configure
// ------------------------------------------------------------
export class ReplyWatcher implements vscode.Disposable {

    private m_watcher: vscode.FileSystemWatcher;
    private readonly m_onDidReply = new vscode.EventEmitter<void>();

    // Event emitted when a new reply is available
    readonly onDidReply: vscode.Event<void> = this.m_onDidReply.event;

    constructor(aBuildDir: string) {
        // Watch only index-*.json files
        // because it's the last file written by CMake after a configure
        const pattern = new vscode.RelativePattern(
            path.join(aBuildDir, '.cmake', 'api', 'v1', 'reply'),
            'index-*.json'
        );

        this.m_watcher = vscode.workspace.createFileSystemWatcher(pattern);

        // New configure → new index file
        this.m_watcher.onDidCreate(() => this.m_onDidReply.fire());
        // Reconfigure in place (rare but possible)
        this.m_watcher.onDidChange(() => this.m_onDidReply.fire());
    }

    dispose() {
        this.m_watcher.dispose();
        this.m_onDidReply.dispose();
    }
}

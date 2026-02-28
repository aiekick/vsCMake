import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import * as os from 'os';
import { isWindows, isClInPath, captureVcvarsEnv, findDefaultVcvarsall } from './msvc_env';
import { CMakeDiagnosticsManager } from './diagnostics_manager';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export interface RunResult {
    success: boolean;
    stdout: string;
    stderr: string;
    code: number | null;
    cancelled: boolean;
}

export interface RunningTask {
    id: number;
    label: string;
    cancel: () => void;
}

interface RunOptions {
    silent?: boolean;
    /** When set, enables CMake diagnostic parsing and resolves relative paths against this dir */
    diagnosticsSourceDir?: string;
}

// ------------------------------------------------------------
// Runner
// ------------------------------------------------------------
export class Runner {
    private static readonly MSVC_STATE_KEY = 'CMakeGraph.msvcEnvCache';

    private m_channel: vscode.OutputChannel;
    private m_tasks = new Map<number, RunningTask>();
    private m_nextId = 1;
    private m_msvcEnv: Record<string, string> | null | undefined = undefined;
    private m_state: vscode.Memento | undefined;
    private m_diagnosticsManager: CMakeDiagnosticsManager | undefined;

    private readonly m_onTasksChanged = new vscode.EventEmitter<RunningTask[]>();
    readonly onTasksChanged: vscode.Event<RunningTask[]> = this.m_onTasksChanged.event;

    constructor(aState?: vscode.Memento, aDiagnosticsManager?: CMakeDiagnosticsManager) {
        this.m_state = aState;
        this.m_diagnosticsManager = aDiagnosticsManager;
        const colorize = vscode.workspace.getConfiguration('CMakeGraph').get<boolean>('colorizeOutput', true);
        this.m_channel = colorize
            ? vscode.window.createOutputChannel('CMakeGraph', 'vscmake-output')
            : vscode.window.createOutputChannel('CMakeGraph');

        // Restore persisted MSVC env from previous session
        if (aState) {
            const persisted = aState.get<Record<string, string> | null>(Runner.MSVC_STATE_KEY);
            if (persisted !== undefined) {
                this.m_msvcEnv = persisted;
            }
        }
    }

    dispose(): void { this.m_channel.dispose(); }

    /** Write a message to the output channel (visible to the user). */
    logToOutput(aMessage: string): void {
        this.m_channel.appendLine(aMessage);
        this.m_channel.show(true);
    }

    getRunningTasks(): RunningTask[] { return [...this.m_tasks.values()]; }

    cancelAll(): void {
        for (const t of this.m_tasks.values()) { t.cancel(); }
    }

    // --------------------------------------------------------
    // MSVC Environment (Windows only)
    // --------------------------------------------------------

    private resolveMsvcEnv(): Record<string, string> | undefined {
        if (!isWindows()) { return undefined; }

        if (this.m_msvcEnv !== undefined) {
            return this.m_msvcEnv ?? undefined;
        }

        if (isClInPath()) {
            this.m_msvcEnv = null;
            this.persistMsvcEnv();
            return undefined;
        }

        const auto = findDefaultVcvarsall();
        if (auto) {
            const env = captureVcvarsEnv(auto.vcvarsall, auto.arch);
            if (env) {
                this.m_channel.appendLine(
                    `ℹ CMakeGraph: MSVC environment auto-detected (${auto.arch})`
                );
                this.m_msvcEnv = env;
                this.persistMsvcEnv();
                return env;
            }
        }

        this.m_msvcEnv = null;
        this.persistMsvcEnv();
        return undefined;
    }

    private persistMsvcEnv(): void {
        this.m_state?.update(Runner.MSVC_STATE_KEY, this.m_msvcEnv);
    }

    // --------------------------------------------------------
    // Silent generic execution (discovery, listing)
    // --------------------------------------------------------
    async exec(aCmd: string, aArgs: string[], aCwd: string): Promise<RunResult> {
        return this.run(aCmd, aArgs, aCwd, { silent: true });
    }

    // --------------------------------------------------------
    // cmake --preset <preset>  OU  cmake -S <src> -B <build>
    // --------------------------------------------------------
    async configure(
        aSourceDir: string | undefined,
        aBuildDir: string | undefined,
        aDefs: Record<string, string> = {},
        aPreset?: string,
        aCmakePath?: string
    ): Promise<RunResult> {
        const cmd = aCmakePath || 'cmake';
        const args: string[] = [];
        if (aPreset) {
            args.push('--preset', aPreset);
        } else {
            args.push('-S', aSourceDir!, '-B', aBuildDir!);
        }
        for (const [k, v] of Object.entries(aDefs)) { args.push(`-D${k}=${v}`); }
        const cwd = aSourceDir ?? '.';
        return this.run(cmd, args, cwd, { diagnosticsSourceDir: cwd });
    }

    // --------------------------------------------------------
    // cmake --build --preset <preset>  OU  cmake --build <dir>
    // --------------------------------------------------------
    async build(
        aBuildDir: string | undefined,
        aTarget?: string,
        aConfig?: string,
        aPreset?: string,
        aCmakePath?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCmakePath || 'cmake';
        const args: string[] = [];
        if (aPreset) {
            args.push('--build', '--preset', aPreset);
            if (aConfig) { args.push('--config', aConfig); }
        } else {
            args.push('--build', aBuildDir!);
            if (aTarget) { args.push('--target', aTarget); }
            if (aConfig) { args.push('--config', aConfig); }
        }
        if (aJobs && aJobs > 0) { args.push('-j', String(aJobs)); }
        return this.run(cmd, args, aBuildDir ?? '.');
    }

    // --------------------------------------------------------
    // cmake --build <dir> --target A --target B  (multi-target)
    // --------------------------------------------------------
    async buildTargets(
        aBuildDir: string,
        aTargets: string[],
        aConfig?: string,
        aCmakePath?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCmakePath || 'cmake';
        const args = ['--build', aBuildDir];
        for (const t of aTargets) { args.push('--target', t); }
        if (aConfig) { args.push('--config', aConfig); }
        if (aJobs && aJobs > 0) { args.push('-j', String(aJobs)); }
        return this.run(cmd, args, aBuildDir);
    }

    async cleanAndBuildTargets(
        aBuildDir: string,
        aTargets: string[],
        aConfig?: string,
        aCmakePath?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCmakePath || 'cmake';
        const args = ['--build', aBuildDir];
        for (const t of aTargets) { args.push('--target', t); }
        args.push('--clean-first');
        if (aConfig) { args.push('--config', aConfig); }
        if (aJobs && aJobs > 0) { args.push('-j', String(aJobs)); }
        return this.run(cmd, args, aBuildDir);
    }

    async clean(aBuildDir: string, aCmakePath?: string): Promise<RunResult> {
        return this.build(aBuildDir, 'clean', undefined, undefined, aCmakePath);
    }

    async install(aBuildDir: string, aPrefix?: string, aCmakePath?: string): Promise<RunResult> {
        const cmd = aCmakePath || 'cmake';
        const args = ['--install', aBuildDir];
        if (aPrefix) { args.push('--prefix', aPrefix); }
        return this.run(cmd, args, aBuildDir);
    }

    // --------------------------------------------------------
    // ctest
    // --------------------------------------------------------
    async test(
        aBuildDir: string | undefined,
        aConfig?: string,
        aPreset?: string,
        aCtestPath?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCtestPath || 'ctest';
        const args: string[] = [];
        if (aPreset) {
            args.push('--preset', aPreset);
        } else {
            args.push('--test-dir', aBuildDir!);
            if (aConfig) { args.push('-C', aConfig); }
        }
        if (aJobs && aJobs > 0) { args.push('-j', String(aJobs)); }
        return this.run(cmd, args, aBuildDir ?? '.');
    }

    async testFiltered(
        aBuildDir: string,
        aTestName: string,
        aConfig?: string,
        aCtestPath?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCtestPath || 'ctest';
        const args = ['--test-dir', aBuildDir, '-R', `^${aTestName}$`];
        if (aConfig) { args.push('-C', aConfig); }
        if (aJobs && aJobs > 0) { args.push('-j', String(aJobs)); }
        return this.run(cmd, args, aBuildDir);
    }

    /**
     * Run ctest with a regex filter and --no-tests=ignore.
     * Used by Impacted Targets to test executables by name pattern,
     * silently ignoring targets that are not actual CTest tests.
     */
    async testByRegex(
        aBuildDir: string,
        aRegex: string,
        aConfig?: string,
        aCtestPath?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCtestPath || 'ctest';
        const args = ['--test-dir', aBuildDir, '-R', aRegex, '--no-tests=ignore'];
        if (aConfig) { args.push('-C', aConfig); }
        if (aJobs && aJobs > 0) { args.push('-j', String(aJobs)); }
        return this.run(cmd, args, aBuildDir);
    }

    async listTests(aBuildDir: string, aCtestPath?: string): Promise<RunResult> {
        const cmd = aCtestPath || 'ctest';
        const args = ['--test-dir', aBuildDir, '--show-only=json-v1'];
        return this.run(cmd, args, aBuildDir, { silent: true });
    }

    async listTestsWithPreset(
        aPreset: string,
        aSourceDir: string,
        aCtestPath?: string
    ): Promise<RunResult> {
        const cmd = aCtestPath || 'ctest';
        const args = ['--preset', aPreset, '--show-only=json-v1'];
        return this.run(cmd, args, aSourceDir, { silent: true });
    }

    // --------------------------------------------------------
    // Private
    // --------------------------------------------------------
    private run(aCmd: string, aArgs: string[], aCwd: string, aOpts: RunOptions = {}): Promise<RunResult> {
        const { silent, diagnosticsSourceDir } = aOpts;
        const id = this.m_nextId++;
        const label = `${aCmd} ${aArgs.join(' ')}`;
        const is_win = os.platform() === 'win32';
        const clear_output = !silent && vscode.workspace.getConfiguration('CMakeGraph').get<boolean>('clearOutputBeforeRun', true);

        const msvc_env = this.resolveMsvcEnv();

        // If this is a configure run, clear previous diagnostics
        const parse_diag = diagnosticsSourceDir && this.m_diagnosticsManager;
        if (parse_diag) {
            this.m_diagnosticsManager!.clear();
        }

        return new Promise(resolve => {
            if (clear_output) { this.m_channel.clear(); }
            if (!silent) {
                this.m_channel.appendLine(`> ${label}`);
                this.m_channel.appendLine('');
                this.m_channel.show(true);
            }

            const spawn_env = msvc_env ? { ...msvc_env } : undefined;

            const proc: ChildProcess = is_win
                ? spawn(aCmd, aArgs, { cwd: aCwd, shell: false, env: spawn_env })
                : spawn(aCmd, aArgs, { cwd: aCwd, shell: false, detached: true });

            let stdout = '', stderr = '', killed = false;

            // Line buffer for diagnostic parsing (data chunks don't align with lines)
            let line_buf = '';

            const kill_proc = (): void => {
                if (is_win) {
                    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: false });
                } else {
                    try { process.kill(-proc.pid!, 'SIGTERM'); } catch { proc.kill(); }
                }
            };

            const task: RunningTask = {
                id,
                label,
                cancel: () => {
                    killed = true;
                    kill_proc();
                    if (!silent) { this.m_channel.appendLine(`⊘ Cancelled: ${label}`); }
                },
            };

            this.m_tasks.set(id, task);
            this.m_onTasksChanged.fire(this.getRunningTasks());

            const finish = (result: RunResult): void => {
                this.m_tasks.delete(id);
                this.m_onTasksChanged.fire(this.getRunningTasks());
                resolve(result);
            };

            /** Feed text to the diagnostic parser, handling partial lines */
            const feed_diagnostics = (text: string): void => {
                if (!parse_diag) { return; }
                line_buf += text;
                const lines = line_buf.split('\n');
                // Keep the last (potentially incomplete) chunk in the buffer
                line_buf = lines.pop()!;
                for (const line of lines) {
                    this.m_diagnosticsManager!.parseLine(line, diagnosticsSourceDir!);
                }
            };

            proc.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stdout += text;
                if (!silent) { this.m_channel.append(text); }
                feed_diagnostics(text);
            });
            proc.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stderr += text;
                if (!silent) { this.m_channel.append(text); }
                feed_diagnostics(text);
            });
            proc.on('error', err => {
                const msg = `Unable to launch ${aCmd}: ${err.message}`;
                if (!silent) {
                    this.m_channel.appendLine(msg);
                    vscode.window.showErrorMessage(msg);
                }
                finish({ success: false, stdout, stderr: msg, code: null, cancelled: false });
            });
            proc.on('close', (code: number | null) => {
                // Flush remaining line buffer to diagnostics parser
                if (parse_diag && line_buf.length > 0) {
                    this.m_diagnosticsManager!.parseLine(line_buf, diagnosticsSourceDir!);
                    line_buf = '';
                }
                if (parse_diag) {
                    this.m_diagnosticsManager!.finalize(diagnosticsSourceDir!);
                }

                if (killed) {
                    finish({ success: false, stdout, stderr, code, cancelled: true });
                } else {
                    const success = code === 0;
                    if (!silent) {
                        this.m_channel.appendLine('');
                        this.m_channel.appendLine(success
                            ? `✓ ${aCmd} completed (code ${code})`
                            : `✗ ${aCmd} failed (code ${code})`
                        );
                    }
                    finish({ success, stdout, stderr, code, cancelled: false });
                }
            });
        });
    }
}

import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import * as os from 'os';
import { isWindows, isClInPath, captureVcvarsEnv, MsvcArch, findDefaultVcvarsall } from './msvc_env';
import { Kit } from './kit_scanner';
import { CMakeDiagnosticsManager } from './cmake_diagnostics_manager';

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
    private static readonly MSVC_STATE_KEY = 'vsCMake.msvcEnvCache';

    private channel: vscode.OutputChannel;
    private tasks = new Map<number, RunningTask>();
    private nextId = 1;
    private msvcEnv: Record<string, string> | null | undefined = undefined;
    private activeKit: Kit | undefined = undefined;
    private state: vscode.Memento | undefined;
    private diagnosticsManager: CMakeDiagnosticsManager | undefined;

    private readonly _onTasksChanged = new vscode.EventEmitter<RunningTask[]>();
    readonly onTasksChanged: vscode.Event<RunningTask[]> = this._onTasksChanged.event;

    constructor(state?: vscode.Memento, diagnosticsManager?: CMakeDiagnosticsManager) {
        this.state = state;
        this.diagnosticsManager = diagnosticsManager;
        const colorize = vscode.workspace.getConfiguration('vsCMake').get<boolean>('colorizeOutput', true);
        this.channel = colorize
            ? vscode.window.createOutputChannel('vsCMake', 'vscmake-output')
            : vscode.window.createOutputChannel('vsCMake');

        // Restore persisted MSVC env from previous session
        if (state) {
            const persisted = state.get<Record<string, string> | null>(Runner.MSVC_STATE_KEY);
            if (persisted !== undefined) {
                this.msvcEnv = persisted;
            }
        }
    }

    dispose(): void { this.channel.dispose(); }

    getRunningTasks(): RunningTask[] { return [...this.tasks.values()]; }

    cancelAll(): void {
        for (const t of this.tasks.values()) { t.cancel(); }
    }

    // --------------------------------------------------------
    // Active kit
    // --------------------------------------------------------

    setActiveKit(kit: Kit | undefined): void {
        this.activeKit = kit;
        this.msvcEnv = undefined;
    }

    // --------------------------------------------------------
    // MSVC Environment (Windows only)
    // --------------------------------------------------------

    private resolveMsvcEnv(): Record<string, string> | undefined {
        if (!isWindows()) { return undefined; }

        if (this.msvcEnv !== undefined) {
            return this.msvcEnv ?? undefined;
        }

        if (isClInPath()) {
            this.msvcEnv = null;
            this.persistMsvcEnv();
            return undefined;
        }

        if (this.activeKit?.vcvarsall && this.activeKit?.vcvarsArch) {
            const env = captureVcvarsEnv(this.activeKit.vcvarsall, this.activeKit.vcvarsArch);
            if (env) {
                this.channel.appendLine(
                    `ℹ vsCMake: MSVC environment injected (${this.activeKit.name})`
                );
                this.msvcEnv = env;
                this.persistMsvcEnv();
                return env;
            }
        }

        const auto = findDefaultVcvarsall();
        if (auto) {
            const env = captureVcvarsEnv(auto.vcvarsall, auto.arch);
            if (env) {
                this.channel.appendLine(
                    `ℹ vsCMake: MSVC environment auto-detected (${auto.arch})`
                );
                this.msvcEnv = env;
                this.persistMsvcEnv();
                return env;
            }
        }

        this.msvcEnv = null;
        this.persistMsvcEnv();
        return undefined;
    }

    private persistMsvcEnv(): void {
        this.state?.update(Runner.MSVC_STATE_KEY, this.msvcEnv);
    }

    resetMsvcEnv(): void {
        this.msvcEnv = undefined;
    }

    clearPersistedMsvcEnv(): void {
        this.msvcEnv = undefined;
        this.state?.update(Runner.MSVC_STATE_KEY, undefined);
    }

    // --------------------------------------------------------
    // Silent generic execution (discovery, listing)
    // --------------------------------------------------------
    async exec(cmd: string, args: string[], cwd: string): Promise<RunResult> {
        return this.run(cmd, args, cwd, { silent: true });
    }

    // --------------------------------------------------------
    // cmake --preset <preset>  OU  cmake -S <src> -B <build>
    // --------------------------------------------------------
    async configure(
        sourceDir: string | undefined,
        buildDir: string | undefined,
        defs: Record<string, string> = {},
        preset?: string,
        cmakePath?: string
    ): Promise<RunResult> {
        const cmd = cmakePath || 'cmake';
        const args: string[] = [];
        if (preset) {
            args.push('--preset', preset);
        } else {
            args.push('-S', sourceDir!, '-B', buildDir!);
        }
        for (const [k, v] of Object.entries(defs)) { args.push(`-D${k}=${v}`); }
        const cwd = sourceDir ?? '.';
        return this.run(cmd, args, cwd, { diagnosticsSourceDir: cwd });
    }

    // --------------------------------------------------------
    // cmake --build --preset <preset>  OU  cmake --build <dir>
    // --------------------------------------------------------
    async build(
        buildDir: string | undefined,
        target?: string,
        config?: string,
        preset?: string,
        cmakePath?: string,
        jobs?: number
    ): Promise<RunResult> {
        const cmd = cmakePath || 'cmake';
        const args: string[] = [];
        if (preset) {
            args.push('--build', '--preset', preset);
            if (config) { args.push('--config', config); }
        } else {
            args.push('--build', buildDir!);
            if (target) { args.push('--target', target); }
            if (config) { args.push('--config', config); }
        }
        if (jobs && jobs > 0) { args.push('-j', String(jobs)); }
        return this.run(cmd, args, buildDir ?? '.');
    }

    async clean(buildDir: string, cmakePath?: string): Promise<RunResult> {
        return this.build(buildDir, 'clean', undefined, undefined, cmakePath);
    }

    async cleanAndBuildTarget(
        buildDir: string,
        target: string,
        config?: string,
        cmakePath?: string
    ): Promise<RunResult> {
        const cmd = cmakePath || 'cmake';
        const args = ['--build', buildDir, '--target', target, '--clean-first'];
        if (config) { args.push('--config', config); }
        return this.run(cmd, args, buildDir);
    }

    async install(buildDir: string, prefix?: string, cmakePath?: string): Promise<RunResult> {
        const cmd = cmakePath || 'cmake';
        const args = ['--install', buildDir];
        if (prefix) { args.push('--prefix', prefix); }
        return this.run(cmd, args, buildDir);
    }

    // --------------------------------------------------------
    // ctest
    // --------------------------------------------------------
    async test(
        buildDir: string | undefined,
        config?: string,
        preset?: string,
        ctestPath?: string,
        jobs?: number
    ): Promise<RunResult> {
        const cmd = ctestPath || 'ctest';
        const args: string[] = [];
        if (preset) {
            args.push('--preset', preset);
        } else {
            args.push('--test-dir', buildDir!);
            if (config) { args.push('-C', config); }
        }
        if (jobs && jobs > 0) { args.push('-j', String(jobs)); }
        return this.run(cmd, args, buildDir ?? '.');
    }

    async testFiltered(
        buildDir: string,
        testName: string,
        config?: string,
        ctestPath?: string,
        jobs?: number
    ): Promise<RunResult> {
        const cmd = ctestPath || 'ctest';
        const args = ['--test-dir', buildDir, '-R', `^${testName}$`];
        if (config) { args.push('-C', config); }
        if (jobs && jobs > 0) { args.push('-j', String(jobs)); }
        return this.run(cmd, args, buildDir);
    }

    async listTests(buildDir: string, ctestPath?: string): Promise<RunResult> {
        const cmd = ctestPath || 'ctest';
        const args = ['--test-dir', buildDir, '--show-only=json-v1'];
        return this.run(cmd, args, buildDir, { silent: true });
    }

    async listTestsWithPreset(
        preset: string,
        sourceDir: string,
        ctestPath?: string
    ): Promise<RunResult> {
        const cmd = ctestPath || 'ctest';
        const args = ['--preset', preset, '--show-only=json-v1'];
        return this.run(cmd, args, sourceDir, { silent: true });
    }

    // --------------------------------------------------------
    // Private
    // --------------------------------------------------------
    private run(cmd: string, args: string[], cwd: string, opts: RunOptions = {}): Promise<RunResult> {
        const { silent = false, diagnosticsSourceDir } = opts;
        const id = this.nextId++;
        const label = `${cmd} ${args.join(' ')}`;
        const isWin = os.platform() === 'win32';
        const clearOutput = !silent && vscode.workspace.getConfiguration('vsCMake').get<boolean>('clearOutputBeforeRun', true);

        const msvcEnv = this.resolveMsvcEnv();

        // If this is a configure run, clear previous diagnostics
        const parseDiag = diagnosticsSourceDir && this.diagnosticsManager;
        if (parseDiag) {
            this.diagnosticsManager!.clear();
        }

        return new Promise(resolve => {
            if (clearOutput) { this.channel.clear(); }
            if (!silent) {
                this.channel.appendLine(`> ${label}`);
                this.channel.appendLine('');
                this.channel.show(true);
            }

            const spawnEnv = msvcEnv ? { ...msvcEnv } : undefined;

            const proc: ChildProcess = isWin
                ? spawn(cmd, args, { cwd, shell: false, env: spawnEnv })
                : spawn(cmd, args, { cwd, shell: false, detached: true });

            let stdout = '', stderr = '', killed = false;

            // Line buffer for diagnostic parsing (data chunks don't align with lines)
            let lineBuf = '';

            const killProc = (): void => {
                if (isWin) {
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
                    killProc();
                    if (!silent) { this.channel.appendLine(`⊘ Cancelled: ${label}`); }
                },
            };

            this.tasks.set(id, task);
            this._onTasksChanged.fire(this.getRunningTasks());

            const finish = (result: RunResult): void => {
                this.tasks.delete(id);
                this._onTasksChanged.fire(this.getRunningTasks());
                resolve(result);
            };

            /** Feed text to the diagnostic parser, handling partial lines */
            const feedDiagnostics = (text: string): void => {
                if (!parseDiag) { return; }
                lineBuf += text;
                const lines = lineBuf.split('\n');
                // Keep the last (potentially incomplete) chunk in the buffer
                lineBuf = lines.pop()!;
                for (const line of lines) {
                    this.diagnosticsManager!.parseLine(line, diagnosticsSourceDir!);
                }
            };

            proc.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stdout += text;
                if (!silent) { this.channel.append(text); }
                feedDiagnostics(text);
            });
            proc.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stderr += text;
                if (!silent) { this.channel.append(text); }
                feedDiagnostics(text);
            });
            proc.on('error', err => {
                const msg = `Unable to launch ${cmd}: ${err.message}`;
                if (!silent) {
                    this.channel.appendLine(msg);
                    vscode.window.showErrorMessage(msg);
                }
                finish({ success: false, stdout, stderr: msg, code: null, cancelled: false });
            });
            proc.on('close', (code: number | null) => {
                // Flush remaining line buffer to diagnostics parser
                if (parseDiag && lineBuf.length > 0) {
                    this.diagnosticsManager!.parseLine(lineBuf, diagnosticsSourceDir!);
                    lineBuf = '';
                }
                if (parseDiag) {
                    this.diagnosticsManager!.finalize(diagnosticsSourceDir!);
                }

                if (killed) {
                    finish({ success: false, stdout, stderr, code, cancelled: true });
                } else {
                    const success = code === 0;
                    if (!silent) {
                        this.channel.appendLine('');
                        this.channel.appendLine(success
                            ? `✓ ${cmd} completed (code ${code})`
                            : `✗ ${cmd} failed (code ${code})`
                        );
                    }
                    finish({ success, stdout, stderr, code, cancelled: false });
                }
            });
        });
    }
}
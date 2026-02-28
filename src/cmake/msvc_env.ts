import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ------------------------------------------------------------
// MSVC environment capture (Windows only)
//
// VS installation detection is in kit_scanner.ts.
// This module only captures environment variables
// resulting from vcvarsall.bat execution.
// ------------------------------------------------------------

export type MsvcArch = 'x86' | 'x64' | 'arm' | 'arm64'
    | 'x86_amd64' | 'x86_arm' | 'x86_arm64'
    | 'amd64_x86' | 'amd64_arm' | 'amd64_arm64';

/** Cache of resolved environments (key = vcvarsall+arch) */
const env_cache = new Map<string, Record<string, string>>();

export function isWindows(): boolean {
    return os.platform() === 'win32';
}

/**
 * Executes vcvarsall.bat and returns the resulting environment variables.
 * The result is cached by (vcvarsallPath, arch).
 */
export function captureVcvarsEnv(
    aVcvarsallPath: string,
    aArch: MsvcArch
): Record<string, string> | null {
    const cache_key = `${aVcvarsallPath}|${aArch}`;
    if (env_cache.has(cache_key)) { return env_cache.get(cache_key)!; }

    try {
        const output = execSync(
            `cmd.exe /s /c ""${aVcvarsallPath}" ${aArch} >nul 2>&1 && set"`,
            {
                encoding: 'utf-8',
                timeout: 30000,
                maxBuffer: 10 * 1024 * 1024,
                stdio: ['pipe', 'pipe', 'pipe'],
            }
        );

        const env: Record<string, string> = {};
        for (const line of output.split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0) {
                env[line.substring(0, eq)] = line.substring(eq + 1).trimEnd();
            }
        }

        if (!env['PATH'] && !env['Path']) { return null; }

        env_cache.set(cache_key, env);
        return env;
    } catch {
        return null;
    }
}

/**
 * Checks if cl.exe is already accessible in the current PATH.
 */
export function isClInPath(): boolean {
    if (!isWindows()) { return false; }
    try {
        execSync('where cl.exe', {
            encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        return true;
    } catch { return false; }
}

export function clearMsvcEnvCache(): void {
    env_cache.clear();
}

/**
 * Automatically detects the most recent VS installation
 * and returns the vcvarsall path + default architecture.
 * Used in preset mode (no selected kit).
 */
export function findDefaultVcvarsall(): { vcvarsall: string; arch: MsvcArch } | null {
    if (!isWindows()) { return null; }

    const vswhere = path.join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Microsoft Visual Studio', 'Installer', 'vswhere.exe'
    );
    if (!fs.existsSync(vswhere)) { return null; }

    try {
        const vs_path = execSync(
            `"${vswhere}" -latest -property installationPath`,
            { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();

        if (!vs_path) { return null; }

        const vcvarsall = path.join(vs_path, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
        if (!fs.existsSync(vcvarsall)) { return null; }

        const host_arch = os.arch();
        const arch: MsvcArch = host_arch === 'arm64' ? 'arm64'
            : host_arch === 'ia32' ? 'x86'
                : 'x64';

        return { vcvarsall, arch };
    } catch {
        return null;
    }
}

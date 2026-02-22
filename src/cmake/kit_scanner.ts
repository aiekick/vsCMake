import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MsvcArch } from './msvc_env';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export interface Kit {
    name: string;
    description: string;
    compilers: {
        c?: string;
        cxx?: string;
    };
    /** vcvarsall.bat path (MSVC kits only) */
    vcvarsall?: string;
    /** vcvarsall architecture (MSVC kits only) */
    vcvarsArch?: MsvcArch;
}

/** Progress callback to inform the caller of the current step */
export type ScanProgress = (message: string) => void;

// ------------------------------------------------------------
// Entry point
// ------------------------------------------------------------

/**
 * Scans the system to detect available compilers.
 *
 * @param extraPaths  Additional paths (from vsCMake.kitSearchPaths setting)
 * @param progress    Optional callback called at each scan step
 */
export async function scanKits(
    extraPaths: string[] = [],
    progress?: ScanProgress
): Promise<Kit[]> {
    const kits: Kit[] = [];
    const isWin = os.platform() === 'win32';

    if (isWin) {
        progress?.('Searching for Visual Studio installations…');
        kits.push(...scanMsvc());

        progress?.('Searching for GCC (MinGW, MSYS2, WinLibs…)');
        kits.push(...scanGccWin(extraPaths));

        progress?.('Searching for Clang-cl…');
        kits.push(...scanClangCl(extraPaths));

        progress?.('Searching for Clang…');
        kits.push(...scanClangWin(extraPaths));
    } else {
        progress?.('Searching for GCC…');
        kits.push(...scanGcc(extraPaths));

        progress?.('Searching for Clang…');
        kits.push(...scanClang(extraPaths));
    }

    // Special kit: let CMake decide
    kits.push({
        name: '[Unspecified]',
        description: 'Let CMake detect the compiler',
        compilers: {},
    });

    progress?.(`${kits.length} kit${kits.length > 1 ? 's' : ''} detected`);
    return kits;
}

// ------------------------------------------------------------
// Windows — MSVC
// ------------------------------------------------------------

interface VsInstance {
    installationPath: string;
    displayName: string;
    installationVersion: string;
}

function scanMsvc(): Kit[] {
    const vswhere = findVswhere();
    if (!vswhere) { return []; }

    let instances: VsInstance[];
    try {
        const output = execSync(
            `"${vswhere}" -all -format json -utf8 -products *`,
            { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        instances = JSON.parse(output) as VsInstance[];
    } catch { return []; }

    const kits: Kit[] = [];
    const archs: Array<{ label: string; arg: MsvcArch }> = [
        { label: 'x64', arg: 'x64' },
        { label: 'x86', arg: 'x86' },
        { label: 'arm64', arg: 'arm64' },
    ];

    for (const inst of instances) {
        const vcvarsallPath = path.join(inst.installationPath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
        if (!fs.existsSync(vcvarsallPath)) { continue; }

        const clVersion = getMsvcClVersion(vcvarsallPath, 'x64');
        const vsYear = extractVsYear(inst.installationVersion);

        for (const arch of archs) {
            kits.push({
                name: `MSVC ${vsYear} ${arch.label}`,
                description: `${inst.displayName} — cl.exe ${clVersion ?? '?'}`,
                compilers: { c: 'cl.exe', cxx: 'cl.exe' },
                vcvarsall: vcvarsallPath,
                vcvarsArch: arch.arg,
            });
        }
    }

    return kits;
}

function findVswhere(): string | null {
    const standard = path.join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Microsoft Visual Studio', 'Installer', 'vswhere.exe'
    );
    if (fs.existsSync(standard)) { return standard; }
    try {
        const result = execSync('where vswhere.exe', {
            encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        const first = result.trim().split('\n')[0]?.trim();
        if (first && fs.existsSync(first)) { return first; }
    } catch { /* */ }
    return null;
}

function getMsvcClVersion(vcvarsall: string, arch: string): string | null {
    try {
        const output = execSync(
            `cmd.exe /s /c ""${vcvarsall}" ${arch} >nul 2>&1 && cl.exe 2>&1"`,
            { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const m = output.match(/Version\s+([\d.]+)/i);
        return m?.[1] ?? null;
    } catch { return null; }
}

function extractVsYear(version: string): string {
    const major = parseInt(version.split('.')[0], 10);
    if (major >= 17) { return '2022'; }
    if (major >= 16) { return '2019'; }
    if (major >= 15) { return '2017'; }
    return version.split('.')[0];
}

// ------------------------------------------------------------
// Windows — GCC (MinGW, MSYS2, WinLibs, Chocolatey, Scoop…)
// ------------------------------------------------------------

function scanGccWin(extraPaths: string[] = []): Kit[] {
    const kits: Kit[] = [];
    const seen = new Set<string>();

    const searchPaths = [
        'C:\\msys64\\mingw64\\bin',
        'C:\\msys64\\mingw32\\bin',
        'C:\\msys64\\ucrt64\\bin',
        'C:\\msys64\\clang64\\bin',
        'C:\\mingw64\\bin',
        'C:\\mingw\\bin',
        'C:\\ProgramData\\chocolatey\\bin',
        path.join(os.homedir(), 'scoop', 'shims'),
        ...extraPaths,
    ];

    const pathDirs = (process.env['PATH'] || '').split(';');
    const wherePaths = findExecutables('gcc.exe').map(p => path.dirname(p));
    const allDirs = [...new Set([...searchPaths, ...pathDirs, ...wherePaths])];

    for (const dir of allDirs) {
        if (!dir) { continue; }
        const gcc = path.join(dir, 'gcc.exe');
        const gxx = path.join(dir, 'g++.exe');
        if (!fs.existsSync(gcc) || !fs.existsSync(gxx)) { continue; }

        let realGcc: string;
        try { realGcc = fs.realpathSync(gcc); } catch { realGcc = gcc; }
        if (seen.has(realGcc)) { continue; }
        seen.add(realGcc);

        const version = getCompilerVersion(gcc);
        const label = inferGccLabel(dir);
        const name = `GCC ${version ?? '?'} (${label})`;

        kits.push({
            name,
            description: dir,
            compilers: { c: gcc, cxx: gxx },
        });
    }

    return kits;
}

function inferGccLabel(dir: string): string {
    const lower = dir.toLowerCase().replace(/\\/g, '/');
    if (lower.includes('ucrt64')) { return 'MSYS2 UCRT64'; }
    if (lower.includes('clang64')) { return 'MSYS2 Clang64'; }
    if (lower.includes('mingw32')) { return 'MSYS2 MinGW32'; }
    if (lower.includes('mingw64')) { return 'MSYS2 MinGW64'; }
    if (lower.includes('msys64')) { return 'MSYS2'; }
    if (lower.includes('chocolatey')) { return 'Chocolatey'; }
    if (lower.includes('scoop')) { return 'Scoop'; }
    if (lower.includes('winlibs')) { return 'WinLibs'; }
    if (lower.includes('mingw')) { return 'MinGW'; }
    return 'PATH';
}

// ------------------------------------------------------------
// Windows — Clang-cl
// ------------------------------------------------------------

function scanClangCl(extraPaths: string[] = []): Kit[] {
    const kits: Kit[] = [];
    const seen = new Set<string>();
    const candidates = findClangExecutables('clang-cl.exe', extraPaths);

    for (const clangCl of candidates) {
        let real: string;
        try { real = fs.realpathSync(clangCl); } catch { real = clangCl; }
        if (seen.has(real)) { continue; }
        seen.add(real);

        const version = getCompilerVersion(clangCl);
        const label = inferClangLabel(path.dirname(clangCl));
        const name = `Clang-cl ${version ?? '?'} (${label})`;

        kits.push({
            name,
            description: path.dirname(clangCl),
            compilers: { c: clangCl, cxx: clangCl },
        });
    }

    return kits;
}

// ------------------------------------------------------------
// Windows — Clang
// ------------------------------------------------------------

function scanClangWin(extraPaths: string[] = []): Kit[] {
    const kits: Kit[] = [];
    const seen = new Set<string>();
    const candidates = findClangExecutables('clang.exe', extraPaths);

    for (const clang of candidates) {
        if (path.basename(clang).toLowerCase() === 'clang-cl.exe') { continue; }
        const clangxx = path.join(path.dirname(clang), 'clang++.exe');
        if (!fs.existsSync(clangxx)) { continue; }

        let real: string;
        try { real = fs.realpathSync(clang); } catch { real = clang; }
        if (seen.has(real)) { continue; }
        seen.add(real);

        const version = getCompilerVersion(clang);
        const label = inferClangLabel(path.dirname(clang));
        const name = `Clang ${version ?? '?'} (${label})`;

        kits.push({
            name,
            description: path.dirname(clang),
            compilers: { c: clang, cxx: clangxx },
        });
    }

    return kits;
}

/** Searches for a Clang executable in known paths + PATH + where */
function findClangExecutables(name: string, extraPaths: string[] = []): string[] {
    const results: string[] = [];
    const seen = new Set<string>();

    const add = (p: string) => {
        const norm = path.normalize(p);
        if (!seen.has(norm.toLowerCase()) && fs.existsSync(norm)) {
            seen.add(norm.toLowerCase());
            results.push(norm);
        }
    };

    const llvmRoots = [
        'C:\\Program Files\\LLVM\\bin',
        'C:\\Program Files (x86)\\LLVM\\bin',
        path.join(os.homedir(), 'scoop', 'apps', 'llvm', 'current', 'bin'),
        'C:\\ProgramData\\chocolatey\\bin',
        'C:\\msys64\\clang64\\bin',
        'C:\\msys64\\mingw64\\bin',
        ...extraPaths,
    ];

    for (const dir of llvmRoots) {
        add(path.join(dir, name));
    }

    for (const p of findExecutables(name)) { add(p); }

    return results;
}

function inferClangLabel(dir: string): string {
    const lower = dir.toLowerCase().replace(/\\/g, '/');
    if (lower.includes('msys64/clang64')) { return 'MSYS2 Clang64'; }
    if (lower.includes('msys64')) { return 'MSYS2'; }
    if (lower.includes('program files')) { return 'LLVM'; }
    if (lower.includes('chocolatey')) { return 'Chocolatey'; }
    if (lower.includes('scoop')) { return 'Scoop'; }
    return 'PATH';
}

// ------------------------------------------------------------
// Linux — GCC
// ------------------------------------------------------------

function scanGcc(extraPaths: string[] = []): Kit[] {
    const kits: Kit[] = [];

    // gcc/g++ par défaut
    const defaultGcc = whichSync('gcc');
    const defaultGxx = whichSync('g++');
    if (defaultGcc && defaultGxx) {
        const version = getCompilerVersion(defaultGcc);
        kits.push({
            name: `GCC ${version ?? '?'}`,
            description: defaultGcc,
            compilers: { c: defaultGcc, cxx: defaultGxx },
        });
    }

    // Versions numérotées : gcc-9 à gcc-14
    for (let v = 9; v <= 14; v++) {
        const gcc = whichSync(`gcc-${v}`);
        const gxx = whichSync(`g++-${v}`);
        if (gcc && gxx) {
            const version = getCompilerVersion(gcc);
            const name = `GCC ${version ?? v}`;
            if (!kits.some(k => k.name === name)) {
                kits.push({ name, description: gcc, compilers: { c: gcc, cxx: gxx } });
            }
        }
    }

    // Chemins utilisateur
    for (const dir of extraPaths) {
        const gcc = path.join(dir, 'gcc');
        const gxx = path.join(dir, 'g++');
        if (fs.existsSync(gcc) && fs.existsSync(gxx)) {
            const version = getCompilerVersion(gcc);
            const name = `GCC ${version ?? '?'} (${dir})`;
            if (!kits.some(k => k.name === name)) {
                kits.push({ name, description: dir, compilers: { c: gcc, cxx: gxx } });
            }
        }
    }

    return kits;
}

// ------------------------------------------------------------
// Linux — Clang
// ------------------------------------------------------------

function scanClang(extraPaths: string[] = []): Kit[] {
    const kits: Kit[] = [];

    // clang/clang++ par défaut
    const defaultClang = whichSync('clang');
    const defaultClangxx = whichSync('clang++');
    if (defaultClang && defaultClangxx) {
        const version = getCompilerVersion(defaultClang);
        kits.push({
            name: `Clang ${version ?? '?'}`,
            description: defaultClang,
            compilers: { c: defaultClang, cxx: defaultClangxx },
        });
    }

    // Versions numérotées : clang-13 à clang-19
    for (let v = 13; v <= 19; v++) {
        const clang = whichSync(`clang-${v}`);
        const clangxx = whichSync(`clang++-${v}`);
        if (clang && clangxx) {
            const version = getCompilerVersion(clang);
            const name = `Clang ${version ?? v}`;
            if (!kits.some(k => k.name === name)) {
                kits.push({ name, description: clang, compilers: { c: clang, cxx: clangxx } });
            }
        }
    }

    // Chemins utilisateur
    for (const dir of extraPaths) {
        const clang = path.join(dir, 'clang');
        const clangxx = path.join(dir, 'clang++');
        if (fs.existsSync(clang) && fs.existsSync(clangxx)) {
            const version = getCompilerVersion(clang);
            const name = `Clang ${version ?? '?'} (${dir})`;
            if (!kits.some(k => k.name === name)) {
                kits.push({ name, description: dir, compilers: { c: clang, cxx: clangxx } });
            }
        }
    }

    return kits;
}

// ------------------------------------------------------------
// Utilitaires
// ------------------------------------------------------------

function getCompilerVersion(compilerPath: string): string | null {
    try {
        const output = execSync(`"${compilerPath}" --version`, {
            encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        const m = output.match(/(\d+\.\d+(?:\.\d+)?)/);
        return m?.[1] ?? null;
    } catch { return null; }
}

function whichSync(name: string): string | null {
    try {
        const result = execSync(`which ${name}`, {
            encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        const p = result.trim();
        return p && fs.existsSync(p) ? p : null;
    } catch { return null; }
}

function findExecutables(name: string): string[] {
    const results: string[] = [];
    const isWin = os.platform() === 'win32';
    const cmd = isWin ? 'where' : 'which -a';
    try {
        const output = execSync(`${cmd} ${name}`, {
            encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        for (const line of output.split('\n')) {
            const p = line.trim();
            if (p && fs.existsSync(p)) { results.push(p); }
        }
    } catch { /* */ }
    return results;
}
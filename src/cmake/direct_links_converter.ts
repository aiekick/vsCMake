import { CmakeReply } from './api_client';
import { Target, BacktraceGraph, BacktraceNode } from './types';

/**
 * For each target, compute `directLinks`: the IDs of targets that
 * are directly linked via target_link_libraries(), excluding transitive.
 *
 * Strategy: each link fragment has a backtrace that forms a chain
 * (node → parent → ... → root). We use the FULL chain as signature.
 * This handles wrapper functions/macros where the immediate node
 * (target_link_libraries inside the function) is the same for all
 * callers, but the call site in the chain differs.
 *
 * A fragment is transitive if a dependency has a fragment with the
 * exact same full backtrace chain signature.
 *
 * Fragments that don't resolve to any project target are parsed as
 * system libraries (Unix `-l<name>`, MSVC `<name>.lib`, full paths)
 * and added as synthetic SYSTEM_LIBRARY leaf nodes.
 */
export function computeDirectLinks(aReply: CmakeReply): CmakeReply {
    const artifact_to_id = buildArtifactMap(aReply.targets);
    const by_id = new Map(aReply.targets.map(t => [t.id, t]));

    // Pre-compute link signatures for each target
    const target_sigs = new Map<string, Set<string>>();
    for (const t of aReply.targets) {
        target_sigs.set(t.id, getLinkSignatures(t));
    }

    // Collect system libraries discovered across all targets.
    // Maps synthetic ID → display name.
    const sys_libs = new Map<string, string>();

    for (const t of aReply.targets) {
        t.directLinks = findDirectLinks(t, artifact_to_id, by_id, target_sigs, sys_libs);
    }

    // Create synthetic Target objects for every discovered system library
    for (const [id, name] of sys_libs) {
        aReply.targets.push(makeSysLibTarget(id, name));
    }

    return aReply;
}

/**
 * Get all full-chain signatures from link fragments of a target.
 */
function getLinkSignatures(t: Target): Set<string> {
    const sigs = new Set<string>();
    if (!t.link?.commandFragments || !t.backtraceGraph) return sigs;
    const bg = t.backtraceGraph;
    for (const frag of t.link.commandFragments) {
        if (frag.role !== 'libraries' || frag.backtrace === undefined) continue;
        const sig = resolveChainSignature(bg, frag.backtrace);
        if (sig) sigs.add(sig);
    }
    return sigs;
}

/**
 * Walk the full backtrace chain from aNodeIdx to root.
 * Returns a signature like "file1:10|file2:42|file3:1"
 * representing the complete call stack.
 */
function resolveChainSignature(
    aBg: BacktraceGraph,
    aNodeIdx: number,
): string | undefined {
    const parts: string[] = [];
    let idx: number | undefined = aNodeIdx;
    while (idx !== undefined) {
        const node: BacktraceNode = aBg.nodes[idx];
        if (!node) break;
        const file = aBg.files[node.file];
        if (file && node.line !== undefined) {
            parts.push(normalizePath(file) + ':' + node.line);
        }
        idx = node.parent;
    }
    return parts.length > 0 ? parts.join('|') : undefined;
}

function findDirectLinks(
    t: Target,
    aArtifactToId: Map<string, string>,
    aById: Map<string, Target>,
    aTargetSigs: Map<string, Set<string>>,
    aSysLibs: Map<string, string>,
): string[] {
    if (!t.link?.commandFragments || !t.backtraceGraph) return [];

    const bg = t.backtraceGraph;
    // Match any command containing "target_link_libraries"
    // (handles _target_link_libraries wrappers)
    const tll_indices = new Set<number>();
    bg.commands.forEach((cmd, i) => {
        if (cmd.includes('target_link_libraries')) tll_indices.add(i);
    });
    if (tll_indices.size === 0) return [];

    // Collect signatures from all dependencies
    const dep_sigs = new Set<string>();
    for (const dep of t.dependencies ?? []) {
        const sigs = aTargetSigs.get(dep.id);
        if (sigs) {
            for (const s of sigs) dep_sigs.add(s);
        }
    }

    const result: string[] = [];
    const seen = new Set<string>();

    for (const frag of t.link.commandFragments) {
        if (frag.role !== 'libraries' || frag.backtrace === undefined) continue;

        // Must be a target_link_libraries call (or wrapper variant)
        const node = bg.nodes[frag.backtrace];
        if (!node || node.command === undefined || !tll_indices.has(node.command)) continue;

        // Full chain signature
        const sig = resolveChainSignature(bg, frag.backtrace);
        if (sig && dep_sigs.has(sig)) continue; // transitive

        // Resolve fragment to a project target ID
        const norm = normalizePath(frag.fragment);
        const id = findTargetByFragment(norm, aArtifactToId);
        if (id && id !== t.id && !seen.has(id)) {
            seen.add(id);
            result.push(id);
            continue;
        }

        // Not a project target — try to parse as a system library
        if (!id) {
            const lib_name = parseSystemLibraryName(norm);
            if (lib_name) {
                const sys_id = SYSLIB_ID_PREFIX + lib_name;
                aSysLibs.set(sys_id, lib_name);
                if (!seen.has(sys_id)) {
                    seen.add(sys_id);
                    result.push(sys_id);
                }
            }
        }
    }
    return result;
}

// ---- Helpers ----

function buildArtifactMap(aTargets: Target[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const t of aTargets) {
        for (const a of t.artifacts ?? []) {
            m.set(normalizePath(a.path), t.id);
        }
    }
    return m;
}

function findTargetByFragment(
    aFragPath: string,
    aArtifactToId: Map<string, string>,
): string | undefined {
    for (const [art_path, id] of aArtifactToId) {
        if (art_path === aFragPath
            || art_path.endsWith('/' + aFragPath)
            || aFragPath.endsWith('/' + art_path)) {
            return id;
        }
    }
    const frag_base = basename(aFragPath);
    for (const [art_path, id] of aArtifactToId) {
        if (basename(art_path) === frag_base) return id;
    }
    return undefined;
}

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
}

function basename(p: string): string {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.substring(i + 1) : p;
}

// ---- System library helpers ----

const SYSLIB_ID_PREFIX = '__syslib__';

/**
 * Extract a clean library name from a linker fragment.
 *
 * Handles:
 *  - Unix `-l<name>` flags:  `-lmosquitto` → `mosquitto`
 *  - Full paths to shared/static libs: `/usr/lib/libssl.so.3` → `ssl`
 *  - macOS dylibs: `libcurl.dylib` → `curl`
 *  - MSVC import libs: `ws2_32.lib` → `ws2_32`
 *  - Bare DLLs passed as fragments: `mosquitto.dll` → `mosquitto`
 *  - Windows `.lib` full paths: `C:/libs/mosquitto.lib` → `mosquitto`
 *
 * Returns undefined if the fragment doesn't look like a library
 * (e.g. plain flags, response files, etc.).
 */
function parseSystemLibraryName(aFragment: string): string | undefined {
    const frag = aFragment.trim();
    if (frag.length === 0) return undefined;

    // -l<name>  (Unix / MinGW)
    if (frag.startsWith('-l')) {
        const name = frag.substring(2);
        return name.length > 0 ? name : undefined;
    }

    // -framework <name> (macOS) — fragment is "-framework CoreFoundation"
    const fw_match = frag.match(/^-framework\s+(.+)$/i);
    if (fw_match) return fw_match[1];

    // Full path or bare filename: extract the basename then strip decorations
    const base = basename(frag);

    // Must have a recognizable library extension
    const lib_ext = /\.(so(\.\d+)*|a|dylib|lib|dll)$/i;
    if (!lib_ext.test(base)) return undefined;

    // Strip extension(s)  — handles .so.1.2.3, .dylib, .lib, .a, .dll
    let name = base.replace(/\.(so(\.\d+)*|dylib|lib|dll|a)$/i, '');

    // Strip `lib` prefix (common on Unix: libfoo.so → foo)
    if (name.startsWith('lib') && name.length > 3) {
        name = name.substring(3);
    }

    return name.length > 0 ? name : undefined;
}

/**
 * Create a synthetic Target for a system library leaf node.
 */
function makeSysLibTarget(aId: string, aName: string): Target {
    return {
        name: aName,
        id: aId,
        type: 'SYSTEM_LIBRARY',
        paths: { source: '', build: '' },
        sources: [],
    };
}

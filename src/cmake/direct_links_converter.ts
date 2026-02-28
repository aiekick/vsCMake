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
 */
export function computeDirectLinks(aReply: CmakeReply): CmakeReply {
    const artifact_to_id = buildArtifactMap(aReply.targets);
    const by_id = new Map(aReply.targets.map(t => [t.id, t]));

    // Pre-compute link signatures for each target
    const target_sigs = new Map<string, Set<string>>();
    for (const t of aReply.targets) {
        target_sigs.set(t.id, getLinkSignatures(t));
    }

    for (const t of aReply.targets) {
        t.directLinks = findDirectLinks(t, artifact_to_id, by_id, target_sigs);
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

        // Resolve fragment to a target ID
        const id = findTargetByFragment(normalizePath(frag.fragment), aArtifactToId);
        if (id && id !== t.id && !seen.has(id)) {
            seen.add(id);
            result.push(id);
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

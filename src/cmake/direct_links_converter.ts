import { CmakeReply } from './api_client';
import { Target, BacktraceGraph } from './types';

/**
 * For each target, compute `directLinks`: the IDs of targets that
 * are directly linked via target_link_libraries(), excluding transitive.
 *
 * Strategy: each link fragment has a backtrace resolved to (file, line).
 * If a dependency has a fragment with the SAME (file, line) origin,
 * then the link was inherited transitively. Otherwise it's direct.
 *
 * Mutates the targets in place and returns the same CmakeReply.
 */
export function computeDirectLinks(reply: CmakeReply): CmakeReply {
    const artifactToId = buildArtifactMap(reply.targets);
    const byId = new Map(reply.targets.map(t => [t.id, t]));

    // Pre-compute link signatures for each target
    // signature = "file_path:line" from backtrace of link fragments
    const targetSigs = new Map<string, Set<string>>();
    for (const t of reply.targets) {
        targetSigs.set(t.id, getLinkSignatures(t));
    }

    for (const t of reply.targets) {
        t.directLinks = findDirectLinks(t, artifactToId, byId, targetSigs);
    }
    return reply;
}

/**
 * Get all (file, line) signatures from link fragments of a target.
 */
function getLinkSignatures(t: Target): Set<string> {
    const sigs = new Set<string>();
    if (!t.link?.commandFragments || !t.backtraceGraph) return sigs;
    const bg = t.backtraceGraph;
    for (const frag of t.link.commandFragments) {
        if (frag.role !== 'libraries' || frag.backtrace === undefined) continue;
        const sig = resolveSignature(bg, frag.backtrace);
        if (sig) sigs.add(sig);
    }
    return sigs;
}

/**
 * Resolve a backtrace index to a "file_path:line" string.
 */
function resolveSignature(bg: BacktraceGraph, nodeIdx: number): string | undefined {
    const node = bg.nodes[nodeIdx];
    if (!node || node.line === undefined) return undefined;
    const file = bg.files[node.file];
    if (!file) return undefined;
    return normalizePath(file) + ':' + node.line;
}

function findDirectLinks(
    t: Target,
    artifactToId: Map<string, string>,
    byId: Map<string, Target>,
    targetSigs: Map<string, Set<string>>,
): string[] {
    if (!t.link?.commandFragments || !t.backtraceGraph) return [];

    const bg = t.backtraceGraph;
    const tllIdx = bg.commands.indexOf('target_link_libraries');
    if (tllIdx === -1) return [];

    // Collect signatures from all dependencies
    const depSigs = new Set<string>();
    for (const dep of t.dependencies ?? []) {
        const sigs = targetSigs.get(dep.id);
        if (sigs) {
            for (const s of sigs) depSigs.add(s);
        }
    }

    const result: string[] = [];
    const seen = new Set<string>();

    for (const frag of t.link.commandFragments) {
        if (frag.role !== 'libraries' || frag.backtrace === undefined) continue;

        // Must be a target_link_libraries call
        const node = bg.nodes[frag.backtrace];
        if (!node || node.command !== tllIdx) continue;

        // Check: does any dependency have a fragment with the same origin?
        const sig = resolveSignature(bg, frag.backtrace);
        if (sig && depSigs.has(sig)) continue; // transitive

        // Resolve fragment to a target ID
        const id = findTargetByFragment(normalizePath(frag.fragment), artifactToId);
        if (id && id !== t.id && !seen.has(id)) {
            seen.add(id);
            result.push(id);
        }
    }
    return result;
}

// ---- Helpers ----

function buildArtifactMap(targets: Target[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const t of targets) {
        for (const a of t.artifacts ?? []) {
            m.set(normalizePath(a.path), t.id);
        }
    }
    return m;
}

function findTargetByFragment(
    fragPath: string,
    artifactToId: Map<string, string>,
): string | undefined {
    for (const [artPath, id] of artifactToId) {
        if (artPath === fragPath
            || artPath.endsWith('/' + fragPath)
            || fragPath.endsWith('/' + artPath)) {
            return id;
        }
    }
    const fragBase = basename(fragPath);
    for (const [artPath, id] of artifactToId) {
        if (basename(artPath) === fragBase) return id;
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

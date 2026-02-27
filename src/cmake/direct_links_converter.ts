import { CmakeReply } from './api_client';
import { Target } from './types';

/**
 * For each target in the reply, compute `directLinks`:
 * the subset of `dependencies` that come from a direct
 * `target_link_libraries()` call (not transitive).
 *
 * Two-pass approach:
 *  1. Filter deps whose backtrace command is `target_link_libraries`
 *  2. Transitive reduction: remove deps reachable through other deps
 *
 * Mutates the targets in place and returns the same CmakeReply.
 */
export function computeDirectLinks(reply: CmakeReply, agressive: Boolean): CmakeReply {
    if (agressive) {
        // --- Pass 1: filter by backtrace command ---
        // Build a map id -> target for quick lookup
        const byId = new Map<string, Target>();
        for (const t of reply.targets) {
            byId.set(t.id, t);
        }

        // For each target, find deps whose backtrace roots at target_link_libraries
        const linkDepsMap = new Map<string, string[]>();

        for (const t of reply.targets) {
            const linkDeps = filterLinkDeps(t);
            linkDepsMap.set(t.id, linkDeps);
        }

        // --- Pass 2: transitive reduction ---
        for (const t of reply.targets) {
            const linkDeps = linkDepsMap.get(t.id) ?? [];

            // Collect everything reachable transitively through each dep's own linkDeps
            const transitive = new Set<string>();
            for (const depId of linkDeps) {
                collectTransitiveLinkDeps(depId, linkDepsMap, transitive, new Set());
            }

            // Keep only deps NOT reachable transitively
            t.directLinks = linkDeps.filter(id => !transitive.has(id));
        }
    } else {
        for (const t of reply.targets) {
            t.directLinks = filterLinkDeps(t);
        }
    }
    return reply;
}

/**
 * From a target's dependencies + backtraceGraph, return the IDs
 * whose backtrace command is "target_link_libraries".
 */
function filterLinkDeps(t: Target): string[] {
    if (!t.dependencies || !t.backtraceGraph) return [];

    const { commands, nodes } = t.backtraceGraph;
    const tllIdx = commands.indexOf('target_link_libraries');
    if (tllIdx === -1) return [];

    const result: string[] = [];
    for (const dep of t.dependencies) {
        if (dep.backtrace === undefined) continue;
        if (isCommandInBacktrace(nodes, dep.backtrace, tllIdx)) {
            result.push(dep.id);
        }
    }
    return result;
}

/**
 * Walk the backtrace chain from `nodeIdx` up to the root.
 * Returns true if any node in the chain has `command === cmdIdx`.
 */
type Node = { command?: number; parent?: number };

function isCommandInBacktrace(
    nodes: Node[],
    nodeIdx: number,
    cmdIdx: number
): boolean {
    let idx: number | undefined = nodeIdx;
    while (idx !== undefined) {
        const n: Node = nodes[idx];
        if (n.command === cmdIdx) return true;
        idx = n.parent;
    }
    return false;
}

/**
 * Recursively collect all link deps reachable from `id`,
 * excluding `id` itself on the first call.
 */
function collectTransitiveLinkDeps(
    id: string,
    linkDepsMap: Map<string, string[]>,
    result: Set<string>,
    visited: Set<string>
): void {
    if (visited.has(id)) return;
    visited.add(id);

    const deps = linkDepsMap.get(id);
    if (!deps) return;

    for (const dep of deps) {
        result.add(dep);
        collectTransitiveLinkDeps(dep, linkDepsMap, result, visited);
    }
}

import { CmakeReply } from './api_client';
import { Target, BacktraceGraph, BacktraceNode } from './types';

/**
 * Debug version: logs why each target has or doesn't have links.
 * Call this instead of computeDirectLinks to diagnose.
 */
export function debugDirectLinks(reply: CmakeReply): void {
    const artifactToId = buildArtifactMap(reply.targets);
    const byId = new Map(reply.targets.map(t => [t.id, t]));

    // Stats
    let noLink = 0, noFragments = 0, noTll = 0, hasLinks = 0, noLinks = 0;
    const unmatchedFragments: string[] = [];

    for (const t of reply.targets) {
        if (!t.link) {
            noLink++;
            console.log(`[NO LINK SECTION] ${t.name} (${t.type})`);
            continue;
        }
        if (!t.link.commandFragments) {
            noFragments++;
            console.log(`[NO FRAGMENTS] ${t.name} (${t.type})`);
            continue;
        }

        const bg = t.backtraceGraph;
        if (!bg) {
            console.log(`[NO BACKTRACE GRAPH] ${t.name}`);
            continue;
        }

        const tllIdx = bg.commands.indexOf('target_link_libraries');
        if (tllIdx === -1) {
            noTll++;
            // Show what commands exist
            console.log(`[NO TLL COMMAND] ${t.name} — commands: [${bg.commands.join(', ')}]`);
            continue;
        }

        // Collect dep signatures
        const depSigs = new Set<string>();
        for (const dep of t.dependencies ?? []) {
            const depTarget = byId.get(dep.id);
            if (depTarget) {
                for (const s of getLinkSignatures(depTarget)) {
                    depSigs.add(s);
                }
            }
        }

        const directIds: string[] = [];
        const seen = new Set<string>();

        for (const frag of t.link.commandFragments) {
            if (frag.role !== 'libraries') continue;
            if (frag.backtrace === undefined) continue;

            const node = bg.nodes[frag.backtrace];
            if (!node || node.command !== tllIdx) continue;

            const sig = resolveSignature(bg, frag.backtrace);
            const isTransitive = sig ? depSigs.has(sig) : false;

            const normFrag = normalizePath(frag.fragment);
            const matchedId = findTargetByFragment(normFrag, artifactToId);

            if (!matchedId) {
                unmatchedFragments.push(`${t.name}: "${frag.fragment}"`);
                console.log(`  [UNMATCHED] ${t.name} → "${frag.fragment}" (sig: ${sig})`);
                continue;
            }

            const matchedTarget = byId.get(matchedId);
            const matchedName = matchedTarget?.name ?? matchedId;

            if (isTransitive) {
                console.log(`  [TRANSITIVE] ${t.name} → ${matchedName} (sig: ${sig})`);
            } else if (matchedId !== t.id && !seen.has(matchedId)) {
                seen.add(matchedId);
                directIds.push(matchedId);
                console.log(`  [DIRECT] ${t.name} → ${matchedName} (sig: ${sig})`);
            }
        }

        if (directIds.length > 0) {
            hasLinks++;
        } else {
            noLinks++;
            // Show all lib fragments for debugging
            const libFrags = t.link.commandFragments
                .filter(f => f.role === 'libraries')
                .map(f => `"${f.fragment}" (bt:${f.backtrace})`);
            console.log(`[ZERO DIRECT LINKS] ${t.name} — lib fragments: [${libFrags.join(', ')}]`);
        }
    }

    console.log('\n=== SUMMARY ===');
    console.log(`Total targets: ${reply.targets.length}`);
    console.log(`No link section: ${noLink}`);
    console.log(`No fragments: ${noFragments}`);
    console.log(`No target_link_libraries cmd: ${noTll}`);
    console.log(`With direct links: ${hasLinks}`);
    console.log(`With zero direct links: ${noLinks}`);
    if (unmatchedFragments.length > 0) {
        console.log(`\nUnmatched fragments (${unmatchedFragments.length}):`);
        // Show unique fragment basenames
        const bases = new Set(unmatchedFragments.map(s => s.split('"')[1]));
        for (const b of [...bases].slice(0, 20)) {
            console.log(`  ${b}`);
        }
        if (bases.size > 20) console.log(`  ... and ${bases.size - 20} more`);
    }
}

// --- Same helpers as computeDirectLinks ---

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

function resolveSignature(bg: { files: string[]; nodes: { file: number; line?: number; parent?: number }[] }, nodeIdx: number): string | undefined {
    const node = bg.nodes[nodeIdx];
    if (!node || node.line === undefined) return undefined;
    const file = bg.files[node.file];
    if (!file) return undefined;
    return normalizePath(file) + ':' + node.line;
}

function buildArtifactMap(targets: Target[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const t of targets) {
        for (const a of t.artifacts ?? []) {
            m.set(normalizePath(a.path), t.id);
        }
    }
    return m;
}

function findTargetByFragment(fragPath: string, artifactToId: Map<string, string>): string | undefined {
    for (const [artPath, id] of artifactToId) {
        if (artPath === fragPath || artPath.endsWith('/' + fragPath) || fragPath.endsWith('/' + artPath)) {
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

/**
 * Find targets that have dependencies to other project targets
 * but zero directLinks. These are the suspects.
 * Logs anonymized info (no lib names, just counts and types).
 */
export function debugMissingLinks(reply: CmakeReply): void {
    const allIds = new Set(reply.targets.map(t => t.id));
    const byId = new Map(reply.targets.map(t => [t.id, t]));

    const suspects: string[] = [];

    for (const t of reply.targets) {
        if (t.type === 'UTILITY' || t.type === 'INTERFACE_LIBRARY') continue;

        const directLinks = t.directLinks ?? [];

        // Count deps that point to real project targets (not ZERO_CHECK etc)
        const projectDeps = (t.dependencies ?? [])
            .filter(d => allIds.has(d.id))
            .map(d => byId.get(d.id))
            .filter((d): d is Target =>
                d !== undefined
                && d.type !== 'UTILITY'
                && d.type !== 'INTERFACE_LIBRARY');

        if (projectDeps.length > 0 && directLinks.length === 0) {
            // This target has deps to other targets but no direct links found
            const bg = t.backtraceGraph;
            const hasTll = bg ? bg.commands.includes('target_link_libraries') : false;
            const libFragCount = (t.link?.commandFragments ?? [])
                .filter(f => f.role === 'libraries').length;
            const libFragWithBt = (t.link?.commandFragments ?? [])
                .filter(f => f.role === 'libraries' && f.backtrace !== undefined).length;

            suspects.push(
                `[SUSPECT] type=${t.type} ` +
                `deps=${projectDeps.length} ` +
                `directLinks=0 ` +
                `hasTll=${hasTll} ` +
                `libFragments=${libFragCount} ` +
                `libFragsWithBt=${libFragWithBt}`,
            );
        }
    }

    console.log(`\n=== SUSPECTS (have deps but zero directLinks) ===`);
    console.log(`Count: ${suspects.length}`);

    // Group by pattern
    const patterns = new Map<string, number>();
    for (const s of suspects) {
        // Extract pattern: type + hasTll + fragment counts
        const match = s.match(/type=(\S+).*hasTll=(\S+).*libFragments=(\d+).*libFragsWithBt=(\d+)/);
        if (match) {
            const key = `type=${match[1]} hasTll=${match[2]} libFrags=${match[3]} libFragsWithBt=${match[4]}`;
            patterns.set(key, (patterns.get(key) ?? 0) + 1);
        }
    }

    console.log('\nPatterns:');
    for (const [pattern, count] of [...patterns.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${count}x ${pattern}`);
    }
}

/**
 * For the FIRST suspect target (has deps but zero directLinks),
 * log detailed chain info. All names are anonymized.
 * Only shows file basenames, line numbers, and command names.
 */
export function debugSignatures(reply: CmakeReply): void {
    const allIds = new Set(reply.targets.map(t => t.id));
    const byId = new Map(reply.targets.map(t => [t.id, t]));

    // Find first suspect
    const suspect = reply.targets.find(t => {
        if (t.type === 'UTILITY' || t.type === 'INTERFACE_LIBRARY') return false;
        const projectDeps = (t.dependencies ?? [])
            .filter(d => allIds.has(d.id))
            .map(d => byId.get(d.id))
            .filter((d): d is Target =>
                d !== undefined && d.type !== 'UTILITY' && d.type !== 'INTERFACE_LIBRARY');
        return projectDeps.length > 0 && (t.directLinks ?? []).length === 0;
    });

    if (!suspect) {
        console.log('No suspects found');
        return;
    }

    const bg = suspect.backtraceGraph!;
    console.log(`\n=== SUSPECT: type=${suspect.type} ===`);
    console.log(`Commands in backtraceGraph: [${bg.commands.join(', ')}]`);
    console.log(`Files in backtraceGraph (basenames): [${bg.files.map(f => fileBasename(f)).join(', ')}]`);

    const tllIdx = bg.commands.indexOf('target_link_libraries');
    console.log(`target_link_libraries index: ${tllIdx}`);

    // Show first 5 library fragments with their chain details
    const libFrags = (suspect.link?.commandFragments ?? [])
        .filter(f => f.role === 'libraries' && f.backtrace !== undefined);

    console.log(`\nLibrary fragments with backtrace: ${libFrags.length}`);
    console.log(`\n--- First 5 fragments detail ---`);

    for (const frag of libFrags.slice(0, 5)) {
        const node = bg.nodes[frag.backtrace!];
        const cmdName = node.command !== undefined ? bg.commands[node.command] : '(none)';
        const fileName = fileBasename(bg.files[node.file]);
        console.log(`\n  Fragment: "...${fileBasename(frag.fragment)}" (bt:${frag.backtrace})`);
        console.log(`  Immediate node: cmd="${cmdName}" file="${fileName}" line=${node.line}`);
        console.log(`  Full chain:`);

        let idx: number | undefined = frag.backtrace;
        let depth = 0;
        while (idx !== undefined && depth < 10) {
            const n = bg.nodes[idx];
            if (!n) break;
            const cmd = n.command !== undefined ? bg.commands[n.command] : '(file)';
            const file = fileBasename(bg.files[n.file]);
            console.log(`    [${depth}] cmd="${cmd}" file="${file}" line=${n.line ?? '-'}`);
            idx = n.parent;
            depth++;
        }

        // Show the chain signature
        const sig = resolveChainSig(bg, frag.backtrace!);
        console.log(`  Chain sig: ${sig}`);
    }

    // Now show signatures from first 2 deps that have sigs
    console.log(`\n--- Dependency signatures (first 2 deps with sigs) ---`);
    let depCount = 0;
    for (const dep of suspect.dependencies ?? []) {
        const depTarget = byId.get(dep.id);
        if (!depTarget || depTarget.type === 'UTILITY') continue;
        const depSigs = getLinkSigs(depTarget);
        if (depSigs.size === 0) continue;
        if (depCount >= 2) break;
        depCount++;

        console.log(`\n  Dep: type=${depTarget.type} (${depSigs.size} sigs)`);
        let i = 0;
        for (const s of depSigs) {
            if (i >= 3) { console.log(`    ... and ${depSigs.size - 3} more`); break; }
            console.log(`    sig: ${s}`);
            i++;
        }
    }

    // Check: how many of suspect's sigs match a dep sig?
    const suspectSigs = new Map<string, string>();
    for (const frag of libFrags) {
        const node = bg.nodes[frag.backtrace!];
        if (!node || node.command !== tllIdx) continue;
        const sig = resolveChainSig(bg, frag.backtrace!);
        if (sig) suspectSigs.set(fileBasename(frag.fragment), sig);
    }

    const depAllSigs = new Set<string>();
    for (const dep of suspect.dependencies ?? []) {
        const dt = byId.get(dep.id);
        if (dt) for (const s of getLinkSigs(dt)) depAllSigs.add(s);
    }

    let matchCount = 0, noMatchCount = 0;
    for (const [frag, sig] of suspectSigs) {
        if (depAllSigs.has(sig)) matchCount++;
        else noMatchCount++;
    }
    console.log(`\n--- Classification ---`);
    console.log(`Fragments matching dep sigs (transitive): ${matchCount}`);
    console.log(`Fragments NOT matching (would be direct): ${noMatchCount}`);

    // Show a few that DON'T match (if any)
    if (noMatchCount > 0) {
        console.log(`\nNon-matching fragments:`);
        for (const [frag, sig] of suspectSigs) {
            if (!depAllSigs.has(sig)) {
                console.log(`  "${frag}" → ${sig}`);
            }
        }
    }
}

function getLinkSigs(t: Target): Set<string> {
    const sigs = new Set<string>();
    if (!t.link?.commandFragments || !t.backtraceGraph) return sigs;
    const bg = t.backtraceGraph;
    for (const frag of t.link.commandFragments) {
        if (frag.role !== 'libraries' || frag.backtrace === undefined) continue;
        const sig = resolveChainSig(bg, frag.backtrace);
        if (sig) sigs.add(sig);
    }
    return sigs;
}

function resolveChainSig(bg: BacktraceGraph, nodeIdx: number): string | undefined {
    const parts: string[] = [];
    let idx: number | undefined = nodeIdx;
    while (idx !== undefined) {
        const node: BacktraceNode = bg.nodes[idx];
        if (!node) break;
        const file = bg.files[node.file];
        if (file && node.line !== undefined) {
            parts.push(fileBasename(file) + ':' + node.line);
        }
        idx = node.parent;
    }
    return parts.length > 0 ? parts.join('|') : undefined;
}

function fileBasename(p: string): string {
    const n = p.replace(/\\/g, '/');
    const i = n.lastIndexOf('/');
    return i >= 0 ? n.substring(i + 1) : n;
}

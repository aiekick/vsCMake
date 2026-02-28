import { CmakeReply } from './api_client';
import { Target, BacktraceGraph, BacktraceNode } from './types';

/**
 * Debug version: logs why each target has or doesn't have links.
 * Call this instead of computeDirectLinks to diagnose.
 */
export function debugDirectLinks(aReply: CmakeReply): void {
    const artifact_to_id = buildArtifactMap(aReply.targets);
    const by_id = new Map(aReply.targets.map(t => [t.id, t]));

    // Stats
    let no_link = 0, no_fragments = 0, no_tll = 0, has_links = 0, no_links = 0;
    const unmatched_fragments: string[] = [];

    for (const t of aReply.targets) {
        if (!t.link) {
            no_link++;
            console.log(`[NO LINK SECTION] ${t.name} (${t.type})`);
            continue;
        }
        if (!t.link.commandFragments) {
            no_fragments++;
            console.log(`[NO FRAGMENTS] ${t.name} (${t.type})`);
            continue;
        }

        const bg = t.backtraceGraph;
        if (!bg) {
            console.log(`[NO BACKTRACE GRAPH] ${t.name}`);
            continue;
        }

        const tll_idx = bg.commands.indexOf('target_link_libraries');
        if (tll_idx === -1) {
            no_tll++;
            // Show what commands exist
            console.log(`[NO TLL COMMAND] ${t.name} — commands: [${bg.commands.join(', ')}]`);
            continue;
        }

        // Collect dep signatures
        const dep_sigs = new Set<string>();
        for (const dep of t.dependencies ?? []) {
            const dep_target = by_id.get(dep.id);
            if (dep_target) {
                for (const s of getLinkSignatures(dep_target)) {
                    dep_sigs.add(s);
                }
            }
        }

        const direct_ids: string[] = [];
        const seen = new Set<string>();

        for (const frag of t.link.commandFragments) {
            if (frag.role !== 'libraries') continue;
            if (frag.backtrace === undefined) continue;

            const node = bg.nodes[frag.backtrace];
            if (!node || node.command !== tll_idx) continue;

            const sig = resolveSignature(bg, frag.backtrace);
            const is_transitive = sig ? dep_sigs.has(sig) : false;

            const norm_frag = normalizePath(frag.fragment);
            const matched_id = findTargetByFragment(norm_frag, artifact_to_id);

            if (!matched_id) {
                unmatched_fragments.push(`${t.name}: "${frag.fragment}"`);
                console.log(`  [UNMATCHED] ${t.name} → "${frag.fragment}" (sig: ${sig})`);
                continue;
            }

            const matched_target = by_id.get(matched_id);
            const matched_name = matched_target?.name ?? matched_id;

            if (is_transitive) {
                console.log(`  [TRANSITIVE] ${t.name} → ${matched_name} (sig: ${sig})`);
            } else if (matched_id !== t.id && !seen.has(matched_id)) {
                seen.add(matched_id);
                direct_ids.push(matched_id);
                console.log(`  [DIRECT] ${t.name} → ${matched_name} (sig: ${sig})`);
            }
        }

        if (direct_ids.length > 0) {
            has_links++;
        } else {
            no_links++;
            // Show all lib fragments for debugging
            const lib_frags = t.link.commandFragments
                .filter(f => f.role === 'libraries')
                .map(f => `"${f.fragment}" (bt:${f.backtrace})`);
            console.log(`[ZERO DIRECT LINKS] ${t.name} — lib fragments: [${lib_frags.join(', ')}]`);
        }
    }

    console.log('\n=== SUMMARY ===');
    console.log(`Total targets: ${aReply.targets.length}`);
    console.log(`No link section: ${no_link}`);
    console.log(`No fragments: ${no_fragments}`);
    console.log(`No target_link_libraries cmd: ${no_tll}`);
    console.log(`With direct links: ${has_links}`);
    console.log(`With zero direct links: ${no_links}`);
    if (unmatched_fragments.length > 0) {
        console.log(`\nUnmatched fragments (${unmatched_fragments.length}):`);
        // Show unique fragment basenames
        const bases = new Set(unmatched_fragments.map(s => s.split('"')[1]));
        for (const b of [...bases].slice(0, 20)) {
            console.log(`  ${b}`);
        }
        if (bases.size > 20) console.log(`  ... and ${bases.size - 20} more`);
    }
}

// --- Same helpers as computeDirectLinks ---

function getLinkSignatures(aTarget: Target): Set<string> {
    const sigs = new Set<string>();
    if (!aTarget.link?.commandFragments || !aTarget.backtraceGraph) return sigs;
    const bg = aTarget.backtraceGraph;
    for (const frag of aTarget.link.commandFragments) {
        if (frag.role !== 'libraries' || frag.backtrace === undefined) continue;
        const sig = resolveSignature(bg, frag.backtrace);
        if (sig) sigs.add(sig);
    }
    return sigs;
}

function resolveSignature(aBg: { files: string[]; nodes: { file: number; line?: number; parent?: number }[] }, aNodeIdx: number): string | undefined {
    const node = aBg.nodes[aNodeIdx];
    if (!node || node.line === undefined) return undefined;
    const file = aBg.files[node.file];
    if (!file) return undefined;
    return normalizePath(file) + ':' + node.line;
}

function buildArtifactMap(aTargets: Target[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const t of aTargets) {
        for (const a of t.artifacts ?? []) {
            m.set(normalizePath(a.path), t.id);
        }
    }
    return m;
}

function findTargetByFragment(aFragPath: string, aArtifactToId: Map<string, string>): string | undefined {
    for (const [art_path, id] of aArtifactToId) {
        if (art_path === aFragPath || art_path.endsWith('/' + aFragPath) || aFragPath.endsWith('/' + art_path)) {
            return id;
        }
    }
    const frag_base = basename(aFragPath);
    for (const [art_path, id] of aArtifactToId) {
        if (basename(art_path) === frag_base) return id;
    }
    return undefined;
}

function normalizePath(aP: string): string {
    return aP.replace(/\\/g, '/');
}

function basename(aP: string): string {
    const i = aP.lastIndexOf('/');
    return i >= 0 ? aP.substring(i + 1) : aP;
}

/**
 * Find targets that have dependencies to other project targets
 * but zero directLinks. These are the suspects.
 * Logs anonymized info (no lib names, just counts and types).
 */
export function debugMissingLinks(aReply: CmakeReply): void {
    const all_ids = new Set(aReply.targets.map(t => t.id));
    const by_id = new Map(aReply.targets.map(t => [t.id, t]));

    const suspects: string[] = [];

    for (const t of aReply.targets) {
        if (t.type === 'UTILITY' || t.type === 'INTERFACE_LIBRARY') continue;

        const direct_links = t.directLinks ?? [];

        // Count deps that point to real project targets (not ZERO_CHECK etc)
        const project_deps = (t.dependencies ?? [])
            .filter(d => all_ids.has(d.id))
            .map(d => by_id.get(d.id))
            .filter((d): d is Target =>
                d !== undefined
                && d.type !== 'UTILITY'
                && d.type !== 'INTERFACE_LIBRARY');

        if (project_deps.length > 0 && direct_links.length === 0) {
            // This target has deps to other targets but no direct links found
            const bg = t.backtraceGraph;
            const has_tll = bg ? bg.commands.includes('target_link_libraries') : false;
            const lib_frag_count = (t.link?.commandFragments ?? [])
                .filter(f => f.role === 'libraries').length;
            const lib_frag_with_bt = (t.link?.commandFragments ?? [])
                .filter(f => f.role === 'libraries' && f.backtrace !== undefined).length;

            suspects.push(
                `[SUSPECT] type=${t.type} ` +
                `deps=${project_deps.length} ` +
                `directLinks=0 ` +
                `hasTll=${has_tll} ` +
                `libFragments=${lib_frag_count} ` +
                `libFragsWithBt=${lib_frag_with_bt}`,
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
export function debugSignatures(aReply: CmakeReply): void {
    const all_ids = new Set(aReply.targets.map(t => t.id));
    const by_id = new Map(aReply.targets.map(t => [t.id, t]));

    // Find first suspect
    const suspect = aReply.targets.find(t => {
        if (t.type === 'UTILITY' || t.type === 'INTERFACE_LIBRARY') return false;
        const project_deps = (t.dependencies ?? [])
            .filter(d => all_ids.has(d.id))
            .map(d => by_id.get(d.id))
            .filter((d): d is Target =>
                d !== undefined && d.type !== 'UTILITY' && d.type !== 'INTERFACE_LIBRARY');
        return project_deps.length > 0 && (t.directLinks ?? []).length === 0;
    });

    if (!suspect) {
        console.log('No suspects found');
        return;
    }

    const bg = suspect.backtraceGraph!;
    console.log(`\n=== SUSPECT: type=${suspect.type} ===`);
    console.log(`Commands in backtraceGraph: [${bg.commands.join(', ')}]`);
    console.log(`Files in backtraceGraph (basenames): [${bg.files.map(f => fileBasename(f)).join(', ')}]`);

    const tll_idx = bg.commands.indexOf('target_link_libraries');
    console.log(`target_link_libraries index: ${tll_idx}`);

    // Show first 5 library fragments with their chain details
    const lib_frags = (suspect.link?.commandFragments ?? [])
        .filter(f => f.role === 'libraries' && f.backtrace !== undefined);

    console.log(`\nLibrary fragments with backtrace: ${lib_frags.length}`);
    console.log(`\n--- First 5 fragments detail ---`);

    for (const frag of lib_frags.slice(0, 5)) {
        const node = bg.nodes[frag.backtrace!];
        const cmd_name = node.command !== undefined ? bg.commands[node.command] : '(none)';
        const file_name = fileBasename(bg.files[node.file]);
        console.log(`\n  Fragment: "...${fileBasename(frag.fragment)}" (bt:${frag.backtrace})`);
        console.log(`  Immediate node: cmd="${cmd_name}" file="${file_name}" line=${node.line}`);
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
    let dep_count = 0;
    for (const dep of suspect.dependencies ?? []) {
        const dep_target = by_id.get(dep.id);
        if (!dep_target || dep_target.type === 'UTILITY') continue;
        const dep_sigs = getLinkSigs(dep_target);
        if (dep_sigs.size === 0) continue;
        if (dep_count >= 2) break;
        dep_count++;

        console.log(`\n  Dep: type=${dep_target.type} (${dep_sigs.size} sigs)`);
        let i = 0;
        for (const s of dep_sigs) {
            if (i >= 3) { console.log(`    ... and ${dep_sigs.size - 3} more`); break; }
            console.log(`    sig: ${s}`);
            i++;
        }
    }

    // Check: how many of suspect's sigs match a dep sig?
    const suspect_sigs = new Map<string, string>();
    for (const frag of lib_frags) {
        const node = bg.nodes[frag.backtrace!];
        if (!node || node.command !== tll_idx) continue;
        const sig = resolveChainSig(bg, frag.backtrace!);
        if (sig) suspect_sigs.set(fileBasename(frag.fragment), sig);
    }

    const dep_all_sigs = new Set<string>();
    for (const dep of suspect.dependencies ?? []) {
        const dt = by_id.get(dep.id);
        if (dt) for (const s of getLinkSigs(dt)) dep_all_sigs.add(s);
    }

    let match_count = 0, no_match_count = 0;
    for (const [frag, sig] of suspect_sigs) {
        if (dep_all_sigs.has(sig)) match_count++;
        else no_match_count++;
    }
    console.log(`\n--- Classification ---`);
    console.log(`Fragments matching dep sigs (transitive): ${match_count}`);
    console.log(`Fragments NOT matching (would be direct): ${no_match_count}`);

    // Show a few that DON'T match (if any)
    if (no_match_count > 0) {
        console.log(`\nNon-matching fragments:`);
        for (const [frag, sig] of suspect_sigs) {
            if (!dep_all_sigs.has(sig)) {
                console.log(`  "${frag}" → ${sig}`);
            }
        }
    }
}

function getLinkSigs(aTarget: Target): Set<string> {
    const sigs = new Set<string>();
    if (!aTarget.link?.commandFragments || !aTarget.backtraceGraph) return sigs;
    const bg = aTarget.backtraceGraph;
    for (const frag of aTarget.link.commandFragments) {
        if (frag.role !== 'libraries' || frag.backtrace === undefined) continue;
        const sig = resolveChainSig(bg, frag.backtrace);
        if (sig) sigs.add(sig);
    }
    return sigs;
}

function resolveChainSig(aBg: BacktraceGraph, aNodeIdx: number): string | undefined {
    const parts: string[] = [];
    let idx: number | undefined = aNodeIdx;
    while (idx !== undefined) {
        const node: BacktraceNode = aBg.nodes[idx];
        if (!node) break;
        const file = aBg.files[node.file];
        if (file && node.line !== undefined) {
            parts.push(fileBasename(file) + ':' + node.line);
        }
        idx = node.parent;
    }
    return parts.length > 0 ? parts.join('|') : undefined;
}

function fileBasename(aP: string): string {
    const n = aP.replace(/\\/g, '/');
    const i = n.lastIndexOf('/');
    return i >= 0 ? n.substring(i + 1) : n;
}

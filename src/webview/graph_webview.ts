import { GraphEdgeDirection } from '../cmake/types';

// ------------------------------------------------------------
// VS Code API
// ------------------------------------------------------------
declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
interface GraphNode {
    id: string;
    label: string;
    type: string;
    color: string;
    shape: string;
    sourcePath: string;
}

interface GraphEdge {
    from: string;
    to: string;
}

interface LayoutNode {
    node: GraphNode;
    x: number;   // world position (center)
    y: number;
    w: number;   // node width (computed from label)
    vx: number;  // velocity for force simulation
    vy: number;
}

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let all_nodes: GraphNode[] = [];
let all_edges: GraphEdge[] = [];
let layout_nodes: LayoutNode[] = [];
let active_filters = new Set<string>();
let selected_node_id: string | null = null;
let edge_style: 'tapered' | 'chevrons' | 'line' = 'tapered';
let edge_direction: GraphEdgeDirection = GraphEdgeDirection.TARGETS_USED_BY; // default to "targets used by" which is more intuitive for most users
let sim_enabled = true;       // user toggle: allows/prevents sim from running
let auto_pause_during_drag = false;
let search_filter = '';
let search_mode: 'name' | 'path' = 'name';
let search_filter_mode: 'dim' | 'hide' = 'hide'; // dim = lower opacity, hide = remove from graph
let minimap_enabled = true;
let tapered_width_factor = 2.0;
let settings_collapse_state: Record<string, boolean> = { edges: false, colors: true, simulation: true, display: false, controls: false };
let settings_panel_visible = false;

// Focused view state: when non-null, only show the recursively connected subgraph
let focused_node_id: string | null = null;
let focus_history: { nodeId: string; label: string }[] = [];
let focus_visible_ids: Set<string> | null = null; // precomputed set of visible node ids in focus mode

const TARGET_TYPES = [
    'EXECUTABLE', 'STATIC_LIBRARY', 'SHARED_LIBRARY',
    'MODULE_LIBRARY', 'OBJECT_LIBRARY', 'INTERFACE_LIBRARY',
];

// Node sizing
const NODE_H = 25;
const NODE_PAD_X = 10;
const NODE_MIN_W = 60;

// Canvas / camera state
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let cam_x = 0;
let cam_y = 0;
let zoom = 1;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 10;
const GRID_SIZE = 40;

// Interaction state
let is_panning = false;
let is_dragging_node = false;
let was_panning = false;
let drag_node: LayoutNode | null = null;
let pan_start_x = 0;
let pan_start_y = 0;
let cam_start_x = 0;
let cam_start_y = 0;
let drag_offset_x = 0;
let drag_offset_y = 0;
let first_layout = true;

// ------------------------------------------------------------
// Force simulation parameters (defaults)
// ------------------------------------------------------------

const SIM_DEFAULTS: Record<string, number> = {
    repulsion: 50000, // node repulsion strength: higher = stronger push away
    attraction: 0.1, // edge attraction strength: higher = stronger pull together
    gravity: 0.001, // gravity strength: higher = stronger pull towards center, prevents drifting apart
    linkLength: 0.05, // ideal link length smaller = stronger spring
    minDistance: 50, // minimum distance for repulsion to avoid extreme forces at close range
    stepsPerFrame: 5, // how many simulation steps to run per animation frame, higher = faster convergence but more CPU usage
    threshold: 2, // when to stop the simulation: if max node movement is below this, we consider it "converged" and stop until next interaction
    damping: 0.85, // velocity damping factor: between 0 and 1, higher = quicker stop but can cause jitter, lower = longer settling time but smoother
};

let sim_vars: Record<string, number> = SIM_DEFAULTS; // current sim parameters, can be tweaked by user

let sim_running = false; // whether the simulation loop is currently running (can be paused by user)
let sim_anim_frame: number | null = null; // current animation frame id for simulation loop, used to cancel when needed

// ------------------------------------------------------------
// State persistence (camera only, survives webview refresh)
// Settings are persisted to workspace via updateSetting messages.
// ------------------------------------------------------------
interface PersistedState {
    camX?: number;
    camY?: number;
    zoom?: number;
}

function saveState(): void {
    vscode.setState({ camX: cam_x, camY: cam_y, zoom } as PersistedState);
}

function restoreState(): boolean {
    const s = vscode.getState() as PersistedState | undefined;
    if (!s || s.camX === undefined) { return false; }
    cam_x = s.camX;
    cam_y = s.camY!;
    zoom = s.zoom!;
    return true;
}

// ------------------------------------------------------------
// Search filter helpers
// ------------------------------------------------------------
function nodeMatchesSearch(aNode: GraphNode): boolean {
    if (!search_filter) { return true; }
    const query = search_filter.toLowerCase();
    const target = search_mode === 'name' ? aNode.label : aNode.sourcePath;
    // Support regex for power users: if the query is a valid regex, use it
    try {
        if (search_filter.includes('*') || search_filter.includes('(') || search_filter.includes('[')) {
            return new RegExp(search_filter, 'i').test(target);
        }
    } catch { /* not a valid regex, fallback to simple match */ }
    return target.toLowerCase().includes(query);
}

/**
 * Returns true if a node should be completely excluded from the graph
 * (simulation + rendering), like type filters in the header.
 * Combines: activeFilters (type checkboxes) + hide-mode search + hide-mode focus.
 */
function isNodeFiltered(aNode: GraphNode): boolean {
    // Type filter from header checkboxes
    if (active_filters.has(aNode.type)) { return true; }
    // In "hide" mode, search and focus act as real filters
    if (search_filter_mode === 'hide') {
        if (search_filter && !nodeMatchesSearch(aNode)) { return true; }
        if (focus_visible_ids && !focus_visible_ids.has(aNode.id)) { return true; }
    }
    return false;
}

// ------------------------------------------------------------
// Text measurement (uses offscreen canvas)
// ------------------------------------------------------------
const measure_ctx = document.createElement('canvas').getContext('2d')!;

function measureNodeWidth(aLabel: string): number {
    const font = getCssVar('--vscode-font-family') || 'monospace';
    measure_ctx.font = `bold 11px ${font}`;
    const text_w = measure_ctx.measureText(aLabel).width;
    return Math.max(NODE_MIN_W, text_w + NODE_PAD_X * 2);
}

// ------------------------------------------------------------
// Canvas setup
// ------------------------------------------------------------
function setupCanvas(): void {
    const container = document.getElementById('graph-container')!;
    container.style.display = 'block';
    document.getElementById('empty-message')!.style.display = 'none';

    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        container.innerHTML = '';
        container.appendChild(canvas);
        ctx = canvas.getContext('2d')!;
        attachCanvasEvents(canvas);
    }

    resizeCanvas();
}

function resizeCanvas(): void {
    if (!canvas) { return; }
    const container = canvas.parentElement!;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    draw();
}

// ------------------------------------------------------------
// Drawing
// ------------------------------------------------------------
function draw(): void {
    if (!canvas || !ctx) { return; }
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    ctx.clearRect(0, 0, w, h);

    const bg = getCssVar('--vscode-editor-background') || '#1e1e1e';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    drawGrid(w, h);
    drawEdges(w, h);
    drawNodes(w, h);
    if (minimap_enabled) { drawMinimap(w, h); }
}

function worldToScreen(aWx: number, aWy: number): [number, number] {
    return [cam_x + aWx * zoom, cam_y + aWy * zoom];
}

// ------------------------------------------------------------
// Edge drawing (supports tapered, chevrons, or plain line)
// ------------------------------------------------------------
function drawEdges(aW: number, aH: number): void {
    if (!ctx || all_edges.length === 0) { return; }

    const node_map = new Map<string, LayoutNode>();
    for (const ln of layout_nodes) {
        if (!isNodeFiltered(ln.node)) {
            node_map.set(ln.node.id, ln);
        }
    }

    const has_search = search_filter.length > 0;

    // Draw normal edges, then highlighted on top
    for (const edge of all_edges) {
        const from_ln = node_map.get(edge.from);
        const to_ln = node_map.get(edge.to);
        if (!from_ln || !to_ln) { continue; }

        const is_highlighted = selected_node_id && (edge.from === selected_node_id || edge.to === selected_node_id);
        if (is_highlighted) { continue; }

        const [x1, y1] = worldToScreen(from_ln.x, from_ln.y);
        const [x2, y2] = worldToScreen(to_ln.x, to_ln.y);
        const margin = 50;
        if (Math.max(x1, x2) < -margin || Math.min(x1, x2) > aW + margin) { continue; }
        if (Math.max(y1, y2) < -margin || Math.min(y1, y2) > aH + margin) { continue; }

        // In "dim" mode, dim edges where neither endpoint matches search/focus
        const from_matches_search = !has_search || nodeMatchesSearch(from_ln.node);
        const to_matches_search = !has_search || nodeMatchesSearch(to_ln.node);
        const from_in_focus = isNodeVisibleInFocus(from_ln.node.id);
        const to_in_focus = isNodeVisibleInFocus(to_ln.node.id);
        const search_dim = has_search && !from_matches_search && !to_matches_search;
        const focus_dim = focused_node_id !== null && !from_in_focus && !to_in_focus;
        const edge_alpha = (search_dim || focus_dim) ? 0.04 : 0.15;
        drawEdgeStyled(ctx, x1, y1, x2, y2, `rgba(255, 255, 255, ${edge_alpha})`);
    }

    // Highlighted edges with gradient: node color -> white along the arrow
    if (selected_node_id) {
        for (const edge of all_edges) {
            const is_highlighted = edge.from === selected_node_id || edge.to === selected_node_id;
            if (!is_highlighted) { continue; }
            const from_ln = node_map.get(edge.from);
            const to_ln = node_map.get(edge.to);
            if (!from_ln || !to_ln) { continue; }
            const [x1, y1] = worldToScreen(from_ln.x, from_ln.y);
            const [x2, y2] = worldToScreen(to_ln.x, to_ln.y);

            // Compute visual arrow direction (after edgeDirection swap)
            // The wide end (base) is at sx1,sy1 and the tip at sx2,sy2
            let sx1 = x1, sy1 = y1, sx2 = x2, sy2 = y2;
            let base_node = from_ln;
            if (edge_direction === GraphEdgeDirection.TARGETS_USED_BY) {
                sx1 = x2; sy1 = y2; sx2 = x1; sy2 = y1;
                base_node = to_ln;
            }

            // Gradient from the base node's color (wide end) -> white (tip)
            const grad = ctx.createLinearGradient(sx1, sy1, sx2, sy2);
            grad.addColorStop(0, base_node.node.color);
            grad.addColorStop(1, '#ffffff');

            drawEdgeStyled(ctx, x1, y1, x2, y2, grad, 0.6);
        }
    }
}

/** Dispatch to the correct edge style, respecting edge direction */
function drawEdgeStyled(
    aC: CanvasRenderingContext2D,
    aX1: number, aY1: number, aX2: number, aY2: number,
    aColor: string | CanvasGradient, aAlpha = 1,
): void {
    // Swap direction if inverted
    let sx1 = aX1, sy1 = aY1, sx2 = aX2, sy2 = aY2;
    if (edge_direction === GraphEdgeDirection.TARGETS_USED_BY) {
        sx1 = aX2; sy1 = aY2; sx2 = aX1; sy2 = aY1;
    }
    switch (edge_style) {
        case 'tapered': drawTaperedEdge(aC, sx1, sy1, sx2, sy2, aColor, aAlpha); break;
        case 'chevrons': drawChevronEdge(aC, sx1, sy1, sx2, sy2, aColor, aAlpha); break;
        case 'line': drawLineEdge(aC, sx1, sy1, sx2, sy2, aColor, aAlpha); break;
    }
}

/** Tapered triangle: wider at "from", narrow at "to" */
function drawTaperedEdge(
    aC: CanvasRenderingContext2D,
    aX1: number, aY1: number, aX2: number, aY2: number,
    aColor: string | CanvasGradient, aAlpha = 1,
): void {
    const dx = aX2 - aX1;
    const dy = aY2 - aY1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 2) { return; }

    const px = -dy / len;
    const py = dx / len;

    const wide_half = Math.max(1.5, 3 * zoom * tapered_width_factor);
    const narrow_half = Math.max(0.3, 0.5 * zoom * tapered_width_factor);

    aC.globalAlpha = aAlpha;
    aC.fillStyle = aColor;
    aC.beginPath();
    aC.moveTo(aX1 + px * wide_half, aY1 + py * wide_half);
    aC.lineTo(aX2 + px * narrow_half, aY2 + py * narrow_half);
    aC.lineTo(aX2 - px * narrow_half, aY2 - py * narrow_half);
    aC.lineTo(aX1 - px * wide_half, aY1 - py * wide_half);
    aC.closePath();
    aC.fill();
    aC.globalAlpha = 1;
}

/** Chevrons (>>>) at the midpoint of a line */
function drawChevronEdge(
    aC: CanvasRenderingContext2D,
    aX1: number, aY1: number, aX2: number, aY2: number,
    aColor: string | CanvasGradient, aAlpha = 1,
): void {
    const dx = aX2 - aX1;
    const dy = aY2 - aY1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 2) { return; }

    aC.globalAlpha = aAlpha;
    aC.strokeStyle = aColor;
    aC.lineWidth = Math.max(1, 1.5 * zoom);
    aC.beginPath();
    aC.moveTo(aX1, aY1);
    aC.lineTo(aX2, aY2);
    aC.stroke();

    const ux = dx / len;
    const uy = dy / len;
    const chev_size = Math.max(3, 5 * zoom);
    const gap = Math.max(2, 4 * zoom);
    const mx = (aX1 + aX2) / 2;
    const my = (aY1 + aY2) / 2;

    aC.lineWidth = Math.max(1, 1.2 * zoom);
    for (let i = -1; i <= 1; i++) {
        const cx = mx + ux * i * gap;
        const cy = my + uy * i * gap;
        aC.beginPath();
        aC.moveTo(cx - ux * chev_size - uy * chev_size, cy - uy * chev_size + ux * chev_size);
        aC.lineTo(cx, cy);
        aC.lineTo(cx - ux * chev_size + uy * chev_size, cy - uy * chev_size - ux * chev_size);
        aC.stroke();
    }
    aC.globalAlpha = 1;
}

/** Simple straight line (no direction indicator) */
function drawLineEdge(
    aC: CanvasRenderingContext2D,
    aX1: number, aY1: number, aX2: number, aY2: number,
    aColor: string | CanvasGradient, aAlpha = 1,
): void {
    aC.globalAlpha = aAlpha;
    aC.strokeStyle = aColor;
    aC.lineWidth = Math.max(1, 1.5 * zoom);
    aC.beginPath();
    aC.moveTo(aX1, aY1);
    aC.lineTo(aX2, aY2);
    aC.stroke();
    aC.globalAlpha = 1;
}

// ------------------------------------------------------------
// Node drawing (all rectangular)
// ------------------------------------------------------------
function drawNodes(aW: number, aH: number): void {
    if (!ctx || layout_nodes.length === 0) { return; }

    const min_font_size = 3;
    const font_size = Math.max(min_font_size, 11 * zoom);

    const has_search = search_filter.length > 0;

    for (const ln of layout_nodes) {
        if (isNodeFiltered(ln.node)) { continue; }

        const [sx, sy] = worldToScreen(ln.x, ln.y);
        const sw = ln.w * zoom;
        const sh = NODE_H * zoom;

        // Cull off-screen
        if (((sx + sw / 2) < 0) ||
            ((sx - sw / 2) > aW) ||
            ((sy + sh / 2) < 0) ||
            ((sy - sh / 2) > aH)) {
            continue;
        }

        // In "dim" mode, reduce opacity for non-matching nodes
        const matches_search = !has_search || nodeMatchesSearch(ln.node);
        const in_focus = isNodeVisibleInFocus(ln.node.id);
        const node_alpha = (!matches_search || !in_focus) ? 0.12 : 1;

        const color = ln.node.color;
        const border_color = darken(color);

        const zoom2 = 2 * zoom;
        const zoom3 = 3 * zoom;
        const zoom4 = 4 * zoom;

        ctx.globalAlpha = node_alpha;
        ctx.fillStyle = color;
        ctx.strokeStyle = border_color;
        ctx.lineWidth = Math.max(1, zoom2);
        const r = Math.min(zoom4, sw * 0.08);
        drawBox(ctx, sx, sy, sw, sh, r);

        // Focused root node halo (golden glow)
        if (focused_node_id && ln.node.id === focused_node_id) {
            ctx.save();
            ctx.shadowColor = '#FFD700';
            ctx.shadowBlur = Math.max(12, 20 * zoom);
            ctx.strokeStyle = '#FFD700';
            ctx.lineWidth = Math.max(2, zoom3);
            const halo_r = Math.min(zoom4 + zoom2, (sw + zoom4 * 2) * 0.08);
            drawBox(ctx, sx, sy, sw + zoom4 * 2, sh + zoom4 * 2, halo_r, true);
            ctx.restore();
            ctx.globalAlpha = node_alpha;
        }

        // Selection border
        if (ln.node.id === selected_node_id) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(2, zoom3);
            drawBox(ctx, sx, sy, sw + zoom4, sh + zoom4, r + zoom2, true);
        }

        if (font_size <= min_font_size) { ctx.globalAlpha = 1; continue; }

        // Label with auto contrast
        const text_color = contrastTextColor(color);
        ctx.fillStyle = text_color;
        ctx.font = `bold ${font_size}px ${getCssVar('--vscode-font-family') || 'monospace'}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ln.node.label, sx, sy);
        ctx.globalAlpha = 1;
    }
}

function drawBox(aC: CanvasRenderingContext2D, aCx: number, aCy: number, aW: number, aH: number, aR: number, aStrokeOnly = false): void {
    const x = aCx - aW / 2;
    const y = aCy - aH / 2;
    aC.beginPath();
    aC.moveTo(x + aR, y);
    aC.lineTo(x + aW - aR, y);
    aC.arcTo(x + aW, y, x + aW, y + aR, aR);
    aC.lineTo(x + aW, y + aH - aR);
    aC.arcTo(x + aW, y + aH, x + aW - aR, y + aH, aR);
    aC.lineTo(x + aR, y + aH);
    aC.arcTo(x, y + aH, x, y + aH - aR, aR);
    aC.lineTo(x, y + aR);
    aC.arcTo(x, y, x + aR, y, aR);
    aC.closePath();
    if (!aStrokeOnly) { aC.fill(); }
    aC.stroke();
}

// ------------------------------------------------------------
// Grid drawing
// ------------------------------------------------------------
function drawGrid(aW: number, aH: number): void {
    if (!ctx) { return; }

    const grid_world = GRID_SIZE;
    const grid_screen = grid_world * zoom;
    if (grid_screen < 4) { return; }

    const world_left = -cam_x / zoom;
    const world_top = -cam_y / zoom;
    const world_right = world_left + aW / zoom;
    const world_bottom = world_top + aH / zoom;

    const start_x = Math.floor(world_left / grid_world) * grid_world;
    const start_y = Math.floor(world_top / grid_world) * grid_world;

    const alpha = Math.min(0.3, grid_screen / 100);
    ctx.strokeStyle = `rgba(128, 128, 128, ${alpha})`;
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let wx = start_x; wx <= world_right; wx += grid_world) {
        const sx = cam_x + wx * zoom;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, aH);
    }
    for (let wy = start_y; wy <= world_bottom; wy += grid_world) {
        const sy = cam_y + wy * zoom;
        ctx.moveTo(0, sy);
        ctx.lineTo(aW, sy);
    }
    ctx.stroke();

    // Origin cross
    const ox = cam_x;
    const oy = cam_y;
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
    ctx.lineWidth = 2;
    if (ox >= 0 && ox <= aW) {
        ctx.beginPath(); ctx.moveTo(ox, 0); ctx.lineTo(ox, aH); ctx.stroke();
    }
    if (oy >= 0 && oy <= aH) {
        ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(aW, oy); ctx.stroke();
    }
}

// ------------------------------------------------------------
// Minimap
// ------------------------------------------------------------
const MINIMAP_W = 150;
const MINIMAP_H = 100;
const MINIMAP_MARGIN = 8;

// Cached minimap transform for mouse interaction
let minimap_transform: {
    mx: number; my: number; // minimap top-left in canvas space
    scale: number;
    wMinX: number; wMinY: number;
    canvasW: number; canvasH: number;
} | null = null;
let is_dragging_minimap = false;

function drawMinimap(aCanvasW: number, aCanvasH: number): void {
    if (!ctx || layout_nodes.length === 0) { return; }

    // Compute bounding box of all visible nodes
    let min_x = Infinity, min_y = Infinity, max_x = -Infinity, max_y = -Infinity;
    let count = 0;
    for (const ln of layout_nodes) {
        if (isNodeFiltered(ln.node)) { continue; }
        min_x = Math.min(min_x, ln.x - ln.w / 2);
        max_x = Math.max(max_x, ln.x + ln.w / 2);
        min_y = Math.min(min_y, ln.y - NODE_H / 2);
        max_y = Math.max(max_y, ln.y + NODE_H / 2);
        count++;
    }
    if (count === 0) { return; }

    const world_w = max_x - min_x || 1;
    const world_h = max_y - min_y || 1;

    // Add some padding to the world bounds
    const pad = Math.max(world_w, world_h) * 0.05;
    const w_min_x = min_x - pad;
    const w_min_y = min_y - pad;
    const w_w = world_w + pad * 2;
    const w_h = world_h + pad * 2;

    // Minimap position (bottom-left)
    const mmx = MINIMAP_MARGIN;
    const mmy = aCanvasH - MINIMAP_H - MINIMAP_MARGIN;

    // Scale factor: fit the entire graph world into the minimap
    const scale_x = MINIMAP_W / w_w;
    const scale_y = MINIMAP_H / w_h;
    const scale = Math.min(scale_x, scale_y);

    // Save transform for mouse interaction
    minimap_transform = { mx: mmx, my: mmy, scale, wMinX: w_min_x, wMinY: w_min_y, canvasW: aCanvasW, canvasH: aCanvasH };

    // Background
    ctx.fillStyle = 'rgba(30, 30, 30, 0.85)';
    ctx.fillRect(mmx, mmy, MINIMAP_W, MINIMAP_H);
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(mmx, mmy, MINIMAP_W, MINIMAP_H);

    // Draw edges as thin lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 0.5;
    const node_map = new Map<string, LayoutNode>();
    for (const ln of layout_nodes) {
        if (!isNodeFiltered(ln.node)) {
            node_map.set(ln.node.id, ln);
        }
    }
    const has_search = search_filter.length > 0;
    for (const edge of all_edges) {
        const from_ln = node_map.get(edge.from);
        const to_ln = node_map.get(edge.to);
        if (!from_ln || !to_ln) { continue; }
        const ex1 = mmx + (from_ln.x - w_min_x) * scale;
        const ey1 = mmy + (from_ln.y - w_min_y) * scale;
        const ex2 = mmx + (to_ln.x - w_min_x) * scale;
        const ey2 = mmy + (to_ln.y - w_min_y) * scale;
        ctx.beginPath();
        ctx.moveTo(ex1, ey1);
        ctx.lineTo(ex2, ey2);
        ctx.stroke();
    }

    // Draw nodes as small dots (reflecting search/focus dim)
    for (const ln of layout_nodes) {
        if (isNodeFiltered(ln.node)) { continue; }
        // In "dim" mode, reduce opacity for non-matching nodes
        const matches_search = !has_search || nodeMatchesSearch(ln.node);
        const in_focus = isNodeVisibleInFocus(ln.node.id);
        const is_dimmed = !matches_search || !in_focus;
        const nx = mmx + (ln.x - w_min_x) * scale;
        const ny = mmy + (ln.y - w_min_y) * scale;
        const dot_size = Math.max(2, ln.w * scale * 0.3);
        ctx.globalAlpha = is_dimmed ? 0.15 : 1;
        ctx.fillStyle = ln.node.id === selected_node_id ? '#ffffff' : ln.node.color;
        ctx.fillRect(nx - dot_size / 2, ny - dot_size / 2, dot_size, dot_size);
    }
    ctx.globalAlpha = 1;

    // Draw viewport rectangle
    const view_world_left = -cam_x / zoom;
    const view_world_top = -cam_y / zoom;
    const view_world_right = view_world_left + aCanvasW / zoom;
    const view_world_bottom = view_world_top + aCanvasH / zoom;

    const vx = mmx + (view_world_left - w_min_x) * scale;
    const vy = mmy + (view_world_top - w_min_y) * scale;
    const vw = (view_world_right - view_world_left) * scale;
    const vh = (view_world_bottom - view_world_top) * scale;

    ctx.strokeStyle = 'rgba(255, 200, 50, 0.8)';
    ctx.lineWidth = 1.5;
    // Clip the viewport rectangle to minimap bounds
    const clip_x = Math.max(mmx, vx);
    const clip_y = Math.max(mmy, vy);
    const clip_r = Math.min(mmx + MINIMAP_W, vx + vw);
    const clip_b = Math.min(mmy + MINIMAP_H, vy + vh);
    if (clip_r > clip_x && clip_b > clip_y) {
        ctx.strokeRect(clip_x, clip_y, clip_r - clip_x, clip_b - clip_y);
    }
}

/** Check if a screen point falls within the minimap bounds */
function isInMinimap(aSx: number, aSy: number): boolean {
    if (!minimap_enabled || !minimap_transform) { return false; }
    const { mx, my } = minimap_transform;
    return aSx >= mx && aSx <= mx + MINIMAP_W && aSy >= my && aSy <= my + MINIMAP_H;
}

/** Convert minimap screen coords to world coords, then center the camera there */
function minimapPanTo(aSx: number, aSy: number): void {
    if (!minimap_transform || !canvas) { return; }
    const { mx, my, scale, wMinX, wMinY } = minimap_transform;
    // Convert minimap position to world coords
    const world_x = (aSx - mx) / scale + wMinX;
    const world_y = (aSy - my) / scale + wMinY;
    // Center the camera on this world position
    cam_x = canvas.clientWidth / 2 - world_x * zoom;
    cam_y = canvas.clientHeight / 2 - world_y * zoom;
    saveState();
    draw();
}

// ------------------------------------------------------------
// Hit testing
// ------------------------------------------------------------
function hitTestNode(aScreenX: number, aScreenY: number): LayoutNode | null {
    for (let i = layout_nodes.length - 1; i >= 0; i--) {
        const ln = layout_nodes[i];
        if (isNodeFiltered(ln.node)) { continue; }
        const [sx, sy] = worldToScreen(ln.x, ln.y);
        const hw = (ln.w * zoom) / 2;
        const hh = (NODE_H * zoom) / 2;
        if (aScreenX >= sx - hw && aScreenX <= sx + hw && aScreenY >= sy - hh && aScreenY <= sy + hh) {
            return ln;
        }
    }
    return null;
}

// ------------------------------------------------------------
// Canvas events: pan, node drag, zoom, selection
// ------------------------------------------------------------
function attachCanvasEvents(aC: HTMLCanvasElement): void {
    aC.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0) { return; }
        e.preventDefault();

        const rect = aC.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Check minimap first -- capture events there
        if (isInMinimap(mx, my)) {
            is_dragging_minimap = true;
            minimapPanTo(mx, my);
            aC.style.cursor = 'crosshair';
            return;
        }

        const hit = hitTestNode(mx, my);
        if (hit) {
            is_dragging_node = true;
            drag_node = hit;
            selected_node_id = hit.node.id;
            updateFooter();
            const [sx, sy] = worldToScreen(hit.x, hit.y);
            drag_offset_x = mx - sx;
            drag_offset_y = my - sy;
            aC.style.cursor = 'move';
            // Auto-pause: pause sim while dragging
            if (auto_pause_during_drag && sim_running) {
                stopSimulation();
            }
            vscode.postMessage({ type: 'nodeClick', targetId: hit.node.id });
        } else {
            is_panning = true;
            pan_start_x = e.clientX;
            pan_start_y = e.clientY;
            cam_start_x = cam_x;
            cam_start_y = cam_y;
            aC.style.cursor = 'grabbing';
        }
        draw();
    });

    window.addEventListener('mousemove', (e: MouseEvent) => {
        if (is_dragging_minimap) {
            const rect = aC.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            minimapPanTo(mx, my);
            return;
        }
        if (is_dragging_node && drag_node) {
            const rect = aC.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            drag_node.x = (mx - drag_offset_x - cam_x) / zoom;
            drag_node.y = (my - drag_offset_y - cam_y) / zoom;
            draw();
        } else if (is_panning) {
            was_panning = true;
            cam_x = cam_start_x + (e.clientX - pan_start_x);
            cam_y = cam_start_y + (e.clientY - pan_start_y);
            draw();
        }
    });

    window.addEventListener('mouseup', (e: MouseEvent) => {
        if (e.button !== 0) { return; }
        if (is_dragging_minimap) {
            is_dragging_minimap = false;
            aC.style.cursor = 'grab';
            return;
        }
        if (is_dragging_node) {
            is_dragging_node = false;
            drag_node = null;
            aC.style.cursor = 'grab';
            // Resume sim if enabled (auto-pause or normal mode)
            if (sim_enabled) {
                startSimulation();
            }
        } else if (!was_panning) {
            selected_node_id = null;
            updateFooter();
        }
        if (is_panning) {
            is_panning = false;
            was_panning = false;
            aC.style.cursor = 'grab';
            saveState();
        }
    });

    aC.addEventListener('dblclick', (e: MouseEvent) => {
        const rect = aC.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        // Ignore double-click on minimap
        if (isInMinimap(mx, my)) { return; }
        // Use selected_node_id from mousedown instead of re-hit-testing,
        // because the node may have moved slightly during the drag between clicks
        if (selected_node_id) {
            if (selected_node_id === focused_node_id) {
                // Already focused -- just re-center gravity origin on this node
                shiftOriginToNode(selected_node_id);
                restartSimIfEnabled();
                draw();
                return;
            }
            // Focus on the selected node and all recursively connected nodes
            focusOnNode(selected_node_id);
        } else {
            // Double-click on background: fit graph to view
            centerOnNodes();
            draw();
        }
    });

    aC.addEventListener('wheel', (e: WheelEvent) => {
        e.preventDefault();
        const rect = aC.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Zoom from minimap: zoom centered on the minimap world position
        if (isInMinimap(mx, my) && minimap_transform) {
            const world_x = (mx - minimap_transform.mx) / minimap_transform.scale + minimap_transform.wMinX;
            const world_y = (my - minimap_transform.my) / minimap_transform.scale + minimap_transform.wMinY;
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
            cam_x = aC.clientWidth / 2 - world_x * zoom;
            cam_y = aC.clientHeight / 2 - world_y * zoom;
            saveState();
            draw();
            return;
        }

        const wx_before = (mx - cam_x) / zoom;
        const wy_before = (my - cam_y) / zoom;

        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));

        cam_x = mx - wx_before * zoom;
        cam_y = my - wy_before * zoom;

        saveState();
        draw();
    }, { passive: false });

    aC.style.cursor = 'grab';
}

// ------------------------------------------------------------
// Force-directed simulation
// ------------------------------------------------------------

/** Restart simulation if it's enabled (convenience for visibility changes) */
function restartSimIfEnabled(): void {
    if (sim_enabled) {
        stopSimulation();
        startSimulation();
    }
}

function startSimulation(): void {
    if (sim_running || !sim_enabled) { return; }
    sim_running = true;
    sim_anim_frame = requestAnimationFrame(simulationStep);
}

function stopSimulation(): void {
    sim_running = false;
    if (sim_anim_frame !== null) {
        cancelAnimationFrame(sim_anim_frame);
        sim_anim_frame = null;
    }
}

function simulationStep(): void {
    if (!sim_running) { return; }

    for (let step = 0; step < sim_vars.stepsPerFrame; step++) {
        let total_movement = 0;

        // Build index
        const node_index = new Map<string, number>();
        layout_nodes.forEach((ln, i) => node_index.set(ln.node.id, i));

        const n = layout_nodes.length;
        const fx = new Float64Array(n);
        const fy = new Float64Array(n);

        // Build adjacency set and degree count for connectivity-aware repulsion
        // This allows us to apply stronger repulsion between unconnected nodes, 
        // especially high-degree ones, to reduce clutter around hubs and improve overall layout clarity
        const adjacency = new Map<string, Set<string>>(); // node id -> set of adjacent node ids
        const degree = new Map<string, number>();// node id -> degree (number of connections)
        for (const edge of all_edges) {
            // Ensure both nodes are in the adjacency map
            if (!adjacency.has(edge.from)) { adjacency.set(edge.from, new Set()); }
            // Ensure both nodes are in the adjacency map
            if (!adjacency.has(edge.to)) { adjacency.set(edge.to, new Set()); }
            adjacency.get(edge.from)!.add(edge.to);
            adjacency.get(edge.to)!.add(edge.from);
        }
        // Compute degree for each node
        for (let i = 0; i < n; i++) {
            degree.set(layout_nodes[i].node.id, adjacency.get(layout_nodes[i].node.id)?.size ?? 0);
        }

        // Repulsion between all pairs (Coulomb) -- stronger for unconnected high-degree nodes
        for (let i = 0; i < n; i++) {
            // Skip filtered nodes
            if (isNodeFiltered(layout_nodes[i].node)) { continue; }
            const id_i = layout_nodes[i].node.id;
            const deg_i = degree.get(id_i) ?? 0;
            const adj_i = adjacency.get(id_i);
            for (let j = i + 1; j < n; j++) {
                if (isNodeFiltered(layout_nodes[j].node)) { continue; }
                const id_j = layout_nodes[j].node.id;
                // Check if nodes are directly connected
                const connected = adj_i !== undefined && adj_i.has(id_j);
                let dx = layout_nodes[j].x - layout_nodes[i].x;
                let dy = layout_nodes[j].y - layout_nodes[i].y;
                const dist_sq = dx * dx + dy * dy;
                let dist = Math.sqrt(dist_sq);
                // Avoid division by zero
                if (dist < 0.1) {
                    dx = (Math.random() - 0.5) * 2;
                    dy = (Math.random() - 0.5) * 2;
                    dist = 1;
                }
                // Standard repulsion
                let force = sim_vars.repulsion / (dist * dist);
                // Extra push when closer than minDistance
                if (dist < sim_vars.minDistance) {
                    force *= (sim_vars.minDistance / dist);
                }
                // Boost repulsion for unconnected nodes based on their degree
                // High-degree nodes push harder to reduce clutter around hubs
                if (!connected) {
                    const deg_j = degree.get(id_j) ?? 0;
                    const deg_boost = 1 + 0.15 * (deg_i + deg_j);
                    force *= deg_boost;
                }
                const force_x = (dx / dist) * force;
                const force_y = (dy / dist) * force;
                fx[i] -= force_x;
                fy[i] -= force_y;
                fx[j] += force_x;
                fy[j] += force_y;
            }
        }

        // Attraction on edges (Hooke)
        for (const edge of all_edges) {
            const fi = node_index.get(edge.from);
            const ti = node_index.get(edge.to);
            if (fi === undefined || ti === undefined) { continue; }
            if (isNodeFiltered(layout_nodes[fi].node)) { continue; }
            if (isNodeFiltered(layout_nodes[ti].node)) { continue; }
            const dx = layout_nodes[ti].x - layout_nodes[fi].x;
            const dy = layout_nodes[ti].y - layout_nodes[fi].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1) { continue; }
            // linear spring: F = k * x
            //const force = sim_vars.attraction * dist;
            // Logarithmic spring: strong pull when far, weaker when close
            const force = sim_vars.attraction * Math.log(2 + dist) / sim_vars.linkLength;
            const force_x = (dx / dist) * force;
            const force_y = (dy / dist) * force;
            fx[fi] += force_x;
            fy[fi] += force_y;
            fx[ti] -= force_x;
            fy[ti] -= force_y;
        }

        // Central gravity toward origin
        for (let i = 0; i < n; i++) {
            if (isNodeFiltered(layout_nodes[i].node)) { continue; }
            const px = layout_nodes[i].x;
            const py = layout_nodes[i].y;
            const dist = Math.sqrt(px * px + py * py);
            if (dist < 1) { continue; }
            const force_dist = sim_vars.gravity; // * Math.pow(dist, 0.25) ;
            fx[i] -= px * force_dist;
            fy[i] -= py * force_dist;
        }

        // Apply forces with velocity damping
        const max_speed = 15;
        for (let i = 0; i < n; i++) {
            if (isNodeFiltered(layout_nodes[i].node)) { continue; }
            // Don't move the node being dragged
            if (is_dragging_node && drag_node === layout_nodes[i]) { continue; }
            // Pin the focused root node in place (anchor for the subgraph)
            if (focused_node_id && layout_nodes[i].node.id === focused_node_id) { continue; }

            const ln = layout_nodes[i];
            ln.vx = (ln.vx + fx[i]) * sim_vars.damping;
            ln.vy = (ln.vy + fy[i]) * sim_vars.damping;

            // Clamp speed
            const speed = Math.sqrt(ln.vx * ln.vx + ln.vy * ln.vy);
            if (speed > max_speed) {
                ln.vx = (ln.vx / speed) * max_speed;
                ln.vy = (ln.vy / speed) * max_speed;
            }

            ln.x += ln.vx;
            ln.y += ln.vy;
            total_movement += Math.abs(ln.vx) + Math.abs(ln.vy);
        }

        // Check equilibrium
        if (total_movement < sim_vars.threshold) {
            stopSimulation();
            draw();
            return;
        }
    }

    draw();
    sim_anim_frame = requestAnimationFrame(simulationStep);
}

// ------------------------------------------------------------
// Resize handling
// ------------------------------------------------------------
let resize_timer: ReturnType<typeof setTimeout> | null = null;

function onResize(): void {
    if (resize_timer) { clearTimeout(resize_timer); }
    resize_timer = setTimeout(() => {
        recalcContainerHeight();
        resizeCanvas();
    }, 50);
}

function recalcContainerHeight(): void {
    const container = document.getElementById('graph-container')!;
    const toolbar_h = document.getElementById('toolbar')?.offsetHeight ?? 0;
    const footer_h = document.getElementById('footer')?.offsetHeight ?? 0;
    const breadcrumb_h = document.getElementById('breadcrumb-bar')?.offsetHeight ?? 0;
    const available = window.innerHeight - toolbar_h - footer_h - breadcrumb_h;
    container.style.height = `${Math.max(200, available)}px`;
}

window.addEventListener('resize', onResize);
const graph_container = document.getElementById('graph-container')!;
const resize_observer = new ResizeObserver(onResize);
resize_observer.observe(graph_container);

// ------------------------------------------------------------
// Graph creation
// ------------------------------------------------------------
function createGraph(aNodes: GraphNode[], aEdges: GraphEdge[]): void {
    stopSimulation();

    // Filter out UTILITY nodes
    const filtered = aNodes.filter(n => n.type !== 'UTILITY');

    // Deduplicate by id
    const seen = new Set<string>();
    const unique: GraphNode[] = [];
    for (const n of filtered) {
        if (!seen.has(n.id)) {
            seen.add(n.id);
            unique.push(n);
        }
    }

    // Filter edges to only reference existing node ids
    const valid_ids = new Set(unique.map(n => n.id));
    all_edges = aEdges.filter(e => valid_ids.has(e.from) && valid_ids.has(e.to));
    all_nodes = unique;
    active_filters.clear();

    const empty_msg = document.getElementById('empty-message')!;

    initSearchBar();
    if (all_nodes.length === 0) {
        document.getElementById('graph-container')!.style.display = 'none';
        empty_msg.style.display = 'flex';
        empty_msg.textContent = 'No targets to display';
        buildFilterCheckboxes();
        return;
    }

    initLayoutNodes(all_nodes);
    buildFilterCheckboxes();
    recalcContainerHeight();

    setTimeout(() => {
        setupCanvas();
        if (first_layout || !restoreState()) {
            centerOnNodes();
            first_layout = false;
        }
        draw();
        // Start force simulation
        startSimulation();
        // Restore settings panel after container is visible
        if (settings_panel_visible && !settings_panel) {
            toggleSettings(false);
        }
    }, 50);
}

/** Initialize layout nodes: preserve existing positions, new nodes in a circle */
function initLayoutNodes(aNodes: GraphNode[]): void {
    const existing_positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
    for (const ln of layout_nodes) {
        existing_positions.set(ln.node.id, { x: ln.x, y: ln.y, vx: ln.vx, vy: ln.vy });
    }

    const widths = aNodes.map(n => measureNodeWidth(n.label));

    layout_nodes = [];
    const radius = Math.max(100, aNodes.length * 10);

    for (let i = 0; i < aNodes.length; i++) {
        const n = aNodes[i];
        const w = widths[i];
        const existing = existing_positions.get(n.id);
        if (existing) {
            layout_nodes.push({ node: n, x: existing.x, y: existing.y, w, vx: existing.vx, vy: existing.vy });
        } else {
            const angle = (2 * Math.PI * i) / aNodes.length;
            layout_nodes.push({
                node: n,
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius,
                w,
                vx: 0,
                vy: 0,
            });
        }
    }
}

/** Reset all node positions to initial circle and restart simulation */
function resetLayoutPositions(): void {
    stopSimulation();
    const radius = Math.max(150, layout_nodes.length * 20);
    for (let i = 0; i < layout_nodes.length; i++) {
        const angle = (2 * Math.PI * i) / layout_nodes.length;
        layout_nodes[i].x = Math.cos(angle) * radius;
        layout_nodes[i].y = Math.sin(angle) * radius;
        layout_nodes[i].vx = 0;
        layout_nodes[i].vy = 0;
    }
    draw();
    startSimulation();
}

function centerOnNodes(): void {
    if (!canvas || layout_nodes.length === 0) { return; }
    let min_x = Infinity, min_y = Infinity, max_x = -Infinity, max_y = -Infinity;
    let count = 0;
    for (const ln of layout_nodes) {
        if (isNodeFiltered(ln.node)) { continue; }
        min_x = Math.min(min_x, ln.x - ln.w / 2);
        max_x = Math.max(max_x, ln.x + ln.w / 2);
        min_y = Math.min(min_y, ln.y - NODE_H / 2);
        max_y = Math.max(max_y, ln.y + NODE_H / 2);
        count++;
    }
    if (count === 0) { return; }
    const bw = max_x - min_x;
    const bh = max_y - min_y;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;

    const pad = 40;
    zoom = Math.min((cw - pad * 2) / Math.max(1, bw), (ch - pad * 2) / Math.max(1, bh), 2);
    zoom = Math.max(ZOOM_MIN, zoom);

    const center_wx = (min_x + max_x) / 2;
    const center_wy = (min_y + max_y) / 2;
    cam_x = cw / 2 - center_wx * zoom;
    cam_y = ch / 2 - center_wy * zoom;

    saveState();
}

// ------------------------------------------------------------
// Search bar (lives inside #breadcrumb-bar, always visible)
// ------------------------------------------------------------
let search_bar_inited = false;
function initSearchBar(): void {
    if (search_bar_inited) { return; }
    search_bar_inited = true;

    // Build the search controls inside the breadcrumb bar
    const bar = document.getElementById('breadcrumb-bar')!;
    bar.innerHTML = buildSearchControlsHtml();
    attachSearchEvents();
}

function buildSearchControlsHtml(): string {
    const filter_icon = search_filter_mode === 'dim' ? '\u{1F441}' : '\u{1F6AB}';
    const filter_title = search_filter_mode === 'dim'
        ? 'Mode: Dim non-matching (click to switch to Hide)'
        : 'Mode: Hide non-matching (click to switch to Dim)';
    const mode_label = search_mode === 'name' ? 'N' : 'P';
    const mode_title = search_mode === 'name'
        ? 'Filtering by name (click to switch to path)'
        : 'Filtering by path (click to switch to name)';
    const placeholder = search_mode === 'name' ? 'Filter by name\u2026' : 'Filter by path\u2026';
    return `<div id="search-container">` +
        `<button id="search-filter-mode" title="${filter_title}">${filter_icon}</button>` +
        `<button id="search-mode" title="${mode_title}">${mode_label}</button>` +
        `<input id="search-input" type="text" placeholder="${placeholder}" spellcheck="false" value="${escapeHtml(search_filter)}">` +
        `<button id="search-clear" title="Clear filter">\u2715</button>` +
        `</div>`;
}

function attachSearchEvents(): void {
    const input = document.getElementById('search-input') as HTMLInputElement;
    const mode_btn = document.getElementById('search-mode') as HTMLButtonElement;
    const filter_mode_btn = document.getElementById('search-filter-mode') as HTMLButtonElement;
    const clear_btn = document.getElementById('search-clear') as HTMLButtonElement;
    if (!input || !mode_btn || !clear_btn || !filter_mode_btn) { return; }

    mode_btn.addEventListener('click', () => {
        search_mode = search_mode === 'name' ? 'path' : 'name';
        input.placeholder = search_mode === 'name' ? 'Filter by name\u2026' : 'Filter by path\u2026';
        mode_btn.textContent = search_mode === 'name' ? 'N' : 'P';
        mode_btn.title = search_mode === 'name' ? 'Filtering by name (click to switch to path)' : 'Filtering by path (click to switch to name)';
        applySearchFilter();
    });

    filter_mode_btn.addEventListener('click', () => {
        search_filter_mode = search_filter_mode === 'dim' ? 'hide' : 'dim';
        filter_mode_btn.textContent = search_filter_mode === 'dim' ? '\u{1F441}' : '\u{1F6AB}';
        filter_mode_btn.title = search_filter_mode === 'dim'
            ? 'Mode: Dim non-matching (click to switch to Hide)'
            : 'Mode: Hide non-matching (click to switch to Dim)';
        applySearchFilter();
    });

    clear_btn.addEventListener('click', () => {
        search_filter = '';
        input.value = '';
        applySearchFilter();
    });

    input.addEventListener('input', () => {
        search_filter = input.value;
        applySearchFilter();
    });
}

function applySearchFilter(): void {
    // In hide mode, filtered nodes are excluded from simulation, so restart it
    if (search_filter_mode === 'hide') {
        restartSimIfEnabled();
    }
    draw();
}

// ------------------------------------------------------------
// Type filters
// ------------------------------------------------------------
function buildFilterCheckboxes(): void {
    const container = document.getElementById('filters')!;
    container.innerHTML = '';

    const type_counts = new Map<string, number>();
    for (const n of all_nodes) {
        type_counts.set(n.type, (type_counts.get(n.type) ?? 0) + 1);
    }

    for (const type of TARGET_TYPES) {
        const count = type_counts.get(type) ?? 0;
        if (count === 0) { continue; }

        const label = document.createElement('label');
        label.className = 'filter-label';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !active_filters.has(type);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                active_filters.delete(type);
            } else {
                active_filters.add(type);
            }
            restartSimIfEnabled();
            draw();
        });

        const span = document.createElement('span');
        const node_of_type = all_nodes.find(n => n.type === type);
        span.textContent = ` ${type} (${count})`;
        span.style.color = node_of_type?.color ?? '#ccc';

        label.appendChild(checkbox);
        label.appendChild(span);
        container.appendChild(label);
    }
}

// ------------------------------------------------------------
// Settings panel
// ------------------------------------------------------------
let settings_panel: HTMLDivElement | null = null;

function toggleSettings(aPersist = true): void {
    if (settings_panel) {
        settings_panel.remove();
        settings_panel = null;
        if (aPersist) { vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsVisible', value: false }); }
        return;
    }
    settings_panel = document.createElement('div');
    settings_panel.id = 'settings-panel';
    settings_panel.innerHTML = buildSettingsHtml();
    // Place inside graph-container as absolute overlay on the right side
    const container = document.getElementById('graph-container')!;
    container.appendChild(settings_panel);
    attachSettingsEvents();
    if (aPersist) { vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsVisible', value: true }); }
}

function sliderRow(aId: string, aLabel: string, aMin: number, aMax: number, aStep: number, aValue: number, aDefaultVal: number): string {
    return `<div class="settings-row">
        <label>${aLabel}</label>
        <div class="settings-slider-row">
            <input type="range" id="s-${aId}" min="${aMin}" max="${aMax}" step="${aStep}" value="${aValue}">
            <span id="v-${aId}">${aValue}</span>
            <button class="settings-reset-btn" data-reset="${aId}" data-default="${aDefaultVal}" title="Reset to default value">\u21BA</button>
        </div>
    </div>`;
}

// ------------------------------------------------------------
// Footer (always visible, shows selected node info)
// ------------------------------------------------------------
function updateFooter(): void {
    const footer = document.getElementById('footer')!;
    if (!selected_node_id) {
        footer.innerHTML = '';
        return;
    }
    const ln = layout_nodes.find(l => l.node.id === selected_node_id);
    if (!ln) {
        footer.innerHTML = '';
        return;
    }
    const n = ln.node;
    footer.innerHTML =
        `<span><span class="info-type-swatch" style="background:${n.color}"></span><span class="info-value">${escapeHtml(n.label)}</span></span>` +
        `<span><span class="info-label">Type:</span> <span class="info-value">${escapeHtml(n.type)}</span></span>` +
        `<span><span class="info-label">Path:</span> <span class="info-value" title="${escapeHtml(n.sourcePath)}">${escapeHtml(n.sourcePath)}</span></span>`;
}

function escapeHtml(aS: string): string {
    return aS.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ------------------------------------------------------------
// Focused view with breadcrumb navigation
// ------------------------------------------------------------

/**
 * BFS from a root node following the current edge direction.
 * Edges: { from: target, to: dependency_it_uses }.
 *
 * - child-to-parent (default): follow from -> to (A uses B, go to B's deps)
 * - parent-to-child: follow to -> from (descend to consumers/children)
 */
function buildConnectedSubgraph(aRootId: string): Set<string> {
    const visited = new Set<string>();
    const queue = [aRootId];

    // Build directed adjacency based on current edge direction
    const adj = new Map<string, string[]>();
    for (const edge of all_edges) {
        if (edge_direction === GraphEdgeDirection.TARGETS_USED_BY) {
            // Follow from -> to (dependencies)
            if (!adj.has(edge.from)) { adj.set(edge.from, []); }
            adj.get(edge.from)!.push(edge.to);
        } else {
            // Follow to -> from (consumers/children)
            if (!adj.has(edge.to)) { adj.set(edge.to, []); }
            adj.get(edge.to)!.push(edge.from);
        }
    }

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) { continue; }
        visited.add(current);
        const neighbors = adj.get(current);
        if (neighbors) {
            for (const nb of neighbors) {
                if (!visited.has(nb)) { queue.push(nb); }
            }
        }
    }
    return visited;
}

/** Shift world origin to a node's position, compensate camera so nothing visually moves. */
function shiftOriginToNode(aNodeId: string): void {
    const focus_ln = layout_nodes.find(ln => ln.node.id === aNodeId);
    if (!focus_ln) { return; }
    const dx = focus_ln.x;
    const dy = focus_ln.y;
    for (const ln of layout_nodes) {
        ln.x -= dx;
        ln.y -= dy;
    }
    cam_x += dx * zoom;
    cam_y += dy * zoom;
}

function focusOnNode(aNodeId: string): void {
    const node = all_nodes.find(n => n.id === aNodeId);
    if (!node) { return; }

    // Build the full recursively-connected subgraph from this node
    focus_visible_ids = buildConnectedSubgraph(aNodeId);

    // Shift world origin to the focused node so gravity centers around it.
    shiftOriginToNode(aNodeId);

    // Check if this node is already at the end of the history
    if (focus_history.length === 0 || focus_history[focus_history.length - 1].nodeId !== aNodeId) {
        focus_history.push({ nodeId: aNodeId, label: node.label });
    }
    focused_node_id = aNodeId;
    selected_node_id = aNodeId;

    restartSimIfEnabled();
    updateBreadcrumb();
    updateFooter();
    draw();
}

function exitFocusView(): void {
    focused_node_id = null;
    focus_history = [];
    focus_visible_ids = null;
    updateBreadcrumb();
    restartSimIfEnabled();
    draw();
}

function navigateBreadcrumb(aIndex: number): void {
    if (aIndex < 0) {
        // "All" clicked - exit focus view
        exitFocusView();
        return;
    }
    // Trim history to the clicked index
    focus_history = focus_history.slice(0, aIndex + 1);
    const entry = focus_history[aIndex];
    focused_node_id = entry.nodeId;
    selected_node_id = entry.nodeId;

    // Rebuild the connected subgraph from the navigated node
    focus_visible_ids = buildConnectedSubgraph(entry.nodeId);
    restartSimIfEnabled();
    updateBreadcrumb();
    updateFooter();
    draw();
}

function updateBreadcrumb(): void {
    const bar = document.getElementById('breadcrumb-bar')!;

    // Always rebuild: search controls + breadcrumb items
    let html = buildSearchControlsHtml();

    if (focused_node_id && focus_history.length > 0) {
        html += '<span class="breadcrumb-separator">\u2502</span>';
        html += '<span class="breadcrumb-item" data-bc-index="-1">All</span>';
        for (let i = 0; i < focus_history.length; i++) {
            html += '<span class="breadcrumb-separator">\u203A</span>';
            if (i === focus_history.length - 1) {
                html += `<span class="breadcrumb-current">${escapeHtml(focus_history[i].label)}</span>`;
            } else {
                html += `<span class="breadcrumb-item" data-bc-index="${i}">${escapeHtml(focus_history[i].label)}</span>`;
            }
        }
    }

    bar.innerHTML = html;

    // Re-attach search events
    attachSearchEvents();

    // Attach breadcrumb click events
    bar.querySelectorAll('.breadcrumb-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt((el as HTMLElement).dataset.bcIndex!, 10);
            navigateBreadcrumb(idx);
        });
    });

    recalcContainerHeight();
}

/** Check if a node should be visible in focused view (uses precomputed set) */
function isNodeVisibleInFocus(aNodeId: string): boolean {
    if (!focus_visible_ids) { return true; }
    return focus_visible_ids.has(aNodeId);
}

function buildNodeColorPickersHtml(): string {
    const present_types = new Map<string, string>();
    for (const n of all_nodes) {
        if (!present_types.has(n.type)) {
            present_types.set(n.type, n.color);
        }
    }
    if (present_types.size === 0) { return ''; }
    let inner = '';
    for (const [type, color] of present_types) {
        inner += `<label class="settings-inline">${type}
            <input type="color" id="s-color-${type}" value="${color}">
        </label>`;
    }
    return sectionHtml('colors', 'Node Colors', inner);
}

function sectionHtml(aId: string, aTitle: string, aContent: string): string {
    const collapsed = settings_collapse_state[aId] ?? false;
    const arrow = collapsed ? '\u25B6' : '\u25BC';
    const display = collapsed ? 'none' : 'flex';
    return `<div class="settings-section" data-section="${aId}">
        <div class="settings-title" data-collapse="${aId}">${arrow} ${aTitle}</div>
        <div class="settings-content" id="sc-${aId}" style="display:${display}">
            ${aContent}
        </div>
    </div>`;
}

function buildSettingsHtml(): string {
    const edges_content = `
        <label class="settings-inline">Style
            <select id="s-edgeStyle">
                <option value="tapered"${edge_style === 'tapered' ? ' selected' : ''}>Tapered</option>
                <option value="chevrons"${edge_style === 'chevrons' ? ' selected' : ''}>Chevrons</option>
                <option value="line"${edge_style === 'line' ? ' selected' : ''}>Line</option>
            </select>
        </label>
        <label class="settings-inline">Direction
            <select id="s-edgeDirection">
                <option value="parent-to-child"${edge_direction === GraphEdgeDirection.USED_BY_TARGETS ? ' selected' : ''}>Used by targets</option>
                <option value="child-to-parent"${edge_direction === GraphEdgeDirection.TARGETS_USED_BY ? ' selected' : ''}>Targets used by</option>
            </select>
        </label>
        ${sliderRow('taperedWidth', 'Tapered Width', 0.1, 5.0, 0.1, tapered_width_factor, 2.0)}`;

    const sim_content = `
        ${sliderRow('repulsion', 'Repulsion', 500, 100000, 500, sim_vars.repulsion, SIM_DEFAULTS.repulsion)}
        ${sliderRow('attraction', 'Attraction', 0.0001, 0.1, 0.001, sim_vars.attraction, SIM_DEFAULTS.attraction)}
        ${sliderRow('gravity', 'Gravity', 0.001, 0.2, 0.001, sim_vars.gravity, SIM_DEFAULTS.gravity)}
        ${sliderRow('linkLength', 'Link Length', 0.001, 1.0, 0.001, sim_vars.linkLength, SIM_DEFAULTS.linkLength)}
        ${sliderRow('minDist', 'Min Distance', 20, 10000, 10, sim_vars.minDistance, SIM_DEFAULTS.minDistance)}
        ${sliderRow('steps', 'Steps/Frame', 1, 10, 1, sim_vars.stepsPerFrame, SIM_DEFAULTS.stepsPerFrame)}
        ${sliderRow('threshold', 'Threshold', 0.001, 5, 0.001, sim_vars.threshold, SIM_DEFAULTS.threshold)}
        ${sliderRow('damping', 'Damping', 0.5, 1.0, 0.01, sim_vars.damping, SIM_DEFAULTS.damping)}`;

    const display_content = `
        <label class="settings-checkbox"><input type="checkbox" id="s-minimap"${minimap_enabled ? ' checked' : ''}> Show minimap</label>`;

    const controls_content = `
        <label class="settings-checkbox"><input type="checkbox" id="s-autoPause"${auto_pause_during_drag ? ' checked' : ''}> Auto-pause sim during node drag</label>
        <button id="s-startstop" class="settings-btn">${sim_enabled ? '\u23F8 Stop Simulation' : '\u25B6 Start Simulation'}</button>
        <button id="s-restart" class="settings-btn">\u21BA Restart Simulation</button>
        <button id="s-fitview" class="settings-btn">\u2922 Fit to View</button>
        <button id="s-screenshot" class="settings-btn">\uD83D\uDCF7 Screenshot (PNG)</button>`;

    return `
<div class="settings-body">
    ${sectionHtml('display', 'Display', display_content)}
    ${sectionHtml('edges', 'Edges', edges_content)}
    ${buildNodeColorPickersHtml()}
    ${sectionHtml('simulation', 'Force Simulation', sim_content)}
    ${sectionHtml('controls', 'Controls', controls_content)}
</div>`;
}

function updateStartStopBtn(): void {
    const btn = settings_panel?.querySelector('#s-startstop') as HTMLButtonElement | null;
    if (btn) {
        btn.textContent = sim_enabled ? '\u23F8 Stop Simulation' : '\u25B6 Start Simulation';
    }
}

function attachSettingsEvents(): void {
    if (!settings_panel) { return; }

    // Collapsible section toggle
    settings_panel.querySelectorAll('.settings-title[data-collapse]').forEach(el => {
        el.addEventListener('click', () => {
            const section_id = (el as HTMLElement).dataset.collapse!;
            const content = settings_panel!.querySelector(`#sc-${section_id}`) as HTMLElement | null;
            if (!content) { return; }
            const is_collapsed = content.style.display === 'none';
            content.style.display = is_collapsed ? 'flex' : 'none';
            settings_collapse_state[section_id] = !is_collapsed;
            (el as HTMLElement).textContent = (!is_collapsed ? '\u25B6' : '\u25BC') + ' ' + (el as HTMLElement).textContent!.substring(2);
            vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsCollapse', value: { ...settings_collapse_state } });
        });
    });

    // Slider ID -> workspace setting key mapping
    const slider_setting_keys: Record<string, string> = {
        's-repulsion': 'graphSimRepulsion',
        's-attraction': 'graphSimAttraction',
        's-gravity': 'graphSimGravity',
        's-linkLength': 'graphSimLinkLength',
        's-minDist': 'graphSimMinDistance',
        's-steps': 'graphSimStepsPerFrame',
        's-threshold': 'graphSimThreshold',
        's-damping': 'graphSimDamping',
        's-taperedWidth': 'graphTaperedWidth',
    };

    // Edge style
    const edge_sel = settings_panel.querySelector('#s-edgeStyle') as HTMLSelectElement;
    edge_sel.addEventListener('change', () => {
        edge_style = edge_sel.value as typeof edge_style;
        vscode.postMessage({ type: 'updateSetting', key: 'graphEdgeStyle', value: edge_style });
        draw();
    });

    // Edge direction
    const dir_sel = settings_panel.querySelector('#s-edgeDirection') as HTMLSelectElement;
    dir_sel.addEventListener('change', () => {
        edge_direction = dir_sel.value as typeof edge_direction;
        const setting_val = edge_direction === GraphEdgeDirection.USED_BY_TARGETS ? 'inverse' : 'dependency';
        vscode.postMessage({ type: 'updateSetting', key: 'graphEdgeDirection', value: setting_val });
        // If in focus mode, rebuild subgraph with new direction
        if (focused_node_id) {
            focus_visible_ids = buildConnectedSubgraph(focused_node_id);
        }
        restartSimIfEnabled();
        draw();
    });

    // Auto-pause checkbox
    const auto_pause_check = settings_panel.querySelector('#s-autoPause') as HTMLInputElement;
    auto_pause_check.addEventListener('change', () => {
        auto_pause_during_drag = auto_pause_check.checked;
        vscode.postMessage({ type: 'updateSetting', key: 'graphAutoPauseDrag', value: auto_pause_during_drag });
    });

    // Minimap checkbox
    const minimap_check = settings_panel.querySelector('#s-minimap') as HTMLInputElement;
    minimap_check.addEventListener('change', () => {
        minimap_enabled = minimap_check.checked;
        vscode.postMessage({ type: 'updateSetting', key: 'graphMinimap', value: minimap_enabled });
        draw();
    });

    // Sliders
    const sliders: [string, string, (aV: number) => void][] = [
        ['s-repulsion', 'v-repulsion', aV => { sim_vars.repulsion = aV; }],
        ['s-attraction', 'v-attraction', aV => { sim_vars.attraction = aV; }],
        ['s-gravity', 'v-gravity', aV => { sim_vars.gravity = aV; }],
        ['s-linkLength', 'v-linkLength', aV => { sim_vars.linkLength = aV; }],
        ['s-minDist', 'v-minDist', aV => { sim_vars.minDistance = aV; }],
        ['s-steps', 'v-steps', aV => { sim_vars.stepsPerFrame = Math.round(aV); }],
        ['s-threshold', 'v-threshold', aV => { sim_vars.threshold = aV; }],
        ['s-damping', 'v-damping', aV => { sim_vars.damping = aV; }],
        ['s-taperedWidth', 'v-taperedWidth', aV => { sim_vars.taperedWidth = aV; }],
    ];

    for (const [slider_id, value_id, setter] of sliders) {
        const slider = settings_panel.querySelector(`#${slider_id}`) as HTMLInputElement | null;
        const value_span = settings_panel.querySelector(`#${value_id}`) as HTMLSpanElement | null;
        if (!slider || !value_span) { continue; }
        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            setter(v);
            value_span.textContent = String(v);
            const setting_key = slider_setting_keys[slider_id];
            if (setting_key) {
                vscode.postMessage({ type: 'updateSetting', key: setting_key, value: v });
            }
            startSimulation();
        });
    }

    // Reset buttons (one per param)
    settings_panel.querySelectorAll('.settings-reset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).dataset.reset!;
            const def = parseFloat((btn as HTMLElement).dataset.default!);
            const slider = settings_panel!.querySelector(`#s-${id}`) as HTMLInputElement;
            const value_span = settings_panel!.querySelector(`#v-${id}`) as HTMLSpanElement;
            slider.value = String(def);
            value_span.textContent = String(def);
            const match = sliders.find(s => s[0] === `s-${id}`);
            if (match) { match[2](def); }
            const setting_key = slider_setting_keys[`s-${id}`];
            if (setting_key) {
                vscode.postMessage({ type: 'updateSetting', key: setting_key, value: def });
            }
            startSimulation();
        });
    });

    // Node color pickers
    const present_types = new Set(all_nodes.map(n => n.type));
    for (const type of present_types) {
        const picker = settings_panel?.querySelector(`#s-color-${type}`) as HTMLInputElement | null;
        if (!picker) { continue; }
        picker.addEventListener('input', () => {
            const new_color = picker.value;
            for (const n of all_nodes) {
                if (n.type === type) { n.color = new_color; }
            }
            draw();
            buildFilterCheckboxes();
            // Persist all node colors as an object
            const color_map: Record<string, string> = {};
            for (const t of present_types) {
                const node = all_nodes.find(n => n.type === t);
                if (node) { color_map[t] = node.color; }
            }
            vscode.postMessage({ type: 'updateSetting', key: 'graphNodeColors', value: color_map });
        });
    }

    // Start/Stop simulation
    const start_stop_btn = settings_panel.querySelector('#s-startstop') as HTMLButtonElement;
    start_stop_btn.addEventListener('click', () => {
        if (sim_enabled) {
            // User wants to stop
            sim_enabled = false;
            stopSimulation();
        } else {
            // User wants to start
            sim_enabled = true;
            startSimulation();
        }
        updateStartStopBtn();
        vscode.postMessage({ type: 'updateSetting', key: 'graphSimEnabled', value: sim_enabled });
    });

    // Restart simulation (reset positions)
    settings_panel.querySelector('#s-restart')!.addEventListener('click', () => {
        sim_enabled = true;
        resetLayoutPositions();
        updateStartStopBtn();
        vscode.postMessage({ type: 'updateSetting', key: 'graphSimEnabled', value: sim_enabled });
    });

    // Fit to View
    settings_panel.querySelector('#s-fitview')!.addEventListener('click', () => {
        centerOnNodes();
        draw();
    });

    // Screenshot
    settings_panel.querySelector('#s-screenshot')!.addEventListener('click', takeScreenshot);
}

// ------------------------------------------------------------
// Screenshot
// ------------------------------------------------------------
function takeScreenshot(): void {
    if (!canvas) { return; }
    const data_uri = canvas.toDataURL('image/png');
    vscode.postMessage({ type: 'saveScreenshot', dataUri: data_uri });
}

// ------------------------------------------------------------
// Apply settings received from the provider (workspace settings)
// ------------------------------------------------------------
function applySettingsFromProvider(aS: any): void {
    if (aS.edgeDirection !== undefined) {
        edge_direction = aS.edgeDirection === 'inverse' ? GraphEdgeDirection.USED_BY_TARGETS : GraphEdgeDirection.TARGETS_USED_BY;
    }
    if (aS.edgeStyle !== undefined) { edge_style = aS.edgeStyle as typeof edge_style; }
    if (aS.taperedWidth !== undefined) { sim_vars.taperedWidth = aS.taperedWidth; }
    if (aS.simRepulsion !== undefined) { sim_vars.repulsion = aS.simRepulsion; }
    if (aS.simAttraction !== undefined) { sim_vars.attraction = aS.simAttraction; }
    if (aS.simGravity !== undefined) { sim_vars.gravity = aS.simGravity; }
    if (aS.simLinkLength !== undefined) { sim_vars.linkLength = aS.simLinkLength; }
    if (aS.simMinDistance !== undefined) { sim_vars.minDistance = aS.simMinDistance; }
    if (aS.simStepsPerFrame !== undefined) { sim_vars.stepsPerFrame = aS.simStepsPerFrame; }
    if (aS.simThreshold !== undefined) { sim_vars.threshold = aS.simThreshold; }
    if (aS.simDamping !== undefined) { sim_vars.damping = aS.simDamping; }
    if (aS.minimap !== undefined) { minimap_enabled = aS.minimap; }
    if (aS.autoPauseDrag !== undefined) { auto_pause_during_drag = aS.autoPauseDrag; }
    if (aS.simEnabled !== undefined) { sim_enabled = aS.simEnabled; }
    if (aS.settingsCollapse !== undefined) { settings_collapse_state = aS.settingsCollapse; }
    if (aS.settingsVisible !== undefined) { settings_panel_visible = aS.settingsVisible; }
}

// ------------------------------------------------------------
// Message listener
// ------------------------------------------------------------
window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data;
    switch (msg.type) {
        case 'update': {
            if (msg.settings) {
                applySettingsFromProvider(msg.settings);
            }
            createGraph(msg.nodes as GraphNode[], msg.edges as GraphEdge[]);
            break;
        }
        case 'showSettings':
            toggleSettings();
            break;
        case 'screenshot':
            takeScreenshot();
            break;
        case 'toggleLayout':
            // Reset velocities and restart
            for (const ln of layout_nodes) { ln.vx = 0; ln.vy = 0; }
            startSimulation();
            break;
        case 'focusNode':
            focusOnNode(msg.targetId as string);
            break;
    }
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function getCssVar(aName: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(aName).trim();
}

function darken(aHex: string): string {
    return adjustBrightness(aHex, -0.3);
}

function adjustBrightness(aHex: string, aFactor: number): string {
    const r = parseInt(aHex.slice(1, 3), 16);
    const g = parseInt(aHex.slice(3, 5), 16);
    const b = parseInt(aHex.slice(5, 7), 16);
    const adj = (c: number) => Math.max(0, Math.min(255, Math.round(c + c * aFactor)));
    return `#${adj(r).toString(16).padStart(2, '0')}${adj(g).toString(16).padStart(2, '0')}${adj(b).toString(16).padStart(2, '0')}`;
}

/** Returns '#000000' or '#ffffff' depending on which has better contrast */
function contrastTextColor(aHex: string): string {
    const r = parseInt(aHex.slice(1, 3), 16);
    const g = parseInt(aHex.slice(3, 5), 16);
    const b = parseInt(aHex.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
vscode.postMessage({ type: 'ready' });

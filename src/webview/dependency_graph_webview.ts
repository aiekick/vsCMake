// ------------------------------------------------------------
// VS Code API
// ------------------------------------------------------------
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
let allNodes: GraphNode[] = [];
let allEdges: GraphEdge[] = [];
let layoutNodes: LayoutNode[] = [];
let activeFilters = new Set<string>();
let selectedNodeId: string | null = null;
let edgeStyle: 'tapered' | 'chevrons' | 'line' = 'tapered';
let edgeDirection: 'parent-to-child' | 'child-to-parent' = 'child-to-parent';
let simEnabled = true;       // user toggle: allows/prevents sim from running
let autoPauseDuringDrag = false;
let searchFilter = '';
let searchMode: 'name' | 'path' = 'name';
let searchFilterMode: 'dim' | 'hide' = 'hide'; // dim = lower opacity, hide = remove from graph
let minimapEnabled = true;
let taperedWidthFactor = 2.0;
let settingsCollapseState: Record<string, boolean> = { edges: false, colors: true, simulation: true, display: false, controls: false };
let settingsPanelVisible = false;

// Focused view state: when non-null, only show the recursively connected subgraph
let focusedNodeId: string | null = null;
let focusHistory: { nodeId: string; label: string }[] = [];
let focusVisibleIds: Set<string> | null = null; // precomputed set of visible node ids in focus mode

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
let camX = 0;
let camY = 0;
let zoom = 1;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 10;
const GRID_SIZE = 40;

// Interaction state
let isPanning = false;
let isDraggingNode = false;
let wasPanning = false;
let dragNode: LayoutNode | null = null;
let panStartX = 0;
let panStartY = 0;
let camStartX = 0;
let camStartY = 0;
let dragOffsetX = 0;
let dragOffsetY = 0;
let firstLayout = true;

// ------------------------------------------------------------
// Force simulation parameters (defaults)
// ------------------------------------------------------------
const SIM_DEFAULTS: Record<string, number> = {
    repulsion: 10000,
    attraction: 0.1,
    gravity: 0.001,
    linkLength: 0.05, // ideal link length smaller = stronger spring
    minDistance: 5000,
    stepsPerFrame: 5,
    threshold: 5,
    damping: 0.85,
};

let simRepulsion = SIM_DEFAULTS.repulsion;
let simAttraction = SIM_DEFAULTS.attraction;
let simGravity = SIM_DEFAULTS.gravity;
let simLinkLength = SIM_DEFAULTS.linkLength;
let simMinDistance = SIM_DEFAULTS.minDistance;
let simStepsPerFrame = SIM_DEFAULTS.stepsPerFrame;
let simThreshold = SIM_DEFAULTS.threshold;
let simDamping = SIM_DEFAULTS.damping;
let simRunning = false;
let simAnimFrame: number | null = null;

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
    vscode.setState({ camX, camY, zoom } as PersistedState);
}

function restoreState(): boolean {
    const s = vscode.getState() as PersistedState | undefined;
    if (!s || s.camX === undefined) { return false; }
    camX = s.camX;
    camY = s.camY!;
    zoom = s.zoom!;
    return true;
}

// ------------------------------------------------------------
// Search filter helpers
// ------------------------------------------------------------
function nodeMatchesSearch(node: GraphNode): boolean {
    if (!searchFilter) { return true; }
    const query = searchFilter.toLowerCase();
    const target = searchMode === 'name' ? node.label : node.sourcePath;
    // Support regex for power users: if the query is a valid regex, use it
    try {
        if (searchFilter.includes('*') || searchFilter.includes('(') || searchFilter.includes('[')) {
            return new RegExp(searchFilter, 'i').test(target);
        }
    } catch { /* not a valid regex, fallback to simple match */ }
    return target.toLowerCase().includes(query);
}

/**
 * Returns true if a node should be completely excluded from the graph
 * (simulation + rendering), like type filters in the header.
 * Combines: activeFilters (type checkboxes) + hide-mode search + hide-mode focus.
 */
function isNodeFiltered(node: GraphNode): boolean {
    // Type filter from header checkboxes
    if (activeFilters.has(node.type)) { return true; }
    // In "hide" mode, search and focus act as real filters
    if (searchFilterMode === 'hide') {
        if (searchFilter && !nodeMatchesSearch(node)) { return true; }
        if (focusVisibleIds && !focusVisibleIds.has(node.id)) { return true; }
    }
    return false;
}

// ------------------------------------------------------------
// Text measurement (uses offscreen canvas)
// ------------------------------------------------------------
const measureCtx = document.createElement('canvas').getContext('2d')!;

function measureNodeWidth(label: string): number {
    const font = getCssVar('--vscode-font-family') || 'monospace';
    measureCtx.font = `bold 11px ${font}`;
    const textW = measureCtx.measureText(label).width;
    return Math.max(NODE_MIN_W, textW + NODE_PAD_X * 2);
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
    if (minimapEnabled) { drawMinimap(w, h); }
}

function worldToScreen(wx: number, wy: number): [number, number] {
    return [camX + wx * zoom, camY + wy * zoom];
}

// ------------------------------------------------------------
// Edge drawing (supports tapered, chevrons, or plain line)
// ------------------------------------------------------------
function drawEdges(w: number, h: number): void {
    if (!ctx || allEdges.length === 0) { return; }

    const nodeMap = new Map<string, LayoutNode>();
    for (const ln of layoutNodes) {
        if (!isNodeFiltered(ln.node)) {
            nodeMap.set(ln.node.id, ln);
        }
    }

    const hasSearch = searchFilter.length > 0;

    // Draw normal edges, then highlighted on top
    for (const edge of allEdges) {
        const fromLn = nodeMap.get(edge.from);
        const toLn = nodeMap.get(edge.to);
        if (!fromLn || !toLn) { continue; }

        const isHighlighted = selectedNodeId && (edge.from === selectedNodeId || edge.to === selectedNodeId);
        if (isHighlighted) { continue; }

        const [x1, y1] = worldToScreen(fromLn.x, fromLn.y);
        const [x2, y2] = worldToScreen(toLn.x, toLn.y);
        const margin = 50;
        if (Math.max(x1, x2) < -margin || Math.min(x1, x2) > w + margin) { continue; }
        if (Math.max(y1, y2) < -margin || Math.min(y1, y2) > h + margin) { continue; }

        // In "dim" mode, dim edges where neither endpoint matches search/focus
        const fromMatchesSearch = !hasSearch || nodeMatchesSearch(fromLn.node);
        const toMatchesSearch = !hasSearch || nodeMatchesSearch(toLn.node);
        const fromInFocus = isNodeVisibleInFocus(fromLn.node.id);
        const toInFocus = isNodeVisibleInFocus(toLn.node.id);
        const searchDim = hasSearch && !fromMatchesSearch && !toMatchesSearch;
        const focusDim = focusedNodeId !== null && !fromInFocus && !toInFocus;
        const edgeAlpha = (searchDim || focusDim) ? 0.04 : 0.15;
        drawEdgeStyled(ctx, x1, y1, x2, y2, `rgba(255, 255, 255, ${edgeAlpha})`);
    }

    // Highlighted edges with gradient: node color → white along the arrow
    if (selectedNodeId) {
        for (const edge of allEdges) {
            const isHighlighted = edge.from === selectedNodeId || edge.to === selectedNodeId;
            if (!isHighlighted) { continue; }
            const fromLn = nodeMap.get(edge.from);
            const toLn = nodeMap.get(edge.to);
            if (!fromLn || !toLn) { continue; }
            const [x1, y1] = worldToScreen(fromLn.x, fromLn.y);
            const [x2, y2] = worldToScreen(toLn.x, toLn.y);

            // Compute visual arrow direction (after edgeDirection swap)
            // The wide end (base) is at sx1,sy1 and the tip at sx2,sy2
            let sx1 = x1, sy1 = y1, sx2 = x2, sy2 = y2;
            let baseNode = fromLn;
            if (edgeDirection === 'child-to-parent') {
                sx1 = x2; sy1 = y2; sx2 = x1; sy2 = y1;
                baseNode = toLn;
            }

            // Gradient from the base node's color (wide end) → white (tip)
            const grad = ctx.createLinearGradient(sx1, sy1, sx2, sy2);
            grad.addColorStop(0, baseNode.node.color);
            grad.addColorStop(1, '#ffffff');

            drawEdgeStyled(ctx, x1, y1, x2, y2, grad, 0.6);
        }
    }
}

/** Dispatch to the correct edge style, respecting edge direction */
function drawEdgeStyled(
    c: CanvasRenderingContext2D,
    x1: number, y1: number, x2: number, y2: number,
    color: string | CanvasGradient, alpha = 1,
): void {
    // Swap direction if inverted
    let sx1 = x1, sy1 = y1, sx2 = x2, sy2 = y2;
    if (edgeDirection === 'child-to-parent') {
        sx1 = x2; sy1 = y2; sx2 = x1; sy2 = y1;
    }
    switch (edgeStyle) {
        case 'tapered': drawTaperedEdge(c, sx1, sy1, sx2, sy2, color, alpha); break;
        case 'chevrons': drawChevronEdge(c, sx1, sy1, sx2, sy2, color, alpha); break;
        case 'line': drawLineEdge(c, sx1, sy1, sx2, sy2, color, alpha); break;
    }
}

/** Tapered triangle: wider at "from", narrow at "to" */
function drawTaperedEdge(
    c: CanvasRenderingContext2D,
    x1: number, y1: number, x2: number, y2: number,
    color: string | CanvasGradient, alpha = 1,
): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 2) { return; }

    const px = -dy / len;
    const py = dx / len;

    const wideHalf = Math.max(1.5, 3 * zoom * taperedWidthFactor);
    const narrowHalf = Math.max(0.3, 0.5 * zoom * taperedWidthFactor);

    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(x1 + px * wideHalf, y1 + py * wideHalf);
    c.lineTo(x2 + px * narrowHalf, y2 + py * narrowHalf);
    c.lineTo(x2 - px * narrowHalf, y2 - py * narrowHalf);
    c.lineTo(x1 - px * wideHalf, y1 - py * wideHalf);
    c.closePath();
    c.fill();
    c.globalAlpha = 1;
}

/** Chevrons (>>>) at the midpoint of a line */
function drawChevronEdge(
    c: CanvasRenderingContext2D,
    x1: number, y1: number, x2: number, y2: number,
    color: string | CanvasGradient, alpha = 1,
): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 2) { return; }

    c.globalAlpha = alpha;
    c.strokeStyle = color;
    c.lineWidth = Math.max(1, 1.5 * zoom);
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();

    const ux = dx / len;
    const uy = dy / len;
    const chevSize = Math.max(3, 5 * zoom);
    const gap = Math.max(2, 4 * zoom);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;

    c.lineWidth = Math.max(1, 1.2 * zoom);
    for (let i = -1; i <= 1; i++) {
        const cx = mx + ux * i * gap;
        const cy = my + uy * i * gap;
        c.beginPath();
        c.moveTo(cx - ux * chevSize - uy * chevSize, cy - uy * chevSize + ux * chevSize);
        c.lineTo(cx, cy);
        c.lineTo(cx - ux * chevSize + uy * chevSize, cy - uy * chevSize - ux * chevSize);
        c.stroke();
    }
    c.globalAlpha = 1;
}

/** Simple straight line (no direction indicator) */
function drawLineEdge(
    c: CanvasRenderingContext2D,
    x1: number, y1: number, x2: number, y2: number,
    color: string | CanvasGradient, alpha = 1,
): void {
    c.globalAlpha = alpha;
    c.strokeStyle = color;
    c.lineWidth = Math.max(1, 1.5 * zoom);
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
    c.globalAlpha = 1;
}

// ------------------------------------------------------------
// Node drawing (all rectangular)
// ------------------------------------------------------------
function drawNodes(w: number, h: number): void {
    if (!ctx || layoutNodes.length === 0) { return; }

    const minFontSize = 3;
    const fontSize = Math.max(minFontSize, 11 * zoom);

    const hasSearch = searchFilter.length > 0;

    for (const ln of layoutNodes) {
        if (isNodeFiltered(ln.node)) { continue; }

        const [sx, sy] = worldToScreen(ln.x, ln.y);
        const sw = ln.w * zoom;
        const sh = NODE_H * zoom;

        // Cull off-screen
        if (((sx + sw / 2) < 0) ||
            ((sx - sw / 2) > w) ||
            ((sy + sh / 2) < 0) ||
            ((sy - sh / 2) > h)) {
            continue;
        }

        // In "dim" mode, reduce opacity for non-matching nodes
        const matchesSearch = !hasSearch || nodeMatchesSearch(ln.node);
        const inFocus = isNodeVisibleInFocus(ln.node.id);
        const nodeAlpha = (!matchesSearch || !inFocus) ? 0.12 : 1;

        const color = ln.node.color;
        const borderColor = darken(color);

        const zoom2 = 2 * zoom;
        const zoom3 = 3 * zoom;
        const zoom4 = 4 * zoom;

        ctx.globalAlpha = nodeAlpha;
        ctx.fillStyle = color;
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = Math.max(1, zoom2);
        const r = Math.min(zoom4, sw * 0.08);
        drawBox(ctx, sx, sy, sw, sh, r);

        // Focused root node halo (golden glow)
        if (focusedNodeId && ln.node.id === focusedNodeId) {
            ctx.save();
            ctx.shadowColor = '#FFD700';
            ctx.shadowBlur = Math.max(12, 20 * zoom);
            ctx.strokeStyle = '#FFD700';
            ctx.lineWidth = Math.max(2, zoom3);
            const haloR = Math.min(zoom4 + zoom2, (sw + zoom4 * 2) * 0.08);
            drawBox(ctx, sx, sy, sw + zoom4 * 2, sh + zoom4 * 2, haloR, true);
            ctx.restore();
            ctx.globalAlpha = nodeAlpha;
        }

        // Selection border
        if (ln.node.id === selectedNodeId) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(2, zoom3);
            drawBox(ctx, sx, sy, sw + zoom4, sh + zoom4, r + zoom2, true);
        }

        if (fontSize <= minFontSize) { ctx.globalAlpha = 1; continue; }

        // Label with auto contrast
        const textColor = contrastTextColor(color);
        ctx.fillStyle = textColor;
        ctx.font = `bold ${fontSize}px ${getCssVar('--vscode-font-family') || 'monospace'}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ln.node.label, sx, sy);
        ctx.globalAlpha = 1;
    }
}

function drawBox(c: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, r: number, strokeOnly = false): void {
    const x = cx - w / 2;
    const y = cy - h / 2;
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.arcTo(x + w, y, x + w, y + r, r);
    c.lineTo(x + w, y + h - r);
    c.arcTo(x + w, y + h, x + w - r, y + h, r);
    c.lineTo(x + r, y + h);
    c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r);
    c.arcTo(x, y, x + r, y, r);
    c.closePath();
    if (!strokeOnly) { c.fill(); }
    c.stroke();
}

// ------------------------------------------------------------
// Grid drawing
// ------------------------------------------------------------
function drawGrid(w: number, h: number): void {
    if (!ctx) { return; }

    const gridWorld = GRID_SIZE;
    const gridScreen = gridWorld * zoom;
    if (gridScreen < 4) { return; }

    const worldLeft = -camX / zoom;
    const worldTop = -camY / zoom;
    const worldRight = worldLeft + w / zoom;
    const worldBottom = worldTop + h / zoom;

    const startX = Math.floor(worldLeft / gridWorld) * gridWorld;
    const startY = Math.floor(worldTop / gridWorld) * gridWorld;

    const alpha = Math.min(0.3, gridScreen / 100);
    ctx.strokeStyle = `rgba(128, 128, 128, ${alpha})`;
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let wx = startX; wx <= worldRight; wx += gridWorld) {
        const sx = camX + wx * zoom;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, h);
    }
    for (let wy = startY; wy <= worldBottom; wy += gridWorld) {
        const sy = camY + wy * zoom;
        ctx.moveTo(0, sy);
        ctx.lineTo(w, sy);
    }
    ctx.stroke();

    // Origin cross
    const ox = camX;
    const oy = camY;
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
    ctx.lineWidth = 2;
    if (ox >= 0 && ox <= w) {
        ctx.beginPath(); ctx.moveTo(ox, 0); ctx.lineTo(ox, h); ctx.stroke();
    }
    if (oy >= 0 && oy <= h) {
        ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(w, oy); ctx.stroke();
    }
}

// ------------------------------------------------------------
// Minimap
// ------------------------------------------------------------
const MINIMAP_W = 150;
const MINIMAP_H = 100;
const MINIMAP_MARGIN = 8;

// Cached minimap transform for mouse interaction
let minimapTransform: {
    mx: number; my: number; // minimap top-left in canvas space
    scale: number;
    wMinX: number; wMinY: number;
    canvasW: number; canvasH: number;
} | null = null;
let isDraggingMinimap = false;

function drawMinimap(canvasW: number, canvasH: number): void {
    if (!ctx || layoutNodes.length === 0) { return; }

    // Compute bounding box of all visible nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;
    for (const ln of layoutNodes) {
        if (isNodeFiltered(ln.node)) { continue; }
        minX = Math.min(minX, ln.x - ln.w / 2);
        maxX = Math.max(maxX, ln.x + ln.w / 2);
        minY = Math.min(minY, ln.y - NODE_H / 2);
        maxY = Math.max(maxY, ln.y + NODE_H / 2);
        count++;
    }
    if (count === 0) { return; }

    const worldW = maxX - minX || 1;
    const worldH = maxY - minY || 1;

    // Add some padding to the world bounds
    const pad = Math.max(worldW, worldH) * 0.05;
    const wMinX = minX - pad;
    const wMinY = minY - pad;
    const wW = worldW + pad * 2;
    const wH = worldH + pad * 2;

    // Minimap position (bottom-left)
    const mmx = MINIMAP_MARGIN;
    const mmy = canvasH - MINIMAP_H - MINIMAP_MARGIN;

    // Scale factor: fit the entire graph world into the minimap
    const scaleX = MINIMAP_W / wW;
    const scaleY = MINIMAP_H / wH;
    const scale = Math.min(scaleX, scaleY);

    // Save transform for mouse interaction
    minimapTransform = { mx: mmx, my: mmy, scale, wMinX, wMinY, canvasW, canvasH };

    // Background
    ctx.fillStyle = 'rgba(30, 30, 30, 0.85)';
    ctx.fillRect(mmx, mmy, MINIMAP_W, MINIMAP_H);
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(mmx, mmy, MINIMAP_W, MINIMAP_H);

    // Draw edges as thin lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 0.5;
    const nodeMap = new Map<string, LayoutNode>();
    for (const ln of layoutNodes) {
        if (!isNodeFiltered(ln.node)) {
            nodeMap.set(ln.node.id, ln);
        }
    }
    const hasSearch = searchFilter.length > 0;
    for (const edge of allEdges) {
        const fromLn = nodeMap.get(edge.from);
        const toLn = nodeMap.get(edge.to);
        if (!fromLn || !toLn) { continue; }
        const ex1 = mmx + (fromLn.x - wMinX) * scale;
        const ey1 = mmy + (fromLn.y - wMinY) * scale;
        const ex2 = mmx + (toLn.x - wMinX) * scale;
        const ey2 = mmy + (toLn.y - wMinY) * scale;
        ctx.beginPath();
        ctx.moveTo(ex1, ey1);
        ctx.lineTo(ex2, ey2);
        ctx.stroke();
    }

    // Draw nodes as small dots (reflecting search/focus dim)
    for (const ln of layoutNodes) {
        if (isNodeFiltered(ln.node)) { continue; }
        // In "dim" mode, reduce opacity for non-matching nodes
        const matchesSearch = !hasSearch || nodeMatchesSearch(ln.node);
        const inFocus = isNodeVisibleInFocus(ln.node.id);
        const isDimmed = !matchesSearch || !inFocus;
        const nx = mmx + (ln.x - wMinX) * scale;
        const ny = mmy + (ln.y - wMinY) * scale;
        const dotSize = Math.max(2, ln.w * scale * 0.3);
        ctx.globalAlpha = isDimmed ? 0.15 : 1;
        ctx.fillStyle = ln.node.id === selectedNodeId ? '#ffffff' : ln.node.color;
        ctx.fillRect(nx - dotSize / 2, ny - dotSize / 2, dotSize, dotSize);
    }
    ctx.globalAlpha = 1;

    // Draw viewport rectangle
    const viewWorldLeft = -camX / zoom;
    const viewWorldTop = -camY / zoom;
    const viewWorldRight = viewWorldLeft + canvasW / zoom;
    const viewWorldBottom = viewWorldTop + canvasH / zoom;

    const vx = mmx + (viewWorldLeft - wMinX) * scale;
    const vy = mmy + (viewWorldTop - wMinY) * scale;
    const vw = (viewWorldRight - viewWorldLeft) * scale;
    const vh = (viewWorldBottom - viewWorldTop) * scale;

    ctx.strokeStyle = 'rgba(255, 200, 50, 0.8)';
    ctx.lineWidth = 1.5;
    // Clip the viewport rectangle to minimap bounds
    const clipX = Math.max(mmx, vx);
    const clipY = Math.max(mmy, vy);
    const clipR = Math.min(mmx + MINIMAP_W, vx + vw);
    const clipB = Math.min(mmy + MINIMAP_H, vy + vh);
    if (clipR > clipX && clipB > clipY) {
        ctx.strokeRect(clipX, clipY, clipR - clipX, clipB - clipY);
    }
}

/** Check if a screen point falls within the minimap bounds */
function isInMinimap(sx: number, sy: number): boolean {
    if (!minimapEnabled || !minimapTransform) { return false; }
    const { mx, my } = minimapTransform;
    return sx >= mx && sx <= mx + MINIMAP_W && sy >= my && sy <= my + MINIMAP_H;
}

/** Convert minimap screen coords to world coords, then center the camera there */
function minimapPanTo(sx: number, sy: number): void {
    if (!minimapTransform || !canvas) { return; }
    const { mx, my, scale, wMinX, wMinY } = minimapTransform;
    // Convert minimap position to world coords
    const worldX = (sx - mx) / scale + wMinX;
    const worldY = (sy - my) / scale + wMinY;
    // Center the camera on this world position
    camX = canvas.clientWidth / 2 - worldX * zoom;
    camY = canvas.clientHeight / 2 - worldY * zoom;
    saveState();
    draw();
}

// ------------------------------------------------------------
// Hit testing
// ------------------------------------------------------------
function hitTestNode(screenX: number, screenY: number): LayoutNode | null {
    for (let i = layoutNodes.length - 1; i >= 0; i--) {
        const ln = layoutNodes[i];
        if (isNodeFiltered(ln.node)) { continue; }
        const [sx, sy] = worldToScreen(ln.x, ln.y);
        const hw = (ln.w * zoom) / 2;
        const hh = (NODE_H * zoom) / 2;
        if (screenX >= sx - hw && screenX <= sx + hw && screenY >= sy - hh && screenY <= sy + hh) {
            return ln;
        }
    }
    return null;
}

// ------------------------------------------------------------
// Canvas events: pan, node drag, zoom, selection
// ------------------------------------------------------------
function attachCanvasEvents(c: HTMLCanvasElement): void {
    c.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0) { return; }
        e.preventDefault();

        const rect = c.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Check minimap first — capture events there
        if (isInMinimap(mx, my)) {
            isDraggingMinimap = true;
            minimapPanTo(mx, my);
            c.style.cursor = 'crosshair';
            return;
        }

        const hit = hitTestNode(mx, my);
        if (hit) {
            isDraggingNode = true;
            dragNode = hit;
            selectedNodeId = hit.node.id;
            updateFooter();
            const [sx, sy] = worldToScreen(hit.x, hit.y);
            dragOffsetX = mx - sx;
            dragOffsetY = my - sy;
            c.style.cursor = 'move';
            // Auto-pause: pause sim while dragging
            if (autoPauseDuringDrag && simRunning) {
                stopSimulation();
            }
            vscode.postMessage({ type: 'nodeClick', targetId: hit.node.id });
        } else {
            isPanning = true;
            panStartX = e.clientX;
            panStartY = e.clientY;
            camStartX = camX;
            camStartY = camY;
            c.style.cursor = 'grabbing';
        }
        draw();
    });

    window.addEventListener('mousemove', (e: MouseEvent) => {
        if (isDraggingMinimap) {
            const rect = c.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            minimapPanTo(mx, my);
            return;
        }
        if (isDraggingNode && dragNode) {
            const rect = c.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            dragNode.x = (mx - dragOffsetX - camX) / zoom;
            dragNode.y = (my - dragOffsetY - camY) / zoom;
            draw();
        } else if (isPanning) {
            wasPanning = true;
            camX = camStartX + (e.clientX - panStartX);
            camY = camStartY + (e.clientY - panStartY);
            draw();
        }
    });

    window.addEventListener('mouseup', (e: MouseEvent) => {
        if (e.button !== 0) { return; }
        if (isDraggingMinimap) {
            isDraggingMinimap = false;
            c.style.cursor = 'grab';
            return;
        }
        if (isDraggingNode) {
            isDraggingNode = false;
            dragNode = null;
            c.style.cursor = 'grab';
            // Resume sim if enabled (auto-pause or normal mode)
            if (simEnabled) {
                startSimulation();
            }
        } else if (!wasPanning) {
            selectedNodeId = null;
            updateFooter();
        }
        if (isPanning) {
            isPanning = false;
            wasPanning = false;
            c.style.cursor = 'grab';
            saveState();
        }
    });

    c.addEventListener('dblclick', (e: MouseEvent) => {
        const rect = c.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        // Ignore double-click on minimap
        if (isInMinimap(mx, my)) { return; }
        // Use selectedNodeId from mousedown instead of re-hit-testing,
        // because the node may have moved slightly during the drag between clicks
        if (selectedNodeId) {
            if (selectedNodeId === focusedNodeId) {
                // Already focused — just re-center gravity origin on this node
                shiftOriginToNode(selectedNodeId);
                restartSimIfEnabled();
                draw();
                return;
            }
            // Focus on the selected node and all recursively connected nodes
            focusOnNode(selectedNodeId);
        } else {
            // Double-click on background: fit graph to view
            centerOnNodes();
            draw();
        }
    });

    c.addEventListener('wheel', (e: WheelEvent) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Zoom from minimap: zoom centered on the minimap world position
        if (isInMinimap(mx, my) && minimapTransform) {
            const worldX = (mx - minimapTransform.mx) / minimapTransform.scale + minimapTransform.wMinX;
            const worldY = (my - minimapTransform.my) / minimapTransform.scale + minimapTransform.wMinY;
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
            camX = c.clientWidth / 2 - worldX * zoom;
            camY = c.clientHeight / 2 - worldY * zoom;
            saveState();
            draw();
            return;
        }

        const wxBefore = (mx - camX) / zoom;
        const wyBefore = (my - camY) / zoom;

        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));

        camX = mx - wxBefore * zoom;
        camY = my - wyBefore * zoom;

        saveState();
        draw();
    }, { passive: false });

    c.style.cursor = 'grab';
}

// ------------------------------------------------------------
// Force-directed simulation
// ------------------------------------------------------------

/** Restart simulation if it's enabled (convenience for visibility changes) */
function restartSimIfEnabled(): void {
    if (simEnabled) {
        stopSimulation();
        startSimulation();
    }
}

function startSimulation(): void {
    if (simRunning || !simEnabled) { return; }
    simRunning = true;
    simAnimFrame = requestAnimationFrame(simulationStep);
}

function stopSimulation(): void {
    simRunning = false;
    if (simAnimFrame !== null) {
        cancelAnimationFrame(simAnimFrame);
        simAnimFrame = null;
    }
}

function simulationStep(): void {
    if (!simRunning) { return; }

    for (let step = 0; step < simStepsPerFrame; step++) {
        let totalMovement = 0;

        // Build index
        const nodeIndex = new Map<string, number>();
        layoutNodes.forEach((ln, i) => nodeIndex.set(ln.node.id, i));

        const n = layoutNodes.length;
        const fx = new Float64Array(n);
        const fy = new Float64Array(n);

        // Build adjacency set and degree count for connectivity-aware repulsion
        const adjacency = new Map<string, Set<string>>();
        const degree = new Map<string, number>();
        for (const edge of allEdges) {
            if (!adjacency.has(edge.from)) { adjacency.set(edge.from, new Set()); }
            if (!adjacency.has(edge.to)) { adjacency.set(edge.to, new Set()); }
            adjacency.get(edge.from)!.add(edge.to);
            adjacency.get(edge.to)!.add(edge.from);
        }
        for (let i = 0; i < n; i++) {
            degree.set(layoutNodes[i].node.id, adjacency.get(layoutNodes[i].node.id)?.size ?? 0);
        }

        // Repulsion between all pairs (Coulomb) — stronger for unconnected high-degree nodes
        for (let i = 0; i < n; i++) {
            if (isNodeFiltered(layoutNodes[i].node)) { continue; }
            const idI = layoutNodes[i].node.id;
            const degI = degree.get(idI) ?? 0;
            const adjI = adjacency.get(idI);
            for (let j = i + 1; j < n; j++) {
                if (isNodeFiltered(layoutNodes[j].node)) { continue; }
                const idJ = layoutNodes[j].node.id;
                const connected = adjI !== undefined && adjI.has(idJ);
                let dx = layoutNodes[j].x - layoutNodes[i].x;
                let dy = layoutNodes[j].y - layoutNodes[i].y;
                const distSq = dx * dx + dy * dy;
                let dist = Math.sqrt(distSq);
                // Avoid division by zero: jitter overlapping nodes
                if (dist < 0.1) {
                    dx = (Math.random() - 0.5) * 2;
                    dy = (Math.random() - 0.5) * 2;
                    dist = 1;
                }
                // Standard repulsion
                let force = simRepulsion / (dist * dist);
                // Extra push when closer than minDistance
                if (dist < simMinDistance) {
                    force *= (simMinDistance / dist);
                }
                // Boost repulsion for unconnected nodes based on their degree
                // High-degree nodes push harder to reduce clutter around hubs
                if (!connected) {
                    const degJ = degree.get(idJ) ?? 0;
                    const degBoost = 1 + 0.15 * (degI + degJ);
                    force *= degBoost;
                }
                const forceX = (dx / dist) * force;
                const forceY = (dy / dist) * force;
                fx[i] -= forceX;
                fy[i] -= forceY;
                fx[j] += forceX;
                fy[j] += forceY;
            }
        }

        // Attraction on edges (Hooke)
        for (const edge of allEdges) {
            const fi = nodeIndex.get(edge.from);
            const ti = nodeIndex.get(edge.to);
            if (fi === undefined || ti === undefined) { continue; }
            if (isNodeFiltered(layoutNodes[fi].node)) { continue; }
            if (isNodeFiltered(layoutNodes[ti].node)) { continue; }
            const dx = layoutNodes[ti].x - layoutNodes[fi].x;
            const dy = layoutNodes[ti].y - layoutNodes[fi].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1) { continue; }

            // linear spring: F = k * x
            //const force = simAttraction * dist;

            // Logarithmic spring: strong pull when far, weaker when close
            const force = simAttraction * Math.log(1 + dist) / simLinkLength;

            const forceX = (dx / dist) * force;
            const forceY = (dy / dist) * force;
            fx[fi] += forceX;
            fy[fi] += forceY;
            fx[ti] -= forceX;
            fy[ti] -= forceY;
        }

        // Central gravity toward origin
        for (let i = 0; i < n; i++) {
            if (isNodeFiltered(layoutNodes[i].node)) { continue; }
            const px = layoutNodes[i].x;
            const py = layoutNodes[i].y;
            const dist = Math.sqrt(px * px + py * py);
            if (dist < 1) { continue; }
            const forceDist = simGravity; // * Math.pow(dist, 0.25) ;
            fx[i] -= px * forceDist;
            fy[i] -= py * forceDist;
        }

        // Apply forces with velocity damping
        const maxSpeed = 15;
        for (let i = 0; i < n; i++) {
            if (isNodeFiltered(layoutNodes[i].node)) { continue; }
            // Don't move the node being dragged
            if (isDraggingNode && dragNode === layoutNodes[i]) { continue; }
            // Pin the focused root node in place (anchor for the subgraph)
            if (focusedNodeId && layoutNodes[i].node.id === focusedNodeId) { continue; }

            const ln = layoutNodes[i];
            ln.vx = (ln.vx + fx[i]) * simDamping;
            ln.vy = (ln.vy + fy[i]) * simDamping;

            // Clamp speed
            const speed = Math.sqrt(ln.vx * ln.vx + ln.vy * ln.vy);
            if (speed > maxSpeed) {
                ln.vx = (ln.vx / speed) * maxSpeed;
                ln.vy = (ln.vy / speed) * maxSpeed;
            }

            ln.x += ln.vx;
            ln.y += ln.vy;
            totalMovement += Math.abs(ln.vx) + Math.abs(ln.vy);
        }

        // Check equilibrium
        if (totalMovement < simThreshold) {
            stopSimulation();
            draw();
            return;
        }
    }

    draw();
    simAnimFrame = requestAnimationFrame(simulationStep);
}

// ------------------------------------------------------------
// Resize handling
// ------------------------------------------------------------
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function onResize(): void {
    if (resizeTimer) { clearTimeout(resizeTimer); }
    resizeTimer = setTimeout(() => {
        recalcContainerHeight();
        resizeCanvas();
    }, 50);
}

function recalcContainerHeight(): void {
    const container = document.getElementById('graph-container')!;
    const toolbarH = document.getElementById('toolbar')?.offsetHeight ?? 0;
    const footerH = document.getElementById('footer')?.offsetHeight ?? 0;
    const breadcrumbH = document.getElementById('breadcrumb-bar')?.offsetHeight ?? 0;
    const available = window.innerHeight - toolbarH - footerH - breadcrumbH;
    container.style.height = `${Math.max(200, available)}px`;
}

window.addEventListener('resize', onResize);
const graphContainer = document.getElementById('graph-container')!;
const resizeObserver = new ResizeObserver(onResize);
resizeObserver.observe(graphContainer);

// ------------------------------------------------------------
// Graph creation
// ------------------------------------------------------------
function createGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
    stopSimulation();

    // Filter out UTILITY nodes
    const filtered = nodes.filter(n => n.type !== 'UTILITY');

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
    const validIds = new Set(unique.map(n => n.id));
    allEdges = edges.filter(e => validIds.has(e.from) && validIds.has(e.to));
    allNodes = unique;
    activeFilters.clear();

    const emptyMsg = document.getElementById('empty-message')!;

    initSearchBar();
    if (allNodes.length === 0) {
        document.getElementById('graph-container')!.style.display = 'none';
        emptyMsg.style.display = 'flex';
        emptyMsg.textContent = 'No targets to display';
        buildFilterCheckboxes();
        return;
    }

    initLayoutNodes(allNodes);
    buildFilterCheckboxes();
    recalcContainerHeight();

    setTimeout(() => {
        setupCanvas();
        if (firstLayout || !restoreState()) {
            centerOnNodes();
            firstLayout = false;
        }
        draw();
        // Start force simulation
        startSimulation();
        // Restore settings panel after container is visible
        if (settingsPanelVisible && !settingsPanel) {
            toggleSettings(false);
        }
    }, 50);
}

/** Initialize layout nodes: preserve existing positions, new nodes in a circle */
function initLayoutNodes(nodes: GraphNode[]): void {
    const existingPositions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
    for (const ln of layoutNodes) {
        existingPositions.set(ln.node.id, { x: ln.x, y: ln.y, vx: ln.vx, vy: ln.vy });
    }

    const widths = nodes.map(n => measureNodeWidth(n.label));

    layoutNodes = [];
    const radius = Math.max(100, nodes.length * 10);

    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const w = widths[i];
        const existing = existingPositions.get(n.id);
        if (existing) {
            layoutNodes.push({ node: n, x: existing.x, y: existing.y, w, vx: existing.vx, vy: existing.vy });
        } else {
            const angle = (2 * Math.PI * i) / nodes.length;
            layoutNodes.push({
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
    const radius = Math.max(150, layoutNodes.length * 20);
    for (let i = 0; i < layoutNodes.length; i++) {
        const angle = (2 * Math.PI * i) / layoutNodes.length;
        layoutNodes[i].x = Math.cos(angle) * radius;
        layoutNodes[i].y = Math.sin(angle) * radius;
        layoutNodes[i].vx = 0;
        layoutNodes[i].vy = 0;
    }
    draw();
    startSimulation();
}

function centerOnNodes(): void {
    if (!canvas || layoutNodes.length === 0) { return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;
    for (const ln of layoutNodes) {
        if (isNodeFiltered(ln.node)) { continue; }
        minX = Math.min(minX, ln.x - ln.w / 2);
        maxX = Math.max(maxX, ln.x + ln.w / 2);
        minY = Math.min(minY, ln.y - NODE_H / 2);
        maxY = Math.max(maxY, ln.y + NODE_H / 2);
        count++;
    }
    if (count === 0) { return; }
    const bw = maxX - minX;
    const bh = maxY - minY;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;

    const pad = 40;
    zoom = Math.min((cw - pad * 2) / Math.max(1, bw), (ch - pad * 2) / Math.max(1, bh), 2);
    zoom = Math.max(ZOOM_MIN, zoom);

    const centerWX = (minX + maxX) / 2;
    const centerWY = (minY + maxY) / 2;
    camX = cw / 2 - centerWX * zoom;
    camY = ch / 2 - centerWY * zoom;

    saveState();
}

// ------------------------------------------------------------
// Search bar (lives inside #breadcrumb-bar, always visible)
// ------------------------------------------------------------
let searchBarInited = false;
function initSearchBar(): void {
    if (searchBarInited) { return; }
    searchBarInited = true;

    // Build the search controls inside the breadcrumb bar
    const bar = document.getElementById('breadcrumb-bar')!;
    bar.innerHTML = buildSearchControlsHtml();
    attachSearchEvents();
}

function buildSearchControlsHtml(): string {
    const filterIcon = searchFilterMode === 'dim' ? '\u{1F441}' : '\u{1F6AB}';
    const filterTitle = searchFilterMode === 'dim'
        ? 'Mode: Dim non-matching (click to switch to Hide)'
        : 'Mode: Hide non-matching (click to switch to Dim)';
    const modeLabel = searchMode === 'name' ? 'N' : 'P';
    const modeTitle = searchMode === 'name'
        ? 'Filtering by name (click to switch to path)'
        : 'Filtering by path (click to switch to name)';
    const placeholder = searchMode === 'name' ? 'Filter by name\u2026' : 'Filter by path\u2026';
    return `<div id="search-container">` +
        `<button id="search-filter-mode" title="${filterTitle}">${filterIcon}</button>` +
        `<button id="search-mode" title="${modeTitle}">${modeLabel}</button>` +
        `<input id="search-input" type="text" placeholder="${placeholder}" spellcheck="false" value="${escapeHtml(searchFilter)}">` +
        `<button id="search-clear" title="Clear filter">\u2715</button>` +
        `</div>`;
}

function attachSearchEvents(): void {
    const input = document.getElementById('search-input') as HTMLInputElement;
    const modeBtn = document.getElementById('search-mode') as HTMLButtonElement;
    const filterModeBtn = document.getElementById('search-filter-mode') as HTMLButtonElement;
    const clearBtn = document.getElementById('search-clear') as HTMLButtonElement;
    if (!input || !modeBtn || !clearBtn || !filterModeBtn) { return; }

    modeBtn.addEventListener('click', () => {
        searchMode = searchMode === 'name' ? 'path' : 'name';
        input.placeholder = searchMode === 'name' ? 'Filter by name\u2026' : 'Filter by path\u2026';
        modeBtn.textContent = searchMode === 'name' ? 'N' : 'P';
        modeBtn.title = searchMode === 'name' ? 'Filtering by name (click to switch to path)' : 'Filtering by path (click to switch to name)';
        applySearchFilter();
    });

    filterModeBtn.addEventListener('click', () => {
        searchFilterMode = searchFilterMode === 'dim' ? 'hide' : 'dim';
        filterModeBtn.textContent = searchFilterMode === 'dim' ? '\u{1F441}' : '\u{1F6AB}';
        filterModeBtn.title = searchFilterMode === 'dim'
            ? 'Mode: Dim non-matching (click to switch to Hide)'
            : 'Mode: Hide non-matching (click to switch to Dim)';
        applySearchFilter();
    });

    clearBtn.addEventListener('click', () => {
        searchFilter = '';
        input.value = '';
        applySearchFilter();
    });

    input.addEventListener('input', () => {
        searchFilter = input.value;
        applySearchFilter();
    });
}

function applySearchFilter(): void {
    // In hide mode, filtered nodes are excluded from simulation, so restart it
    if (searchFilterMode === 'hide') {
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

    const typeCounts = new Map<string, number>();
    for (const n of allNodes) {
        typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
    }

    for (const type of TARGET_TYPES) {
        const count = typeCounts.get(type) ?? 0;
        if (count === 0) { continue; }

        const label = document.createElement('label');
        label.className = 'filter-label';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !activeFilters.has(type);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                activeFilters.delete(type);
            } else {
                activeFilters.add(type);
            }
            restartSimIfEnabled();
            draw();
        });

        const span = document.createElement('span');
        const nodeOfType = allNodes.find(n => n.type === type);
        span.textContent = ` ${type} (${count})`;
        span.style.color = nodeOfType?.color ?? '#ccc';

        label.appendChild(checkbox);
        label.appendChild(span);
        container.appendChild(label);
    }
}

// ------------------------------------------------------------
// Settings panel
// ------------------------------------------------------------
let settingsPanel: HTMLDivElement | null = null;

function toggleSettings(persist = true): void {
    if (settingsPanel) {
        settingsPanel.remove();
        settingsPanel = null;
        if (persist) { vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsVisible', value: false }); }
        return;
    }
    settingsPanel = document.createElement('div');
    settingsPanel.id = 'settings-panel';
    settingsPanel.innerHTML = buildSettingsHtml();
    // Place inside graph-container as absolute overlay on the right side
    const graphContainer = document.getElementById('graph-container')!;
    graphContainer.appendChild(settingsPanel);
    attachSettingsEvents();
    if (persist) { vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsVisible', value: true }); }
}

function sliderRow(id: string, label: string, min: number, max: number, step: number, value: number, defaultVal: number): string {
    return `<div class="settings-row">
        <label>${label}</label>
        <div class="settings-slider-row">
            <input type="range" id="s-${id}" min="${min}" max="${max}" step="${step}" value="${value}">
            <span id="v-${id}">${value}</span>
            <button class="settings-reset-btn" data-reset="${id}" data-default="${defaultVal}" title="Reset to ${defaultVal}">\u21BA</button>
        </div>
    </div>`;
}

// ------------------------------------------------------------
// Footer (always visible, shows selected node info)
// ------------------------------------------------------------
function updateFooter(): void {
    const footer = document.getElementById('footer')!;
    if (!selectedNodeId) {
        footer.innerHTML = '';
        return;
    }
    const ln = layoutNodes.find(l => l.node.id === selectedNodeId);
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

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ------------------------------------------------------------
// Focused view with breadcrumb navigation
// ------------------------------------------------------------

/**
 * BFS from a root node following the current edge direction.
 * Edges: { from: target, to: dependency_it_uses }.
 *
 * - child-to-parent (default): follow from → to (A uses B, go to B's deps)
 * - parent-to-child: follow to → from (descend to consumers/children)
 */
function buildConnectedSubgraph(rootId: string): Set<string> {
    const visited = new Set<string>();
    const queue = [rootId];

    // Build directed adjacency based on current edge direction
    const adj = new Map<string, string[]>();
    for (const edge of allEdges) {
        if (edgeDirection === 'child-to-parent') {
            // Follow from → to (dependencies)
            if (!adj.has(edge.from)) { adj.set(edge.from, []); }
            adj.get(edge.from)!.push(edge.to);
        } else {
            // Follow to → from (consumers/children)
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
function shiftOriginToNode(nodeId: string): void {
    const focusLn = layoutNodes.find(ln => ln.node.id === nodeId);
    if (!focusLn) { return; }
    const dx = focusLn.x;
    const dy = focusLn.y;
    for (const ln of layoutNodes) {
        ln.x -= dx;
        ln.y -= dy;
    }
    camX += dx * zoom;
    camY += dy * zoom;
}

function focusOnNode(nodeId: string): void {
    const node = allNodes.find(n => n.id === nodeId);
    if (!node) { return; }

    // Build the full recursively-connected subgraph from this node
    focusVisibleIds = buildConnectedSubgraph(nodeId);

    // Shift world origin to the focused node so gravity centers around it.
    shiftOriginToNode(nodeId);

    // Check if this node is already at the end of the history
    if (focusHistory.length === 0 || focusHistory[focusHistory.length - 1].nodeId !== nodeId) {
        focusHistory.push({ nodeId, label: node.label });
    }
    focusedNodeId = nodeId;
    selectedNodeId = nodeId;

    restartSimIfEnabled();
    updateBreadcrumb();
    updateFooter();
    draw();
}

function exitFocusView(): void {
    focusedNodeId = null;
    focusHistory = [];
    focusVisibleIds = null;
    updateBreadcrumb();
    restartSimIfEnabled();
    draw();
}

function navigateBreadcrumb(index: number): void {
    if (index < 0) {
        // "All" clicked - exit focus view
        exitFocusView();
        return;
    }
    // Trim history to the clicked index
    focusHistory = focusHistory.slice(0, index + 1);
    const entry = focusHistory[index];
    focusedNodeId = entry.nodeId;
    selectedNodeId = entry.nodeId;

    // Rebuild the connected subgraph from the navigated node
    focusVisibleIds = buildConnectedSubgraph(entry.nodeId);
    restartSimIfEnabled();
    updateBreadcrumb();
    updateFooter();
    draw();
}

function updateBreadcrumb(): void {
    const bar = document.getElementById('breadcrumb-bar')!;

    // Always rebuild: search controls + breadcrumb items
    let html = buildSearchControlsHtml();

    if (focusedNodeId && focusHistory.length > 0) {
        html += '<span class="breadcrumb-separator">\u2502</span>';
        html += '<span class="breadcrumb-item" data-bc-index="-1">All</span>';
        for (let i = 0; i < focusHistory.length; i++) {
            html += '<span class="breadcrumb-separator">\u203A</span>';
            if (i === focusHistory.length - 1) {
                html += `<span class="breadcrumb-current">${escapeHtml(focusHistory[i].label)}</span>`;
            } else {
                html += `<span class="breadcrumb-item" data-bc-index="${i}">${escapeHtml(focusHistory[i].label)}</span>`;
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
function isNodeVisibleInFocus(nodeId: string): boolean {
    if (!focusVisibleIds) { return true; }
    return focusVisibleIds.has(nodeId);
}

function buildNodeColorPickersHtml(): string {
    const presentTypes = new Map<string, string>();
    for (const n of allNodes) {
        if (!presentTypes.has(n.type)) {
            presentTypes.set(n.type, n.color);
        }
    }
    if (presentTypes.size === 0) { return ''; }
    let inner = '';
    for (const [type, color] of presentTypes) {
        inner += `<label class="settings-inline">${type}
            <input type="color" id="s-color-${type}" value="${color}">
        </label>`;
    }
    return sectionHtml('colors', 'Node Colors', inner);
}

function sectionHtml(id: string, title: string, content: string): string {
    const collapsed = settingsCollapseState[id] ?? false;
    const arrow = collapsed ? '\u25B6' : '\u25BC';
    const display = collapsed ? 'none' : 'flex';
    return `<div class="settings-section" data-section="${id}">
        <div class="settings-title" data-collapse="${id}">${arrow} ${title}</div>
        <div class="settings-content" id="sc-${id}" style="display:${display}">
            ${content}
        </div>
    </div>`;
}

function buildSettingsHtml(): string {
    const edgesContent = `
        <label class="settings-inline">Style
            <select id="s-edgeStyle">
                <option value="tapered"${edgeStyle === 'tapered' ? ' selected' : ''}>Tapered</option>
                <option value="chevrons"${edgeStyle === 'chevrons' ? ' selected' : ''}>Chevrons</option>
                <option value="line"${edgeStyle === 'line' ? ' selected' : ''}>Line</option>
            </select>
        </label>
        <label class="settings-inline">Direction
            <select id="s-edgeDirection">
                <option value="parent-to-child"${edgeDirection === 'parent-to-child' ? ' selected' : ''}>Parents to childs</option>
                <option value="child-to-parent"${edgeDirection === 'child-to-parent' ? ' selected' : ''}>Childs to parents</option>
            </select>
        </label>
        ${sliderRow('taperedWidth', 'Tapered Width', 0.1, 5.0, 0.1, taperedWidthFactor, 2.0)}`;

    const simContent = `
        ${sliderRow('repulsion', 'Repulsion', 500, 100000, 500, simRepulsion, SIM_DEFAULTS.repulsion)}
        ${sliderRow('attraction', 'Attraction', 0.0001, 0.1, 0.001, simAttraction, SIM_DEFAULTS.attraction)}
        ${sliderRow('gravity', 'Gravity', 0.001, 0.2, 0.001, simGravity, SIM_DEFAULTS.gravity)}
        ${sliderRow('linkLength', 'Link Length', 0.001, 1.0, 0.001, simLinkLength, SIM_DEFAULTS.linkLength)}
        ${sliderRow('minDist', 'Min Distance', 20, 100000, 10, simMinDistance, SIM_DEFAULTS.minDistance)}
        ${sliderRow('steps', 'Steps/Frame', 1, 10, 1, simStepsPerFrame, SIM_DEFAULTS.stepsPerFrame)}
        ${sliderRow('threshold', 'Threshold', 0.001, 5, 0.001, simThreshold, SIM_DEFAULTS.threshold)}
        ${sliderRow('damping', 'Damping', 0.5, 1.0, 0.01, simDamping, SIM_DEFAULTS.damping)}`;

    const displayContent = `
        <label class="settings-checkbox"><input type="checkbox" id="s-minimap"${minimapEnabled ? ' checked' : ''}> Show minimap</label>`;

    const controlsContent = `
        <label class="settings-checkbox"><input type="checkbox" id="s-autoPause"${autoPauseDuringDrag ? ' checked' : ''}> Auto-pause sim during node drag</label>
        <button id="s-startstop" class="settings-btn">${simEnabled ? '\u23F8 Stop Simulation' : '\u25B6 Start Simulation'}</button>
        <button id="s-restart" class="settings-btn">\u21BA Restart Simulation</button>
        <button id="s-fitview" class="settings-btn">\u2922 Fit to View</button>
        <button id="s-screenshot" class="settings-btn">\uD83D\uDCF7 Screenshot (PNG)</button>`;

    return `
<div class="settings-body">
    ${sectionHtml('display', 'Display', displayContent)}
    ${sectionHtml('edges', 'Edges', edgesContent)}
    ${buildNodeColorPickersHtml()}
    ${sectionHtml('simulation', 'Force Simulation', simContent)}
    ${sectionHtml('controls', 'Controls', controlsContent)}
</div>`;
}

function updateStartStopBtn(): void {
    const btn = settingsPanel?.querySelector('#s-startstop') as HTMLButtonElement | null;
    if (btn) {
        btn.textContent = simEnabled ? '\u23F8 Stop Simulation' : '\u25B6 Start Simulation';
    }
}

function attachSettingsEvents(): void {
    if (!settingsPanel) { return; }

    // Collapsible section toggle
    settingsPanel.querySelectorAll('.settings-title[data-collapse]').forEach(el => {
        el.addEventListener('click', () => {
            const sectionId = (el as HTMLElement).dataset.collapse!;
            const content = settingsPanel!.querySelector(`#sc-${sectionId}`) as HTMLElement | null;
            if (!content) { return; }
            const isCollapsed = content.style.display === 'none';
            content.style.display = isCollapsed ? 'flex' : 'none';
            settingsCollapseState[sectionId] = !isCollapsed;
            (el as HTMLElement).textContent = (!isCollapsed ? '\u25B6' : '\u25BC') + ' ' + (el as HTMLElement).textContent!.substring(2);
            vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsCollapse', value: { ...settingsCollapseState } });
        });
    });

    // Slider ID → workspace setting key mapping
    const sliderSettingKeys: Record<string, string> = {
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
    const edgeSel = settingsPanel.querySelector('#s-edgeStyle') as HTMLSelectElement;
    edgeSel.addEventListener('change', () => {
        edgeStyle = edgeSel.value as typeof edgeStyle;
        vscode.postMessage({ type: 'updateSetting', key: 'graphEdgeStyle', value: edgeStyle });
        draw();
    });

    // Edge direction
    const dirSel = settingsPanel.querySelector('#s-edgeDirection') as HTMLSelectElement;
    dirSel.addEventListener('change', () => {
        edgeDirection = dirSel.value as typeof edgeDirection;
        const settingVal = edgeDirection === 'parent-to-child' ? 'inverse' : 'dependency';
        vscode.postMessage({ type: 'updateSetting', key: 'graphEdgeDirection', value: settingVal });
        // If in focus mode, rebuild subgraph with new direction
        if (focusedNodeId) {
            focusVisibleIds = buildConnectedSubgraph(focusedNodeId);
        }
        restartSimIfEnabled();
        draw();
    });

    // Auto-pause checkbox
    const autoPauseCheck = settingsPanel.querySelector('#s-autoPause') as HTMLInputElement;
    autoPauseCheck.addEventListener('change', () => {
        autoPauseDuringDrag = autoPauseCheck.checked;
        vscode.postMessage({ type: 'updateSetting', key: 'graphAutoPauseDrag', value: autoPauseDuringDrag });
    });

    // Minimap checkbox
    const minimapCheck = settingsPanel.querySelector('#s-minimap') as HTMLInputElement;
    minimapCheck.addEventListener('change', () => {
        minimapEnabled = minimapCheck.checked;
        vscode.postMessage({ type: 'updateSetting', key: 'graphMinimap', value: minimapEnabled });
        draw();
    });

    // Sliders
    const sliders: [string, string, (v: number) => void][] = [
        ['s-repulsion', 'v-repulsion', v => { simRepulsion = v; }],
        ['s-attraction', 'v-attraction', v => { simAttraction = v; }],
        ['s-gravity', 'v-gravity', v => { simGravity = v; }],
        ['s-linkLength', 'v-linkLength', v => { simLinkLength = v; }],
        ['s-minDist', 'v-minDist', v => { simMinDistance = v; }],
        ['s-steps', 'v-steps', v => { simStepsPerFrame = Math.round(v); }],
        ['s-threshold', 'v-threshold', v => { simThreshold = v; }],
        ['s-damping', 'v-damping', v => { simDamping = v; }],
        ['s-taperedWidth', 'v-taperedWidth', v => { taperedWidthFactor = v; }],
    ];

    for (const [sliderId, valueId, setter] of sliders) {
        const slider = settingsPanel.querySelector(`#${sliderId}`) as HTMLInputElement | null;
        const valueSpan = settingsPanel.querySelector(`#${valueId}`) as HTMLSpanElement | null;
        if (!slider || !valueSpan) { continue; }
        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            setter(v);
            valueSpan.textContent = String(v);
            const settingKey = sliderSettingKeys[sliderId];
            if (settingKey) {
                vscode.postMessage({ type: 'updateSetting', key: settingKey, value: v });
            }
            startSimulation();
        });
    }

    // Reset buttons (one per param)
    settingsPanel.querySelectorAll('.settings-reset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).dataset.reset!;
            const def = parseFloat((btn as HTMLElement).dataset.default!);
            const slider = settingsPanel!.querySelector(`#s-${id}`) as HTMLInputElement;
            const valueSpan = settingsPanel!.querySelector(`#v-${id}`) as HTMLSpanElement;
            slider.value = String(def);
            valueSpan.textContent = String(def);
            const match = sliders.find(s => s[0] === `s-${id}`);
            if (match) { match[2](def); }
            const settingKey = sliderSettingKeys[`s-${id}`];
            if (settingKey) {
                vscode.postMessage({ type: 'updateSetting', key: settingKey, value: def });
            }
            startSimulation();
        });
    });

    // Node color pickers
    const presentTypes = new Set(allNodes.map(n => n.type));
    for (const type of presentTypes) {
        const picker = settingsPanel?.querySelector(`#s-color-${type}`) as HTMLInputElement | null;
        if (!picker) { continue; }
        picker.addEventListener('input', () => {
            const newColor = picker.value;
            for (const n of allNodes) {
                if (n.type === type) { n.color = newColor; }
            }
            draw();
            buildFilterCheckboxes();
            // Persist all node colors as an object
            const colorMap: Record<string, string> = {};
            for (const t of presentTypes) {
                const node = allNodes.find(n => n.type === t);
                if (node) { colorMap[t] = node.color; }
            }
            vscode.postMessage({ type: 'updateSetting', key: 'graphNodeColors', value: colorMap });
        });
    }

    // Start/Stop simulation
    const startStopBtn = settingsPanel.querySelector('#s-startstop') as HTMLButtonElement;
    startStopBtn.addEventListener('click', () => {
        if (simEnabled) {
            // User wants to stop
            simEnabled = false;
            stopSimulation();
        } else {
            // User wants to start
            simEnabled = true;
            startSimulation();
        }
        updateStartStopBtn();
        vscode.postMessage({ type: 'updateSetting', key: 'graphSimEnabled', value: simEnabled });
    });

    // Restart simulation (reset positions)
    settingsPanel.querySelector('#s-restart')!.addEventListener('click', () => {
        simEnabled = true;
        resetLayoutPositions();
        updateStartStopBtn();
        vscode.postMessage({ type: 'updateSetting', key: 'graphSimEnabled', value: simEnabled });
    });

    // Fit to View
    settingsPanel.querySelector('#s-fitview')!.addEventListener('click', () => {
        centerOnNodes();
        draw();
    });

    // Screenshot
    settingsPanel.querySelector('#s-screenshot')!.addEventListener('click', takeScreenshot);
}

// ------------------------------------------------------------
// Screenshot
// ------------------------------------------------------------
function takeScreenshot(): void {
    if (!canvas) { return; }
    const dataUri = canvas.toDataURL('image/png');
    vscode.postMessage({ type: 'saveScreenshot', dataUri });
}

// ------------------------------------------------------------
// Apply settings received from the provider (workspace settings)
// ------------------------------------------------------------
function applySettingsFromProvider(s: any): void {
    if (s.edgeDirection !== undefined) {
        edgeDirection = s.edgeDirection === 'inverse' ? 'parent-to-child' : 'child-to-parent';
    }
    if (s.edgeStyle !== undefined) { edgeStyle = s.edgeStyle as typeof edgeStyle; }
    if (s.taperedWidth !== undefined) { taperedWidthFactor = s.taperedWidth; }
    if (s.simRepulsion !== undefined) { simRepulsion = s.simRepulsion; }
    if (s.simAttraction !== undefined) { simAttraction = s.simAttraction; }
    if (s.simGravity !== undefined) { simGravity = s.simGravity; }
    if (s.simLinkLength !== undefined) { simLinkLength = s.simLinkLength; }
    if (s.simMinDistance !== undefined) { simMinDistance = s.simMinDistance; }
    if (s.simStepsPerFrame !== undefined) { simStepsPerFrame = s.simStepsPerFrame; }
    if (s.simThreshold !== undefined) { simThreshold = s.simThreshold; }
    if (s.simDamping !== undefined) { simDamping = s.simDamping; }
    if (s.minimap !== undefined) { minimapEnabled = s.minimap; }
    if (s.autoPauseDrag !== undefined) { autoPauseDuringDrag = s.autoPauseDrag; }
    if (s.simEnabled !== undefined) { simEnabled = s.simEnabled; }
    if (s.settingsCollapse !== undefined) { settingsCollapseState = s.settingsCollapse; }
    if (s.settingsVisible !== undefined) { settingsPanelVisible = s.settingsVisible; }
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
            for (const ln of layoutNodes) { ln.vx = 0; ln.vy = 0; }
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
function getCssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function darken(hex: string): string {
    return adjustBrightness(hex, -0.3);
}

function adjustBrightness(hex: string, factor: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const adj = (c: number) => Math.max(0, Math.min(255, Math.round(c + c * factor)));
    return `#${adj(r).toString(16).padStart(2, '0')}${adj(g).toString(16).padStart(2, '0')}${adj(b).toString(16).padStart(2, '0')}`;
}

/** Returns '#000000' or '#ffffff' depending on which has better contrast */
function contrastTextColor(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
vscode.postMessage({ type: 'ready' });

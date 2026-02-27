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
    repulsion: 50000,
    attraction: 0.1,
    gravity: 0.001,
    linkLength: 0.1, // ideal link length smaller = stronger spring
    minDistance: 5000,
    stepsPerFrame: 5,
    threshold: 0.1,
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
// State persistence (camera + settings, survives refresh)
// ------------------------------------------------------------
interface PersistedState {
    camX?: number;
    camY?: number;
    zoom?: number;
    edgeStyle?: string;
    simRepulsion?: number;
    simAttraction?: number;
    simGravity?: number;
    simLinkLength?: number;
    simMinDistance?: number;
    simStepsPerFrame?: number;
    simThreshold?: number;
    simDamping?: number;
}

function saveState(): void {
    vscode.setState({
        camX, camY, zoom, edgeStyle,
        simRepulsion, simAttraction, simGravity, simLinkLength,
        simMinDistance, simStepsPerFrame, simThreshold, simDamping,
    } as PersistedState);
}

function restoreState(): boolean {
    const s = vscode.getState() as PersistedState | undefined;
    if (!s || s.camX === undefined) { return false; }
    camX = s.camX;
    camY = s.camY!;
    zoom = s.zoom!;
    if (s.edgeStyle) { edgeStyle = s.edgeStyle as typeof edgeStyle; }
    if (s.simRepulsion !== undefined) { simRepulsion = s.simRepulsion; }
    if (s.simAttraction !== undefined) { simAttraction = s.simAttraction; }
    if (s.simGravity !== undefined) { simGravity = s.simGravity; }
    if (s.simLinkLength !== undefined) { simLinkLength = s.simLinkLength; }
    if (s.simMinDistance !== undefined) { simMinDistance = s.simMinDistance; }
    if (s.simStepsPerFrame !== undefined) { simStepsPerFrame = s.simStepsPerFrame; }
    if (s.simThreshold !== undefined) { simThreshold = s.simThreshold; }
    if (s.simDamping !== undefined) { simDamping = s.simDamping; }
    return true;
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
        if (!activeFilters.has(ln.node.type)) {
            nodeMap.set(ln.node.id, ln);
        }
    }

    const selNode = selectedNodeId ? nodeMap.get(selectedNodeId) : null;
    const selColor = selNode?.node.color ?? null;

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

        drawEdgeStyled(ctx, x1, y1, x2, y2, 'rgba(255, 255, 255, 0.15)');
    }

    // Highlighted edges
    if (selColor) {
        for (const edge of allEdges) {
            const isHighlighted = edge.from === selectedNodeId || edge.to === selectedNodeId;
            if (!isHighlighted) { continue; }
            const fromLn = nodeMap.get(edge.from);
            const toLn = nodeMap.get(edge.to);
            if (!fromLn || !toLn) { continue; }
            const [x1, y1] = worldToScreen(fromLn.x, fromLn.y);
            const [x2, y2] = worldToScreen(toLn.x, toLn.y);
            drawEdgeStyled(ctx, x1, y1, x2, y2, selColor, 0.6);
        }
    }
}

/** Dispatch to the correct edge style, respecting edge direction */
function drawEdgeStyled(
    c: CanvasRenderingContext2D,
    x1: number, y1: number, x2: number, y2: number,
    color: string, alpha = 1,
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
    color: string, alpha = 1,
): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 2) { return; }

    const px = -dy / len;
    const py = dx / len;

    const wideHalf = Math.max(1.5, 3 * zoom);
    const narrowHalf = Math.max(0.3, 0.5 * zoom);

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
    color: string, alpha = 1,
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
    color: string, alpha = 1,
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

    for (const ln of layoutNodes) {
        if (activeFilters.has(ln.node.type)) { continue; }

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

        const color = ln.node.color;
        const borderColor = darken(color);

        const zoom2 = 2 * zoom;
        const zoom3 = 3 * zoom;
        const zoom4 = 4 * zoom;

        ctx.fillStyle = color;
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = Math.max(1, zoom2);
        const r = Math.min(zoom4, sw * 0.08);
        drawBox(ctx, sx, sy, sw, sh, r);

        // Selection border
        if (ln.node.id === selectedNodeId) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(2, zoom3);
            drawBox(ctx, sx, sy, sw + zoom4, sh + zoom4, r + zoom2, true);
        }

        if (fontSize <= minFontSize) { continue; }

        // Label with auto contrast
        const textColor = contrastTextColor(color);
        ctx.fillStyle = textColor;
        ctx.font = `bold ${fontSize}px ${getCssVar('--vscode-font-family') || 'monospace'}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ln.node.label, sx, sy);
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
// Hit testing
// ------------------------------------------------------------
function hitTestNode(screenX: number, screenY: number): LayoutNode | null {
    for (let i = layoutNodes.length - 1; i >= 0; i--) {
        const ln = layoutNodes[i];
        if (activeFilters.has(ln.node.type)) { continue; }
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

        const hit = hitTestNode(mx, my);
        if (hit) {
            isDraggingNode = true;
            dragNode = hit;
            selectedNodeId = hit.node.id;
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
        const hit = hitTestNode(mx, my);
        if (hit) {
            vscode.postMessage({ type: 'nodeDoubleClick', targetId: hit.node.id });
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

        // Repulsion between all pairs (Coulomb)
        for (let i = 0; i < n; i++) {
            if (activeFilters.has(layoutNodes[i].node.type)) { continue; }
            for (let j = i + 1; j < n; j++) {
                if (activeFilters.has(layoutNodes[j].node.type)) { continue; }
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
            if (activeFilters.has(layoutNodes[fi].node.type)) { continue; }
            if (activeFilters.has(layoutNodes[ti].node.type)) { continue; }
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
            if (activeFilters.has(layoutNodes[i].node.type)) { continue; }
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
            if (activeFilters.has(layoutNodes[i].node.type)) { continue; }
            // Don't move the node being dragged
            if (isDraggingNode && dragNode === layoutNodes[i]) { continue; }

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
    const legendH = document.getElementById('legend')?.offsetHeight ?? 0;
    const available = window.innerHeight - toolbarH - legendH;
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

    if (allNodes.length === 0) {
        document.getElementById('graph-container')!.style.display = 'none';
        emptyMsg.style.display = 'flex';
        emptyMsg.textContent = 'No targets to display';
        buildFilterCheckboxes();
        buildLegend();
        return;
    }

    initLayoutNodes(allNodes);
    buildFilterCheckboxes();
    buildLegend();
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
    centerOnNodes();
    draw();
    startSimulation();
}

function centerOnNodes(): void {
    if (!canvas || layoutNodes.length === 0) { return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;
    for (const ln of layoutNodes) {
        if (activeFilters.has(ln.node.type)) { continue; }
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
// Legend
// ------------------------------------------------------------
function buildLegend(): void {
    const container = document.getElementById('legend')!;
    container.innerHTML = '';
    const presentTypes = new Set(allNodes.map(n => n.type));
    for (const type of TARGET_TYPES) {
        if (!presentTypes.has(type)) { continue; }
        const color = allNodes.find(n => n.type === type)?.color ?? '#ccc';
        const item = document.createElement('div');
        item.className = 'legend-item';
        const swatch = document.createElement('span');
        swatch.className = 'legend-swatch';
        swatch.style.background = color;
        item.appendChild(swatch);
        item.appendChild(document.createTextNode(type));
        container.appendChild(item);
    }
}

// ------------------------------------------------------------
// Settings panel
// ------------------------------------------------------------
let settingsPanel: HTMLDivElement | null = null;

function toggleSettings(): void {
    if (settingsPanel) {
        settingsPanel.remove();
        settingsPanel = null;
        return;
    }
    settingsPanel = document.createElement('div');
    settingsPanel.id = 'settings-panel';
    settingsPanel.innerHTML = buildSettingsHtml();
    document.body.appendChild(settingsPanel);
    attachSettingsEvents();
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

function buildSettingsHtml(): string {
    return `
<div class="settings-header">
    <span>Graph Settings</span>
    <button id="settings-close" title="Close">\u2715</button>
</div>
<div class="settings-body">
    <div class="settings-section">
        <div class="settings-title">Edges</div>
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
    </div>
    <div class="settings-section">
        <div class="settings-title">Force Simulation</div>
        ${sliderRow('repulsion', 'Repulsion', 500, 100000, 500, simRepulsion, SIM_DEFAULTS.repulsion)}
        ${sliderRow('attraction', 'Attraction', 0.0001, 0.1, 0.001, simAttraction, SIM_DEFAULTS.attraction)}
        ${sliderRow('gravity', 'Gravity', 0.001, 0.2, 0.001, simGravity, SIM_DEFAULTS.gravity)}
        ${sliderRow('linkLength', 'Link Length', 0.001, 1.0, 0.001, simLinkLength, SIM_DEFAULTS.linkLength)}
        ${sliderRow('minDist', 'Min Distance', 20, 100000, 10, simMinDistance, SIM_DEFAULTS.minDistance)}
        ${sliderRow('steps', 'Steps/Frame', 1, 10, 1, simStepsPerFrame, SIM_DEFAULTS.stepsPerFrame)}
        ${sliderRow('threshold', 'Threshold', 0.001, 5, 0.001, simThreshold, SIM_DEFAULTS.threshold)}
        ${sliderRow('damping', 'Damping', 0.5, 1.0, 0.01, simDamping, SIM_DEFAULTS.damping)}
        <label class="settings-checkbox"><input type="checkbox" id="s-autoPause"${autoPauseDuringDrag ? ' checked' : ''}> Auto-pause sim during node drag</label>
    </div>
    <div class="settings-section">
        <div class="settings-title">Controls</div>
        <button id="s-startstop" class="settings-btn">${simEnabled ? '\u23F8 Stop Simulation' : '\u25B6 Start Simulation'}</button>
        <button id="s-restart" class="settings-btn">\u21BA Restart Simulation</button>
        <button id="s-fitview" class="settings-btn">\u2922 Fit to View</button>
        <button id="s-screenshot" class="settings-btn">\uD83D\uDCF7 Screenshot (PNG)</button>
    </div>
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

    settingsPanel.querySelector('#settings-close')!.addEventListener('click', toggleSettings);

    // Edge style
    const edgeSel = settingsPanel.querySelector('#s-edgeStyle') as HTMLSelectElement;
    edgeSel.addEventListener('change', () => {
        edgeStyle = edgeSel.value as typeof edgeStyle;
        saveState();
        draw();
    });

    // Edge direction
    const dirSel = settingsPanel.querySelector('#s-edgeDirection') as HTMLSelectElement;
    dirSel.addEventListener('change', () => {
        edgeDirection = dirSel.value as typeof edgeDirection;
        // Save to VS Code workspace settings
        vscode.postMessage({ type: 'updateSetting', key: 'graphEdgeDirection', value: edgeDirection });
        draw();
    });

    // Auto-pause checkbox
    const autoPauseCheck = settingsPanel.querySelector('#s-autoPause') as HTMLInputElement;
    autoPauseCheck.addEventListener('change', () => {
        autoPauseDuringDrag = autoPauseCheck.checked;
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
    ];

    for (const [sliderId, valueId, setter] of sliders) {
        const slider = settingsPanel.querySelector(`#${sliderId}`) as HTMLInputElement;
        const valueSpan = settingsPanel.querySelector(`#${valueId}`) as HTMLSpanElement;
        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            setter(v);
            valueSpan.textContent = String(v);
            saveState();
            startSimulation(); // respects simEnabled
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
            saveState();
            startSimulation();
        });
    });

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
    });

    // Restart simulation (reset positions)
    settingsPanel.querySelector('#s-restart')!.addEventListener('click', () => {
        simEnabled = true;
        resetLayoutPositions();
        updateStartStopBtn();
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
// Message listener
// ------------------------------------------------------------
window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data;
    switch (msg.type) {
        case 'update': {
            if (msg.edgeDirection) {
                edgeDirection = msg.edgeDirection as typeof edgeDirection;
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

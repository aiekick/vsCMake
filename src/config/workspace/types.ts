
export namespace WorkspaceConfig {
    export namespace Graph {
        export enum EdgeDirection {
            USED_BY_TARGETS = 'usedByTargets',
            TARGETS_USED_BY = 'targetsUsedBy',
        }
        export enum EdgeStyle {
            TAPERED = 'tapered',
            CHEVRONS = 'chevronsy',
            LINE = 'line',
        }
    }
    export interface Settings {
        readonly general: {
            readonly buildDirectory: string;
            readonly configType: string;
        };
        readonly graph: {
            readonly colors: {
                readonly targetExecutable: string;
                readonly targetLibraryShared: string;
                readonly targetLibraryStatic: string;
                readonly targetLibraryInterface: string;
                readonly targetLibraryModule: string;
                readonly targetLibraryImported: string;
                readonly targetLibrarySystem: string;
            };
            readonly edges: {
                readonly edgeDirection: Graph.EdgeDirection; // edge direction can be "usedByTargets" or "targetsUsedBy"
                readonly edgeStyle: Graph.EdgeStyle; // edge styles  can be "tapered", "chevrons" or "line"
                readonly taperedWidth: number; // width of the tapered end of edges, in pixels
            };
            readonly simulation: {
                readonly params: {
                    readonly repulsion: number; // node repulsion strength: higher = stronger push away
                    readonly attraction: number; // edge attraction strength: higher = stronger pull together
                    readonly gravity: number;// gravity strength: higher = stronger pull towards center, prevents drifting apart
                    readonly linkLength: number;// ideal link length smaller = stronger spring
                    readonly minDistance: number; // minimum distance for repulsion to avoid extreme forces at close range
                    readonly stepsPerFrame: number; // how many simulation steps to run per animation frame, higher = faster convergence but more CPU usage
                    readonly threshold: number; // when to stop the simulation: if max node movement is below this, we consider it "converged" and stop until next interaction
                    readonly damping: number; // velocity damping factor: between 0 and 1, higher = quicker stop but can cause jitter, lower = longer settling time but smoother
                };
                readonly controls: {
                    readonly minimap: boolean; // whether to show a minimap overview of the graph
                    readonly autoPauseDrag: boolean; // whether to automatically pause the simulation while dragging nodes
                    readonly simEnabled: boolean; // master switch to enable/disable the simulation (force-directed layout)
                    readonly settingsCollapse: Record<string, boolean>; // which settings sections are collapsed in the UI (edges, colors, simulation, display, controls)
                    readonly settingsVisible: boolean; // whether the settings panel is visible
                };
            };
        };
    };
}

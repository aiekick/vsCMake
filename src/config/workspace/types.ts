
export namespace WorkspaceConfig {
    export namespace Graph {
        export enum EdgeDirection {
            USED_BY_TARGETS = 'inverse',
            TARGETS_USED_BY = 'dependency',
        }
        export enum EdgeStyle {
            TAPERED = 'tapered',
            CHEVRONS = 'chevrons',
            LINE = 'line',
        }
    }
    export interface Settings {
        readonly general: {
            readonly buildDirectory: string;
            readonly configType: string;
        };
        readonly graph: {
            readonly colors: Readonly<Record<string, string>>;
            readonly edges: {
                readonly edgeDirection: Graph.EdgeDirection;
                readonly edgeStyle: Graph.EdgeStyle;
                readonly taperedWidth: number;
            };
            readonly simulation: {
                readonly params: {
                    readonly repulsion: number;
                    readonly attraction: number;
                    readonly gravity: number;
                    readonly linkLength: number;
                    readonly minDistance: number;
                    readonly stepsPerFrame: number;
                    readonly threshold: number;
                    readonly damping: number;
                };
                readonly controls: {
                    readonly minimap: boolean;
                    readonly autoPauseDrag: boolean;
                    readonly simEnabled: boolean;
                    readonly settingsCollapse: Record<string, boolean>;
                    readonly settingsVisible: boolean;
                };
            };
        };
    };
}

// Re-export for backward compatibility (used by webview and graph_provider)
export type GraphEdgeDirection = WorkspaceConfig.Graph.EdgeDirection;
export const GraphEdgeDirection = WorkspaceConfig.Graph.EdgeDirection;

import { WorkspaceConfig as WorkspaceTypes } from './types';

// Default values for workspace (per-project) settings
// Aligned with package.json "contributes.configuration.properties"
export const WorkspaceConfigDefault: WorkspaceTypes.Settings = {
    general: {
        buildDirectory: '${workspaceFolder}/build',
        configType: 'Release',
    },
    graph: {
        colors: {
            EXECUTABLE: '#7f5be3',
            STATIC_LIBRARY: '#2196F3',
            SHARED_LIBRARY: '#52ff67',
            MODULE_LIBRARY: '#9C27B0',
            OBJECT_LIBRARY: '#cf6eff',
            INTERFACE_LIBRARY: '#00BCD4',
            SYSTEM_LIBRARY: '#c8ea32',
            UTILITY: '#795548',
        },
        edges: {
            edgeDirection: WorkspaceTypes.Graph.EdgeDirection.TARGETS_USED_BY,
            edgeStyle: WorkspaceTypes.Graph.EdgeStyle.TAPERED,
            taperedWidth: 1.0,
        },
        simulation: {
            params: {
                repulsion: 10000,
                attraction: 0.05,
                gravity: 0.002,
                linkLength: 0.1,
                minDistance: 1000,
                stepsPerFrame: 2,
                threshold: 0.5,
                damping: 0.85,
            },
            controls: {
                minimap: true,
                autoPauseDrag: false,
                simEnabled: true,
                settingsCollapse: { edges: false, colors: true, simulation: true, display: false, controls: false },
                settingsVisible: false,
            },
        },
    },
};

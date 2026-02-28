// On importe le namespace sous un autre nom (ex: AppTypes)
import { WorkspaceConfig as WorkspaceTypes } from './types';

export const WorkspaceConfigDefault: WorkspaceTypes.Settings = {
    general: {
        buildDirectory: 'dist',
        configType: 'debug',
    },
    graph: {
        colors: {
            targetExecutable: '#ff4444',
            targetLibraryShared: '#44ff44',
            targetLibraryStatic: '#4444ff',
            targetLibraryInterface: '#ffff44',
            targetLibraryModule: '#ff44ff',
            targetLibraryImported: '#44ffff',
            targetLibrarySystem: '#888888',
        },
        edges: {
            edgeDirection: WorkspaceTypes.Graph.EdgeDirection.USED_BY_TARGETS,
            edgeStyle: WorkspaceTypes.Graph.EdgeStyle.TAPERED,
            taperedWidth: 10,
        },
        simulation: {
            params: {
                repulsion: 1000,
                attraction: 0.1,
                gravity: 0.05,
                linkLength: 50,
                minDistance: 10,
                stepsPerFrame: 1,
                threshold: 0.1,
                damping: 0.9,
            },
            controls: {
                minimap: true,
                autoPauseDrag: true,
                simEnabled: true,
                settingsCollapse: { edges: false, colors: true },
                settingsVisible: true,
            },
        },
    },
};

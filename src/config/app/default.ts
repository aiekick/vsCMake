import { AppConfig as AppTypes } from './types';

// Default values for application-level (global) settings
// Aligned with package.json "contributes.configuration.properties"
export const AppConfigDefault: AppTypes.Settings = {
    cmakePath: 'cmake',
    ctestPath: 'ctest',
    cpackPath: 'cpack',
    clearOutputBeforeRun: true,
    colorizeOutput: true,
    defaultJobs: 0,
};

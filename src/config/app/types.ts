
export namespace AppConfig {
    export interface Settings {
        readonly cmakePath: string;
        readonly ctestPath: string;
        readonly cpackPath: string;
        readonly clearOutputBeforeRun: boolean;
        readonly colorizeOutput: boolean;
        readonly defaultJobs: number;
    };
}

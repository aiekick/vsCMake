// ============================================================
// CMake File-Based API v1 — Types
// https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html
// ============================================================

// ------------------------------------------------------------
// Index
// ------------------------------------------------------------

export interface Index {
    cmake: {
        version: {
            major: number;
            minor: number;
            patch: number;
            suffix: string;
            string: string;
            isDirty: boolean;
        };
        paths: {
            cmake: string;
            ctest: string;
            cpack: string;
            root: string;
        };
    };
    objects: IndexObject[];
    reply: Record<string, ReplyRef>;
}

export interface IndexObject {
    kind: 'codemodel' | 'cache' | 'cmakeFiles' | 'toolchains';
    version: { major: number; minor: number };
    jsonFile: string;
}

export interface ReplyRef {
    kind: string;
    version: { major: number; minor: number };
    jsonFile: string;
}

// ------------------------------------------------------------
// Codemodel v2
// ------------------------------------------------------------

export interface Codemodel {
    kind: 'codemodel';
    version: { major: number; minor: number };
    paths: {
        source: string;
        build: string;
        cmake: string;
    };
    configurations: Configuration[];
}

export interface Configuration {
    name: string; // "Debug", "Release", ""...
    directories: Directory[];
    projects: Project[];
    targets: TargetRef[];
}

export interface Directory {
    source: string;
    build: string;
    parent?: number;         // index in directories[]
    children?: number[];
    project: number;         // index in projects[]
    hasInstallRule?: boolean;
    minimumCMakeVersion?: string;
}

export interface Project {
    name: string;
    parent?: number;
    children?: number[];
    directories: number[];
    targets?: number[];
}

export interface TargetRef {
    name: string;
    id: string;
    directoryIndex: number;
    projectIndex: number;
    jsonFile: string;
}

// ------------------------------------------------------------
// Target
// ------------------------------------------------------------

export type TargetType =
    | 'EXECUTABLE'
    | 'STATIC_LIBRARY'
    | 'SHARED_LIBRARY'
    | 'MODULE_LIBRARY'
    | 'OBJECT_LIBRARY'
    | 'INTERFACE_LIBRARY'
    | 'UTILITY';

export interface Target {
    name: string;
    id: string;
    type: TargetType;
    backtrace?: number;
    folder?: { name: string };
    paths: {
        source: string;
        build: string;
    };
    nameOnDisk?: string;        // name of the produced file (libfoo.a, foo.exe...)
    artifacts?: Artifact[];
    isGeneratorProvided?: boolean;
    install?: Install;
    link?: Link;
    archive?: Archive;
    dependencies?: Dependency[];
    sources: Source[];
    sourceGroups?: SourceGroup[];
    compileGroups?: CompileGroup[];
    backtraceGraph?: BacktraceGraph;
}

export interface Artifact {
    path: string;
}

export interface Install {
    prefix: { path: string };
    destinations: InstallDestination[];
}

export interface InstallDestination {
    path: string;
    backtrace?: number;
}

export interface Link {
    language: string;
    commandFragments?: CommandFragment[];
    lto?: boolean;
    sysroot?: { path: string };
}

export interface Archive {
    commandFragments?: CommandFragment[];
    lto?: boolean;
}

export interface CommandFragment {
    fragment: string;
    role: 'flags' | 'libraries' | 'libraryPath' | 'frameworkPath';
}

export interface Dependency {
    id: string;
    backtrace?: number;
}

export interface Source {
    path: string;
    compileGroupIndex?: number;  // index in compileGroups[]
    sourceGroupIndex?: number;   // index in sourceGroups[]
    isGenerated?: boolean;
    backtrace?: number;
}

export interface SourceGroup {
    name: string;                // "Source Files", "Header Files", ""...
    sourceIndexes: number[];     // indexes in sources[]
}

export interface CompileGroup {
    sourceIndexes: number[];
    language: string;            // "C", "CXX", "CUDA"...
    languageStandard?: {
        backtraces?: number[];
        standard: string;          // "17", "20"...
    };
    compileCommandFragments?: { fragment: string }[];
    includes?: Include[];
    precompileHeaders?: PrecompileHeader[];
    defines?: Define[];
    sysroot?: { path: string };
}

export interface Include {
    path: string;
    isSystem?: boolean;
    backtrace?: number;
}

export interface PrecompileHeader {
    header: string;
    backtrace?: number;
}

export interface Define {
    define: string;             // "FOO=1" ou "BAR"
    backtrace?: number;
}

export interface BacktraceGraph {
    nodes: BacktraceNode[];
    commands: string[];
    files: string[];
}

export interface BacktraceNode {
    file: number;
    line?: number;
    command?: number;
    parent?: number;
}

// ------------------------------------------------------------
// Cache v2
// ------------------------------------------------------------

export interface CacheReply {
    kind: 'cache';
    version: { major: number; minor: number };
    entries: CacheEntry[];
}

export type CacheEntryType =
    | 'BOOL'
    | 'FILEPATH'
    | 'PATH'
    | 'STRING'
    | 'INTERNAL'
    | 'STATIC'
    | 'UNINITIALIZED';

export interface CacheEntry {
    name: string;
    value: string;
    type: CacheEntryType;
    properties: {
        HELPSTRING?: string;
        ADVANCED?: string;      // "1" or absent
        STRINGS?: string;       // possible values separated by ";"
        [key: string]: string | undefined;
    };
}

// ------------------------------------------------------------
// CmakeFiles v1
// ------------------------------------------------------------

export interface CmakeFilesReply {
    kind: 'cmakeFiles';
    version: { major: number; minor: number };
    paths: {
        source: string;
        build: string;
        cmake: string;
    };
    inputs: CmakeFileInput[];
}

export interface CmakeFileInput {
    path: string;
    isGenerator?: boolean;
    isCMake?: boolean;
    isExternal?: boolean;
    cmakeListsFile?: boolean;
}

// ------------------------------------------------------------
// Toolchains v1
// ------------------------------------------------------------

export interface ToolchainsReply {
    kind: 'toolchains';
    version: { major: number; minor: number };
    toolchains: Toolchain[];
}

export interface Toolchain {
    language: string;
    compiler: {
        id?: string;
        version?: string;
        path?: string;
        implicit?: {
            includeDirectories?: string[];
            linkDirectories?: string[];
            linkLibraries?: string[];
            linkFrameworkDirectories?: string[];
        };
    };
    sourceFileExtensions?: string[];
}

// ------------------------------------------------------------
// CTest — ctest --show-only=json-v1
// ------------------------------------------------------------

export interface CtestBacktraceNode {
    file: number;
    command?: number;
    line?: number;
    parent?: number;
}

export interface CtestBacktraceGraph {
    commands: string[];
    files: string[];
    nodes: CtestBacktraceNode[];
}

export interface CtestProperty {
    name: string;
    value: unknown;
}

export interface CtestTestInfo {
    name: string;
    config?: string;
    command?: string[];
    backtrace: number;
    properties?: CtestProperty[];
}

export interface CtestShowOnlyResult {
    kind: 'ctestInfo';
    version: { major: number; minor: number };
    backtraceGraph: CtestBacktraceGraph;
    tests: CtestTestInfo[];
}
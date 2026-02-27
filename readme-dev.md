# vsCMake -- Developer Guide

This document describes the internal architecture of vsCMake and the procedures for developing, debugging and packaging the extension.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Visual Studio Code](https://code.visualstudio.com/) >= 1.80.0
- (optional) [`vsce`](https://github.com/microsoft/vscode-vsce) for packaging via the standard method

```bash
npm install -g @vscode/vsce
```

## Getting Started

```bash
git clone https://github.com/aiekick/vscmake.git
cd vscmake
npm install --save-dev typescript @types/vscode --ignore-scripts
```

## Available Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `npm run compile` | `tsc -p ./` | Compile TypeScript to `out/` (development) |
| `npm run watch` | `tsc -watch -p ./` | Continuous compilation on save |
| `npm run check` | `tsc --noEmit` | Type-check without emitting files |
| `npm run package` | `rm -rf out && node ./scripts/esbuild.js && node ./scripts/package.js` | Bundle with esbuild and produce VSIX |

## Running & Debugging in VS Code

The project ships with `.vscode/launch.json` and `.vscode/tasks.json` pre-configured.

1. Open the project folder in VS Code.
2. Press **F5** (or **Run > Start Debugging**).
3. This launches the `Extension` configuration which:
   - Runs the `npm: watch` background task (auto-compilation)
   - Opens a new VS Code window (**Extension Development Host**) with the extension loaded
4. Open a CMake project in the Extension Development Host to test.
5. Breakpoints in `src/` files work normally.
6. After modifying code, the watch task recompiles automatically. Reload the Extension Development Host with `Ctrl+Shift+F5` to pick up changes.

## Build & Packaging

### Development build (tsc)

During development, `npm run compile` (or `npm run watch`) uses the TypeScript compiler to produce individual `.js` files under `out/`. This preserves source maps and enables debugging.

### Production build (esbuild + custom packager)

`npm run package` performs a full production build:

1. **`scripts/esbuild.js`** bundles two entry points:
   - **Extension** (Node context): `src/extension.ts` → `out/extension.js` (CommonJS, externals: `vscode`)
   - **Webview** (Browser context): `src/webview/dependency_graph_webview.ts` → `out/webview/dependency_graph_webview.js` (IIFE, no externals)
   - In production mode: minified, no source maps
2. **`scripts/package.js`** creates the `.vsix` archive (ZIP format) containing:
   - `package.json`, `readme.md`, `changelog.md`, `LICENSE`
   - `out/` (bundled JavaScript)
   - `medias/` (CSS, icons)
   - `syntaxes/` (TextMate grammars)

This replaces `vsce package` with a custom packager that generates the `[Content_Types].xml` and `extension.vsixmanifest` files.

Install the produced VSIX via:
- VS Code: **Extensions > ... > Install from VSIX...**
- Command line: `code --install-extension vscmake-<version>.vsix`

## Icons

VS Code built-in icons (ThemeIcons) are used throughout the extension.

Reference: https://github.com/microsoft/vscode-icons

## Project Structure

```
vsCMake/
  src/
    extension.ts                          Main entry point (activate / deactivate)
    cmake/
      api_client.ts                       CMake File-Based API reader
      runner.ts                           cmake / ctest / cpack process execution
      types.ts                            TypeScript interfaces for CMake API JSON
      kit_scanner.ts                      Compiler detection (MSVC, GCC, Clang)
      msvc_env.ts                         Windows MSVC environment injection
      preset_reader.ts                    CMakePresets.json reader & evaluator
      preset_evaluator.ts                 Macro and condition evaluation
      cmake_diagnostics_manager.ts        Parse cmake output for errors/warnings
    providers/
      project_outline_provider.ts         Project Outline tree view
      config_provider.ts                  Configuration (cache) tree view
      impacted_targets_provider.ts        Impacted Targets tree view
      dependency_graph_provider.ts        Dependency Graph webview provider
      cmake_file_decoration_provider.ts   File decoration badges (E/W/D)
    webview/
      dependency_graph_webview.ts         Dependency Graph client-side code (Canvas2D)
      vscode.d.ts                         Type declarations for VS Code webview API
    misc/
      cmake_tools_api.ts                  CMake Tools extension integration
    watchers/
      reply_watcher.ts                    File watcher for CMake API replies
    syntaxes/
      output_coloration.tmLanguage.json   TextMate grammar for output panel
  medias/
    icon.svg                              Extension icon
    css/
      dependency_graph.css                Dependency Graph webview styles
  scripts/
    esbuild.js                            esbuild bundler configuration
    package.js                            Custom VSIX packager
  out/                                    Compiled/bundled JavaScript (git-ignored)
  package.json                            Extension manifest
  tsconfig.json                           TypeScript configuration
  .vscodeignore                           Files excluded from VSIX (used by vsce)
  LICENSE                                 MIT license
```

## Architecture Overview

### Data Flow

```
CMake File-Based API
        |
        v
  api_client.ts ---- loadAll() ----> CmakeReply { codemodel, targets[], cache, cmakeFiles }
        |
        v
  extension.ts ---- loadReply()
        |
        +---> outlineProvider.refresh()
        +---> configProvider.refresh(cache)
        +---> impactedProvider.refresh(targets, sourceDir)
        +---> graphProvider.refresh(targets)
        +---> refreshAvailableTests() ---> impactedProvider.setTestMap()
```

### CMake Tools Integration (`misc/cmake_tools_api.ts`)

`CMakeToolsIntegrationManager` listens for configure events from the official CMake Tools extension (if installed). When CMake Tools finishes a configure, vsCMake receives the build directory and build type, then calls `initBuildDir()` and `updateAllPanesWithConfig()` to refresh all panels automatically.

The manager handles reconnection when workspace folders change or when CMake Tools is activated after vsCMake.

### CMake File-Based API Integration (`api_client.ts`)

The extension communicates with CMake through its File-Based API (v1):

1. **Query phase**: `writeQueries()` creates empty request files in `<buildDir>/.cmake/api/v1/query/`:
   - `codemodel-v2` -- project structure, targets, configurations
   - `cache-v2` -- CMake cache variables
   - `cmakeFiles-v1` -- list of CMake input files
   - `toolchains-v1` -- compiler toolchain information

2. **Reply phase**: After `cmake --configure`, CMake writes JSON replies to `<buildDir>/.cmake/api/v1/reply/`. The `index-*.json` file references all reply objects.

3. **Loading**: `loadAll()` reads the latest index, then loads all referenced JSON files. Targets are loaded in parallel and deduplicated across configurations.

### Reply Watcher (`reply_watcher.ts`)

A `vscode.FileSystemWatcher` monitors `.cmake/api/v1/reply/index-*.json`. When a new index appears (after a configure), it fires `onDidReply` which triggers `loadReply()` in `extension.ts`, refreshing all providers.

### Runner (`runner.ts`)

Executes cmake, ctest and cpack as child processes:

- **Output**: streams stdout/stderr to a dedicated output channel (with optional TextMate colorization)
- **MSVC environment**: on Windows, resolves `vcvarsall.bat` automatically (from selected kit or auto-detected) and injects the environment variables into spawned processes
- **Diagnostics**: during configure, feeds output lines to `CMakeDiagnosticsManager` for error/warning parsing
- **Task tracking**: each running process is tracked as a `RunningTask` with cancel support (via `taskkill` on Windows, `SIGTERM` on Unix)
- **Silent mode**: discovery operations (test listing, etc.) run silently without showing output

Key methods:

| Method | Description |
|--------|-------------|
| `configure()` | `cmake --preset <p>` or `cmake -S <src> -B <build> -D...` |
| `build()` | `cmake --build --preset <p>` or `cmake --build <dir> --target <t>` |
| `buildTargets()` | Multi-target build (`--target A --target B`) |
| `cleanAndBuildTarget()` | `cmake --build <dir> --target <t> --clean-first` |
| `test()` | `ctest --preset <p>` or `ctest --test-dir <dir>` |
| `testFiltered()` | `ctest --test-dir <dir> -R ^<name>$` |
| `testByRegex()` | `ctest --test-dir <dir> -R <regex> --no-tests=ignore` |
| `listTests()` | `ctest --test-dir <dir> --show-only=json-v1` (silent) |

### Diagnostics Manager (`cmake_diagnostics_manager.ts`)

Parses CMake configure output line-by-line to extract diagnostics:

- Detects patterns: `CMake Error at <file>:<line> (<command>):`, `CMake Warning at ...`, `CMake Deprecation Warning at ...`, `CMake Warning (dev) at ...`
- Accumulates multi-line messages
- Creates `vscode.Diagnostic` entries for the Problems panel
- Notifies `CMakeFileDecorationProvider` to update file badges
- Clears previous diagnostics before each new configure

### Tree View Providers

Three tree views implement `vscode.TreeDataProvider<TreeNode>` with discriminated union node types.

#### ProjectOutlineProvider (`project_outline_provider.ts`)

- Builds a tree from the CMake codemodel: directories -> targets -> sources
- Each target has a "CMake Extras" sub-tree: includes, flags, defines, link flags, libraries, dependencies, cmake files
- Filter support: substring match on target name or type
- `findTargetNode()`: enables "Show in outline" navigation from dependencies

#### ConfigProvider (`config_provider.ts`)

- Groups cache entries by prefix (`CMAKE_`, `BUILD_`, etc.)
- Supports filter on name, value and `HELPSTRING`
- Each entry node carries the full `CacheEntry` for inline editing

#### ImpactedTargetsProvider (`impacted_targets_provider.ts`)

- **Dependency graph**: builds a reverse dependency map from `target.dependencies`
- **Transitive resolution**: BFS from each target to collect all dependents
- **File mapping**: for each target source file, stores all transitively impacted targets
- **Active file tracking**: listens to `onDidChangeActiveTextEditor`
- **Test separation**: uses `testsByTarget` map to split EXECUTABLE targets into Executables vs Tests sections
- **Test regex building**: `getTestRegex()` and `getTestSectionRegex()` group test names by first token (before `_`) to produce compact `ctest -R` patterns

### Dependency Graph (`dependency_graph_provider.ts` + `dependency_graph_webview.ts`)

The Dependency Graph is a webview-based panel that renders an interactive force-directed graph of CMake target dependencies using Canvas2D (no external visualization library at runtime).

#### Provider side (`dependency_graph_provider.ts`)

- Implements `vscode.WebviewViewProvider`
- Converts the target list into graph nodes (with color/shape per target type) and edges (from `target.dependencies`)
- Filters out UTILITY targets and CMake-generated targets (`ALL_BUILD`, `ZERO_CHECK`, etc.)
- Handles messages from the webview: node clicks (reveal in outline), double-clicks (open definition in CMakeLists.txt), screenshot export, settings updates
- Serves the webview HTML with CSP headers, referencing the bundled JS and CSS from `out/` and `medias/`

#### Webview side (`dependency_graph_webview.ts`)

Pure TypeScript compiled to a single IIFE bundle (via esbuild). Runs in the webview's browser context.

**Rendering:**
- Canvas2D-based with device pixel ratio support
- Grid background with origin cross
- Rectangular nodes with rounded corners, auto-contrast text color
- Three edge styles: tapered (triangle), chevrons (>>>), line
- Off-screen culling for both nodes and edges

**Interaction:**
- Pan: click & drag on background
- Zoom: mouse wheel (centered on cursor)
- Node drag: click & drag on a node
- Selection: click a node to highlight it and its edges
- Double-click node: sends message to open target definition
- Double-click background: fit graph to view (`centerOnNodes()`)

**Force simulation:**
- Repulsion (Coulomb), attraction on edges (Hooke), central gravity
- Configurable parameters: repulsion, attraction, gravity, min distance, steps/frame, threshold, damping
- Auto-stops when total movement drops below threshold
- Optional auto-pause during node drag

**Settings panel:**
- Edge style and direction selectors
- Simulation parameter sliders with per-parameter reset buttons
- Start/Stop, Restart, Fit to View, Screenshot buttons
- Auto-pause during drag checkbox

**State persistence:**
- Camera position, zoom, edge style and simulation parameters are saved via `vscode.setState()` / `vscode.getState()` and survive view refreshes

### CTest Discovery & Test-to-Target Mapping

After each configure, `refreshAvailableTests()` in `extension.ts`:

1. Runs `ctest --show-only=json-v1` (silently)
2. Parses the JSON to extract test names and properties
3. Builds a `Map<buildPath, targetName>` from all EXECUTABLE targets (resolving `target.paths.build` to absolute paths)
4. For each test, matches its `WORKING_DIRECTORY` property against the build path map to find the owning target
5. Produces a `Map<targetName, testNames[]>` passed to `impactedProvider.setTestMap()`

This allows the Impacted Targets view to:
- Show test executables in a dedicated **Tests** section (with beaker icon)
- Run all tests of a target with a single click (using a grouped regex)
- Run all tests of the entire Tests section

### Preset Reader (`preset_reader.ts` + `preset_evaluator.ts`)

Reads `CMakePresets.json` and `CMakeUserPresets.json`:

1. Loads JSON from source directory
2. Resolves recursive `include` directives (version >= 4)
3. Merges user presets over project presets
4. Evaluates `inherits` chains (single or array)
5. Expands macros: `${sourceDir}`, `${presetName}`, `${fileDir}`, `${pathListSep}`, `$env{VAR}`, `$penv{VAR}`
6. Evaluates conditions: `const`, `equals`, `notEquals`, `inList`, `notInList`, `matches`, `notMatches`, `anyOf`, `allOf`, `not`
7. Returns resolved `configurePresets`, `buildPresets`, `testPresets`, `packagePresets`

### Kit Scanner (`kit_scanner.ts` + `msvc_env.ts`)

Detects compilers on the system:

**Windows:**
- MSVC: uses `vswhere.exe` to find Visual Studio installations, extracts `cl.exe` paths for x64/x86/arm64
- GCC: searches `PATH` and user-provided extra paths for `gcc`/`g++`
- Clang: searches for `clang`/`clang++`
- Clang-cl: MSVC-compatible Clang variant

**Unix/Linux/macOS:**
- GCC: searches `PATH` and extra paths
- Clang: searches `PATH` and extra paths

A special `[Unspecified]` kit lets CMake auto-detect the compiler.

**MSVC environment injection** (`msvc_env.ts`):
- Runs `vcvarsall.bat <arch>` in a subprocess
- Captures the resulting environment variables
- Injects them into all spawned cmake/ctest/cpack processes
- Caches the resolved environment in `workspaceState` for faster subsequent launches
- Auto-detects `vcvarsall.bat` if no kit is selected but `cl.exe` is not in PATH

### Output Colorization (`output_coloration.tmLanguage.json`)

TextMate grammar for the `vscmake-output` language, applied to the output channel when `colorizeOutput` is `true`:

| Pattern | Scope | Visual |
|---------|-------|--------|
| `[25/105]` build progress | `constant.numeric.progress` | Numeric color |
| `Building CXX object` | `keyword.operator.action` | Keyword color |
| Language tokens (C, CXX, CUDA) | `entity.name.type.language` | Type color |
| File paths | `string.unquoted.filepath` | String color |
| Success messages | `string.success` | Green |
| Error messages | `invalid.illegal.error` | Red |
| CMake warnings | `markup.changed.warning` | Yellow |
| CMake status lines | `comment.line.cmake-status` | Comment color |
| Target names | `entity.name.function.target` | Function color |
| Cancellation | `markup.changed.cancelled` | Yellow |

### File Decoration Provider (`cmake_file_decoration_provider.ts`)

Decorates files and folders in the Explorer with diagnostic badges:

- **E** (red): CMake error at this file
- **W** (yellow): CMake warning
- **D** (yellow): CMake deprecation warning
- Parent directories propagate the highest severity from their children

## package.json Structure

### Views

Four views in the `vsCMake` activity bar container:

| View ID | Name | Type |
|---------|------|------|
| `vsCMakeOutline` | Project Outline | Tree view |
| `vsCMakeConfig` | Configuration | Tree view |
| `vsCMakeImpacted` | Impacted Targets | Tree view |
| `vsCMakeDependencyGraph` | Dependency Graph | Webview |

### Context Values

Context values control which inline buttons appear on each tree node:

**Impacted Targets:**
- `impactedSection_libraries` -- build, rebuild buttons
- `impactedSection_executables` -- build, rebuild, test buttons
- `impactedSection_tests` -- build, rebuild, test buttons
- `impactedTarget_EXECUTABLE` -- build, rebuild, test buttons
- `impactedTarget_TEST` -- build, rebuild, test buttons
- `impactedTarget_STATIC_LIBRARY` etc. -- build, rebuild buttons
- `impactedFilter` / `impactedFilterActive` -- filter / clear filter

**Project Outline:**
- `outlineTarget_<TYPE>` -- build, rebuild buttons
- `outlineFilter` / `outlineFilterActive` -- filter / clear filter
- `outlineCopyable` -- copy to clipboard
- `outlineExtras_<type>` -- copy entire section
- `outlineDependency` -- copy, show in outline

**Configuration:**
- `cmakeCacheEntry` -- edit button
- `cmakeCacheFilter` / `cmakeCacheFilterActive` -- filter / clear filter

### Commands

All commands are prefixed with `vsCMake.`. The full list is declared in `package.json` under `contributes.commands`. Key commands:

| Command | Title | Keybinding |
|---------|-------|------------|
| `configure` | Configure | `Ctrl+Shift+F7` |
| `build` | Build | `Ctrl+F7` |
| `clean` | Clean | -- |
| `test` | Test | -- |
| `buildTarget` | Build target | -- |
| `rebuildTarget` | Rebuild target (clean + build) | -- |
| `testImpactedTarget` | Run test | -- |
| `testImpactedSection` | Run all tests in section | -- |
| `cancelTask` | Cancel running task | -- |
| `refresh` | Refresh | -- |
| `filterImpacted` | Filter targets | -- |
| `filterOutline` | Filter targets | -- |
| `filterConfig` | Filter variables | -- |
| `toggleGraphLayout` | Toggle graph layout | -- |
| `graphSettings` | Graph settings | -- |
| `graphScreenshot` | Screenshot graph | -- |
| `refreshDependencyGraph` | Refresh dependency graph | -- |
| `openSettings` | Open extension settings | -- |

## TypeScript Configuration

From `tsconfig.json`:

- **Target**: ES2022
- **Module**: CommonJS
- **Strict mode**: enabled
- **Source maps**: enabled
- **Root**: `src/`
- **Output**: `out/`

## Dependencies

**Runtime dependencies:**
- `vis-data` ^8.0.3
- `vis-network` ^10.0.2

Dev dependencies:
- `@types/node` ^20.0.0
- `@types/vscode` ^1.80.0
- `typescript` ^5.9.3
- `esbuild` ^0.27.3

## Quick Reference

```bash
# Type-check without compiling
npm run check

# Compile once (development, with source maps)
npm run compile

# Watch mode (auto-compile on save)
npm run watch

# Bundle with esbuild and produce VSIX
npm run package

# Install VSIX locally
code --install-extension vscmake-<version>.vsix
```

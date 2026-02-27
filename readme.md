# vsCMake

CMake integration for VS Code via the **CMake File-Based API** -- no CMakeLists.txt parsing required.

![VS Code](https://img.shields.io/badge/VS%20Code-^1.80.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Philosophy

vsCMake takes a different approach from other CMake extensions: instead of parsing `CMakeLists.txt` files, it relies entirely on the [CMake File-Based API](https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html). This means vsCMake reads what CMake itself reports after a configure, giving you accurate project information regardless of how complex your CMake scripts are.

## Features

### Project Outline

A tree view of your project structure based on the CMake codemodel:

- Targets grouped by CMake folder structure (`set_property(GLOBAL PROPERTY USE_FOLDERS ON)`)
- Source files organized by source groups or directory structure
- Click any source file to open it in the editor
- Click any target to jump to its `add_executable`/`add_library` definition in CMakeLists.txt
- Build or rebuild individual targets directly from the outline via inline buttons
- **CMake Extras** sub-tree per target:
  - Include directories (user and system)
  - Compile flags and defines
  - Link flags
  - Linked libraries
  - Target dependencies (with "Show in outline" navigation)
  - CMake input files
- Copy individual items or entire sections to the clipboard via right-click menu
- Filter by target name or type

### Configuration Panel

Browse and edit CMake cache variables:

- Variables grouped by prefix (`CMAKE_`, `BUILD_`, etc.)
- Inline editing: booleans show ON/OFF picker, strings with `STRINGS` property show a dropdown, others show an input box
- Editing a variable triggers an automatic reconfigure with `-D`
- Filter by name, value, or help string

### Impacted Targets

Shows which targets are affected when the file you are currently editing changes.

- **Transitive dependency resolution**: if you edit a file in `libA`, and `libB` depends on `libA` while `app` depends on `libB`, all three targets appear
- Direct targets are shown normally; transitive ones are marked *(transitive)*
- Three sections:
  - **Libraries** -- static, shared, module, object and interface libraries
  - **Executables** -- non-test executable targets
  - **Tests** -- test executables identified via CTest discovery
- Per-target inline buttons: **Build**, **Rebuild**, **Test**
- Per-section inline buttons: **Build section**, **Rebuild section**, **Test section**
- Hovering a test target shows the full list of associated CTest tests
- Filter by target name or type

### Dependency Graph

An interactive force-directed graph that visualizes CMake target dependencies:

- **Canvas-based rendering** with pan (click & drag background) and zoom (mouse wheel)
- **Node interaction**: click a node to select it and highlight its edges, drag a node to reposition it
- **Double-click a node** to jump to its `add_executable`/`add_library` definition in CMakeLists.txt
- **Double-click the background** to fit the entire graph in the view
- **Type filtering**: toggle visibility of target types (Executable, Static Library, etc.) via checkboxes
- **Edge styles**: choose between Tapered, Chevrons, or Line in the settings panel
- **Edge direction**: show edges toward dependencies or inverted
- **Force simulation**: nodes are positioned automatically via a physics simulation with configurable parameters (repulsion, attraction, gravity, damping, etc.)
- **Settings panel** (gear icon): adjust simulation parameters, start/stop/restart the simulation, fit the graph to view, and export a screenshot as PNG
- **Legend** showing the color for each target type
- **State persistence**: camera position, zoom level, edge style and simulation parameters are preserved across view refreshes

### CTest Integration

Tests are discovered automatically after every configure by running `ctest --show-only=json-v1` in the background.

- Test executables are separated from normal executables in the Impacted Targets view
- Running tests on a single target or a whole section builds the appropriate `ctest -R` regex automatically from the discovered test names
- The tooltip on a test target lists all its associated CTest tests

### Diagnostics

CMake errors, warnings and deprecation notices from the configure step are parsed and shown:

- In the VS Code **Problems** panel, with file path and line number
- As file decorations (colored badges) in the Explorer and tree views:
  - **E** (red) for errors
  - **W** (yellow) for warnings
  - **D** (yellow) for deprecation warnings
- Parent directories propagate the highest severity from their children

### Output Panel

All CMake and CTest output is shown in a dedicated **vsCMake** output channel with optional syntax highlighting:

- Build progress (`[25/105]`)
- File paths, target names
- Error and warning messages
- Success / failure status

### CMake Tools Integration

vsCMake can work alongside the official CMake Tools extension. When CMake Tools triggers a configure, vsCMake automatically picks up the new build directory and build type, refreshing all panels with the latest project data.

### Task Management

- Status bar shows running tasks with a spinner
- Cancel individual tasks or all tasks at once
- Long-running silent operations (like test discovery) can also be cancelled

## Getting Started

1. **Install the extension** from the `.vsix` file or the marketplace.
2. **Open a CMake project** in VS Code.
3. Set the **build folder** via the command palette or let the extension auto-detect it.
4. Once the build directory contains CMake reply files (after a configure), all panels update automatically.

## Keyboard Shortcuts

| Shortcut | Command |
|----------|---------|
| `Ctrl+Shift+F7` | Configure |
| `Ctrl+F7` | Build |

## Settings

All settings are under the `vsCMake` prefix.

| Setting | Default | Description |
|---------|---------|-------------|
| `sourceDir` | `${workspaceFolder}` | Path to the CMake source directory |
| `buildDir` | `${workspaceFolder}/build` | Path to the CMake build directory |
| `cmakePath` | `cmake` | Path to the cmake executable |
| `ctestPath` | `ctest` | Path to the ctest executable |
| `cpackPath` | `cpack` | Path to the cpack executable |
| `clearOutputBeforeRun` | `true` | Clear the output panel before each CMake command |
| `showJobsOption` | `false` | Show the Jobs (parallelism) row in Build and Test sections |
| `defaultJobs` | `0` | Default number of parallel jobs (`0` = let CMake/CTest decide) |
| `colorizeOutput` | `true` | Enable syntax highlighting in the output panel |
| `graphEdgeDirection` | `dependency` | Edge arrow direction in the dependency graph: `dependency` (toward dependency) or `inverse` |

The `${workspaceFolder}` variable is supported and resolved automatically in path settings.

## How It Works

1. **Query files** are written to `.cmake/api/v1/query/` in the build directory
2. When you run **Configure**, CMake generates reply files in `.cmake/api/v1/reply/`
3. A **file watcher** detects new `index-*.json` files and triggers a reload
4. vsCMake reads the **codemodel**, **cache**, **cmakeFiles**, and **toolchains** replies
5. All panels update with accurate project information straight from CMake

This approach means vsCMake works with any CMake project, regardless of complexity -- custom functions, generator expressions, FetchContent, ExternalProject, toolchain files -- everything is supported because CMake itself does the heavy lifting.

## Requirements

- VS Code >= 1.80.0
- CMake >= 3.14 (File-Based API support)
- CTest (bundled with CMake, used for test discovery)

## License

MIT -- see [LICENSE](LICENSE) for details.

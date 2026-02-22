# vsCMake

CMake integration for VS Code via the **CMake File-Based API** -- no CMakeLists.txt parsing required.

![VS Code](https://img.shields.io/badge/VS%20Code-^1.80.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Philosophy

vsCMake takes a different approach from other CMake extensions: instead of parsing `CMakeLists.txt` files, it relies entirely on the [CMake File-Based API](https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html). This means vsCMake reads what CMake itself reports after a configure, giving you accurate project information regardless of how complex your CMake scripts are.

## Features

### Project Status Panel

The main panel gives you a clear overview and full control over your CMake project:

| Section | Description |
|---------|-------------|
| **Folder** | Source directory selection. Build directory is requested automatically if not set (defaults to `${workspaceFolder}/build`). |
| **Kit** | Active compiler toolchain. Auto-detected via kit scanning or manually selected. |
| **Configure** | Without presets: pick `CMAKE_BUILD_TYPE` (Debug, Release, RelWithDebInfo, MinSizeRel). With presets: pick the configure preset. |
| **Build** | Without presets: pick the build target (all, install, or any individual target). With presets: pick the build preset. Multi-config generators (Ninja Multi-Config, Visual Studio, Xcode) show an additional config selector. |
| **Test** | Select and run individual tests or all tests. **Only visible when tests are detected** -- test list is fetched automatically after each configure via `ctest --show-only=json-v1`. |
| **Package** | CPack integration -- **only visible when CPack is detected**. |
| **Debug** | Select an executable target for debugging. |
| **Launch** | Select an executable target for launching. |

Inline action buttons let you **Configure**, **Build**, **Clean**, **Test** and **Install** directly from this view.

### CMake Presets Support

Full support for `CMakePresets.json` and `CMakeUserPresets.json`:

- Recursive `include` resolution (version >= 4)
- Preset inheritance (`inherits`)
- Macro expansion (`${sourceDir}`, `${presetName}`, `$env{VAR}`, `$penv{VAR}`, etc.)
- Condition evaluation (`equals`, `notEquals`, `inList`, `matches`, `anyOf`, `allOf`, `not`, etc.)
- Automatic cascade: changing the configure preset updates compatible build, test, and package presets
- **Dynamic detection**: presets are reloaded from disk before every configure

### Compiler Kit Scanning

vsCMake can scan your system for available compilers:

- **Windows**: MSVC (via `vswhere`), GCC (MinGW / MSYS2 / WinLibs), Clang, Clang-cl
- **Linux / macOS**: GCC and Clang from `PATH` and user-configured search paths

The selected kit is injected via `CMAKE_C_COMPILER` / `CMAKE_CXX_COMPILER` at configure time.
On Windows, the MSVC environment (`vcvarsall.bat`) is resolved and injected automatically so that CMake finds the compiler without requiring a Developer Command Prompt.

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

### CTest Integration

Tests are discovered automatically after every configure by running `ctest --show-only=json-v1` in the background.

- The **Test** row in Project Status shows the total test count
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

All CMake, CTest and CPack output is shown in a dedicated **vsCMake** output channel with optional syntax highlighting:

- Build progress (`[25/105]`)
- File paths, target names
- Error and warning messages
- Success / failure status

### Smart Detection

vsCMake automatically detects project capabilities from the CMake reply:

- **CPack detection**: the Package section only appears if `include(CPack)` is detected. Detection works by checking for `CPackConfig.cmake` in the CMake file inputs.
- **Test detection**: the Test section only appears if at least one test is found. If you disable `enable_testing()` and reconfigure, the section disappears automatically.
- **Multi-config detection**: automatically detects multi-config generators (Ninja Multi-Config, Visual Studio, Xcode) and adapts the UI -- showing a build config selector under the Build section.

### Task Management

- Status bar shows running tasks with a spinner
- Cancel individual tasks or all tasks at once
- Long-running silent operations (like test discovery) can also be cancelled

### Delete Cache & Reconfigure

A single command to cleanly reconfigure your project:

- Recursively finds and deletes all `CMakeCache.txt` files and `CMakeFiles/` directories in the build tree (handles FetchContent submodules)
- Clears the MSVC environment cache to force re-resolution
- Reloads presets from disk
- Runs a fresh configure with current settings

## Getting Started

1. **Install the extension** from the `.vsix` file or the marketplace.
2. **Open a CMake project** in VS Code.
3. In the **vsCMake** sidebar, set the **source folder** and **build folder** (or let the extension use `CMakePresets.json`).
4. If your project has no presets, use **Scan compilers** to detect available toolchains and select one.
5. Click **Configure** to generate the build system.
6. Click **Build** to compile.

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

The `${workspaceFolder}` variable is supported and resolved automatically in path settings.

## How It Works

1. **Query files** are written to `.cmake/api/v1/query/` in the build directory
2. When you run **Configure**, CMake generates reply files in `.cmake/api/v1/reply/`
3. A **file watcher** detects new `index-*.json` files and triggers a reload
4. vsCMake reads the **codemodel**, **cache**, **cmakeFiles**, and **toolchains** replies
5. All four panels update with accurate project information straight from CMake

This approach means vsCMake works with any CMake project, regardless of complexity -- custom functions, generator expressions, FetchContent, ExternalProject, toolchain files -- everything is supported because CMake itself does the heavy lifting.

## Requirements

- VS Code >= 1.80.0
- CMake >= 3.14 (File-Based API support)
- CTest (bundled with CMake, used for test discovery)

## License

MIT -- see [LICENSE](LICENSE) for details.

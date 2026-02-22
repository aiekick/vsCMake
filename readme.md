# vsCMake

CMake integration for VS Code via the **CMake File-Based API** — no CMakeLists.txt parsing required.

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
| **Configure** | Without presets: pick `CMAKE_BUILD_TYPE` (Debug, Release, RelWithDebInfo, MinSizeRel). With presets: pick the configure preset. |
| **Build** | Without presets: pick the build target (all, install, or any individual target). With presets: pick the build preset. Multi-config generators (Ninja Multi-Config, Visual Studio, Xcode) show an additional config selector. |
| **Debug** | Select an executable target for debugging. |
| **Launch** | Select an executable target for launching. |
| **Test** | Select and run individual tests or all tests. **Only visible when tests are detected** — test list is fetched automatically after each configure via `ctest --show-only=json-v1`. If no tests are found, the section is hidden. |
| **Package** | CPack integration — **only visible when CPack is detected** (see below). |

### CMake Presets Support

Full support for `CMakePresets.json` and `CMakeUserPresets.json`:

- Recursive `include` resolution (version ≥ 4)
- Preset inheritance (`inherits`)
- Macro expansion (`${sourceDir}`, `${presetName}`, `$env{VAR}`, `$penv{VAR}`, etc.)
- Condition evaluation (`equals`, `notEquals`, `inList`, `matches`, `anyOf`, `allOf`, `not`, etc.)
- Automatic cascade: changing the configure preset updates compatible build, test, and package presets
- **Dynamic detection**: presets are reloaded from disk before every configure, so adding/removing a `CMakePresets.json` file is handled seamlessly

### Project Outline

A tree view of your project structure based on the CMake codemodel:

- Targets grouped by CMake folder structure (`set_property(GLOBAL PROPERTY USE_FOLDERS ON)`)
- Source files organized by source groups or directory structure
- Click any source file to open it in the editor
- Click any target to jump to its `add_executable`/`add_library` definition in CMakeLists.txt
- Build individual targets directly from the outline via inline button
- **CMake Extras** sub-tree per target:
  - Include directories (user and system)
  - Compile flags and defines
  - Link flags
  - Linked libraries
  - Target dependencies
  - CMake input files

### Configuration Panel

Browse and edit CMake cache variables:

- Variables grouped by prefix (CMAKE_, BUILD_, etc.)
- Inline editing: booleans show ON/OFF picker, strings with `STRINGS` property show a dropdown, others show an input box
- Editing a variable triggers an automatic reconfigure with `-D`

### Smart Detection

vsCMake automatically detects project capabilities from the CMake reply:

- **CPack detection**: the Package section only appears if `include(CPack)` is detected. Detection works by checking for `CPackConfig.cmake` in the CMake file inputs, which covers both single-config generators (Ninja, Makefiles) and multi-config generators (Visual Studio, Xcode) where a `package` utility target is also present.
- **Test detection**: after each configure, vsCMake silently runs `ctest --show-only=json-v1` to discover registered tests. The Test section only appears if at least one test is found. If you disable `enable_testing()` and reconfigure, the section disappears automatically.
- **Multi-config detection**: automatically detects multi-config generators (Ninja Multi-Config, Visual Studio, Xcode) and adapts the UI accordingly — showing a build config selector under the Build section.

### Delete Cache & Reconfigure

A single command to cleanly reconfigure your project:

- Recursively finds and deletes all `CMakeCache.txt` files and `CMakeFiles/` directories in the build tree (handles FetchContent submodules)
- Reloads presets from disk (handles preset file changes)
- Runs a fresh configure with current settings

### Task Management

- Status bar shows running tasks with a spinner
- Cancel individual tasks or all tasks at once
- Long-running silent operations (like test discovery) can also be cancelled

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `vsCMake.sourceDir` | `${workspaceFolder}` | Path to the CMake source directory |
| `vsCMake.buildDir` | `${workspaceFolder}/build` | Path to the CMake build directory |
| `vsCMake.cmakePath` | `cmake` | Path to the cmake executable |
| `vsCMake.ctestPath` | `ctest` | Path to the ctest executable |
| `vsCMake.cpackPath` | `cpack` | Path to the cpack executable |
| `vsCMake.clearOutputBeforeRun` | `true` | Clear the output panel before each CMake command |

The `${workspaceFolder}` variable is supported and resolved automatically in path settings.

## Keyboard Shortcuts

| Shortcut | Command |
|----------|---------|
| `Ctrl+Shift+F7` | Configure |
| `Ctrl+F7` | Build |

## How It Works

1. **Query files** are written to `.cmake/api/v1/query/` in the build directory
2. When you run **Configure**, CMake generates reply files in `.cmake/api/v1/reply/`
3. A **file watcher** detects new `index-*.json` files and triggers a reload
4. vsCMake reads the **codemodel**, **cache**, **cmakeFiles**, and **toolchains** replies
5. The UI updates with accurate project information straight from CMake

This approach means vsCMake works with any CMake project, regardless of complexity — custom functions, generator expressions, FetchContent, ExternalProject, toolchain files — everything is supported because CMake itself does the heavy lifting.

## Requirements

- VS Code ≥ 1.80.0
- CMake ≥ 3.14 (File-Based API support)
- CTest (bundled with CMake, used for test discovery)

## License

MIT — see [LICENSE](LICENSE) for details.
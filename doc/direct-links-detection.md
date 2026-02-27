# Extracting Direct `target_link_libraries` from CMake's File API

## The Problem

CMake's File API (codemodel v2) does not distinguish between **direct** and **transitive** link dependencies.

Given this CMake setup:

```cmake
# 3rdparty/imguipack/CMakeLists.txt
add_library(imguipack SHARED ...)
target_link_libraries(imguipack PRIVATE freetype glfw)

# 3rdparty/grapher/CMakeLists.txt
add_library(grapher SHARED ...)
target_link_libraries(grapher PUBLIC imguipack)

# CMakeLists.txt
add_executable(ezRenamer ...)
target_link_libraries(ezRenamer PRIVATE grapher glad imguipack glfw)
```

The `dependencies` field in the File API target object for `ezRenamer` will list **all** of: `grapher`, `glad`, `imguipack`, `glfw`, **and** `freetype` — with no way to tell which were explicitly written in `target_link_libraries(ezRenamer ...)` and which were pulled in transitively.

This is a [known limitation](https://discourse.cmake.org/t/different-target-dependencies-in-cmake-graphviz-and-file-api-output/11058) confirmed by CMake maintainers. The `--graphviz` output does produce direct-only edges, but lacks other metadata available in the File API.

## The Solution: Backtrace Signature Comparison

We found that the **`link.commandFragments`** section of each target object contains the information needed to reconstruct direct links. Each fragment with `role: "libraries"` has a `backtrace` index pointing into the target's `backtraceGraph`. This backtrace resolves to a specific **(file, line)** origin — the exact `target_link_libraries()` call that introduced the library.

### Key Insight

When a library is inherited transitively, its `link.commandFragments` entry will have a backtrace pointing to the **same (file, line)** as the corresponding entry in one of its dependencies. A direct link, on the other hand, has a backtrace origin that does **not** appear in any dependency's link fragments.

### Example from Real Data

**ezRenamer** links `freetype.lib` with backtrace → `3rdparty/imguipack/CMakeLists.txt:374`
**imguipack** links `freetype.lib` with backtrace → `3rdparty/imguipack/CMakeLists.txt:374`

Same origin → `ezRenamer→freetype` is **transitive** (inherited from imguipack).

**ezRenamer** links `grapher.lib` with backtrace → `CMakeLists.txt:186`
No dependency has a fragment from `CMakeLists.txt:186` → `ezRenamer→grapher` is **direct**.

This also works when `target_link_libraries` is called from an included `.cmake` file rather than directly in a `CMakeLists.txt`:

**imguipack** links `glfw3dll.lib` with backtrace → `cmake/Maintained/imguipack.cmake:89`
No dependency of imguipack has this origin → `imguipack→glfw` is **direct** ✅

**grapher** links `glfw3dll.lib` with backtrace → `cmake/Maintained/imguipack.cmake:89`
Its dependency imguipack has the same origin → `grapher→glfw` is **transitive** ✅

## Algorithm

```
For each target T:

  1. RESOLVE SIGNATURES
     For each link fragment (role "libraries") in T.link.commandFragments:
       - Follow the backtrace index into T.backtraceGraph
       - Resolve to a signature string: "normalized_file_path:line_number"

  2. COLLECT DEPENDENCY SIGNATURES
     For each dependency D listed in T.dependencies:
       - Compute the same set of link signatures for D
       - Merge into a set: depSigs

  3. CLASSIFY FRAGMENTS
     For each link fragment F in T:
       - Skip if F.role ≠ "libraries" or no backtrace
       - Skip if the backtrace command is not "target_link_libraries"
       - Compute F's signature
       - If signature ∈ depSigs → TRANSITIVE (skip)
       - Otherwise → DIRECT
         - Match F.fragment (a .lib/.a/.so path) to a known target
           by comparing against target artifact paths
         - Add matched target ID to T.directLinks
```

## Matching Fragments to Targets

Link fragments contain **file paths** (e.g. `3rdparty/grapher/Release/grapher.lib`), not target names. To resolve them to target IDs, we build a map from artifact paths to target IDs using each target's `artifacts` array. Matching is done by:

1. Normalized path suffix match (handles relative vs absolute paths)
2. Fallback to basename match (e.g. `grapher.lib`)

## Limitations

- **Header-only / INTERFACE libraries** don't produce link fragments, so they won't appear in `directLinks`. They may still appear in `dependencies` if they affect the build order.
- **UTILITY targets** (custom targets) don't have link information.
- **Non-target libraries** (system libs like `kernel32.lib`) have no backtrace and are naturally excluded.
- The algorithm depends on `link.commandFragments` being present, which requires the target to actually produce a linked artifact.

## Result

| Target | directLinks |
| --- | --- |
| ezRenamer | grapher, glad, imguipack, glfw |
| grapher | imguipack |
| imguipack | freetype, glfw |
| freetype | *(none)* |
| glad | *(none)* |
| glfw | *(none)* |

This matches exactly what is written in each target's `target_link_libraries()` calls.

## References

- [CMake File API documentation](https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html)
- [CMake Discourse: Different target dependencies in graphviz and file-api](https://discourse.cmake.org/t/different-target-dependencies-in-cmake-graphviz-and-file-api-output/11058)
- [GitLab issue #21995: Distinguish direct and transitive link dependencies](https://gitlab.kitware.com/cmake/cmake/-/issues/21995)
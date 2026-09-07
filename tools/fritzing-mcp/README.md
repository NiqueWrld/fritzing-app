# Fritzing MCP Server

This package exposes a small Model Context Protocol server so GitHub Copilot can work with this Fritzing checkout through MCP tools.

## Tools

- `help`: show the available MCP tools, their key inputs, resolved workspace root, and Fritzing executable status.
- `read_file`: read a UTF-8 text file from the Fritzing repository.
- `write_file`: create or replace a UTF-8 text file in the Fritzing repository.
- `move_path`: move or rename a repository file or folder.
- `delete_path`: delete a repository file or folder.
- `find_parts`: find installed Fritzing part definitions and their `moduleId` values.
- `place_part`: place a real part in the active Fritzing editor view.
- `get_live_sketch_xml`: read the active editor's complete sketch XML.
- `edit_live_part`: inspect or move a live Fritzing part through `PartProbe` using `getPosition`, `movePart`, `movePartRelative`, `getSize`, `getResizeHandlePos`, `sceneToScreen`, or `getGridSize`.
- `edit_live_wire`: inspect, move, or delete live Fritzing wires through `WireProbe`.
- `list_sketches`: list `.fz` and `.fzz` sketches in the workspace.
- `inspect_sketch`: show basic file metadata and simple `.fz` XML counts.
- `locate_fritzing_executable`: look for a built Fritzing executable in common local build folders.
- `export_sketch`: run Fritzing's existing command-line export service for `svg`, `gerber`, or `all`. Use `all` to include BOM and IPC output.
- `render_sketch_image`: export a sketch view to SVG and return it as MCP image content.

## Setup

```powershell
cd tools/fritzing-mcp
npm install
npm run build
```

VS Code can start the server from `.vscode/mcp.json`. Use the MCP server tools from Copilot Chat after dependencies are installed.

For exports and rendered images, build Fritzing first or pass `fritzingExecutable` to `export_sketch` or `render_sketch_image`.

You can also set `FRITZING_EXECUTABLE` globally so the MCP server finds the app automatically.

## File Editing

The file editing tools can create, replace, move, and delete repository files.
They accept only paths inside the Fritzing repository root. Set `overwrite` or
`recursive` explicitly when replacing an existing path or deleting a folder.

## Live Visual Editing

Start the Debug build with its FTesting service enabled before using the live
editor tools:

```powershell
build\debug32\Fritzing.exe --ftesting --folder . --parts ..\fritzing-parts
```

The service listens on `127.0.0.1:17999` by default. Use `find_parts` to find
an installed component and its real `moduleId`, then use `place_part` to add it
to the active Fritzing view. Use `edit_live_part` and `edit_live_wire` for
layout and wire operations. These tools operate on the open Fritzing sketch,
not a placeholder text file.

Use the MCP `help` tool at any time to list the complete tool set, key inputs,
repository root, and configured Fritzing executable.
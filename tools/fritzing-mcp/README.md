# Fritzing MCP Server

This package exposes a small Model Context Protocol server so GitHub Copilot can work with this Fritzing checkout through MCP tools.

## Tools

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
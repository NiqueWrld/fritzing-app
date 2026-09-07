# Fritzing MCP Server

This package exposes a file-based Model Context Protocol server so GitHub Copilot can work with Fritzing source, parts, and sketch packages without starting Fritzing.

## Tools

- `help`: show the available direct MCP tools, their key inputs, and the resolved repository root.
- `read_file`: read a UTF-8 text file from the Fritzing repository.
- `write_file`: create or replace a UTF-8 text file in the Fritzing repository.
- `move_path`: move or rename a repository file or folder.
- `delete_path`: delete a repository file or folder.
- `find_parts`: find installed Fritzing part definitions and their `moduleId` values.
- `update_parts_library`: update the configured official `fritzing-parts` Git repository.
- `list_sketches`: list `.fz` and `.fzz` sketches in the workspace.
- `inspect_sketch`: show basic file metadata and simple `.fz` XML counts.
- `read_sketch_model`: extract editable `.fz` XML from a `.fz` file or `.fzz` package without starting Fritzing.
- `write_sketch_model`: update the `.fz` model in a `.fz` file or `.fzz` package without starting Fritzing; creates a backup by default.

## Setup

```powershell
cd tools/fritzing-mcp
npm install
npm run build
```

VS Code can start the server from `.vscode/mcp.json`. Use the MCP server tools from Copilot Chat after dependencies are installed. Fritzing does not need to be built or running.

## File Editing

The file editing tools can create, replace, move, and delete repository files.
They accept only paths inside the Fritzing repository root. Set `overwrite` or
`recursive` explicitly when replacing an existing path or deleting a folder.

## External Sketch Editing

Use `read_sketch_model` and `write_sketch_model` to edit a local `.fz` or
`.fzz` sketch package without a running Fritzing application. The write tool
replaces only the embedded `.fz` model inside `.fzz`, preserving its other ZIP
entries, and creates a `.bak` copy unless `createBackup` is set to `false`.

## Parts Management

Use `find_parts` before creating a custom part. Run `update_parts_library` to
pull additions from the configured official parts repository.

Use the MCP `help` tool at any time to list the complete tool set, key inputs,
and repository root.
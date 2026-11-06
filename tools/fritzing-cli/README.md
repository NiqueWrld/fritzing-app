# Fritzing CLI

This package now runs as a simple Node CLI for working with Fritzing sketches, parts, and repository files.

It supports CLI commands, stdio MCP for direct use, and Streamable HTTP MCP for the Fritzing desktop app.

## Commands

- `help`: show the available commands and repository root.
- `list-sketches --folder sketches --limit 20`: list `.fz` and `.fzz` files.
- `inspect-sketch --path sketches/core/555TouchSwitch.fzz`: show metadata for a sketch.
- `read-sketch-model --path sketches/core/555TouchSwitch.fzz`: print the embedded `.fz` XML.
- `find-parts --query 555 --limit 10`: search installed part definitions.
- `update-parts-library`: pull the configured official `fritzing-parts` repo.
- `mcp`: start the stdio MCP transport for direct use.
- `--mcp-http`: start Streamable HTTP MCP on `127.0.0.1:17998`.

## MCP Tools

- `running_instances`: list running Fritzing process IDs.
- `get_open_sketches`: inspect open windows, sketch paths, unsaved changes, and active views.
- `save_sketch`: save an open sketch or Save As to an exact path. Existing files are protected unless `overwrite` is true; missing folders are created.
- `open_sketch`: open an existing `.fz` or `.fzz` in a running Fritzing instance.
- `reload_sketch`: reload a saved sketch from disk; refuses to discard unsaved changes.

Live window tools communicate with the Fritzing application over a per-process local socket. They use Fritzing's document APIs, not keyboard or clipboard automation. When multiple Fritzing instances are running, pass a `pid`; `get_open_sketches` also returns a `windowId` for selecting a particular window in that process.

## Setup

```powershell
cd tools/fritzing-cli
npm install
npm run build
```

Run the CLI directly:

```powershell
node dist/index.js list-sketches --folder sketches --limit 10
node dist/index.js inspect-sketch --path sketches/core/555TouchSwitch.fzz
```

Fritzing starts the HTTP MCP service and local control socket when the desktop app opens, if Node.js and the built CLI are available. VS Code connects through `.vscode/mcp.json`. To run the HTTP service manually instead:

```powershell
node dist/index.js --mcp-http
```

## File Editing

The CLI can read and write repository files, and it can inspect or update sketch XML without requiring a running Fritzing window.

## Parts Management

Use `find-parts` before creating a custom part and `update-parts-library` to pull the official parts repo.

The legacy stdio MCP transport remains available with `node dist/index.js --mcp` for clients that launch the server process directly.
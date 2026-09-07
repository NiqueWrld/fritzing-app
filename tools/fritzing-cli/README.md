# Fritzing CLI

This package now runs as a simple Node CLI for working with Fritzing sketches, parts, and repository files.

It still supports the original MCP server mode when needed, but the default path is a plain command-line workflow that is easier to run and script.

## Commands

- `help`: show the available commands and repository root.
- `list-sketches --folder sketches --limit 20`: list `.fz` and `.fzz` files.
- `inspect-sketch --path sketches/core/555TouchSwitch.fzz`: show metadata for a sketch.
- `read-sketch-model --path sketches/core/555TouchSwitch.fzz`: print the embedded `.fz` XML.
- `find-parts --query 555 --limit 10`: search installed part definitions.
- `update-parts-library`: pull the configured official `fritzing-parts` repo.
- `mcp`: start the MCP transport for Copilot integration.

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

For the original Copilot/MCP flow:

```powershell
node dist/index.js --mcp
```

## File Editing

The CLI can read and write repository files, and it can inspect or update sketch XML without requiring a running Fritzing window.

## Parts Management

Use `find-parts` before creating a custom part and `update-parts-library` to pull the official parts repo.

## Existing VS Code MCP config

The workspace `.vscode/mcp.json` can still point to the JSON-RPC server if you want Copilot integration, but the simpler default is the CLI, which requires no MCP transport.
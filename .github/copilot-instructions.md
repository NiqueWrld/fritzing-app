# Copilot Instructions

This repository includes a workspace CLI in `tools/fritzing-cli`.

- Use the official TypeScript MCP SDK for MCP changes: https://github.com/modelcontextprotocol/typescript-sdk
- The VS Code MCP server entry is `.vscode/mcp.json`.
- Build the CLI with `cd tools/fritzing-cli; npm install; npm run build` before using it from Copilot Chat.
- Keep CLI/MCP tools external to the Qt application unless a task specifically requires changing Fritzing's C++ service layer.
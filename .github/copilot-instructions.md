# Copilot Instructions

This repository includes a workspace MCP server in `tools/fritzing-mcp`.

- Use the official TypeScript MCP SDK for MCP changes: https://github.com/modelcontextprotocol/typescript-sdk
- The VS Code MCP server entry is `.vscode/mcp.json`.
- Build the MCP server with `cd tools/fritzing-mcp; npm install; npm run build` before using it from Copilot Chat.
- Keep MCP tools external to the Qt application unless a task specifically requires changing Fritzing's C++ service layer.
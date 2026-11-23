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

## Web UI

A React + Vite app in `ui/` (Sketches, Parts, Breadboard, Schematic, Connections, Settings). Run it with the local server:

```powershell
cd tools/fritzing-cli
npm run dev:all   # server + UI on http://localhost:5173
```

## Accounts and Cloud Storage

Sign-in is **optional**. Without an account everything works except cloud storage.

| Piece | Where | What it does |
| --- | --- | --- |
| Firebase Auth | project `fritzing-niquewrld`, web app "Fritzing UI" | Google and email/password sign-in |
| Auth in the UI | `ui/src/lib/firebase.ts`, `ui/src/context/AuthContext.tsx`, `ui/src/pages/Login.tsx` | `/login` page; sidebar Sign in / account link; `canUseStorage` is true only when signed in |
| Storage client | `ui/src/lib/cloudStorage.ts` | `listFiles`, `uploadFile`, `downloadFile`, `deleteFile`; refuses when signed out |
| Storage Worker | `worker/` → `https://fritzing-storage.siyathokoza321.workers.dev` | Cloudflare Worker that verifies the Firebase ID token and stores files in R2 bucket `fritzing-user-files` under `users/<uid>/` |

### Worker API

All routes need `Authorization: Bearer <Firebase ID token>`.

- `GET /files`: list the user's files
- `GET /files/:name`: download
- `PUT /files/:name`: upload (25 MB limit, `MAX_FILE_BYTES`)
- `DELETE /files/:name`: delete

### Parts on Cloudflare

**Official library (public, no sign-in).** Stored in the same R2 bucket under `library/`, with `library/index.json` used for search.

- `GET /parts?q=555&limit=25`: search; returns `{ parts: [{ moduleId, title, path }] }`
- `GET /parts/image?moduleId=…&view=breadboard|schematic` (or `path=…` instead of `moduleId`)
- `GET /parts/file/<path>`: raw `.fzp` / `.svg`
- `PUT /parts/file/<path>`: upload, needs `Authorization: Bearer <PARTS_UPLOAD_TOKEN>`

Upload or refresh the library (needs the `fritzing-parts` repo next to `fritzing-app`, or pass `--root`):

```powershell
cd tools/fritzing-cli/worker
npx wrangler secret put PARTS_UPLOAD_TOKEN   # pick a long random value
$env:PARTS_UPLOAD_TOKEN = "<same value>"
npm run upload-parts -- --dry-run            # counts only
npm run upload-parts
```

The index is uploaded last, so search never points at missing files. In the UI, the Parts page has a Local / Cloud picker; set `VITE_PARTS_SOURCE=cloud` to make cloud the default and load Breadboard/Schematic images from the Worker too.

**Desktop/Android app.** The app does not ship the parts library. On launch, `src/utils/cloudparts.cpp` reads `GET /parts/file/bundle/version.txt` (the `fritzing-parts` commit) and, when it differs from the cached copy, downloads `bundle/fritzing-parts.zip` (~40 MB) into app data (`<AppData>/fritzing-parts`), unpacks it, and rebuilds `parts.db`. Offline launches use the cached copy; with no copy and no connection the app tells the user to connect. `npm run upload-parts` publishes the bundle (`--skip-files` publishes only the bundle). Developers can still use a local checkout with `-parts <folder>`; `FRITZING_CLOUD_PARTS_URL` (or the `cloudPartsUrl` setting) points the app at another bundle URL.

**User parts (signed in).** Stored as ordinary files under `users/<uid>/parts/` through the `/files` API. The Parts page's *My cloud parts* section uploads, downloads and deletes them.

Allowed browser origins are set by `ALLOWED_ORIGINS` in `worker/wrangler.toml`.

### Configuration

Copy `ui/.env.example` to `ui/.env` and fill in the Firebase web config (`firebase apps:sdkconfig WEB --project fritzing-niquewrld`) and `VITE_STORAGE_API_URL`. `.env` is git-ignored. If the Firebase values are missing, sign-in is hidden and the app runs signed-out.

### Deploying the Worker

```powershell
cd tools/fritzing-cli/worker
npm install
npx wrangler login
npm run deploy
```

The R2 bucket was created once with `npx wrangler r2 bucket create fritzing-user-files`.

### Still to do

- Enable the **Google** and **Email/Password** providers in Firebase console → Authentication → Sign-in method.
- When the UI is hosted, add its origin to `ALLOWED_ORIGINS` (then redeploy) and to Firebase **Authorized domains**.
- Wire a "save to cloud" action for sketches into the UI (cloud parts are wired up on the Parts page).
- Run `npm run upload-parts` once the `fritzing-parts` repo is checked out; until then `/parts` returns 503.

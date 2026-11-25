# NEXUS Core v0.4.0

A self-hosted, dependency-free development control center for managing local project workspaces and development tasks.

## Requirements

- Node.js 18 or newer
- Git installed and available on PATH for Git status, initialization, and diff features

## Run locally

```bash
npm start
```

Open [http://localhost:3030](http://localhost:3030).

## Features in v0.4.0

- Import public GitHub repositories into NEXUS-managed local workspaces
- Scan projects and identify their detected stack and available scripts
- Manage project workspaces, including projects that do not already have Git initialized
- Initialize Git for a workspace and inspect repository status
- View Git diffs from the project interface
- Queue and execute supported development missions, with status updates and execution history
- Browse workspace files and preview supported text files (up to 300 KB)
- Receive live state updates through Server-Sent Events (SSE)

## Local data

NEXUS stores its runtime state in `data/nexus.json` and imported repositories in `data/workspaces/`. These are local runtime files, not application source files. The repository's `.gitignore` excludes them from Git.

Back up `data/nexus.json` before replacing or resetting your local runtime data.

## Safety

NEXUS is intended for trusted local use. Authentication is not implemented, so do not expose the server directly to the public internet. Only import and run tasks from projects you trust. Workspace browsing and text previews are read-only; previews are limited to 300 KB.

# NEXUS Core v0.3.0 — Workspace Control

Self-hosted, dependency-free development control center.

## Requirements
- Node.js 18+
- Git on PATH for Git status/diff missions

## Run
```bash
npm start
```
Open http://localhost:3030.

## v0.3 features
- Project workspace directory browser
- Text file preview (max 300 KB)
- Workspace path traversal and symlink escape checks
- Server-sent events for state updates
- Persistent mission history in `data/nexus.json`
- Predefined execution tasks: workspace inspect, git status, npm test, npm build
- Read-only file browser and previews

## Safety
Intended for trusted local use. Do not expose directly to the public internet; authentication is not yet implemented. Workspace browsing is read-only and previews are limited to 300 KB.

## Data
Persistent state is stored in `data/nexus.json`. Back it up before upgrading.

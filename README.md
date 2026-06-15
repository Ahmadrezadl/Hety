# Hety

An all-in-one developer cockpit — **SSH**, **Git**, and **PostgreSQL** in one place, organised by project.

Built with **Electron + React + TypeScript + Vite + Tailwind**.

## Features

- **Projects** with name, description, **group** (projects bundle by group), and **tags**. Search + tag
  filtering, **recent projects on top**.
- Each project has its own **SSH servers** and **PostgreSQL databases**.
- **SSH tab** — multiple **colorized** terminals in tabs (xterm.js), keyboard-interactive/password/key auth.
- **Repository tab** — branch switch, fetch/pull/push, stage/unstage/discard per file, commit (+ push),
  recent history, "open in" editors.
- **Database tab** — schema browser (schemas → tables / views / enums → columns), double-click a table to
  query it, **multi-tab SQL consoles** with **autocomplete** (CodeMirror), **save & search queries**, and
  **export results** to Markdown / CSV / TSV (copy or save to file).
- **Connection testing** before save (SSH tunnel + database), JetBrains-style.
- **Encrypted local store** — AES-256-GCM with an optional master password.

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run typecheck   # type-check main + renderer
npm run build       # bundle main/preload/renderer into ./out
npm run pack        # build a distributable (electron-builder)
```

## Requirements

- Node.js 18+ (For running the app)
- Git on `PATH` (used by the Repository tab)

The data file is stored (encrypted, if a password is set) under Electron's `userData` directory as
`hety-data.dat`.

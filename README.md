# Hety

<p align="center">
  <img src="assets/logo.png" alt="Hety logo" width="160" />
</p>

Hety is an all-in-one desktop developer cockpit for managing SSH sessions, Git repositories, and PostgreSQL databases from one project-based workspace.

Built with Electron, React, TypeScript, Vite, and Tailwind CSS.

## Features

- Project dashboard with groups, tags, search, and recent projects.
- Per-project SSH servers, Git repository paths, and PostgreSQL database connections.
- Multi-tab SSH terminals powered by xterm.js with password, key, and keyboard-interactive authentication.
- Git workspace tools for branch switching, fetch, pull, push, staging, unstaging, committing, and recent history.
- PostgreSQL schema browser for schemas, tables, views, enums, and columns.
- Multi-tab SQL console with CodeMirror autocomplete, saved queries, editable table views, and result export to Markdown, CSV, or TSV.
- Connection testing before saving SSH and database settings.
- Encrypted local storage with AES-256-GCM and optional master password protection.

## Tech Stack

- Electron + electron-vite
- React 18 + TypeScript
- Tailwind CSS
- Zustand
- simple-git
- ssh2
- pg
- CodeMirror
- xterm.js

## Requirements

- Node.js 18 or newer
- Git available on `PATH` for repository features
- PostgreSQL access for database connections
- SSH access for remote terminal and tunnel features

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development app:

```bash
npm run dev
```

## Build

Type-check the main, preload, and renderer code:

```bash
npm run typecheck
```

Build the app into `out`:

```bash
npm run build
```

Create a distributable package with electron-builder:

```bash
npm run pack
```

## Local Data

Hety stores its local app data in Electron's `userData` directory as `hety-data.dat`. When a master password is set, the data file is encrypted locally with AES-256-GCM.

## Project Structure

```text
src/main       Electron main process, IPC, local storage, SSH/Git/DB handlers
src/preload    Safe API bridge exposed to the renderer
src/renderer   React application, panels, dialogs, and UI components
src/shared     Shared TypeScript types
assets         Project images and branding assets
```

## GitHub Description

All-in-one desktop developer cockpit for SSH terminals, Git workflows, and PostgreSQL databases.

## License

MIT

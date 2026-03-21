# JiraSync Hub

JiraSync Hub is a cross-platform desktop workspace for syncing Jira tasks into a fast local app, editing them offline, tracking worklogs, and pushing only the changes that matter back to Jira.

![JiraSync Hub preview](docs/preview.png)

## Why It Exists

- Sync multiple Jira accounts into one desktop workspace.
- Keep task edits local first with Dexie + IndexedDB, then push dirty tasks back to Jira on demand.
- Log work, update fields, export CSV reports, and keep using the app even when the browser-side Jira APIs would normally trip over WebView cookie/XSRF issues.
- Ship the same app to Windows, macOS, and Linux with Electrobun.

## Key Features

- Multi-account Jira connections stored locally on the device.
- Background sync with dirty-task protection so local edits are not overwritten.
- Worklog creation and deletion synced through the Bun process.
- CSV export for reporting.
- Custom hidden titlebar with draggable regions and native window controls.
- Stable cross-platform packaging through GitHub Actions.

## Tech Stack

- Electrobun for the desktop shell and native packaging
- Bun for the main process and Jira proxy requests
- React + Vite for the renderer
- Tailwind CSS + shadcn/ui for the interface
- Zustand for app state
- Dexie / IndexedDB for local persistence

## Getting Started

```bash
bun install

# Bundled desktop dev build
bun run dev

# HMR renderer + Electrobun shell
bun run dev:hmr

# Local packaged build in dev mode
bun run build

# Stable release artifacts
bun run build:stable
```

The renderer entrypoint is `src/index.html`, which loads the React app from `src/mainview/main.tsx`. The desktop shell lives in `src/bun/index.ts`.

## Release Flow

- The repository keeps `0.1.0` as the base version.
- Production release versions come from Git tags such as `v0.1.3`.
- GitHub Actions patches `electrobun.config.ts` before each build so Electrobun artifacts use the tag version.
- Stable builds publish platform artifacts for Windows, macOS, and Linux, then attach them to the matching GitHub Release on tag pushes.

## Scripts

```bash
bun run lint
bun run test
bun run build:canary
bun run build:stable
bun run build:prod
```

## Packaging Notes

- Windows uses `assets/icon.ico`
- Linux uses `assets/icon.png` and bundles CEF by default
- macOS uses `icon.iconset`
- The GitHub Actions workflow targets `windows-2025`, `macos-15-intel`, and `ubuntu-24.04`

## Project Layout

```text
src/
  bun/         Bun + Electrobun main process
  mainview/    React renderer
docs/          Screenshots and docs assets
assets/        Cross-platform icon assets
icon.iconset/  macOS app icon set
```

## Uninstall

- Release artifacts now include OS-specific uninstall helpers generated during `postPackage`.
- Windows gets `*-uninstall.ps1` and `*-uninstall.cmd` helpers because Electrobun's installer flow does not document automatic uninstall registration.
- macOS gets a `*-uninstall.command` helper that removes the app bundle and local JiraSync Hub data.
- Linux gets a `*-uninstall.sh` helper that removes the extracted app directory, matching desktop entries, and local JiraSync Hub data.

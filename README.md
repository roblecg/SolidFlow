# SolidFlow

YAML E2E runner for Windows desktop apps (WebView2 / Tauri) with a plugin seam for mobile and web drivers later.

## Requirements

- Node.js >= 24.20
- Windows 11 (WebView2 runtime) for driving packaged Tauri apps
- Built **CIM Document Exporter** exe when running CIM flows (`SOLIDFLOW_APP_PATH`)

## Install

```sh
cd solidFlow
pnpm install
pnpm exec playwright-core install chromium
```

If `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS` for `esbuild`, ensure [`pnpm-workspace.yaml`](pnpm-workspace.yaml) contains `allowBuilds.esbuild: true` (already committed), then run `pnpm install` again. If you add new native deps later, run `pnpm approve-builds --all` once in this directory.

## Windows application

`pnpm studio` builds `bin/app/SolidFlow.exe` and opens SolidFlow in its own window. The window uses the Windows WebView2 runtime (already on Windows 11) and starts the local studio server. Closing the window stops that server.

The first time the window opens, a Select workspace dialog appears. Choose Documents, Desktop, or Browse. Browse opens Windows File Explorer with the title Select a SolidFlow workspace. SolidFlow remembers that folder and opens it next time. Use the Workspace control in the header to switch. Choosing a folder creates a SolidFlow workspace when those files are missing: `.solidflow/config.yaml`, a `flows/` directory, `flows/example.yaml` when the folder has no flows yet, and `README.md`. An older `.maestro` folder is renamed to `.solidflow`. Existing files are not overwritten. The flows panel is the project tree. Right-click a file or folder for New File, New Folder, and Show in Explorer. Each desktop flow names the exe it launches with `appPath`.

`pnpm studio:web` opens the same Studio in the browser. `pnpm oss` checks dependency licenses.

## CLI

| Command | Description |
| -------- | ------------- |
| `pnpm dev doctor` | Check Node, schema, Playwright, optional app path |
| `pnpm dev devices` | List local desktop targets |
| `pnpm dev test run <flow.yaml>` | Run a flow |
| `pnpm dev test watch <flow.yaml>` | Re-run on file change |
| `pnpm dev inspect <url\|flow>` | Dump hierarchy + screenshot |
| `pnpm dev record <url>` | Record interactions to YAML |
| `pnpm studio` | Open SolidFlow as a Windows application |
| `pnpm studio:web` | Open the same Studio in the browser |
| `pnpm app` | Same as `pnpm studio` |
| `pnpm oss` | Check that dependencies stay free and open source |
| `pnpm dev report open [dir]` | Open latest HTML report |

## Configuration

Flow meta is validated by `solidFlow doctor` (see `schema/flow.schema.json` for editor autocomplete).

Put the exe on the flow. Forward slashes are fine:

```yaml
appPath: "C:/path/to/other-app.exe"
name: Login validation
locale: en
tags: [smoke, login]
---
- launchApp
```

`SOLIDFLOW_APP_PATH` is used only when the flow has no `appPath`. It must be the full path to a built `.exe`.

- `SOLIDFLOW_ALLOW_SHELL=1` — enable `executeShellCommand` (argv only, cwd confined)
- `SOLIDFLOW_REPORT_DIR` — optional override. By default every run is saved in the workspace `test-results` folder.

Flows belong in the workspace folder you chose in SolidFlow (Documents, Desktop, or Browse). The SolidFlow application folder is not a workspace, and SolidFlow will not create `.solidflow`, `flows`, or `test-results` inside it.

## Studio

Create and run flows in the browser (device view, YAML editor, file list):

```bat
cd C:\Users\roblecg\Documents\depot\Projects\KCIM\Desktop\solidFlow
pnpm studio
```

The page opens at `http://127.0.0.1:4317`.

1. Open a flow and set `appPath` to the exe, then click **Connect app**.
2. **Inspect** shows a small preview. Click a control there and choose a command to insert YAML. **Pop out** opens that preview in a larger window.
3. **Record** listens to the real CIM window. Click and type there and each action is appended to the YAML.
4. Click **Run test**. The app window replays the steps. Reports land in the workspace `test-results` folder.

New files are saved under `flows/`.

## Flow example

```yaml
appPath: "C:/path/to/other-app.exe"
name: Login validation
locale: en
tags: [smoke, login]
---
- launchApp
- tapOn: "Continue"
- assertVisible: "Select a region."
- assertVisible: "Invalid organization name"
- takeScreenshot: login-errors
- stopApp
```

Fixture flows use `driver: chromium` and `appId: fixture.demo`.

## Reports

Each run writes a folder under the workspace `test-results` directory. The folder name is the local time and the flow name, for example `2026-09-25_19-23-05_login-validation`. A second run in the same second gets `_2` on the end.

Inside that folder:

- `report.html`, `report.json`, `junit.xml`
- `screenshots/` for a failed step, and for any `takeScreenshot` step

## Tests

```sh
pnpm test
```

Chromium fixture tests run without the Tauri binary. They use the practice login page shipped with SolidFlow, not a workspace inside the application folder.

## License

MIT

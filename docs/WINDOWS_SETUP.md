# Windows Setup for OpenCode Fusion Council

This guide covers installing and running the Fusion Council plugin on Windows using PowerShell.

## Requirements

- **Git for Windows** — <https://git-scm.com/download/win>
- **Node.js** — version `>=22` (see `engines` in `package.json`)
  - Download from <https://nodejs.org/>
  - Or install with a version manager such as [fnm](https://github.com/Schniz/fnm) or [nvm-windows](https://github.com/coreybutler/nvm-windows)
- **OpenCode** — installed and available on your machine

## Clone the repository

Open **PowerShell** and run:

```powershell
# Choose a projects folder, for example:
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\Projects" | Set-Location

git clone https://github.com/mustfsb/fusion.git opencode-fusion-council
Set-Location opencode-fusion-council
```

## Install dependencies

This repository uses **npm** and includes a `package-lock.json` lockfile:

```powershell
npm ci
```

If you prefer a manual install:

```powershell
npm install
```

## Build

```powershell
npm run build
```

The TypeScript compiler writes output to `dist\`. This directory is generated and is not committed to Git.

## Install Fusion slash commands into OpenCode

The plugin ships with OpenCode slash-command templates in `examples\commands\`. The included installer copies them into your user-wide OpenCode commands directory.

```powershell
npm run install:opencode-commands
```

Under the hood this copies the following files into `%USERPROFILE%\.config\opencode\commands\`:

- `fusion-build.md`
- `fusion-no-build.md`
- `fusion-decision.md`
- `fusion-model.md`
- `fusion-plan.md`
- `fusion-prompt.md`
- `fusion-review.md`
- `fusion-trace.md`

To verify the destination:

```powershell
Get-ChildItem "$env:USERPROFILE\.config\opencode\commands\fusion-*.md"
```

If you previously had unsupported or stale command files such as `fusion-status.md`, delete them manually so OpenCode does not show outdated commands.

## Register the plugin in OpenCode

Fusion Council registers three tools: `fusion_council`, `fusion_trace`, and `fusion_model_config`. The slash commands above invoke those tools. You still need to tell OpenCode to load the plugin itself.

Create or edit your OpenCode config file. The file location depends on where you keep your workspace config; a common location is `%USERPROFILE%\.config\opencode\opencode.config.jsonc`.

Add the plugin by **local build path** (recommended while developing or using a private clone):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "C:/Users/YOUR_USERNAME/Projects/opencode-fusion-council/dist/plugin.js"
  ]
}
```

Use forward slashes in the JSONC path, even on Windows — OpenCode resolves them correctly.

If you publish or `npm link` the package, you can instead reference it by package name:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-fusion-council"
  ]
}
```

To link the package locally after building:

```powershell
npm link
```

Then your OpenCode config can use `"opencode-fusion-council"` instead of the absolute path.

Restart OpenCode after editing the config, the plugin, or any command file.

## Verify the setup

### `/fusion-model`

Show the current model configuration:

```txt
/fusion-model
```

Set custom panel and judge models:

```txt
/fusion-model opencode-go/kimi-k2.7-code, opencode-go/qwen3.7-max, opencode-go/minimax-m3, openai/gpt-5.5
```

Reset to defaults:

```txt
/fusion-model reset
```

Model settings are saved to `%USERPROFILE%\.config\opencode\fusion-council-models.json`.

### `/fusion-trace`

After running a Fusion command, inspect the latest trace:

```txt
/fusion-trace
```

### `/fusion-build`

Run a candidate-build council:

```txt
/fusion-build Add server-side validation for signup emails and run the tests
```

Or use `/fusion-no-build` for advisory-only planning.

## Common Windows issues

### PowerShell execution policy

If you see an error about running scripts, you may need to allow local scripts:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

This is only needed if you run `.ps1` scripts directly; the npm scripts in this project run Node, not PowerShell scripts.

### Stale global command files

If a slash command behaves differently than the templates in `examples\commands\`, delete old copies:

```powershell
Remove-Item "$env:USERPROFILE\.config\opencode\commands\fusion-*.md"
npm run install:opencode-commands
```

### Node path or version mismatch

Confirm Node is on your PATH and meets the required version:

```powershell
node --version
npm --version
```

Expected: Node `v22` or newer. If you have multiple Node installations, make sure the correct one is first in your user PATH.

### Rebuilding after source changes

The `dist\` folder is generated. Rebuild after any change under `src\`:

```powershell
npm run build
```

Then restart OpenCode so it picks up the new `dist\plugin.js`.

### Plugin not found

- Verify the path in your OpenCode config points to `dist\plugin.js`.
- Confirm the file exists: `Test-Path "C:/Users/YOUR_USERNAME/Projects/opencode-fusion-council/dist/plugin.js"`.
- Use forward slashes in the config file.
- Restart OpenCode.

## Important: keep machine-local settings out of Git

The following are intentionally stored outside the repository and must **not** be committed:

- API keys and tokens — keep them in environment variables or a local `.env` file (`.env` is ignored by Git).
- Fusion model configuration — stored in `%USERPROFILE%\.config\opencode\fusion-council-models.json`.
- OpenCode run artifacts — stored under `.opencode\fusion-runs\` in your workspace.

Only source code, tests, examples, and build configuration belong in the repository.

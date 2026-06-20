# opencode-fusion-council

`opencode-fusion-council` is an OpenCode plugin and standalone CLI for running a multi-model council workflow.

```txt
User task
  -> panel models answer independently in parallel
  -> judge/orchestrator compares and synthesizes
  -> structured final result
```

It is not a majority-vote system. The judge identifies consensus, contradictions, partial coverage, unique insights, risks, missing considerations, and a mode-specific final recommendation.

## Defaults

Inside OpenCode, `modelSource: "auto"` uses OpenCode's configured model/provider system by default.

Panel models:

- `opencode-go/kimi-k2.7-code`
- `opencode-go/qwen3.7-max`
- `opencode-go/minimax-m3`

Judge/orchestrator model:

- `openai/gpt-5.5`

These IDs use OpenCode's `provider/model` format. For example, `opencode-go/kimi-k2.7-code` is provider `opencode-go` and model `kimi-k2.7-code`.

## When To Use

Use Fusion Council for:

- architecture decisions
- implementation planning
- major refactors
- code review
- build prompt generation
- provider/security/cost tradeoff analysis

Do not use it for:

- tiny bug fixes
- simple UI spacing changes
- obvious TypeScript errors
- every single coding task

## V1 Scope

V1 is read-only for repository content. It supports:

- core council engine
- standalone CLI
- OpenCode plugin tool named `fusion_council`
- OpenCode-native configured-model execution from the plugin
- direct HTTP provider adapters for CLI/fallback use
- safe context collection
- tests and examples

V1 does not apply patches, merge branches, create worktrees, run worktree builds, or modify repository files based on model output.

## Model Execution Modes

`modelSource` controls how model calls run:

- `auto`: inside OpenCode, use the OpenCode-native runner; outside OpenCode, use direct provider config.
- `opencode`: require OpenCode-native model execution and fail clearly if unavailable.
- `direct`: use `fusion-council.config.jsonc` model mappings and direct HTTP adapters.

Best case inside OpenCode: Fusion Council calls configured models through OpenCode's SDK client with `client.session.prompt`, passing `model: { providerID, modelID }`. This avoids duplicated API keys/base URLs in Fusion Council config.

Fallback: if you run the CLI outside OpenCode, or choose `modelSource: "direct"`, provide direct provider mappings in `fusion-council.config.jsonc`.

## Modes

- `plan`: produce an implementation plan.
- `review`: review selected files, current git diff, pasted task/context, or project metadata.
- `decision`: compare options and make a clear recommendation.
- `build_prompt`: generate a high-quality prompt for OpenCode, Claude Code, Codex, Cursor CLI, or similar tools.
- `architecture`: analyze system design, risks, tradeoffs, and migration strategy.

## Repository Layout

```txt
src/              TypeScript source
src/plugin.ts     OpenCode plugin entry point
src/cli.ts        Standalone CLI entry point
tests/            Vitest tests
examples/         Example configs and slash-command templates
examples/commands OpenCode slash-command markdown files
scripts/          Cross-platform helper scripts
docs/             Documentation
```

## Quick Start (macOS / Linux)

```bash
git clone https://github.com/mustfsb/fusion.git
cd opencode-fusion-council
npm ci
npm run build
```

For Windows, see [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md).

## Install OpenCode Slash Commands

The plugin provides slash-command templates in `examples/commands/`. Copy them into your OpenCode commands directory:

```bash
npm run install:opencode-commands
```

This installs the current supported commands into `~/.config/opencode/commands/` on macOS/Linux or `%USERPROFILE%\.config\opencode\commands\` on Windows. Restart OpenCode after installing or updating command files.

You can also copy them manually:

```bash
mkdir -p ~/.config/opencode/commands
cp examples/commands/*.md ~/.config/opencode/commands/
```

## Register the Plugin in OpenCode

OpenCode `1.17.4` was installed in the verified environment, so this package pins `@opencode-ai/plugin` to `1.17.4` to keep plugin tool/context types aligned with the runtime.

Published or linked package:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-fusion-council"]
}
```

Direct local build path:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./opencode-fusion-council/dist/plugin.js"]
}
```

Restart OpenCode after changing plugin, command, or config files.

The plugin registers:

```txt
fusion_council
fusion_trace
fusion_model_config
```

## OpenCode Commands

Use them in the TUI:

```txt
/fusion-plan Design the new auth flow
/fusion-review Check the current diff for regressions
/fusion-decision Should we use Supabase Edge Functions or a separate backend API?
/fusion-prompt Create a build prompt for fixing the price freshness banner
/fusion-build Add server-side validation for signup emails and run the requested tests
/fusion-no-build Build a tiny TypeScript library with the requested verification commands
/fusion-trace
/fusion-model
```

`/fusion-no-build` means advisory-council-assisted build, not "no implementation." Panels produce plans/checklists/risks/tests only (no candidate codebase), the judge synthesizes advisory guidance, and then the active OpenCode build agent implements the original task automatically.

`/fusion-build` is candidate-code-council-assisted build: panels produce advisory analysis plus complete candidate implementation proposals, the judge compares candidate code outputs and produces a build contract, and then the active OpenCode build agent implements the final repo automatically.

Use `/fusion-trace` to inspect the latest run's panel/judge statuses and artifact paths.

### `/fusion-model` — global model configuration

Configure panel and judge models globally (saved to `~/.config/opencode/fusion-council-models.json`):

```txt
/fusion-model panel1, panel2, panel3, judge
/fusion-model panel1/effort, panel2, panel3, judge/high
```

Each model spec uses `provider/model` or optional `provider/model/effort`.

Allowed effort values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.

Examples:

```txt
/fusion-model opencode-go/kimi-k2.7-code, opencode-go/minimax-m3, opencode-go/qwen3.7-max, openai/gpt-5.4/high
/fusion-model openai/gpt-5.4/medium, openai/gpt-5.4/medium, openai/gpt-5.4/medium, openai/gpt-5.4/xhigh
```

- Effort is optional; legacy `provider/model` syntax keeps working.
- Old saved string configs are migrated automatically on load.
- Effort is stored in config and trace metadata.
- As of `@opencode-ai/sdk@1.17.4`, `session.prompt` does not expose a typed `reasoningEffort` option; configured effort is preserved but reported as unsupported until the SDK adds support.

Other commands:

```txt
/fusion-model
/fusion-model reset
```

## Fusion Workflows

### `/fusion-no-build` — advisory-council-assisted build

```txt
/fusion-no-build + original prompt
→ 3 panel models produce advisory plans only
→ judge synthesizes advisory guidance
→ active OpenCode main agent automatically implements the original task
```

Panel models provide requirement checklists, implementation plans, risks, edge cases, test strategy, architecture guidance, do-not-break constraints, and packaging/build checklists. They do not produce full candidate codebases.

### `/fusion-build` — candidate-code-council-assisted build

```txt
/fusion-build + original prompt
→ 3 panel models produce advisory analysis + complete candidate code output
→ judge compares candidate implementations
→ active OpenCode main agent implements final codebase
```

Panel outputs are validated before judging. Incomplete candidate outputs trigger one repair call; if repair still fails, Fusion fails closed.

## Trace Artifacts

Every Fusion run writes trace artifacts by default under:

```txt
.opencode/fusion-runs/<runId>/
```

Each run directory includes:

- `trace.json`
- `original-prompt.md`
- `panel-1-prompt.md` / `panel-1-output.md` (and panels 2–3)
- `judge-prompt.md`
- `judge-output.md`
- `final-guidance.md`

The tool output and markdown result include run ID, artifact path, panel/judge statuses, fallback status, and candidate validation status for `/fusion-build`.

Inspect the latest run with `/fusion-trace` or open the artifact directory directly.

## Tool Arguments

```ts
{
  task: string;
  mode: "plan" | "review" | "decision" | "build_prompt" | "architecture";
  panelMode?: "advisory" | "candidate_build";
  files?: string[];
  includeDiff?: boolean;
  panelModels?: string[];
  judgeModel?: string;
  requireAllPanels?: boolean;
  minSuccessfulPanels?: number;
  allowDegradedJudge?: boolean;
  promptVerbosity?: "compact" | "standard" | "detailed";
  panelTimeoutMs?: number;
  judgeTimeoutMs?: number;
  panelMaxAttempts?: number;
  repairMaxAttempts?: number;
  repairTimeoutMs?: number;
  outputFormat?: "markdown" | "json";
  modelSource?: "auto" | "opencode" | "direct";
}
```

Example override through tool args:

```json
{
  "task": "Design the new auth flow",
  "mode": "plan",
  "panelModels": ["openai/gpt-5.5", "opencode-go/kimi-k2.7-code"],
  "judgeModel": "anthropic/claude-sonnet-4.6",
  "modelSource": "opencode"
}
```

## Plugin Options

Optional plugin registration options:

```jsonc
{
  "plugin": [
    ["opencode-fusion-council", {
      "saveRunArtifacts": true,
      "keepPanelSessions": false,
      "traceDir": ".opencode/fusion-runs",
      "verboseTrace": false
    }]
  ]
}
```

## CLI Usage

The CLI runs outside OpenCode, so `modelSource: "auto"` falls back to direct provider config.

```bash
fusion-council plan "Design a new auth flow"
fusion-council review --diff
fusion-council decision "Should we use Supabase Edge Functions or a separate backend API?"
fusion-council build-prompt "Create a build prompt for fixing the price freshness banner"
```

CLI options:

```txt
--mode <mode>            mode override
--task <task>            task text override
--file <path...>         selected files to include
--diff                   include current git diff
--panel <model...>       override panel model ids
--judge <model>          override judge model id
--panel-mode <mode>      advisory | candidate_build
--model-source <source>  auto | direct; opencode is plugin-only
--require-all-panels     fail before judging unless every requested panel succeeds
--panel-timeout-ms <ms>  timeout for each panel model attempt
--judge-timeout-ms <ms>  timeout for the judge model call
--panel-max-attempts <n> maximum attempts per panel model
--config <path>          config path
--json                   output raw JSON
--no-context             disable automatic context collection
```

Examples:

```bash
fusion-council plan --file src/auth.ts "Refactor auth token refresh"
fusion-council review --diff --json
fusion-council architecture --panel opencode-go/kimi-k2.7-code opencode-go/qwen3.7-max --judge openai/gpt-5.5 "Move billing into a separate service?"
```

## Direct Provider Config

For CLI or `modelSource: "direct"`, create `fusion-council.config.jsonc`:

```jsonc
{
  "defaults": {
    "panelModels": [
      "opencode-go/kimi-k2.7-code",
      "opencode-go/qwen3.7-max",
      "opencode-go/minimax-m3"
    ],
    "judgeModel": "openai/gpt-5.5",
    "timeoutMs": 480000,
    "maxPanelConcurrency": 3
  },
  "models": {
    "opencode-go/kimi-k2.7-code": {
      "provider": "openai-compatible",
      "model": "kimi-k2.7",
      "baseUrl": "https://your-openai-compatible-gateway.example/v1",
      "apiKeyEnv": "OPENCODE_GO_API_KEY"
    },
    "opencode-go/qwen3.7-max": {
      "provider": "openai-compatible",
      "model": "qwen3.7-max",
      "baseUrl": "https://your-openai-compatible-gateway.example/v1",
      "apiKeyEnv": "OPENCODE_GO_API_KEY"
    },
    "opencode-go/minimax-m3": {
      "provider": "openai-compatible",
      "model": "minimax-m3",
      "baseUrl": "https://your-openai-compatible-gateway.example/v1",
      "apiKeyEnv": "OPENCODE_GO_API_KEY"
    },
    "openai/gpt-5.5": {
      "provider": "openai-compatible",
      "model": "gpt-5.5",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  }
}
```

Environment variables for direct mode:

```bash
OPENCODE_GO_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_API_KEY=...
OPENROUTER_API_KEY=...
```

OpenRouter remains optional through the OpenAI-compatible adapter.

## Context Safety

Context collection can include current git diff, branch name, changed file list, selected files, and project metadata files such as `README.md`, `AGENTS.md`, `CLAUDE.md`, `package.json`, `tsconfig.json`, and OpenCode config files.

Hard exclusions:

```txt
.env
.env.*
node_modules
.git
dist
build
.next
coverage
*.pem
*.key
*.p12
*.sqlite
*.db
```

Likely secrets and bearer tokens are redacted before provider calls.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Tests use mocked runners and do not require real API keys.

## Machine-Local Settings Are Not Committed

The following are intentionally kept out of Git:

- API keys and tokens — use environment variables or a local `.env` file (`.env` is ignored).
- Fusion model configuration — saved to `~/.config/opencode/fusion-council-models.json`.
- OpenCode run artifacts — written to `.opencode/fusion-runs/` in the workspace.
- The `dist/` build output is generated and ignored.

Only source, tests, examples, and configuration belong in the repository.

## Troubleshooting

- Model not found in OpenCode: confirm the provider/model ID exists in OpenCode and use `provider/model` format.
- Missing API key in direct mode: set the `apiKeyEnv` variable referenced by `fusion-council.config.jsonc`.
- OpenCode-native runner unavailable: use the plugin inside OpenCode, or switch to `modelSource: "direct"` with direct provider config.
- One panel model times out or fails: the council continues if at least one panel succeeds and reports the failed model in panel status.
- All panel models fail: the judge is not run and the command fails clearly.
- Judge returns invalid JSON: the result falls back to raw judge text in `finalOutput` with `decision: "needs_more_info"`.

For Windows-specific setup and troubleshooting, see [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md).

## Limitations

- The OpenCode-native runner creates OpenCode sessions for each panel/judge call; sessions are deleted by default after each call unless `keepPanelSessions: true`.
- OpenCode does not expose a dedicated subagent API in the pinned plugin SDK; visible sessions plus trace artifacts are the supported observability path.
- Provider pricing/cost estimation is not implemented yet.
- Token counting is approximate via character limits, not provider tokenizers.
- Direct HTTP adapters do not support streaming, provider tool use, cache controls, or advanced reasoning controls.
- Slash command files cannot parse arbitrary flags themselves; use explicit tool args for complex overrides.

## Roadmap

- V1: planning/review/decision/prompt synthesis.
- V2: patch suggestion with user approval.
- V3: multi-worktree candidate implementation and test comparison.

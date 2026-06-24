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

## Native Subagent Orchestration

`/fusion-build` and `/fusion-no-build` default to the `native_subagents` execution mode. Instead of running panels and the judge through hidden SDK sessions, the fusion-orchestrator primary agent dispatches them as real OpenCode Task subagents:

- `fusion-panel-1`, `fusion-panel-2`, `fusion-panel-3` — independent panel subagents (one per configured panel model).
- `fusion-judge` — the judge/synthesizer subagent (configured judge model).

During a Fusion run, open the native child sessions created by `fusion-panel-1`, `fusion-panel-2`, `fusion-panel-3`, or `fusion-judge` to view their live tool use and reasoning progress. The parent `fusion-orchestrator` session shows the live todo state and receives each final result when the task completes.

The `fusion_native` plugin tool (stages `prepare`, `advance`, `collect`, `finalize`, `audit_prepare`, `audit_finalize`) handles the deterministic parts — fast run creation, deferred panel staging, staggered dispatch decisions, SHA-256 prompt hash, candidate validation tiers, quorum, judge prompt, judge parsing, final guidance, and trace artifacts — without ever calling a panel or judge model itself. In `/fusion-build`, `prepare` now returns quickly and `advance` owns the live runtime state machine. The trace records `executionMode: "native_subagents"`, `sharedPanelPromptHash` when materialized, `panelSessions`, `panelAttempts`, and runtime capability flags.

The prepare result returns the minimal run metadata immediately; `advance` then materializes candidate workspaces and returns deterministic `nextAction` decisions (`start_panel`, `wait`, `call_collect`, `done`) for the visible orchestrator.

### Staggered panel cascade and liveness watchdog

Native panel execution uses a staggered cascade with a start-gate fallback and a same-slot retry policy:

- **Panel 1 starts first.**
- **Panel 2 starts when Panel 1 produces its first observable output activity**, or after a **bounded fallback gate of about 45 seconds** when no credible activity is observable.
- **Panel 3 starts the same way** after Panel 2.
- The cascade retains staggered order — it never starts all remaining panels simultaneously.
- A silent or stuck Panel 2 does not block Panel 3 forever; the scheduler can bypass it through the bounded fallback gate.
- Each logical panel slot (`fusion-panel-1`, `fusion-panel-2`, `fusion-panel-3`) gets **one original attempt plus one replacement attempt** (`MAX_PANEL_ATTEMPTS = 2`). A retry uses the same configured model and the same canonical prompt/brief artifacts, and stays attached to the same logical panel index. The trace never creates `fusion-panel-4`.
- If a panel Task returns an error or times out, mark the attempt `stalled` and retry once. If the replacement also stalls or fails, mark that logical slot `failed` and continue using existing quorum semantics. Do not fabricate a candidate response.

**Liveness telemetry limitation (honest):** OpenCode's `task` tool from a primary agent may not expose child-session token streams, reasoning deltas, or tool lifecycle events to the caller. Fusion therefore layers detection truthfully: real child-session activity when available, then candidate workspace mutation or candidate-local output evidence, then bounded scheduler fallbacks. Polling alone never counts as activity. Automatic cancellation remains disabled unless runtime capability verification explicitly proves abort support; token-level liveness detection is not assumed. These limits are surfaced in trace fields such as `panelLivenessCapability`, `runtimeCapabilities`, and `streamActivityExposed`.

### Prompt transport compression

When a canonical shared panel prompt, judge context, or post-build audit context exceeds **50 physical lines**, Fusion switches to `brief_plus_file` transport mode instead of sending the entire prompt inline:

- **≤ 50 lines (`inline_full`)**: the full inline prompt is sent as today; no mandatory file-reading instructions are added.
- **> 50 lines (`brief_plus_file`)**: the complete canonical prompt is written to a full artifact file atomically before native Task dispatch; panels/judge/audit receive a compact inline navigation brief (≤ 50 lines, never padded artificially) that requires reading the full file first.

Physical line counting normalizes CRLF/LF and trailing newlines:

```ts
lineCount = text.trimEnd() === ""
  ? 0
  : text.trimEnd().split(/\r\n|\r|\n/).length;
```

Artifact names under `.opencode/fusion-runs/<runId>/`:

| Role | Full artifact | Brief artifact |
|------|---------------|----------------|
| Panel | `shared-panel-prompt.full.md` | `shared-panel-prompt.brief.md` |
| Judge | `judge-context.full.md` | `judge-context.brief.md` |
| Post-build audit | `post-build-audit-context.full.md` | `post-build-audit-context.brief.md` |

The full artifact is always the source of truth and is written byte-for-byte identical to the canonical prompt. The inline brief is navigation only — it must not be treated as an exhaustive specification. It contains only: a role/mode reminder, the mandatory file-read protocol, the task title, a compact headings list, the expected output format, and a reminder that the full file overrides the brief. It does **not** include generated Contract Gate identifier dumps, auto-extracted identifier lists, large Public Surface Matrix content, raw panel outputs, or massive requirement lists.

The mandatory file-read protocol requires the subagent to read the entire canonical file (continuing until EOF — reading only the first chunk is not sufficient) before reasoning, planning, or responding. If the subagent cannot read the full file, it must return exactly:

```txt
FUSION_FULL_PROMPT_UNAVAILABLE: <absolute-path>
```

Fusion records this as a validation failure (panels), judge failure, or degraded audit — never as a successful synthesis or audit.

Trace metadata includes `panelPromptTransport`, `judgePromptTransport`, and `auditPromptTransport` with canonical/inline line counts, SHA-256 hashes, and artifact paths. The `sharedPanelPromptHash` always hashes the canonical full prompt — not the inline brief. A separate `inlineSha256` is recorded for the inline transport text.

The legacy `fusion_council` tool (hidden SDK panel runner) remains available for `/fusion-plan`, `/fusion-review`, `/fusion-decision`, `/fusion-prompt`, and `/fusion-architecture`, and as a debug fallback. `/fusion-build` and `/fusion-no-build` do not use it.

OpenCode loads agent definitions once at startup and does not hot-reload them. After running `/fusion-model set ...` (which regenerates the agent files) or `npm run install:opencode-agents`, restart OpenCode so the new agent definitions take effect.

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

## Install OpenCode Slash Commands and Agents

The plugin provides slash-command templates in `examples/commands/` and native subagent agent definitions. Install both with one command:

```bash
npm run install:opencode-agents
```

This installs the supported commands into `~/.config/opencode/commands/` and writes the Fusion native agents (`fusion-orchestrator`, `fusion-panel-1`, `fusion-panel-2`, `fusion-panel-3`, `fusion-judge`) into `~/.config/opencode/agent/` on macOS/Linux or `%USERPROFILE%\.config\opencode\agent\` on Windows. The installer uses Node's `os.homedir()` and never touches unrelated user agent files. Restart OpenCode after installing or updating command/agent files.

To install only the slash commands (without the native agents):

```bash
npm run install:opencode-commands
```

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
fusion_council      (legacy all-in-one council, hidden SDK panels — used by /fusion-plan, /fusion-review, etc.)
fusion_native       (native-subagent orchestration: prepare/advance/collect/record_main_baseline/finalize/audit_* — used by /fusion-build, /fusion-no-build)
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

`/fusion-no-build` runs the full native council (panels + judge) and then STOPS with final guidance. It does not edit implementation files, create candidate workspaces, or allow panel writes. Use it when you want the advisory plan and contract without automatic implementation.

`/fusion-build` is speculative parallel build: panels produce complete competing candidate builds in isolated workspaces while the main agent independently builds the real-workspace baseline. The judge then compares actual implementations and produces a Merge Patch Contract. The main agent applies only approved targeted patches rather than merging candidate code wholesale.

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

### `/fusion-no-build` — advisory-council-assisted planning only

```txt
/fusion-no-build + original prompt
→ 3 panel models produce advisory plans only
→ judge synthesizes advisory guidance
→ STOP (no implementation, no candidate workspaces, no panel writes)
```

`/fusion-no-build` remains planning-only. Panel models provide requirement checklists, implementation plans, risks, edge cases, test strategy, architecture guidance, do-not-break constraints, and packaging/build checklists. They do not produce full candidate codebases and do not edit files.

### `/fusion-build` — speculative parallel build

```txt
/fusion-build + original prompt
→ Stage 0: isolated candidate workspaces
→ visible native fusion-panel-1/2/3 build competing candidates in those workspaces
→ main agent independently builds a real-workspace baseline before seeing panel output
→ visible native fusion-judge compares actual implementations and verification evidence
→ judge writes a Merge Patch Contract
→ main agent applies only approved targeted patches
→ final typecheck/test/build
→ post-build audit + one fix cycle
```

Internal mode name:

```txt
speculative_parallel_build
```

The old behavior where panels analyze first and the main agent only builds later is gone.

Panels build in isolated candidate workspaces, not in the real user workspace. The main agent remains the only agent that writes to the real workspace.

Fusion run artifacts may be stored in the project workspace.

Speculative panel candidate workspaces are always created in an external Fusion cache/staging directory to prevent recursive source copying and to protect the real workspace. External candidate workspaces are retained after runs for debugging.

`/fusion-build` is slower and more expensive than the old plan-first orchestration because it overlaps:

- isolated panel candidate builds
- an independent main baseline build
- a judge comparison pass
- a post-build audit pass

Panel outputs are still validated before judging. Incomplete candidate outputs trigger the existing validation/quorum handling and the run fails closed when safe comparison cannot be established.

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

For `/fusion-build` speculative runs, the run directory also includes artifacts such as:

- `baseline-manifest.json`
- `baseline-summary.md`
- `panel-1-report.md` (and panels 2–3)
- `panel-1.patch` (and panels 2–3)
- `main-baseline-manifest.json`
- `main-baseline.patch`
- `merge-patch-contract.full.md`

Writable panel candidate workspaces and per-panel manifests are stored outside the project in the Fusion cache/staging directory:

- macOS: `~/Library/Caches/opencode-fusion-council/speculative-runs/<runId>/panel-*-workspace`
- Windows: `%LOCALAPPDATA%/opencode-fusion-council/speculative-runs/<runId>/panel-*-workspace`
- Linux: `$XDG_CACHE_HOME/opencode-fusion-council/speculative-runs/<runId>/panel-*-workspace` (or `~/.cache/...`)

External candidate workspaces are retained after runs for debugging.

The speculative trace also reports honest runtime fields such as `parallelExecutionSupported`, `overlapObserved`, `overlapDurationMs`, `parallelCapabilityLimitation`, `isolationCapability`, `mainBaseline`, `panelCandidates`, `mergePatchDecision`, and `appliedPatchItems`.

The tool output and markdown result include run ID, artifact path, panel/judge statuses, fallback status, and candidate validation status for `/fusion-build`.

### `/fusion-resume` — recover orphaned speculative runs

Use `/fusion-resume` when a speculative `/fusion-build` was interrupted or left orphaned (for example, collect/finalize ran with an empty run ID). Recovery:

- searches the current workspace only for one coherent orphaned attempt;
- validates orphan artifacts before reuse and never silently guesses;
- reuses a validated main baseline already present in the real workspace;
- reruns only missing or invalid logical panel slots (`fusion-panel-1/2/3`);
- creates a new valid recovered run ID under `.opencode/fusion-runs/<runId>/`.

It does not revive an invalid empty run ID directly and does not rebuild the main baseline from scratch when reuse checks pass.

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

- `/fusion-build` and `/fusion-no-build` run panels and the judge as native OpenCode Task subagents (`fusion-orchestrator` + `fusion-panel-1/2/3` + `fusion-judge`). The parent session shows the live todo list and each child session is inspectable in the OpenCode UI while it runs; a token-by-token merged live transcript inside the parent message is not provided.
- OpenCode's native task runtime does not expose per-task CWD override or path-scoped write permissions to the caller. `/fusion-build` therefore reports isolation honestly: candidate workspaces are verified directory-level isolation (separate copies, no hard links, symlink safety), not runtime-enforced CWD/write boundaries.
- If true non-blocking native overlap cannot be verified, `/fusion-build` reports `parallelExecutionSupported: false` and aborts before implementation. It does not silently run sequentially and does not claim overlap.
- OpenCode loads agent definitions once at startup. After `/fusion-model set ...` regenerates agent files, restart OpenCode so the new panel/judge models take effect.
- The legacy `fusion_council` tool (used by `/fusion-plan`, `/fusion-review`, `/fusion-decision`, `/fusion-prompt`, `/fusion-architecture`) still runs panels through OpenCode SDK sessions and deletes them by default unless `keepPanelSessions: true`.
- Judge reasoning effort is preserved as the agent `variant` field when supported by the installed OpenCode version; otherwise it is recorded in config/trace metadata only.
- Provider pricing/cost estimation is not implemented yet.
- Token counting is approximate via character limits, not provider tokenizers.
- Direct HTTP adapters do not support streaming, provider tool use, cache controls, or advanced reasoning controls.
- Slash command files cannot parse arbitrary flags themselves; use explicit tool args for complex overrides.

## Roadmap

- V1: planning/review/decision/prompt synthesis.
- V2: patch suggestion with user approval.
- V3: richer speculative candidate comparison, stronger runtime isolation primitives, and deeper implementation/test evidence synthesis.

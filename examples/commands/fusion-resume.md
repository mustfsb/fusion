---
description: Recover an interrupted or orphaned speculative /fusion-build run without rebuilding a valid main baseline
agent: fusion-orchestrator
---
You are running `/fusion-resume` as the `fusion-orchestrator`.

This command **recovers interrupted or orphaned speculative `/fusion-build` attempts**. It is a recovery command, not another build mode.

Use only the `fusion_native` tool for deterministic discovery, validation, run-state creation, and quorum logic. Do **not** use hidden SDK/provider calls. Panels and the judge still run only as visible native Task subagents when reruns or judging are required.

## What `/fusion-resume` does

1. Searches the **current workspace only** for a single coherent orphaned speculative attempt.
2. Validates orphan artifacts before reuse — it **never silently guesses**.
3. Validates the **main baseline already present in the real workspace** and reuses it when identity checks pass.
4. Validates existing panel candidate workspaces and reports where present.
5. Creates a **new non-empty recovered run ID** and a normal run directory under `.opencode/fusion-runs/<runId>/`.
6. Migrates only validated artifacts into that recovered run directory.
7. If usable panel quorum already exists: proceed to **fusion-judge → targeted patch → audit**.
8. If quorum is missing: rerun **only missing or invalid logical panel slots** (`fusion-panel-1`, `fusion-panel-2`, `fusion-panel-3`). Never create `fusion-panel-4`.

It does **not** revive an invalid empty run ID directly. It does **not** ask the main agent to rebuild the original task from scratch when the main baseline is valid.

## Step 1 — Determine the run type

First, check whether the run is a `hybrid_external_main_native_panels` supervisor run.
Look for `supervisor-state.json` under `.opencode/fusion-runs/<runId>/`.

If `supervisor-state.json` exists, resume the detached supervisor instead of the
legacy native-subagent flow:

```json
{ "stage": "resume", "runId": "<runId>" }
```

via the `fusion_supervisor` tool. Supervisor resume inspects live worker PIDs,
recovers completed worker result artifacts, reuses completed valid workers
(it never reruns a valid completed main implementation or valid completed
panel), promotes a completed main candidate if not yet promoted, and resumes the
judge stage when prerequisites are already met.
The supervisor state alone is sufficient to continue after OpenCode restart,
plugin reload, or parent chat closure. Use `{ "stage": "status", "runId": "<runId>" }`
first to inspect live PIDs and the concurrency verdict.

Only if no `supervisor-state.json` exists (an actual legacy run), proceed to the
legacy native-subagent resume below.

## Step 2 — Legacy resume discovery and validation

Call `fusion_native` with stage `resume`:

```json
{
  "stage": "resume",
  "runId": "$ARGUMENTS",
  "minSuccessfulPanels": 2,
  "allowDegradedJudge": true
}
```

Omit `runId` when you want the existing safe orphan discovery behavior. Pass a concrete run ID such as `fusion-20260624-183742-39fc7a` when recovering a completed or terminal trace directory in place.

Do NOT pass `panelModels` or `judgeModel` unless the user explicitly overrode them.

Read the resume result. It returns at minimum:

- `runId` (new recovered run ID)
- `traceArtifactDir`
- `runStatePath`
- `recovery` metadata (`recovered`, `recoveredFromRunId`, `orphanSourceArtifactRoot`, `originalSharedPromptHash`, `mainBaselineReused`, `recoveredPanelIndexes`, `invalidPanelIndexes`)
- `mainBaseline` (reused when validation passed)
- `judgeEligible`
- `quorum`
- `recoveredPanelResults`
- `panelsToRerun`
- `panelAgents`
- `panelExecutionPlan`
- `judgeAgent`
- `todoPlan`
- `speculative`

If resume throws `FUSION_RESUME_NOT_FOUND` or `FUSION_RESUME_AMBIGUOUS`, stop and report the error. Do not guess.

## Step 3 — Rerun only missing/invalid panel slots (if needed)

If `panelsToRerun` is non-empty:

- Dispatch each listed panel using its **same logical slot** (`fusion-panel-1/2/3`) and its `inlineDispatchPrompt`.
- Keep validated recovered panels as-is; do not rebuild them.
- Use normal cascade / same-slot retry behavior.
- Do **not** redo the main baseline build.

When reruns finish, call `fusion_native` stage `collect` with the **recovered `runId`**, merging:

- `recoveredPanelResults` from the resume result, plus
- fresh results from any rerun panels.

Also pass `mainBaseline` from the resume result (already reused).

## Step 4 — Judge when quorum is ready

When `judgeEligible` is true (or collect returns `shouldProceed: true`):

1. Dispatch `fusion-judge` with the `judgeTransportPrompt` from collect.
2. Call `fusion_native` stage `finalize` with the recovered `runId` and judge output.
3. Apply only approved targeted patches from the Merge Patch Contract.
4. Run `audit_prepare` → audit judge → `audit_finalize` when enabled for build flows.
5. Run final verification once.

## Hard rules

- Prefer `fusion_supervisor` resume for any run that has `supervisor-state.json`.
- Never use `.` or the source workspace itself as the trace artifact directory.
- Never call collect/finalize with an empty run ID.
- Never treat orphan root artifacts as a valid normal run without resume validation.
- Preserve visible native panel/judge behavior, external candidate staging, Contract Gate, Council Comparison Dossier, Merge Patch Contract, Correctness Coverage Gate, post-build audit, and one-fix-cycle semantics.

Final response must include: recovered run ID, trace artifact path, recovery metadata, main baseline reuse status, recovered vs invalid panel indexes, quorum, judge eligibility, and verification results.

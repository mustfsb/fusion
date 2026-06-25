---
description: Parallel main build + isolated panel candidate builds, then judge patch contract, targeted patching, and final audit
agent: fusion-orchestrator
---
You are running `/fusion-build` as the `fusion-orchestrator`.

Panels and the judge MUST run as visible native OpenCode Task subagents (3 panel subagents plus judge):

- `fusion-panel-1`
- `fusion-panel-2`
- `fusion-panel-3`
- `fusion-judge`

Do NOT use the legacy all-in-one `fusion_council` tool for this command.
Do NOT use hidden SDK runners, direct provider calls, or background model HTTP calls.
Use `fusion_native` for deterministic orchestration state only.

Pass the exact user task text through without rewriting: `$ARGUMENTS`

## Default execution mechanism: real_parallel_process_build

The DEFAULT `/fusion-build` engine is `real_parallel_process_build`, driven by a
detached Node process supervisor. It does not depend on the parent model calling
advance, on prompt sleeps, on panel activity gates, on panel completion before
main work, or on manual continuation. Use the `fusion_supervisor` tool:

```json
{ "stage": "launch", "task": "$ARGUMENTS", "command": "fusion-build" }
```

`launch` performs a minimal safe bootstrap (immutable source snapshot, isolated
candidate workspaces, canonical task artifact) and then spawns a detached
supervisor that immediately launches four real concurrent OpenCode CLI worker
processes without awaiting any of them:

```txt
T+0s  immutable source snapshot complete
T+0s  fusion-main-builder spawned   (real source workspace)
T+0s  fusion-panel-1 spawned        (isolated candidate workspace)
T+0s  fusion-panel-2 spawned        (isolated candidate workspace)
T+0s  fusion-panel-3 spawned        (isolated candidate workspace)
```

The supervisor monitors all four as independent processes (PIDs, stdout/stderr
activity, result-artifact writes, workspace mutations, exit codes), launches the
visible judge only after main AND all three panels are terminal, writes a Merge
Patch Contract, runs the patch worker on `PATCH_REQUIRED`, and performs final
verification + audit. It survives parent/orchestrator session closure, OpenCode
restart, and plugin reload. Poll progress with
`{ "stage": "status", "runId": "<runId>" }` and continue an interrupted run with
`{ "stage": "resume", "runId": "<runId>" }` (completed valid workers are reused,
never rerun). The trace renders an explicit
`REAL_PARALLEL_EXECUTION_CONFIRMED` / `REAL_PARALLEL_EXECUTION_NOT_CONFIRMED`
verdict from true process-interval overlap.

The legacy `speculative_parallel_build` native-subagent flow below is retained
only as a non-default compatibility fallback.
Never add `/fusion-spec-build`.

## Step 1: Fast Prepare

Call `fusion_native` with stage `prepare`:

```json
{
  "stage": "prepare",
  "task": "$ARGUMENTS",
  "mode": "build_prompt",
  "panelMode": "candidate_build",
  "buildStrategy": "speculative_parallel_build",
  "promptVerbosity": "compact",
  "command": "fusion-build",
  "requireAllPanels": false,
  "minSuccessfulPanels": 2,
  "allowDegradedJudge": true,
  "parallelExecutionSupported": true
}
```

Do NOT pass `panelModels` or `judgeModel` unless the user explicitly overrode them.

Prepare must return quickly with:

- `runId`
- `traceArtifactDir`
- `runStatePath`
- `canonicalTaskPath`
- `canonicalTaskHash`
- `panelAgents`
- `panelExecutionPlan`
- `judgeAgent`
- `todoPlan`
- `speculative.pathResolution`

In `/fusion-build`, prepare is intentionally minimal. It must not wait for:

- candidate workspace copying
- panel readiness
- panel output
- judge setup

Immediately call `todowrite` with the returned `todoPlan`.

## Step 2: Start the Main Baseline Immediately

Immediately after successful minimal prepare, before any panel staging or dispatch:

1. Record the main baseline start through the real lifecycle route:

```json
{
  "stage": "advance",
  "runId": "<runId>",
  "mainBaselineStartedAt": "<ISO timestamp>"
}
```

`mainBaselineStartedAt` records authorization only (the parent is permitted to begin). It is intentionally distinct from first real work.

2. Begin implementation in the real source workspace right away. As soon as you perform the first real workspace operation that changes or intentionally inspects implementation state, record it once:

```json
{
  "stage": "advance",
  "runId": "<runId>",
  "mainBaselineFirstWorkAt": "<ISO timestamp of the first real workspace operation>"
}
```

`mainBaselineFirstWorkAt` must be a real first-work marker, never fabricated before work begins. If it lands after any panel terminal result, the runtime records the hard violation `MAIN_BASELINE_SERIALIZED_BEHIND_PANELS` in the trace.

Do NOT wait for:

- candidate workspace copying
- shared panel prompt materialization
- Panel 1 dispatch
- Panel 1 activity
- Panel 2/3 cascade logic
- any heavy panel-only preparation

When advance returns `nextAction.type = "wait"` with `delayMs: 0` after this recording call, that means main baseline start was persisted and panel staging is deferred to the next advance tick. Proceed with real workspace implementation and call advance again for panel scheduling.

Implement the user task normally in the real workspace:

- inspect files
- edit code
- add or update tests
- run verification

Until the baseline is terminal, do NOT read:

- panel reports
- panel candidate code
- panel patches
- judge conclusions
- merge patch contract

## Step 3: Deterministic Advance Loop for Panel Scheduling

While the main baseline continues, `fusion_native advance` is the runtime driver for panel work. It owns:

- isolated candidate workspaces per panel slot
- shared task materialization
- staggered panel dispatch decisions
- credible activity tracking
- bounded fallback gates
- same-slot retry
- judge eligibility

Call advance at deterministic checkpoints while main baseline work continues:

```json
{
  "stage": "advance",
  "runId": "<runId>"
}
```

Never make main baseline startup depend on these panel actions.

Read `nextAction`.

### If `nextAction.type` is `start_panel`

Dispatch exactly the returned panel:

- `subagent_type`: `nextAction.agentName`
- `prompt`: `nextAction.prompt`
- `description`: `Fusion Panel <logical slot>`

In speculative mode the returned prompt is panel-specific and already bound to that panel's candidate workspace. Do NOT substitute `panelTransportPrompt` here.

Immediately call `fusion_native advance` again with the dispatch event:

```json
{
  "stage": "advance",
  "runId": "<runId>",
  "panelDispatches": [
    {
      "logicalPanelIndex": 1,
       "startReason": "initial_immediate",
      "startedAt": "<ISO timestamp>",
      "taskId": "<if available>",
      "sessionId": "<if available>"
    }
  ]
}
```

### Absolute stagger schedule (not activity-gated)

Panel launch timing is driven by a persisted, monotonic absolute schedule, not by previous-panel activity, output, success, failure, or your own reasoning about elapsed time:

```txt
Panel 1: launch immediately once the launch packet is ready (delay 0)
Panel 2: launch at launch-clock anchor + 60 seconds
Panel 3: launch at launch-clock anchor + 120 seconds
```

`advance` persists `speculative.panelLaunchSchedule` with each panel's `plannedDispatchAt`. Panel 2 never waits for Panel 1, and Panel 3 never waits for Panel 2 — a stuck or silent earlier panel cannot delay a later scheduled launch. Same-slot retries fire immediately (`launchReason: "recovery_rerun"`) and never shift the original Panel 2/3 schedule.

### If `nextAction.type` is `wait`

Obey the returned scheduler deadline. Do not invent your own timer.

- Use `nextAction.delayMs` (this is the time until the next panel's `plannedDispatchAt`)
- Wait only for that returned delay while you keep working the main baseline
- Call `fusion_native advance` again when it expires; the persisted schedule launches each panel on time even if you call slightly late

Activity detection still runs for tracing, stall diagnosis, and same-slot retry. A bounded silent-panel liveness fallback gate (about 45 seconds without credible activity) only affects diagnostics and retry eligibility — it does not gate the original Panel 2/3 launches, which fire purely on `plannedDispatchAt`. A silent or stuck Panel 2 must not block Panel 3 forever. This replaces any `sleep 60` or wait-for-panel-activity orchestration.

When a scheduled launch arrives the action is `start_panel` with `startReason: "scheduled_delay"` and `launchReason: "scheduled_delay"`.

This is the live staggered cascade.

### If `nextAction.type` is `call_collect`

The main baseline is terminal and usable panel quorum is ready. Move to collect immediately. Do not wait for a failed or silent third panel.

### If `nextAction.type` is `done`

Stop and report the reason honestly.

## Step 4: Feed Back Real Activity Only

While panels run, keep an accumulated `panelResults` array from real Task completions.

Only send `panelObservations` when they are real. Valid credible activity includes:

- non-empty assistant output
- non-empty reasoning output
- tool call start
- tool call completion
- tool result
- candidate workspace source or test file mutation
- candidate-local report or notes write
- terminal result

Do not count:

- polling
- scheduler ticks
- task creation alone
- placeholder messages
- fake progress
- empty output

If the runtime exposes no real child-session activity, that is fine. Keep calling `advance` on its returned wait deadlines and on real panel completions. Do not fabricate telemetry.

If `advance` returns `start_panel` with `startReason: "recovery_rerun"`, redispatch the SAME logical slot. Never create `fusion-panel-4`.

Do not automatically cancel panels unless Fusion runtime capability reporting explicitly says cancellation/abort is supported. Current default behavior is conservative.

## Step 5: Record the Terminal Main Baseline

When the main baseline reaches a terminal state, call `record_main_baseline`:

```json
{
  "stage": "record_main_baseline",
  "runId": "<runId>",
  "mainBaseline": {
    "startedAt": "<ISO>",
    "completedAt": "<ISO>",
    "status": "passed",
    "workspacePath": "<real workspace absolute path>",
    "changedFiles": ["<relative path>"],
    "verification": {
      "typecheck": "pass",
      "test": "pass",
      "build": "pass",
      "commandsRun": ["npm run typecheck", "npm test", "npm run build"]
    }
  }
}
```

Use `failed` or `blocked` when appropriate. Main baseline failure is still terminal and must not deadlock the orchestration.

## Step 6: Collect and Judge

When `advance` returns `call_collect`, call:

```json
{
  "stage": "collect",
  "runId": "<runId>",
  "panelResults": [
    { "agentName": "fusion-panel-1", "modelId": "<panel 1 model>", "content": "<panel 1 text>" },
    { "agentName": "fusion-panel-2", "modelId": "<panel 2 model>", "error": "timed out", "errorType": "timeout" }
  ]
}
```

You may omit a missing late panel. `collect` will use the persisted run-state and current quorum rules. It returns:

- `shouldProceed`
- `reason`
- `quorum`
- `judgeTransportPrompt`
- `judgeAgent`
- `panelAttempts`
- `todoUpdates`
- `speculative`

`collect` also records actual overlap between the main baseline and panel attempts when both intervals are known.

Call `todowrite` with `todoUpdates`.

If `shouldProceed` is false, stop and report the reason honestly.

Judge dispatch is quorum-first: as soon as the main baseline is terminal AND at least 2 usable panel candidates exist, the candidate subset is frozen, `judgeEligibleAt` is persisted, and the judge dispatches immediately. A third panel that is still running, stalled, retrying, or late becomes `late_excluded` for that judge run.

The judge starts lean. `advance` writes an incremental `judge-preflight-manifest.json` (path in `speculative.judgeManifestPath`) as panels reach a usable/terminal state — compact navigational evidence only (candidate paths, report paths, classifications), never inlined source trees. The `judgeTransportPrompt` carries task artifact path/hash, the main workspace and verification summary paths, usable candidate workspace paths, panel report paths, and the Council Comparison / Contract Gate / decision-matrix artifact paths. The judge inspects candidate files selectively from those paths; it does not receive full candidate source trees, huge diffs, or duplicated task text in its initial context.

If `shouldProceed` is true:

1. Dispatch visible `fusion-judge` with `judgeTransportPrompt`
2. Immediately record the judge dispatch:

```json
{
  "stage": "advance",
  "runId": "<runId>",
  "judgeDispatched": {
    "startedAt": "<ISO timestamp>",
    "taskId": "<if available>",
    "sessionId": "<if available>"
  }
}
```

3. Wait for the real judge result
4. Call `finalize`

## Step 7: Apply the Merge Patch Contract

Call `finalize`:

```json
{
  "stage": "finalize",
  "runId": "<runId>",
  "judgeOutput": "<judge result text>",
  "judgeSessionId": "<judge child session id if available>"
}
```

Read the Merge Patch Contract. Apply only approved targeted patches:

- Apply all `BLOCKER`
- Apply all `MUST_FIX`
- Apply `SAFE_ADDITION` only when explicitly low-risk and non-breaking
- Never apply `REJECTED`

Do not copy an entire candidate workspace into the real project.

## Step 8: Audit and Final Verification

After targeted patching:

1. Run real project verification:
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
2. Call `audit_prepare`
3. Run post-build contract audit by dispatching visible `fusion-judge` for the post-build audit
4. Call `audit_finalize` with `appliedPatchItems`
5. Preserve the existing one-fix-cycle behavior

The post-build audit, Correctness Coverage Gate, Council Comparison Dossier, Contract Gate, and Merge Patch Contract behavior must remain intact.

## Final Response Requirements

Final response must include:

- Fusion run ID
- execution mode `native_subagents`
- build strategy `speculative_parallel_build`
- artifact path
- shared panel prompt hash
- panel agent names and model IDs
- panel success and validation status
- panel attempt summary
- main baseline status
- quorum
- Merge Patch Contract decision
- applied patch items
- post-build audit status
- verification results

Also surface the launch/overlap/judge timeline from the persisted run-state:

```txt
Launch:
- run launch requested (speculative.runLaunchRequestedAt)
- main authorized (mainBaseline.startAuthorizedAt)
- main first work (mainBaseline.firstWorkAt)
- panel 1/2/3 planned vs dispatched (speculative.panelLaunchSchedule[*].plannedDispatchAt / dispatchAt / scheduleSkewMs)

Overlap:
- main vs panel overlap (speculative.overlapObserved / overlapDurationMs)

Judge:
- judge eligible (speculative.judgeEligibleAt)
- judge dispatched (speculative.judgeDispatchAt)
- candidate subset frozen (speculative.frozenPanelIndexes) / late excluded (speculative.lateExcludedPanelIndexes)

Warnings:
- orchestration violations (speculative.orchestrationViolations), including MAIN_BASELINE_SERIALIZED_BEHIND_PANELS
```

Tell the user they can inspect `fusion-panel-1/2/3` and `fusion-judge` child sessions in the OpenCode UI, and they can inspect raw artifacts via `/fusion-trace`.

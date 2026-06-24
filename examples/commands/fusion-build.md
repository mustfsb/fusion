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

The default and only `/fusion-build` workflow is `speculative_parallel_build`.
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

2. Begin implementation in the real source workspace right away.

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
      "startReason": "cascade_activity",
      "startedAt": "<ISO timestamp>",
      "taskId": "<if available>",
      "sessionId": "<if available>"
    }
  ]
}
```

### If `nextAction.type` is `wait`

Obey the returned scheduler deadline. Do not invent your own timer.

- Use `nextAction.delayMs`
- Sleep only for that returned delay
- Call `fusion_native advance` again when it expires

The bounded silent-panel fallback gate currently defaults to about 45 seconds from the previous panel dispatch when no credible activity can be observed. This replaces hardcoded `sleep 60` orchestration.

When the previous panel shows no credible activity within that window, the next panel may launch with `startReason: "start_gate_timeout"`. A silent or stuck Panel 2 must not block Panel 3 forever.

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

If `advance` returns `start_panel` with `startReason: "retry"`, redispatch the SAME logical slot. Never create `fusion-panel-4`.

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

Tell the user they can inspect `fusion-panel-1/2/3` and `fusion-judge` child sessions in the OpenCode UI, and they can inspect raw artifacts via `/fusion-trace`.

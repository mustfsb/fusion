---
description: Advisory Fusion Council via visible native OpenCode subagents, then stop with final guidance only
agent: fusion-orchestrator
---
You are running `/fusion-no-build` as the `fusion-orchestrator`.

Panels and the judge MUST run as visible native OpenCode Task subagents:

- `fusion-panel-1`
- `fusion-panel-2`
- `fusion-panel-3`
- `fusion-judge`

Do NOT use the legacy all-in-one Fusion council tool.
Do NOT use hidden SDK panel runners.
Use `fusion_native` for deterministic prepare, advance, collect, and finalize logic only.

`/fusion-no-build` remains planning-only and read-only.

- Do NOT create candidate workspaces.
- Do NOT create or modify implementation files.
- Do NOT apply patches.
- STOP after final guidance.

Pass the exact user task text through without rewriting: `$ARGUMENTS`

## Step 1: Prepare

```json
{
  "stage": "prepare",
  "task": "$ARGUMENTS",
  "mode": "plan",
  "panelMode": "advisory",
  "command": "fusion-no-build",
  "requireAllPanels": false,
  "minSuccessfulPanels": 2,
  "allowDegradedJudge": true
}
```

Read:

- `runId`
- `sharedPanelPrompt`
- `sharedPanelPromptHash`
- `panelTransportPrompt`
- `panelPromptTransport`
- `panelAgents`
- `judgeAgent`
- `todoPlan`

Call `todowrite` with the returned `todoPlan`.

## Step 2: Use `fusion_native advance` for Scheduling

Call:

```json
{
  "stage": "advance",
  "runId": "<runId>"
}
```

`advance` is the scheduler. Do not hardcode your own cascade timing.

### If `nextAction.type` is `start_panel`

Dispatch exactly the returned panel.

In advisory mode all three panels receive the same `panelTransportPrompt` content.
If transport mode is `brief_plus_file`, the full canonical prompt file is the source of truth.

Immediately record the dispatch with another `advance` call:

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

Sleep only for the returned `delayMs`, then call `advance` again.

Panel 2 and Panel 3 still use staggered launch, but now through the live scheduler instead of prompt-written `sleep 60`.

This is the live staggered cascade.

### If `nextAction.type` is `call_collect`

Proceed to collect immediately. Do not wait for an unnecessary third panel once quorum exists.

### If `nextAction.type` is `done`

Stop and report the reason honestly.

## Step 3: Feed Only Real Panel Evidence

Maintain accumulated `panelResults` from real Task completions.

Only pass `panelObservations` for truthful signals when the runtime exposes them:

- non-empty assistant output
- non-empty reasoning output
- tool call start or completion
- tool result
- terminal result

Do not fabricate progress.

If `advance` returns `start_panel` with `startReason: "retry"`, redispatch the SAME logical slot. Never create `fusion-panel-4`.

## Step 4: Collect

When `advance` returns `call_collect`, call:

```json
{
  "stage": "collect",
  "runId": "<runId>",
  "panelResults": [
    { "agentName": "fusion-panel-1", "modelId": "<panel 1 model>", "content": "<panel 1 text>" },
    { "agentName": "fusion-panel-2", "modelId": "<panel 2 model>", "content": "<panel 2 text>" }
  ]
}
```

Read:

- `shouldProceed`
- `reason`
- `quorum`
- `judgeTransportPrompt`
- `judgeAgent`
- `panelAttempts`
- `todoUpdates`
- `councilComparison`
- `councilComparisonMarkdown`

Call `todowrite` with `todoUpdates`.

If `shouldProceed` is false, stop and report the reason. Do not implement.

## Step 5: Judge and Finalize

If `shouldProceed` is true:

1. Dispatch visible `fusion-judge` with `judgeTransportPrompt`
2. Wait for the real judge result
3. Call:

```json
{
  "stage": "finalize",
  "runId": "<runId>",
  "judgeOutput": "<judge result text>",
  "judgeSessionId": "<judge child session id if available>"
}
```

## Step 6: Stop With Guidance Only

STOP after finalize.

STOP. Do NOT implement.
Do NOT create or modify any project files.

Present the final guidance as a build-ready planning packet. It should still surface:

- Contract Gate
- Council Comparison
- Common Ground
- Key Differences
- Unique Additions
- Partial Coverage and Blind Spots
- Requirement Decision Matrix
- External Consumer Test Plan
- Hidden Semantic Test Plan
- Implementation Order
- Scope Boundaries
- Package Entry Checklist
- Final Self-Audit Checklist

Make it explicit that visible-test-only success would still fail the later build if consumer probes or hidden semantic probes are missing.

Final response must include:

- Fusion run ID
- execution mode `native_subagents`
- trace artifact path
- shared panel prompt hash
- panel agent names and model IDs
- panel success status
- judge agent and model
- quorum status
- council comparison summary
- requirement decision matrix summary
- where to inspect raw panel and judge outputs

Tell the user they can inspect raw artifacts via `/fusion-trace`, and to run `/fusion-build` when they want implementation.

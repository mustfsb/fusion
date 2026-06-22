---
description: Advisory Fusion Council via native OpenCode subagents — 3 panel subagents + judge subagent, then stop with final guidance (no implementation)
agent: fusion-orchestrator
---
You are running `/fusion-no-build` as the fusion-orchestrator. Panels and the judge MUST run as real OpenCode native Task subagents (`fusion-panel-1`, `fusion-panel-2`, `fusion-panel-3`, `fusion-judge`). Do NOT use the legacy all-in-one Fusion council tool for this command. Do NOT use any hidden SDK panel runner. Use the `fusion_native` tool only for deterministic prepare/collect/finalize logic.

`/fusion-no-build` runs the full native council (panels + judge) and then STOPS. Do NOT edit, create, or modify any implementation files. Present the final guidance only.

Pass the exact user task text through without rewriting, summarizing, improving, or expanding it: $ARGUMENTS

Execute this exact sequence:

1. Call `fusion_native` with stage `prepare`:
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
Do NOT pass `panelModels` or `judgeModel` — `fusion_native` resolves them from saved `/fusion-model` config or built-in defaults.

2. Read the prepare result (`runId`, `sharedPanelPrompt`, `sharedPanelPromptHash`, `panelAgents`, `judgeAgent`, `todoPlan`).

3. Call `todowrite` with the `todoPlan` array. You own the todo list.

4. Dispatch the three panel subagents IN PARALLEL in a single assistant turn — three `task` tool calls together:
   - `task` with `subagent_type: "fusion-panel-1"`, `prompt: <sharedPanelPrompt>`, `description: "Fusion Panel 1"`
   - `task` with `subagent_type: "fusion-panel-2"`, `prompt: <sharedPanelPrompt>`, `description: "Fusion Panel 2"`
   - `task` with `subagent_type: "fusion-panel-3"`, `prompt: <sharedPanelPrompt>`, `description: "Fusion Panel 3"`

   Send the EXACT same `sharedPanelPrompt` to all three. The shared prompt hash proves identical payloads.

5. Immediately after dispatching, call `todowrite` to mark the three Panel analysis todos `in_progress`.

6. The user can open the native child sessions for `fusion-panel-1/2/3` in the OpenCode UI while they run. Let the three Task calls return.

7. Collect the three panel Task results (`agentName`, `modelId`, `content` or `error`/`errorType`, plus any `task_id`/session id).

8. Call `fusion_native` with stage `collect`:
```json
{
  "stage": "collect",
  "runId": "<runId from prepare>",
  "panelResults": [
    { "agentName": "fusion-panel-1", "modelId": "<panel 1 model>", "content": "<panel 1 text>" },
    { "agentName": "fusion-panel-2", "modelId": "<panel 2 model>", "content": "<panel 2 text>" },
    { "agentName": "fusion-panel-3", "modelId": "<panel 3 model>", "content": "<panel 3 text>" }
  ]
}
```

9. Read the collect result (`shouldProceed`, `reason`, `quorum`, `judgePrompt`, `judgeAgent`, `panelStatus`, `degraded`, `todoUpdates`). Call `todowrite` with `todoUpdates`.

10. If `shouldProceed` is false, stop. Do not call the judge. Do not implement. Report the reason, quorum, and failed panel diagnostics. Mark the Judge synthesis todo `failed`.

11. If `shouldProceed` is true, dispatch the judge as a native Task subagent:
    - `task` with `subagent_type: "fusion-judge"`, `prompt: <judgePrompt>`, `description: "Fusion Judge"`

    Mark the Judge synthesis todo `in_progress`. The user can open the native `fusion-judge` child session in the OpenCode UI.

12. Collect the judge Task result text.

13. Call `fusion_native` with stage `finalize`:
```json
{
  "stage": "finalize",
  "runId": "<runId>",
  "judgeOutput": "<judge result text>",
  "judgeSessionId": "<judge child session id if available>"
}
```

14. Read the finalize result (`executionMode: "native_subagents"`, `success`, `councilResult`, `finalGuidance`, `trace`, `traceSummary`, `artifactDir`). Call `todowrite` to mark the Judge synthesis todo `completed` (or `failed`).

15. STOP. Do NOT implement. Do NOT create or modify any project files. Present the final guidance as a Build-Ready Contract Packet.
    - Surface the Literal Public Surface, Required exports/types/errors, Public Surface Matrix, Required consumer probes, Compatibility recommendations, Hidden semantic tests, Implementation order, Package Entry Checklist, and Final self-audit checklist.
    - Make it explicit that visible-test-only success would still be a failure if the consumer probes or hidden semantic probes are missing.
    - Do not accept visible-test-only success during the later build run if the consumer probes or hidden semantic probes would still fail.
    - Include a Build-Ready External Consumer Test Plan and an explicit Package Entry Checklist.
    - Tell the user to run `/fusion-build` when they want the plan implemented.

16. Final response must include: Fusion run ID, execution mode `native_subagents`, trace artifact path, shared panel prompt hash, panel agent names + model IDs + panel success status, judge agent + model + success, quorum status (note degraded mode if applicable), and where to inspect raw panel/judge outputs under the artifact path or via `/fusion-trace`.

17. Tell the user that the native child sessions for `fusion-panel-1/2/3` and `fusion-judge` are inspectable in the OpenCode UI while the run is in progress.

If `fusion_native` is unavailable or `prepare` fails, stop and report the error. Do not fall back to a hidden SDK panel runner.

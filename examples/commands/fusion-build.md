---
description: Candidate-build Fusion Council via native OpenCode subagents — 3 panel subagents + judge subagent, then implement
agent: fusion-orchestrator
---
You are running `/fusion-build` as the fusion-orchestrator. Panels and the judge MUST run as real OpenCode native Task subagents (`fusion-panel-1`, `fusion-panel-2`, `fusion-panel-3`, `fusion-judge`). Do NOT use the legacy all-in-one Fusion council tool for this command. Do NOT use any hidden SDK panel runner. Use the `fusion_native` tool only for deterministic prepare/collect/finalize logic.

Pass the exact user task text through without rewriting, summarizing, improving, or expanding it: $ARGUMENTS

Execute this exact sequence:

1. Call `fusion_native` with stage `prepare`:
```json
{
  "stage": "prepare",
  "task": "$ARGUMENTS",
  "mode": "build_prompt",
  "panelMode": "candidate_build",
  "promptVerbosity": "compact",
  "command": "fusion-build",
  "requireAllPanels": false,
  "minSuccessfulPanels": 2,
  "allowDegradedJudge": true
}
```
Do NOT pass `panelModels` or `judgeModel` — `fusion_native` resolves them from saved `/fusion-model` config or built-in defaults.

2. Read the prepare result. It returns `runId`, `sharedPanelPrompt`, `sharedPanelPromptHash`, `panelAgents` (three entries with `agentName` + `modelId`), `judgeAgent`, and `todoPlan`.

3. Call `todowrite` with the `todoPlan` array from the prepare result. You own the todo list.

4. Dispatch the three panel subagents IN PARALLEL in a single assistant turn — issue three `task` tool calls together, not one after another:
   - `task` with `subagent_type: "fusion-panel-1"`, `prompt: <sharedPanelPrompt>`, `description: "Fusion Panel 1"`
   - `task` with `subagent_type: "fusion-panel-2"`, `prompt: <sharedPanelPrompt>`, `description: "Fusion Panel 2"`
   - `task` with `subagent_type: "fusion-panel-3"`, `prompt: <sharedPanelPrompt>`, `description: "Fusion Panel 3"`

   Send the EXACT same `sharedPanelPrompt` text to all three. Do not rewrite it. The shared prompt hash proves they received identical payloads.

5. Immediately after dispatching, call `todowrite` to mark the three Panel analysis todos `in_progress`.

6. The user can open the native child sessions for `fusion-panel-1`, `fusion-panel-2`, and `fusion-panel-3` in the OpenCode UI to watch them work live. Let the three Task calls return.

7. Collect the three panel Task results. For each, capture `agentName`, `modelId`, the returned text as `content` (or `error`/`errorType` if it failed), and any `task_id`/session id if available.

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
Pass `error` and `errorType` instead of `content` for any panel that failed.

9. Read the collect result. It returns `shouldProceed`, `reason`, `quorum`, `judgePrompt`, `judgeAgent`, `panelStatus`, `degraded`, and `todoUpdates`. Call `todowrite` with `todoUpdates`.

10. If `shouldProceed` is false, stop. Do not call the judge. Do not implement. Report the reason, quorum, and failed panel diagnostics. Mark the Judge synthesis todo `failed`.

11. If `shouldProceed` is true, dispatch the judge as a native Task subagent:
    - `task` with `subagent_type: "fusion-judge"`, `prompt: <judgePrompt>`, `description: "Fusion Judge"`

    Mark the Judge synthesis todo `in_progress`. The user can open the native `fusion-judge` child session in the OpenCode UI while it runs.

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
Pass `judgeError` instead of `judgeOutput` if the judge Task failed.

14. Read the finalize result. It returns `executionMode: "native_subagents"`, `success`, `councilResult`, `finalGuidance`, `trace`, `traceSummary`, and `artifactDir`. Call `todowrite` to mark the Judge synthesis todo `completed` (or `failed`), and mark `Implement approved plan` `in_progress`.

15. Implement the original user task in the current repository using `finalGuidance` as the build contract. The original user task is the sole source of truth.
    - Treat the Contract Gate and final build contract as contract-first guidance, not optional advice.
    - Preserve explicit exports, typed errors, option/property names, edge-case behavior, normalization, determinism, serialization, and public-state hygiene exactly.
    - Do not assume an instance method satisfies a literal `Export ...` requirement.
    - If the task requires non-empty strings, reject whitespace-only strings too unless the task explicitly says otherwise.
    - If the task exposes public APIs or error classes, add tests that import from the package entry, not only internal source files.
    - If any explicit API/error/edge-case contract conflicts with existing visible tests, update the implementation and tests to match the original user task, not the weaker visible tests.
    - Do not accept visible-test-only success if hidden probes or the literal task would still fail.

16. Create or update contract-focused consumer tests using the project's existing test framework. Mark `Create or update contract-focused consumer tests` `in_progress`, then `completed` when done.
    - At minimum, cover the judge's Package Entry Checklist, Public Surface Matrix, Required External Consumer Probes, and Required Hidden Semantic Probes.
    - Test package-root exports, exported error classes, consumer-facing option/property names, whitespace normalization, typed errors, and public-state hygiene when relevant.

17. Call `fusion_native` with stage `audit_prepare`:
```json
{
  "stage": "audit_prepare",
  "runId": "<runId>"
}
```
Read the result.
    - If `enabled` is false, report the reason honestly and continue to final verification without claiming the audit ran.
    - If `enabled` is true, it returns `auditPrompt`, `auditAgent`, `fixCyclesUsed`, and `maxFixCycles`.

18. If audit is enabled, dispatch `fusion-judge` again as a native Task subagent for the post-build contract audit:
    - `task` with `subagent_type: "fusion-judge"`, `prompt: <auditPrompt>`, `description: "Fusion Contract Audit"`

    Mark `Post-build contract audit` `in_progress`. The user can open this additional native `fusion-judge` child session in the OpenCode UI.

19. Collect the audit Task result text.

20. Call `fusion_native` with stage `audit_finalize`:
```json
{
  "stage": "audit_finalize",
  "runId": "<runId>",
  "auditOutput": "<audit result text>",
  "auditSessionId": "<audit child session id if available>"
}
```
Pass `auditError` instead of `auditOutput` if the audit Task failed.

21. Read the audit finalize result. It returns `status` (`PASS` or `FIX_REQUIRED`), `findings`, `fixCyclesUsed`, `maxFixCycles`, `autoFixAllowed`, `trace`, and `traceSummary`.
    - If `status` is `PASS`, mark `Post-build contract audit` `completed` and `Resolve contract audit findings` `completed`.
    - If `status` is `FIX_REQUIRED` and `autoFixAllowed` is true, mark `Resolve contract audit findings` `in_progress`, fix the exact findings, rerun the contract-focused tests you changed, then run one more `audit_prepare` + audit Task + `audit_finalize` cycle.
    - If `status` is `FIX_REQUIRED` after the allowed cycle, or the audit Task itself failed, stop claiming full compliance. Mark the audit/fix todo(s) honestly and surface the remaining mismatches.

22. Run final verification: `npm run typecheck`, `npm test`, and `npm run build` (or the verification commands the user task names). Mark `Final verification` `completed` or `failed`.

23. Final response must include: Fusion run ID, execution mode `native_subagents`, trace artifact path, shared panel prompt hash, panel agent names + model IDs + panel success/validation status, judge agent + model + success, quorum status (note degraded mode if applicable), post-build audit status and findings summary, files created, test count, verification results, consumer-facing tests added, known limitations, and design trade-offs.

24. Tell the user where to inspect raw panel/judge/audit outputs under the artifact path or via `/fusion-trace`, and that the native child sessions for `fusion-panel-1/2/3` and both `fusion-judge` runs are inspectable in the OpenCode UI while the run is in progress.

If `fusion_native` is unavailable or `prepare` fails, stop and report the error. Do not fall back to a hidden SDK panel runner.

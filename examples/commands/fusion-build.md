---
description: Foreground hybrid external main + native panel candidate builds, main promotion, then native judge merge-patch contract and self-patching
agent: fusion-orchestrator
---
<!-- FUSION_COMMAND_TEMPLATE_VERSION: fusion-build-hybrid-v6 -->
<!-- FUSION_FOREGROUND_PROTOCOL_VERSION: 6 -->

You are running `/fusion-build` as the `fusion-orchestrator`.

The default and only fresh-run engine is `hybrid_external_main_native_panels`,
driven FOREGROUND by this active parent session. You stay in the loop and the
user watches the real panels and judge run live in the OpenCode UI. There is NO
detached background supervisor and NO early "background work started" return:
you must not report success until collect reports `judge.eligible: true` and
finalize completes.

Preserve this exact hybrid role split:

- **Main builder** — ONE independent external `opencode run` process, started
  immediately with this active invoking session's exact model unless the caller
  deliberately supplied `mainModel`/`mainModelId`, working in an isolated main
  candidate workspace. Never a native panel-style Task session.
- **Panel 1/2/3** — real visible native OpenCode Task subagents
  (`fusion-panel-1/2/3`), all dispatched in ONE parallel wave from this active
  parent session, each in its own isolated candidate workspace.
- **Judge** — a real visible native OpenCode Task subagent (`fusion-judge`),
  launched ONLY after the promoted main baseline and all panels are terminal.

Never launch panels or the judge through external `opencode run`. Never call
panel/judge models through any hidden SDK path.

## Execute this exact foreground sequence

1. **Launch.** Call `fusion_supervisor` (stage: launch) with the exact user task
   as `task` and `command: "fusion-build"`:

   ```json
   { "stage": "launch", "task": "$ARGUMENTS", "command": "fusion-build" }
   ```

   This performs a minimal safe bootstrap (immutable source snapshot, isolated
   candidate workspaces, canonical task artifact), spawns the external main
   builder (`fusion-main-builder`) to a REAL PID, materializes the panel
   candidate workspaces, and returns `main.pid` plus three `panelDispatchSpecs`.
   If it cannot obtain a real main PID and ready panel specs within the startup
   deadline it fails loudly with `FUSION_SUPERVISOR_LAUNCH_FAILED` — surface that
   error, do not retry blindly.

2. **Begin the native wave.** IMMEDIATELY before dispatching any panel, call
   `fusion_supervisor` (stage: begin_native_wave) with the run ID:

   ```json
   { "stage": "begin_native_wave", "runId": "<runId>" }
   ```

   This registers the dispatch wave and records the dispatch-requested time and
   expected panel agent IDs. Its only deadline is the short registration window
   measured from the main spawn to this call — it does NOT bound how long the
   panels run. It never claims a fake session ID or a fake running state.

3. **Dispatch the panel wave.** Using `task`, dispatch `fusion-panel-1`,
   `fusion-panel-2`, and `fusion-panel-3` as native visible Task subagents in
   ONE parallel wave (a single turn), sending each panel the EXACT `prompt` from
   its `panelDispatchSpecs` entry. Do not dispatch them serially and do not wait
   for one panel before dispatching the next. These native Task calls BLOCK this
   session until they return — expected, and possibly minutes. The blocking
   duration is normal panel execution, not a startup failure.

4. **Confirm the launch (lifecycle acknowledgement).** IMMEDIATELY AFTER the panel
   Task calls return, call `fusion_supervisor` (stage: confirm_launch). This stage
   only records that the external main PID exists, that the native wave was
   dispatched, and that the parent returned from the blocking Task wave. It never
   gates panel evidence.

   ```json
   { "stage": "confirm_launch", "runId": "<runId>", "waveDispatchedAt": "<iso>" }
   ```

   Include `panelOutcomes` only for fields truthfully available from the Task
   results — they are optional enrichment, never mandatory. Native `sessionId`,
   `taskId`, receipts, and candidate metadata are all optional.

   confirm_launch returns:
   - `LAUNCH_CONFIRMED` — always continue immediately to collect.
   - `MAIN_PROCESS_UNAVAILABLE` — only when the external main PID is missing or
     dead; keep polling collect but do not treat missing panel metadata as fatal.

   The exact confirm input and result are persisted to
   `<runDir>/confirm-launch-input.json` and `<runDir>/confirm-launch-result.json`.
   NEVER call `fusion_trace` instead of continuing the active run.

5. **Collect + promote + judge gate.** IMMEDIATELY after confirm_launch returns
   `LAUNCH_CONFIRMED`, call `fusion_supervisor` (stage: collect). Collect owns
   panel inspection: it reads each registered candidate workspace, compares it to
   the immutable baseline snapshot, writes `<runDir>/panel-evidence/panel-N.json`,
   and classifies each panel as `usable`, `usable_degraded`, `awaiting`,
   `completed_no_output`, or `evidence_rejected`.

   When the main builder reaches a successful terminal state, collect validates it
   and promotes its candidate changes snapshot-relatively into the real source
   workspace (preserving `.git`, `.opencode/fusion-runs/<runId>`, and user files
   main did not touch). Re-call collect while it reports `awaitingPanelIndexes`
   or before main promotion completes. Only when collect reports `judge.eligible:
   true` — main promoted, native wave returned, and all panels classified — does
   it return a `judge.dispatch` spec. A `completed_no_output` panel is not fatal.
   The judge may receive 0–3 usable panel candidates and must ignore unavailable
   ones using the evidence reports.

6. **Dispatch the judge.** When collect returns `judge.eligible: true`, dispatch
   `fusion-judge` as a native visible Task subagent using the exact
   `judge.dispatch.prompt`, running directly against the promoted real source
   workspace. The judge compares the promoted main implementation against all
   usable panel candidates (panel code, not just chat text), writes a Merge
   Patch Contract (`merge-patch-contract.md`), and applies targeted fixes ITSELF
   directly to the real source workspace — only blocker fixes, mandatory literal
   requirement fixes, verified correctness fixes, safe compatibility additions,
   and the tests needed to prove them. There is NO second external patch worker.
   The judge never wholesale-copies a panel candidate over the main source.

7. **Finalize.** Call `fusion_supervisor` (stage: finalize) with the judge's
   `sessionId`. It records the Merge Patch Contract decision, applied patch
   items, and final verification, and writes the final trace + summary.

Inspect progress any time with `/fusion-trace`, continue an interrupted run with
`/fusion-resume`, and stop a run with `fusion_supervisor` stage `cancel`. Runs
live under `.opencode/fusion-runs/<runId>/` only.

The legacy `speculative_parallel_build` native-subagent flow is retained only as
a non-default compatibility fallback when the user explicitly requests
`speculative_parallel_build` or when resuming an actual legacy run.
Never add `/fusion-spec-build` and never silently fall back to the legacy flow,
all-external supervisor workers, hidden runners, or the default build agent for a
fresh run.

## Final Response Requirements

Final response must include:

- Fusion run ID
- execution mode `native_subagents`
- build strategy `hybrid_external_main_native_panels`
- artifact path (`.opencode/fusion-runs/<runId>`)
- shared canonical task hash
- panel agent names and model IDs (panels run in isolated candidate workspaces)
- panel success and validation status
- main builder: requested vs observed model, candidate workspace, promotion into
  the real source workspace
- quorum
- Merge Patch Contract decision and path
- applied patch items (judge self-patching)
- final verification results

Tell the user they can inspect `fusion-panel-1/2/3` and `fusion-judge` child
sessions in the OpenCode UI, and inspect raw artifacts via `/fusion-trace`.

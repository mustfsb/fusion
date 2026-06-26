---
description: Hybrid external main + native panel candidate builds, main promotion, then native judge merge-patch contract and self-patching
agent: fusion-orchestrator
---
<!-- FUSION_COMMAND_TEMPLATE_VERSION: fusion-build-hybrid-v2 -->

You are running `/fusion-build` as the `fusion-orchestrator`.

For a fresh default `/fusion-build`, the ONLY required action is to launch the
`hybrid_external_main_native_panels` supervisor. Do NOT call `fusion_native`
stages for a fresh default run. Do NOT wait for worker completion, panel
activity, or judge output before returning the launch receipt to the user.

```json
{ "stage": "launch", "task": "$ARGUMENTS", "command": "fusion-build" }
```

Use the `fusion_supervisor` tool with stage `launch`. Pass the exact user task
text through without rewriting: `$ARGUMENTS`.

`launch` performs a minimal safe bootstrap (immutable source snapshot, isolated
main candidate workspace, isolated panel candidate workspaces, canonical task
artifact) and then spawns a detached Node supervisor that immediately launches
four builders concurrently without awaiting any of them:

```txt
T+0s  immutable source snapshot complete
T+0s  fusion-main-builder spawned   (isolated main candidate workspace)
T+0s  fusion-panel-1 dispatched     (native subagent, isolated candidate workspace 1)
T+0s  fusion-panel-2 dispatched     (native subagent, isolated candidate workspace 2)
T+0s  fusion-panel-3 dispatched     (native subagent, isolated candidate workspace 3)
```

The main builder is an external independent OpenCode CLI process using
`FUSION_MAIN_MODEL`. It works ONLY in its isolated main candidate workspace and
never writes to the real source workspace during initial implementation. Panels
are real visible native OpenCode subagents (`fusion-panel-1/2/3`) using the
configured panel models; they work in their own isolated candidate workspaces.
All four derive from the same byte-identical immutable pre-main source snapshot
and the same byte-identical canonical task artifact. Panel dispatches are issued
concurrently (a single batch / `Promise.all`), never serially and never awaiting
another panel's terminal result.

The supervisor then:

1. Monitors all four builders independently (main PID/stdout/stderr/result
   artifact; native panel session/result artifacts).
2. When the main builder reaches a successful terminal state, validates it
   (expected model, task hash, result artifact, meaningful changes, verification
   evidence, no source mutation before promotion) and promotes its candidate
   changes snapshot-relatively into the real source workspace — preserving
   `.git`, `.opencode/fusion-runs/<runId>`, and user files main did not touch.
   This promotion does NOT wait for panels.
3. When the main candidate is promoted AND all three panels are terminal, the
   supervisor classifies panel candidates and dispatches `fusion-judge` as a
   real visible native OpenCode subagent using the configured judge model,
   running directly against the promoted real source workspace.
4. The judge compares the promoted main implementation against all usable panel
   candidates (panel code, not just chat text), writes a Merge Patch Contract
   (`merge-patch-contract.md`), and applies targeted fixes ITSELF directly to the
   real source workspace — only blocker fixes, mandatory literal requirement
   fixes, verified correctness fixes, safe compatibility additions, and tests.
   There is NO second external patch worker. The judge never wholesale-copies a
   panel candidate over the main source.
5. The judge runs final verification (typecheck/test/build) and the supervisor
   writes the final trace, artifacts, and summary.

The supervisor survives parent/orchestrator session closure, OpenCode restart,
and plugin reload.

Return the receipt to the user: run ID, strategy
`hybrid_external_main_native_panels`, artifact directory, and supervisor PID.
Tell the user they can inspect progress with `/fusion-trace` and continue an
interrupted run with `/fusion-resume`.

Poll progress with `{ "stage": "status", "runId": "<runId>" }` and continue an
interrupted run with `{ "stage": "resume", "runId": "<runId>" }` (completed valid
workers are reused, never rerun). The trace renders an explicit
`HYBRID_PARALLEL_LAUNCH_CONFIRMED` / `HYBRID_PARALLEL_LAUNCH_NOT_CONFIRMED`
verdict from real launch evidence (main PID, all three native panel session IDs,
all four launch timestamps, concurrent panel dispatch, no panel via external
CLI, main requested model == observed model).

The legacy `speculative_parallel_build` native-subagent flow is retained only as
a non-default compatibility fallback when the user explicitly requests
`speculative_parallel_build` or when resuming an actual legacy run. Never add `/fusion-spec-build` and never silently fall back to the legacy flow, all-
external supervisor workers, hidden runners, or the default build agent for a
fresh run.

## Final Response Requirements

Final response must include:

- Fusion run ID
- execution mode `native_subagents`
- build strategy `hybrid_external_main_native_panels`
- artifact path
- shared canonical task hash
- panel agent names and model IDs
- panel success and validation status
- main builder: requested vs observed model, candidate workspace, promotion status
- quorum
- Merge Patch Contract decision and path
- applied patch items (judge self-patching)
- final verification results

Tell the user they can inspect `fusion-panel-1/2/3` and `fusion-judge` child
sessions in the OpenCode UI, and inspect raw artifacts via `/fusion-trace`.

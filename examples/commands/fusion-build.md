---
description: Candidate-build Fusion Council — 3 panels produce competing implementation proposals, judge synthesizes, main agent builds
agent: build
---
Your first action must be to call the `fusion_council` tool.

Do not implement before the tool returns.

If the tool is unavailable or fails, stop and report the error. Do not continue as a normal single-model build.

Use the `fusion_council` tool with these exact arguments:

```json
{
  "task": "$ARGUMENTS",
  "mode": "build_prompt",
  "panelMode": "candidate_build",
  "modelSource": "opencode",
  "requireAllPanels": false,
  "minSuccessfulPanels": 2,
  "allowDegradedJudge": true,
  "panelTimeoutMs": 600000,
  "judgeTimeoutMs": 720000,
  "panelMaxAttempts": 1,
  "outputFormat": "markdown",
  "command": "fusion-build"
}
```

Required settings: `panelMode: "candidate_build"`, `modelSource: "opencode"`, `minSuccessfulPanels: 2`. Do NOT pass `panelModels` or `judgeModel` — the plugin resolves them from saved `/fusion-model` config or built-in defaults.

Pass the exact user task text to `fusion_council` without rewriting, summarizing, improving, or expanding it: $ARGUMENTS

If fewer than 2 panels produce usable output, stop immediately. Do not call the judge. Do not implement.

If 2+ panels succeed (even with validation warnings or 1 timeout), proceed with judge synthesis. Failed panel diagnostics are included in the trace.

After judge succeeds, implement the full project automatically. No manual second message is required.

Before implementation, show the Fusion trace from the tool result, including: run ID, artifact path, panel model IDs requested, panel success/failure per model, quorum status, candidate validation status per panel, judge model ID requested, judge success/failure, and whether fallback happened. Fallback must be `no`; if fallback happened, stop.

After the council returns, use the judge final build contract as implementation guidance. Then continue as the active OpenCode build agent:

1. Implement the original user task in the current repository.
2. Use the judge Requirement Ledger and final build contract as guidance; the original user task remains authoritative.
3. Preserve the original requirement semantics, explicit API/error contracts, and edge-case behavior exactly.
4. Do not add speculative behavior, extra features, broad refactors, compatibility layers, or semantic changes that were not explicitly requested.
5. Before finishing, implement the judge's Required Hidden Tests or equivalent coverage.
6. Do not accept visible-test-only success if hidden probes or the literal task would still fail.
7. If council ran in degraded/quorum mode, be conservative and must verify with tests.
8. If any explicit API/error/edge-case contract conflicts with existing visible tests, update the implementation and tests to match the original user task, not the weaker visible tests.
9. Before finalizing, run this pre-final self-audit:
   - All required public API symbols are exported.
   - package.json main and types resolve to actual built files.
   - No accidental test emission into dist unless intentional.
   - TypeScript strict mode is enabled.
   - Runtime dependencies are justified.
   - Public reads do not expose mutable internals.
   - State-check functions do not mutate state.
   - Failure paths do not partially mutate state.
   - Typed errors are used where required.
   - JSON-safe input constraints are enforced where required.
   - Deterministic seed/clock behavior is actually deterministic.
   - Snapshot/restore/replay/diff semantics are covered if relevant.
   - Visible-test-only success is not being mistaken for full compliance.
   - Hidden tests from judge guidance are implemented where practical.
10. Run the verification commands requested by the user task. If the task does not name verification commands, run the smallest relevant existing project checks you can identify and explain what you ran.
11. Final response must include: Fusion run ID, trace artifact path, files created, test count, verification results, hidden-edge tests added, known limitations, and design trade-offs.
12. Tell the user where to inspect raw panel/judge outputs under the artifact path or via `/fusion-trace`.

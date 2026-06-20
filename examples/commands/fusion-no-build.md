---
description: Advisory-council-assisted build — 3 panels advise, judge synthesizes, then the main agent implements
agent: build
---
Your first action must be to call the `fusion_council` tool.

Do not implement before the tool returns.

If the tool is unavailable or fails, stop and report the error.

Use the `fusion_council` tool with these exact arguments:

```json
{
  "task": "$ARGUMENTS",
  "mode": "plan",
  "panelMode": "advisory",
  "modelSource": "opencode",
  "requireAllPanels": false,
  "minSuccessfulPanels": 2,
  "allowDegradedJudge": true,
  "panelTimeoutMs": 600000,
  "judgeTimeoutMs": 720000,
  "panelMaxAttempts": 1,
  "outputFormat": "markdown",
  "command": "fusion-no-build"
}
```

Required settings: `panelMode: "advisory"`, `modelSource: "opencode"`, `minSuccessfulPanels: 2`. Do NOT pass `panelModels` or `judgeModel` — the plugin resolves them from saved `/fusion-model` config or built-in defaults.

Pass the exact user task text to `fusion_council` without rewriting, summarizing, improving, or expanding it: $ARGUMENTS

If fewer than 2 panels produce usable output, stop immediately. Do not call the judge. Do not implement.

If 2+ panels succeed (even with 1 timeout), proceed with judge synthesis.

After judge succeeds, implement the original user task automatically. No manual second message is required.

After the council returns:
1. Show the Fusion trace (run ID, artifact path, panel models, panel success/failure per model, quorum status, judge model, judge success/failure, fallback status).
2. Use the judge Requirement Ledger and output as the implementation contract; the original prompt is source of truth.
3. Because panels were advisory-only, do not expect full candidate code outputs from them.
4. Implement the original user task in the current repository.
5. Preserve explicit API/error contracts and edge-case behavior exactly.
6. Before finishing, implement the judge's Required Hidden Tests or equivalent coverage.
7. Do not accept visible-test-only success if hidden probes or the literal task would still fail.
8. If council ran in degraded/quorum mode, be conservative and must verify with tests.
9. If any explicit API/error/edge-case contract conflicts with existing visible tests, update the implementation and tests to match the original user task, not the weaker visible tests.
10. Before finalizing, run this pre-final self-audit:
   - All required public API symbols are exported.
   - package.json main and types resolve to actual built files.
   - No accidental test emission into dist unless intentional.
   - TypeScript strict mode is enabled.
   - Public reads do not expose mutable internals.
   - State-check functions do not mutate state.
   - Failure paths do not partially mutate state.
   - Typed errors are used where required.
   - JSON-safe input constraints are enforced where required.
   - Deterministic seed/clock behavior is actually deterministic.
   - Snapshot/restore/replay/diff semantics are covered if relevant.
   - Visible-test-only success is not being mistaken for full compliance.
   - Hidden tests from judge guidance are implemented where practical.
11. Run the verification commands requested by the user task. If the task does not name verification commands, run the smallest relevant existing project checks you can identify and explain what you ran.
12. Final response must include: Fusion run ID, trace artifact path, files created, test count, verification results, hidden-edge tests added, known limitations, and design trade-offs.
13. Do not ask for confirmation after council output.
14. Tell the user where to inspect raw panel/judge outputs under the artifact path or via `/fusion-trace`.

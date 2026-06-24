import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const defaultModels = [
  "opencode-go/kimi-k2.7-code",
  "opencode-go/qwen3.7-max",
  "opencode-go/minimax-m3",
  "openai/gpt-5.5",
];

describe("docs and examples", () => {
  test("README and OpenCode example mention default model IDs", async () => {
    const readme = await readFile("README.md", "utf8");
    const example = await readFile("examples/opencode.config.example.jsonc", "utf8");

    for (const model of defaultModels) {
      expect(readme).toContain(model);
      expect(example).toContain(model);
    }
  });

  test("fusion-build command documents speculative parallel build workflow", async () => {
    const readme = await readFile("README.md", "utf8");
    const command = await readFile("examples/commands/fusion-build.md", "utf8");

    expect(readme).toContain("/fusion-build");
    expect(readme).toContain("/fusion-trace");
    expect(readme).toContain(".opencode/fusion-runs");
    expect(command).toContain("agent: fusion-orchestrator");
    expect(command).toContain("fusion_native");
    expect(command).toContain('"stage": "prepare"');
    expect(command).toContain('"panelMode": "candidate_build"');
    expect(command).toContain('"buildStrategy": "speculative_parallel_build"');
    expect(command).toContain('"mode": "build_prompt"');
    expect(command).toContain('"command": "fusion-build"');
    expect(command).toContain('"requireAllPanels": false');
    expect(command).toContain('"minSuccessfulPanels": 2');
    expect(command).toContain('"allowDegradedJudge": true');
    expect(command).toContain('"parallelExecutionSupported": true');
    expect(command).toContain('"stage": "advance"');
    expect(command).toContain("nextAction");
    expect(command).toContain('"mainBaselineStartedAt"');
    expect(command).toContain('"judgeDispatched"');
    expect(command).toContain("fusion-panel-1");
    expect(command).toContain("fusion-panel-2");
    expect(command).toContain("fusion-panel-3");
    expect(command).toContain("fusion-judge");
    expect(command).toContain("staggered cascade");
    expect(command).toContain("45 seconds");
    expect(command).toContain("start_gate_timeout");
    expect(command).toContain("retry");
    expect(command).toContain("fusion-panel-4");
    expect(command).toContain("panelResults");
    expect(command).toContain("shared panel prompt hash");
    expect(command).toContain("record_main_baseline");
    expect(command).toContain("main baseline");
    expect(command).toContain("judgeTransportPrompt");
    expect(command).toContain("audit_prepare");
    expect(command).toContain("audit_finalize");
    expect(command).toContain("native_subagents");
    expect(command).toContain("todowrite");
    expect(command).toContain("Contract Gate");
    expect(command).toContain("Merge Patch Contract");
    expect(command).toContain("speculative_parallel_build");
    expect(command).toContain("isolated candidate workspaces");
    expect(command).toContain("Start the Main Baseline Immediately");
    expect(command).toContain("before any panel staging or dispatch");
    expect(command).toContain("real source workspace");
    expect(command).toContain("overlap");
    expect(command).toContain("call_collect");
    expect(command).toContain("canonicalTaskPath");
    expect(command).toContain("Run post-build contract audit");
    expect(command).toContain("Correctness Coverage Gate");
    expect(command).toContain("Apply only approved targeted patches");
    expect(command).toContain("Never add `/fusion-spec-build`");
    expect(command).toContain("npm run typecheck");
    expect(command).toContain("artifact path");
    expect(command).toContain("/fusion-trace");
    expect(command).toContain("3 panel subagents");
    expect(command).toContain("build strategy `speculative_parallel_build`");
    expect(command).toContain("Pass the exact user task text");
    expect(command).toContain("$ARGUMENTS");
    expect(command).toContain("Do NOT use the legacy all-in-one `fusion_council` tool");
  });

  test("fusion-no-build command exists and preserves advisory-only workflow requirements", async () => {
    const command = await readFile("examples/commands/fusion-no-build.md", "utf8");

    expect(command).toContain("agent: fusion-orchestrator");
    expect(command).toContain("fusion_native");
    expect(command).toContain('"panelMode": "advisory"');
    expect(command).toContain('"command": "fusion-no-build"');
    expect(command).toContain('"minSuccessfulPanels": 2');
    expect(command).toContain('"stage": "advance"');
    expect(command).toContain("nextAction");
    expect(command).toContain("fusion-judge");
    expect(command).toContain("staggered cascade");
    expect(command).toContain("delayMs");
    expect(command).toContain("panelResults");
    expect(command).toContain("panelTransportPrompt");
    expect(command).toContain("sharedPanelPromptHash");
    expect(command).toContain("judgeTransportPrompt");
    expect(command).toContain("native_subagents");
    expect(command).toContain("STOP. Do NOT implement");
    expect(command).toContain("Do NOT create or modify any project files");
    expect(command).toContain("build-ready planning packet");
    expect(command).toContain("Package Entry Checklist");
    expect(command).toContain("External Consumer Test Plan");
    expect(command).toContain("Council Comparison");
    expect(command).toContain("Requirement Decision Matrix");
    expect(command).toContain("Scope Boundaries");
    expect(command).toContain("/fusion-trace");
    expect(command).toContain("$ARGUMENTS");
    expect(command).toContain("Do NOT use the legacy all-in-one Fusion council tool");
  });

  test("fusion-resume command documents orphan recovery workflow", async () => {
    const readme = await readFile("README.md", "utf8");
    const command = await readFile("examples/commands/fusion-resume.md", "utf8");

    expect(readme).toContain("/fusion-resume");
    expect(command).toContain("agent: fusion-orchestrator");
    expect(command).toContain('"stage": "resume"');
    expect(command).toContain("FUSION_RESUME_NOT_FOUND");
    expect(command).toContain("FUSION_RESUME_AMBIGUOUS");
    expect(command).toContain("mainBaselineReused");
    expect(command).toContain("fusion-panel-4");
    expect(command).toContain("never silently guesses");
    expect(command).toContain(".opencode/fusion-runs");
  });

  test("fusion-model command documents effort syntax and native agent sync", async () => {
    const command = await readFile("examples/commands/fusion-model.md", "utf8");
    expect(command).toContain("provider/model/effort");
    expect(command).toContain("openai/gpt-5.4/high");
    expect(command).toContain("xhigh");
    expect(command).toContain("native OpenCode subagent");
    expect(command).toContain("fusion-panel-1");
    expect(command).toContain("fusion-judge");
  });

  test("README documents prompt transport compression", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("brief_plus_file");
    expect(readme).toContain("inline_full");
    expect(readme).toContain("50 physical lines");
    expect(readme).toContain("shared-panel-prompt.full.md");
    expect(readme).toContain("FUSION_FULL_PROMPT_UNAVAILABLE");
    expect(readme).toContain("panelPromptTransport");
  });

  test("README documents staggered panel cascade and liveness watchdog", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("Staggered panel cascade");
    expect(readme).toContain("45 seconds");
    expect(readme).toContain("MAX_PANEL_ATTEMPTS");
    expect(readme).toContain("same-slot retry");
    expect(readme).toContain("fusion-panel-4");
    expect(readme).toContain("panelLivenessCapability");
    expect(readme).toContain("streamActivityExposed");
    expect(readme).toContain("Automatic cancellation remains disabled");
    expect(readme).toContain("panelAttempts");
    expect(readme).toContain("advance");
    expect(readme).toContain("speculative_parallel_build");
    expect(readme).toContain("Merge Patch Contract");
    expect(readme).toContain("isolated candidate workspaces");
    expect(readme).toContain("record_main_baseline");
    expect(readme).toContain("advance");
  });

  test("fusion-trace command exists", async () => {
    const command = await readFile("examples/commands/fusion-trace.md", "utf8");
    expect(command).toContain("fusion_trace");
    expect(command).toContain("artifact");
  });

  test("no fusion-spec-build command exists", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).not.toContain("/fusion-spec-build");
  });
});

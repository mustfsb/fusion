import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { buildOrchestratorAgentFile } from "../src/native/agentTemplates.js";

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
    const orchestrator = buildOrchestratorAgentFile().content;

    expect(readme).toContain("/fusion-build");
    expect(readme).toContain("/fusion-trace");
    expect(readme).toContain(".opencode/fusion-runs");
    expect(command).toContain("agent: fusion-orchestrator");
    expect(command).toContain("speculative_parallel_build");
    expect(command).toContain("non-default compatibility fallback");
    expect(command).toContain("Never add `/fusion-spec-build`");
    expect(command).toContain("native_subagents");
    expect(command).toContain("Merge Patch Contract");
    expect(command).toContain("isolated candidate workspaces");
    expect(command).toContain("real source workspace");
    expect(command).toContain("/fusion-trace");

    // The detailed legacy speculative_parallel_build workflow is documented in
    // the fusion-orchestrator agent prompt (the runtime driver for that flow).
    expect(orchestrator).toContain("fusion_native");
    expect(orchestrator).toContain("(stage: prepare)");
    expect(orchestrator).toContain("panelMode: \"candidate_build\"");
    expect(orchestrator).toContain("buildStrategy: \"speculative_parallel_build\"");
    expect(orchestrator).toContain("mode: \"build_prompt\"");
    expect(orchestrator).toContain("command: \"fusion-build\"");
    expect(orchestrator).toContain("(stage: advance)");
    expect(orchestrator).toContain("nextAction");
    expect(orchestrator).toContain("mainBaselineStartedAt");
    expect(orchestrator).toContain("judgeDispatched");
    expect(orchestrator).toContain("fusion-panel-1");
    expect(orchestrator).toContain("fusion-panel-2");
    expect(orchestrator).toContain("fusion-panel-3");
    expect(orchestrator).toContain("fusion-judge");
    expect(orchestrator).toContain("Staggered panel cascade");
    expect(orchestrator).toContain("~45s");
    expect(orchestrator).toContain("scheduled_delay");
    expect(orchestrator).toContain("recovery_rerun");
    expect(orchestrator).toContain("fusion-panel-4");
    expect(orchestrator).toContain("panelResults");
    expect(orchestrator).toContain("record_main_baseline");
    expect(orchestrator).toContain("main baseline");
    expect(orchestrator).toContain("judgeTransportPrompt");
    expect(orchestrator).toContain("audit_prepare");
    expect(orchestrator).toContain("audit_finalize");
    expect(orchestrator).toContain("native_subagents");
    expect(orchestrator).toContain("todowrite");
    expect(orchestrator).toContain("Merge Patch Contract");
    expect(orchestrator).toContain("speculative_parallel_build");
    expect(orchestrator).toContain("candidate workspaces");
    expect(orchestrator).toContain("call_collect");
    expect(orchestrator).toContain("Apply ONLY approved targeted patches");
  });

  test("fusion-build documents the default hybrid_external_main_native_panels supervisor", async () => {
    const command = await readFile("examples/commands/fusion-build.md", "utf8");
    expect(command).toContain("hybrid_external_main_native_panels");
    expect(command).toContain("fusion_supervisor");
    expect(command).toContain('"stage": "launch"');
    expect(command).toContain("fusion-main-builder");
    expect(command).toContain("detached Node supervisor");
    expect(command).toContain("HYBRID_PARALLEL_LAUNCH_CONFIRMED");
    expect(command).toContain("non-default compatibility fallback");
  });

  test("fusion-resume documents supervisor recovery", async () => {
    const command = await readFile("examples/commands/fusion-resume.md", "utf8");
    expect(command).toContain("hybrid_external_main_native_panels");
    expect(command).toContain("supervisor-state.json");
    expect(command).toContain("fusion_supervisor");
    expect(command).toContain('"stage": "resume"');
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

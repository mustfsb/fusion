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

  test("fusion-build command exists and preserves benchmark workflow requirements", async () => {
    const readme = await readFile("README.md", "utf8");
    const command = await readFile("examples/commands/fusion-build.md", "utf8");

    expect(readme).toContain("/fusion-build");
    expect(readme).toContain("/fusion-trace");
    expect(readme).toContain(".opencode/fusion-runs");
    expect(command).toContain("agent: fusion-orchestrator");
    expect(command).toContain("fusion_native");
    expect(command).toContain('"stage": "prepare"');
    expect(command).toContain('"panelMode": "candidate_build"');
    expect(command).toContain('"mode": "build_prompt"');
    expect(command).toContain('"command": "fusion-build"');
    expect(command).toContain('"requireAllPanels": false');
    expect(command).toContain('"minSuccessfulPanels": 2');
    expect(command).toContain('"allowDegradedJudge": true');
    expect(command).toContain("subagent_type");
    expect(command).toContain("fusion-panel-1");
    expect(command).toContain("fusion-panel-2");
    expect(command).toContain("fusion-panel-3");
    expect(command).toContain("fusion-judge");
    expect(command).toContain("IN PARALLEL");
    expect(command).toContain("sharedPanelPrompt");
    expect(command).toContain("native_subagents");
    expect(command).toContain("todowrite");
    expect(command).toContain("Contract Gate");
    expect(command).toContain("Required Hidden Semantic Probes");
    expect(command).toContain('"stage": "audit_prepare"');
    expect(command).toContain('"stage": "audit_finalize"');
    expect(command).toContain("Post-build contract audit");
    expect(command).toContain("Package Entry Checklist");
    expect(command).toContain("Do not accept visible-test-only success");
    expect(command).toContain("update the implementation and tests to match the original user task");
    expect(command).toContain("consumer-facing tests added");
    expect(command).toContain("Implement the original user task in the current repository");
    expect(command).toContain("npm run typecheck");
    expect(command).toContain("artifact path");
    expect(command).toContain("/fusion-trace");
    expect(command).toContain("3 panel subagents");
    expect(command).toContain("final build contract");
    expect(command).toContain("Pass the exact user task text");
    expect(command).toContain("$ARGUMENTS");
    expect(command).not.toContain("fusion_council");
  });

  test("fusion-no-build command exists and preserves advisory-only workflow requirements", async () => {
    const command = await readFile("examples/commands/fusion-no-build.md", "utf8");

    expect(command).toContain("agent: fusion-orchestrator");
    expect(command).toContain("fusion_native");
    expect(command).toContain('"panelMode": "advisory"');
    expect(command).toContain('"command": "fusion-no-build"');
    expect(command).toContain('"minSuccessfulPanels": 2');
    expect(command).toContain("subagent_type");
    expect(command).toContain("fusion-judge");
    expect(command).toContain("IN PARALLEL");
    expect(command).toContain("sharedPanelPrompt");
    expect(command).toContain("native_subagents");
    expect(command).toContain("STOP. Do NOT implement");
    expect(command).toContain("Do NOT create or modify any project files");
    expect(command).toContain("Build-Ready Contract Packet");
    expect(command).toContain("Package Entry Checklist");
    expect(command).toContain("Build-Ready External Consumer Test Plan");
    expect(command).toContain("Do not accept visible-test-only success");
    expect(command).toContain("/fusion-trace");
    expect(command).toContain("$ARGUMENTS");
    expect(command).not.toContain("fusion_council");
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

  test("fusion-trace command exists", async () => {
    const command = await readFile("examples/commands/fusion-trace.md", "utf8");
    expect(command).toContain("fusion_trace");
    expect(command).toContain("artifact");
  });
});

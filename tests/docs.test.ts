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
    expect(command).toContain("Your first action must be to call the `fusion_council` tool.");
    expect(command).toContain("Do not implement before the tool returns.");
    expect(command).toContain("If the tool is unavailable or fails, stop");
    expect(command).toContain('"panelMode": "candidate_build"');
    expect(command).toContain('"mode": "build_prompt"');
    expect(command).toContain('"modelSource": "opencode"');
    expect(command).toContain('"requireAllPanels": false');
    expect(command).toContain('"minSuccessfulPanels": 2');
    expect(command).toContain('"allowDegradedJudge": true');
    expect(command).toContain('"panelTimeoutMs": 600000');
    expect(command).toContain('"judgeTimeoutMs": 720000');
    expect(command).toContain('"panelMaxAttempts": 1');
    expect(command).toContain('"command": "fusion-build"');
    expect(command).toContain("panelModels");
    expect(command).toContain("judgeModel");
    expect(command).toContain("Fallback must be `no`");
    expect(command).toContain("candidate validation");
    expect(command).toContain("artifact path");
    expect(command).toContain("/fusion-trace");
    expect(command).toContain("Pass the exact user task text to `fusion_council` without rewriting, summarizing, improving, or expanding it: $ARGUMENTS");
    expect(command).toContain("Implement the original user task in the current repository");
    expect(command).toContain("Run the verification commands requested by the user task");
    expect(command).toContain("3 panels produce competing implementation proposals");
    expect(command).toContain("final build contract");
    expect(command).toContain("Requirement Ledger");
    expect(command).toContain("Required Hidden Tests or equivalent coverage");
    expect(command).toContain("Do not accept visible-test-only success");
    expect(command).toContain("update the implementation and tests to match the original user task");
    expect(command).toContain("pre-final self-audit");
    expect(command).toContain("hidden-edge tests added");
  });

  test("fusion-no-build command exists and preserves advisory-only workflow requirements", async () => {
    const command = await readFile("examples/commands/fusion-no-build.md", "utf8");

    expect(command).toContain("Your first action must be to call the `fusion_council` tool.");
    expect(command).toContain('"panelMode": "advisory"');
    expect(command).toContain('"modelSource": "opencode"');
    expect(command).toContain('"requireAllPanels": false');
    expect(command).toContain('"minSuccessfulPanels": 2');
    expect(command).toContain('"command": "fusion-no-build"');
    expect(command).toContain("Do not implement before the tool returns.");
    expect(command).toContain("After judge succeeds, implement the original user task automatically");
    expect(command).toContain("Do not ask for confirmation after council output");
    expect(command).toContain("Requirement Ledger");
    expect(command).toContain("Required Hidden Tests or equivalent coverage");
    expect(command).toContain("Do not accept visible-test-only success");
    expect(command).toContain("pre-final self-audit");
    expect(command).toContain("hidden-edge tests added");
    expect(command).toContain("implementation contract");
    expect(command).toContain("/fusion-trace");
    expect(command).not.toContain("Stop. Do not implement. Do not create or modify any files.");
  });

  test("fusion-model command documents effort syntax", async () => {
    const command = await readFile("examples/commands/fusion-model.md", "utf8");
    expect(command).toContain("provider/model/effort");
    expect(command).toContain("openai/gpt-5.4/high");
    expect(command).toContain("xhigh");
  });

  test("fusion-trace command exists", async () => {
    const command = await readFile("examples/commands/fusion-trace.md", "utf8");
    expect(command).toContain("fusion_trace");
    expect(command).toContain("artifact");
  });
});

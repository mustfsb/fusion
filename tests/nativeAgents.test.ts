import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearFusionAgentFiles,
  defaultAgentDir,
  formatAgentSyncMarkdown,
  listFusionAgentFiles,
  listNonFusionAgentFiles,
  syncDefaultNativeAgents,
  syncNativeAgents,
} from "../src/native/agentSync.js";
import {
  FUSION_AGENT_NAMES,
  buildJudgeAgentFile,
  buildOrchestratorAgentFile,
  buildPanelAgentFile,
} from "../src/native/agentTemplates.js";
import { nativeAdvance, nativeCollect, nativeFinalize, nativeFinalizeAudit, nativePrepare, nativePrepareAudit, buildTodoPlan } from "../src/native/nativeCouncil.js";
import { hashSharedPanelPrompt, loadRunState } from "../src/native/runState.js";
import { parseModelArgs } from "../src/modelConfig.js";
import { completeCandidate } from "./fixtures/candidates.js";
import type { FusionModelSpec } from "../src/modelSpec.js";

let tmpAgentDir: string;
let tmpCwd: string;

beforeEach(async () => {
  tmpAgentDir = await mkdtemp(path.join(tmpdir(), "fusion-agents-"));
  tmpCwd = await mkdtemp(path.join(tmpdir(), "fusion-native-cwd-"));
});

afterEach(async () => {
  await Promise.all([rm(tmpAgentDir, { recursive: true, force: true }), rm(tmpCwd, { recursive: true, force: true })]);
});

const defaultPanels: FusionModelSpec[] = [
  { modelId: "opencode-go/kimi-k2.7-code", raw: "opencode-go/kimi-k2.7-code" },
  { modelId: "opencode-go/qwen3.7-max", raw: "opencode-go/qwen3.7-max" },
  { modelId: "opencode-go/minimax-m3", raw: "opencode-go/minimax-m3" },
];

describe("native agent generation", () => {
  test("syncNativeAgents writes orchestrator + 3 panel + 1 judge agent files with exact model IDs", async () => {
    const result = await syncNativeAgents(
      {
        panelModels: defaultPanels,
        judgeModel: { modelId: "openai/gpt-5.4", reasoningEffort: "high", raw: "openai/gpt-5.4/high" },
      },
      tmpAgentDir,
    );

    expect(result.agentDir).toBe(tmpAgentDir);
    expect(result.wrote).toHaveLength(5);
    expect(result.panelAgents.map((p) => p.modelId)).toEqual([
      "opencode-go/kimi-k2.7-code",
      "opencode-go/qwen3.7-max",
      "opencode-go/minimax-m3",
    ]);
    expect(result.judgeAgent.modelId).toBe("openai/gpt-5.4");

    const present = await listFusionAgentFiles(tmpAgentDir);
    expect(present.sort()).toEqual(
      [FUSION_AGENT_NAMES.judge, FUSION_AGENT_NAMES.orchestrator, FUSION_AGENT_NAMES.panel1, FUSION_AGENT_NAMES.panel2, FUSION_AGENT_NAMES.panel3].sort(),
    );

    const panel1 = await readFile(path.join(tmpAgentDir, "fusion-panel-1.md"), "utf8");
    expect(panel1).toContain("mode: subagent");
    expect(panel1).toContain("model: opencode-go/kimi-k2.7-code");
    // Speculative_parallel_build requires panel write access in candidate workspaces.
    expect(panel1).toContain("edit: allow");
    expect(panel1).toContain("write: allow");
    expect(panel1).toContain("task: deny");
    expect(panel1).toContain("todowrite: deny");

    const judge = await readFile(path.join(tmpAgentDir, "fusion-judge.md"), "utf8");
    expect(judge).toContain("mode: subagent");
    expect(judge).toContain("model: openai/gpt-5.4");
    expect(judge).toContain("variant: high");
    expect(judge).toContain("edit: deny");
    expect(judge).toContain("task: deny");
    expect(judge).toContain("PASS or FIX_REQUIRED");

    const orchestrator = await readFile(path.join(tmpAgentDir, "fusion-orchestrator.md"), "utf8");
    expect(orchestrator).toContain("mode: primary");
    expect(orchestrator).toContain("fusion-panel-1: allow");
    expect(orchestrator).toContain("fusion-judge: allow");
    expect(orchestrator).toContain("audit_prepare");
    expect(orchestrator).toContain('"*": deny');
  });

  test("preserves exact provider/model IDs including opencode-go prefix", async () => {
    await syncNativeAgents(
      {
        panelModels: defaultPanels,
        judgeModel: { modelId: "openai/gpt-5.5" },
      },
      tmpAgentDir,
    );

    const panel2 = await readFile(path.join(tmpAgentDir, "fusion-panel-2.md"), "utf8");
    expect(panel2).toContain("model: opencode-go/qwen3.7-max");
    const panel3 = await readFile(path.join(tmpAgentDir, "fusion-panel-3.md"), "utf8");
    expect(panel3).toContain("model: opencode-go/minimax-m3");
  });

  test("judge effort is preserved as variant when provided", async () => {
    const file = buildJudgeAgentFile({ modelId: "openai/gpt-5.4", reasoningEffort: "xhigh" });
    expect(file.content).toContain("variant: xhigh");
    expect(file.content).toContain("model: openai/gpt-5.4");
  });

  test("judge effort none omits variant", async () => {
    const file = buildJudgeAgentFile({ modelId: "openai/gpt-5.4", reasoningEffort: "none" });
    expect(file.content).not.toContain("variant:");
    expect(file.content).toContain("model: openai/gpt-5.4");
  });

  test("unrelated user agent files are untouched", async () => {
    await writeFile(path.join(tmpAgentDir, "my-custom-agent.md"), "---\nmode: subagent\ndescription: mine\n---\nbody\n", "utf8");
    await writeFile(path.join(tmpAgentDir, "another.md"), "keep me", "utf8");

    await syncNativeAgents({ panelModels: defaultPanels, judgeModel: { modelId: "openai/gpt-5.5" } }, tmpAgentDir);

    const leftover = await listNonFusionAgentFiles(tmpAgentDir);
    expect(leftover.sort()).toEqual(["another.md", "my-custom-agent.md"]);
    const custom = await readFile(path.join(tmpAgentDir, "my-custom-agent.md"), "utf8");
    expect(custom).toContain("description: mine");
  });

  test("clearFusionAgentFiles removes only fusion agent files", async () => {
    await syncNativeAgents({ panelModels: defaultPanels, judgeModel: { modelId: "openai/gpt-5.5" } }, tmpAgentDir);
    await writeFile(path.join(tmpAgentDir, "keep.md"), "keep", "utf8");
    await clearFusionAgentFiles(tmpAgentDir);
    const present = await listFusionAgentFiles(tmpAgentDir);
    expect(present).toEqual([]);
    const leftover = await listNonFusionAgentFiles(tmpAgentDir);
    expect(leftover).toEqual(["keep.md"]);
  });

  test("formatAgentSyncMarkdown lists panel and judge agent mappings", () => {
    const markdown = formatAgentSyncMarkdown({
      agentDir: tmpAgentDir,
      wrote: ["fusion-orchestrator.md", "fusion-panel-1.md", "fusion-panel-2.md", "fusion-panel-3.md", "fusion-judge.md"],
      panelAgents: [
        { panelIndex: 1, agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code" },
        { panelIndex: 2, agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max" },
        { panelIndex: 3, agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3" },
      ],
      judgeAgent: { agentName: "fusion-judge", modelId: "openai/gpt-5.4/high", reasoningEffort: "high" },
      orchestratorAgent: { agentName: "fusion-orchestrator" },
    });
    expect(markdown).toContain("Panel 1 agent: fusion-panel-1 -> opencode-go/kimi-k2.7-code");
    expect(markdown).toContain("Judge agent: fusion-judge -> openai/gpt-5.4/high");
    expect(markdown).toContain("Restart OpenCode");
  });

  test("defaultAgentDir uses home-directory API path", () => {
    expect(defaultAgentDir()).toBe(path.join(homedir(), ".config", "opencode", "agent"));
  });
});

describe("shared panel prompt", () => {
  test("speculative prepare defers shared prompt materialization until advance", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        minSuccessfulPanels: 2,
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );

    expect(prepare.executionMode).toBe("native_subagents");
    expect(prepare.panelAgents).toHaveLength(3);
    const hashes = prepare.panelAgents.map((p) => p.promptHash);
    expect(new Set(hashes).size).toBe(1);
    expect(prepare.sharedPanelPromptHash).toBeUndefined();
    expect(prepare.sharedPanelPrompt).toBeUndefined();
    expect(prepare.canonicalTaskHash).toBe(hashes[0]);
    expect(prepare.panelAgents.map((p) => p.nativeTask)).toEqual([true, true, true]);
    expect(prepare.panelAgents.map((p) => p.agentName)).toEqual(["fusion-panel-1", "fusion-panel-2", "fusion-panel-3"]);

    await nativeAdvance({ runId: prepare.runId }, { cwd: tmpCwd });
    const state = await loadRunState(tmpCwd, prepare.runId);
    expect(state.sharedPanelPromptHash).toBe(hashSharedPanelPrompt(state.sharedPanelPrompt));
    expect(new Set(state.panelAgents.map((p) => p.promptHash)).size).toBe(1);
    expect(state.panelAgents[0]?.promptHash).toBe(state.sharedPanelPromptHash);
  });

  test("run-state records the shared prompt hash and path", async () => {
    const prepare = await nativePrepare(
      { task: "Build add(a,b)", mode: "plan", panelMode: "advisory", command: "fusion-no-build", trace: { saveRunArtifacts: true } },
      { cwd: tmpCwd },
    );
    const state = await loadRunState(tmpCwd, prepare.runId);
    expect(state.sharedPanelPromptHash).toBe(prepare.sharedPanelPromptHash);
    expect(state.sharedPanelPrompt).toBe(prepare.sharedPanelPrompt);
    expect(state.contractGate).toBeDefined();
    expect(Array.isArray(state.contractGate.literalPublicSurface)).toBe(true);
  });
});

describe("native todo plan", () => {
  test("fusion-build todo plan includes speculative stages, patch phase, audit, and verification", () => {
    const plan = buildTodoPlan({
      panelModelSpecs: defaultPanels,
      judgeModelSpec: { modelId: "openai/gpt-5.4" },
      command: "fusion-build",
      phase: "prepare",
      buildStrategy: "speculative_parallel_build",
    });
    expect(plan.map((p) => p.content)).toEqual([
      "Stage 0: isolate candidate workspaces",
      "Build Contract Gate and shared panel prompt",
      "Panel candidate build 1 — opencode-go/kimi-k2.7-code",
      "Panel candidate build 2 — opencode-go/qwen3.7-max",
      "Panel candidate build 3 — opencode-go/minimax-m3",
      "Main baseline build in real workspace",
      "Validate panel outputs and determine quorum",
      "Compare panel findings and resolve differences",
      "Judge Merge Patch Contract — openai/gpt-5.4",
      "Apply approved targeted patches from Merge Patch Contract",
      "Run post-build contract audit",
      "Run correctness coverage gate",
      "Resolve one audit/fix cycle if needed",
      "Final verification",
    ]);
    expect(plan[0].status).toBe("completed");
    expect(plan[1].status).toBe("completed");
    expect(plan.slice(2).every((p) => p.status === "pending")).toBe(true);
  });

  test("fusion-no-build todo plan omits implement + verification stages", () => {
    const plan = buildTodoPlan({
      panelModelSpecs: defaultPanels,
      judgeModelSpec: { modelId: "openai/gpt-5.4" },
      command: "fusion-no-build",
      phase: "prepare",
    });
    expect(plan.map((p) => p.content)).not.toContain("Implement approved contract");
    expect(plan.map((p) => p.content)).not.toContain("Post-build contract audit");
    expect(plan.map((p) => p.content)).not.toContain("Run correctness coverage gate");
    expect(plan).toHaveLength(7);
  });

  test("collect phase marks panel todos completed/failed and quorum todo completed", () => {
    const plan = buildTodoPlan({
      panelModelSpecs: defaultPanels,
      judgeModelSpec: { modelId: "openai/gpt-5.4" },
      command: "fusion-build",
      phase: "collect",
      panelStatuses: [
        { success: true },
        { success: false },
        { success: true, validationStatus: "usable_with_warnings" },
      ],
      quorum: { required: 2, usable: 2, total: 3, degraded: true, failedPanels: [] },
    });
    expect(plan[1].status).toBe("completed");
    expect(plan[2].status).toBe("failed");
    expect(plan[3].status).toBe("completed");
    expect(plan[3].content).toContain("usable with warnings");
    expect(plan[4].status).toBe("completed");
    expect(plan[4].content).toContain("2/3 usable");
    expect(plan[4].content).toContain("degraded");
  });
});

describe("native collect + quorum", () => {
  test("proceeds with 2 usable panels and marks degraded; judge prompt includes quorum + failed diagnostics", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        panelModels: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-max", "opencode-go/minimax-m3"],
        minSuccessfulPanels: 2,
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    await nativeAdvance({ runId: prepare.runId }, { cwd: tmpCwd });

    const collect = await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", error: "timed out", errorType: "timeout" },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate },
        ],
      },
      { cwd: tmpCwd },
    );

    expect(collect.shouldProceed).toBe(true);
    expect(collect.quorum).toMatchObject({ usable: 2, total: 3, required: 2, degraded: true });
    expect(collect.degraded).toBe(true);
    // Speculative mode builds a Merge Patch Contract judge prompt (not the legacy
    // judge prompt). It still includes the Contract Gate and candidate workspace
    // paths. The Council Comparison Dossier is embedded when available.
    expect(collect.judgePrompt).toContain("Merge Patch Contract");
    expect(collect.judgePrompt).toContain("Contract Gate");
    expect(collect.judgePrompt).toContain("speculative");
    expect(collect.speculative).toBeDefined();
    expect(collect.speculative?.buildStrategy).toBe("speculative_parallel_build");
    expect(collect.speculative?.candidateWorkspaces).toHaveLength(3);
    expect(collect.judgeAgent.agentName).toBe("fusion-judge");
    expect(collect.panelStatus.find((p) => p.agentName === "fusion-panel-2")?.success).toBe(false);
    expect(collect.panelStatus.find((p) => p.agentName === "fusion-panel-2")?.errorType).toBe("timeout");
  });

  test("does not proceed when all panels fail", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "plan",
        panelMode: "advisory",
        command: "fusion-no-build",
        panelModels: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-max", "opencode-go/minimax-m3"],
        minSuccessfulPanels: 2,
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );

    const collect = await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", error: "down", errorType: "provider_error" },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", error: "down", errorType: "provider_error" },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", error: "down", errorType: "provider_error" },
        ],
      },
      { cwd: tmpCwd },
    );

    expect(collect.shouldProceed).toBe(false);
    expect(collect.quorum.usable).toBe(0);
    expect(collect.judgePrompt).toBe("");
  });

  test("candidate_build validation tiers mark incomplete candidate as failed", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        panelModels: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-max", "opencode-go/minimax-m3"],
        minSuccessfulPanels: 2,
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );

    const collect = await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: "just a high-level plan" },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate },
        ],
      },
      { cwd: tmpCwd },
    );

    const panel2 = collect.panelStatus.find((p) => p.agentName === "fusion-panel-2");
    expect(panel2?.success).toBe(false);
    expect(panel2?.validationStatus).toBe("failed");
    expect(collect.quorum.usable).toBe(2);
    expect(collect.shouldProceed).toBe(true);
  });
});

describe("native finalize + trace", () => {
  test("finalize parses judge output and records executionMode native_subagents + shared prompt hash + panel sessions", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        panelModels: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-max", "opencode-go/minimax-m3"],
        minSuccessfulPanels: 2,
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: completeCandidate, sessionId: "sess-1" },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: completeCandidate, sessionId: "sess-2" },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate, sessionId: "sess-3" },
        ],
      },
      { cwd: tmpCwd },
    );

    const judgeContract = [
      "# Speculative Build Comparison",
      "",
      "## Main Baseline Status",
      "- verification status: passed",
      "- key implementation paths: src/index.ts",
      "",
      "## Panel Candidate Status",
      "- panel 1: usable",
      "- panel 2: usable",
      "- panel 3: usable",
      "",
      "## Literal Requirement Gaps in Main",
      "- severity: MUST_FIX",
      "- literal requirement: export add from package root",
      "- observed main behavior: add defined but not exported",
      "- evidence: src/index.ts: add",
      "- required correction: add `export` keyword to add function",
      "- required regression test: package-entry import test for add",
      "",
      "## Main Strengths to Preserve",
      "- pure function implementation",
      "",
      "## Adopted Panel Insights",
      "- source panels: 1, 2",
      "- idea: typed error for non-number inputs",
      "- why correct: task requires typed errors",
      "- why it fits the main architecture: single export, no extra surface",
      "- exact implementation direction: add TypeError subclass",
      "- required test: add(NaN, 1) throws typed error",
      "",
      "## Rejected Panel Ideas",
      "- source panel: 3",
      "- idea: add a Curry helper",
      "- reason: scope risk — not requested by task",
      "",
      "## Patch Plan",
      "1. src/index.ts",
      "   symbol: add",
      "   required change: add export keyword",
      "   required regression test: package-entry import test",
      "   risk: low",
      "",
      "## Final Patch Decision",
      "- PATCH_REQUIRED",
    ].join("\n");

    const finalize = await nativeFinalize(
      { runId: prepare.runId, judgeOutput: judgeContract, judgeSessionId: "judge-sess" },
      { cwd: tmpCwd },
    );

    expect(finalize.success).toBe(true);
    expect(finalize.executionMode).toBe("native_subagents");
    expect(finalize.trace.executionMode).toBe("native_subagents");
    const state = await loadRunState(tmpCwd, prepare.runId);
    expect(finalize.trace.sharedPanelPromptHash).toBe(state.sharedPanelPromptHash);
    expect(finalize.trace.panelSessions).toHaveLength(3);
    const sessionHashes = finalize.trace.panelSessions?.map((s) => s.promptHash);
    expect(new Set(sessionHashes).size).toBe(1);
    expect(finalize.trace.panelSessions?.[0].nativeTask).toBe(true);
    expect(finalize.trace.panelSessions?.map((s) => s.sessionId)).toEqual(["sess-1", "sess-2", "sess-3"]);
    // Speculative mode: council result is built from the Merge Patch Contract.
    expect(finalize.councilResult.summary).toContain("Merge Patch Contract");
    expect(finalize.councilResult.summary).toContain("PATCH_REQUIRED");
    expect(finalize.finalGuidance).toContain("Speculative Build Comparison");
    expect(finalize.trace.contractGate?.publicExportsRequired).toBeInstanceOf(Array);
    expect(finalize.trace.postBuildAudit?.status).toBe("not_run");
    expect(finalize.traceSummary).toContain("native_subagents");
    expect(finalize.traceSummary).toContain(state.sharedPanelPromptHash ?? "");
    expect(finalize.artifactDir).toBeTruthy();
    // Speculative trace fields
    expect(finalize.trace.speculative).toBeDefined();
    expect(finalize.trace.speculative?.mode).toBe("speculative_parallel_build");
    expect(finalize.trace.speculative?.mergePatchDecision).toBe("PATCH_REQUIRED");
    expect(finalize.trace.speculative?.mergePatchContractPath).toBeTruthy();
    expect(finalize.trace.speculative?.panelCandidates).toHaveLength(3);
    expect(finalize.trace.speculative?.isolationCapability.verified).toBe(true);
    expect(finalize.traceSummary).toContain("Speculative Parallel Build");
    expect(finalize.traceSummary).toContain("speculative_parallel_build");
    expect(finalize.traceSummary.toLowerCase()).toContain("build strategy");
    expect(finalize.speculative).toBeDefined();
    expect(finalize.speculative?.mergePatchContract).toBeDefined();
    expect(finalize.speculative?.mergePatchDecision).toBe("PATCH_REQUIRED");
    expect(finalize.speculative?.mergePatchContract?.gaps).toHaveLength(1);
    expect(finalize.speculative?.mergePatchContract?.gaps[0]?.severity).toBe("MUST_FIX");
  });

  test("finalize records failure when judge errors", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "plan",
        panelMode: "advisory",
        command: "fusion-no-build",
        panelModels: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-max", "opencode-go/minimax-m3"],
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: "advice A" },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: "advice B" },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: "advice C" },
        ],
      },
      { cwd: tmpCwd },
    );

    const finalize = await nativeFinalize(
      { runId: prepare.runId, judgeError: "judge model timed out" },
      { cwd: tmpCwd },
    );

    expect(finalize.success).toBe(false);
    expect(finalize.error).toContain("judge model timed out");
    expect(finalize.trace.judge.success).toBe(false);
  });
});

describe("native post-build audit", () => {
  test("audit_prepare reuses fusion-judge and builds a contract-audit prompt", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: completeCandidate },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate },
        ],
      },
      { cwd: tmpCwd },
    );
    await nativeFinalize(
      {
        runId: prepare.runId,
        judgeOutput: JSON.stringify({
          summary: "ok",
          finalRecommendation: "Proceed.",
          requirementChecklist: ["export add"],
          finalBuildGuidance: "Final build contract",
          requiredTests: ["package-entry import test"],
          finalOutput: "## Final Build Contract\nContract",
        }),
      },
      { cwd: tmpCwd },
    );

    const auditPrepare = await nativePrepareAudit({ runId: prepare.runId }, { cwd: tmpCwd });

    expect(auditPrepare.enabled).toBe(true);
    expect(auditPrepare.auditAgent.agentName).toBe("fusion-judge");
    expect(auditPrepare.auditPrompt).toContain("post-build contract audit");
    expect(auditPrepare.auditPrompt).toContain("Contract Gate");
    expect(auditPrepare.auditPrompt).toContain("PASS | FIX_REQUIRED");
  });

  test("audit_finalize records fix_required findings and allows one fix cycle by default", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: completeCandidate },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate },
        ],
      },
      { cwd: tmpCwd },
    );
    await nativeFinalize(
      {
        runId: prepare.runId,
        judgeOutput: JSON.stringify({
          summary: "ok",
          finalRecommendation: "Proceed.",
          requirementChecklist: ["export add"],
          finalBuildGuidance: "Final build contract",
          requiredTests: ["package-entry import test"],
          finalOutput: "## Final Build Contract\nContract",
        }),
      },
      { cwd: tmpCwd },
    );
    await nativePrepareAudit({ runId: prepare.runId }, { cwd: tmpCwd });

    const auditFinalize = await nativeFinalizeAudit(
      {
        runId: prepare.runId,
        auditOutput: JSON.stringify({
          status: "FIX_REQUIRED",
          summary: "Missing package-root export test.",
          findings: [
            {
              requirement: "Package-root import/export check exists.",
              observed: "Tests only import internal modules.",
              requiredFix: "Add a consumer-facing package-entry test.",
            },
          ],
          finalOutput: "## Audit Verdict\nFIX_REQUIRED",
        }),
        auditSessionId: "audit-sess-1",
      },
      { cwd: tmpCwd },
    );

    expect(auditFinalize.success).toBe(true);
    expect(auditFinalize.status).toBe("FIX_REQUIRED");
    expect(auditFinalize.fixCyclesUsed).toBe(1);
    expect(auditFinalize.autoFixAllowed).toBe(true);
    expect(auditFinalize.trace.postBuildAudit?.status).toBe("fix_required");
    expect(auditFinalize.trace.postBuildAudit?.sessionId).toBe("audit-sess-1");
    expect(auditFinalize.trace.postBuildAudit?.findings[0]?.requiredFix).toContain("package-entry test");
  });
});

describe("native safety", () => {
  test("panel agent files allow edit (speculative candidate workspace writes), deny task and todowrite", async () => {
    for (let index = 1; index <= 3; index += 1) {
      const file = buildPanelAgentFile({ panelIndex: index, modelId: `provider/model-${index}` });
      // Speculative_parallel_build mode requires panels to write in their
      // isolated candidate workspaces. The panel prompt enforces the write
      // boundary (write ONLY in the assigned candidate workspace); the
      // runtime does not path-scope write permissions.
      expect(file.content).toContain("edit: allow");
      expect(file.content).toContain("write: allow");
      expect(file.content).toContain("task: deny");
      expect(file.content).toContain("todowrite: deny");
      expect(file.content).toContain("mode: subagent");
    }
  });

  test("judge agent file denies edit, task, and todowrite", async () => {
    const file = buildJudgeAgentFile({ modelId: "openai/gpt-5.4" });
    expect(file.content).toContain("edit: deny");
    expect(file.content).toContain("task: deny");
    expect(file.content).toContain("todowrite: deny");
  });

  test("orchestrator restricts task to fusion agents only", async () => {
    const file = buildOrchestratorAgentFile();
    expect(file.content).toContain("mode: primary");
    expect(file.content).toContain("fusion-panel-1: allow");
    expect(file.content).toContain("fusion-panel-2: allow");
    expect(file.content).toContain("fusion-panel-3: allow");
    expect(file.content).toContain("fusion-judge: allow");
    expect(file.content).toContain('"*": deny');
  });

  test("legacy runner is not used in native mode (nativeCouncil never calls modelRunner.generate)", async () => {
    const prepare = await nativePrepare(
      { task: "Build add(a,b)", mode: "plan", panelMode: "advisory", command: "fusion-no-build", trace: { saveRunArtifacts: true } },
      { cwd: tmpCwd },
    );
    expect(prepare.executionMode).toBe("native_subagents");
    expect(prepare.sharedPanelPrompt).toContain("ADVISORY mode");
  });
});

describe("cross-platform installer", () => {
  test("installer agent/command paths use home-directory APIs and never install fusion-status", async () => {
    const installerSource = await readFile(path.join(process.cwd(), "scripts", "install-opencode-agents.mjs"), "utf8");
    expect(installerSource).toContain('join(homedir(), ".config", "opencode"');
    expect(installerSource).toContain('join(opencodeDir, "agent")');
    expect(installerSource).toContain('join(opencodeDir, "commands")');
    expect(installerSource).not.toContain("fusion-status");

    const entries = await readdir(path.join(process.cwd(), "examples", "commands"));
    expect(entries).not.toContain("fusion-status.md");
  });

  test("syncDefaultNativeAgents uses default models", async () => {
    const result = await syncDefaultNativeAgents(tmpAgentDir);
    expect(result.panelAgents.map((p) => p.modelId)).toEqual([
      "opencode-go/kimi-k2.7-code",
      "opencode-go/qwen3.7-max",
      "opencode-go/minimax-m3",
    ]);
    expect(result.judgeAgent.modelId).toBe("openai/gpt-5.5");
  });

  test("installer-generated panel file matches agentSync-generated file for defaults", async () => {
    const installer = await import("../scripts/install-opencode-agents.mjs");
    await syncDefaultNativeAgents(tmpAgentDir);
    const installerPanel1 = installer.buildPanelFile(1, "opencode-go/kimi-k2.7-code").content;
    const agentPanel1 = await readFile(path.join(tmpAgentDir, "fusion-panel-1.md"), "utf8");
    expect(installerPanel1).toBe(agentPanel1);
  });

  test("installer-generated judge and orchestrator files match agentSync-generated files", async () => {
    const installer = await import("../scripts/install-opencode-agents.mjs");
    await syncDefaultNativeAgents(tmpAgentDir);
    expect(installer.buildJudgeFile("openai/gpt-5.5").content).toBe(
      await readFile(path.join(tmpAgentDir, "fusion-judge.md"), "utf8"),
    );
    expect(installer.buildOrchestratorFile().content).toBe(
      await readFile(path.join(tmpAgentDir, "fusion-orchestrator.md"), "utf8"),
    );
  });

  test("installer default models and supported commands match package defaults", async () => {
    const installer = await import("../scripts/install-opencode-agents.mjs");
    expect(installer.DEFAULT_PANEL_MODELS).toEqual([
      "opencode-go/kimi-k2.7-code",
      "opencode-go/qwen3.7-max",
      "opencode-go/minimax-m3",
    ]);
    expect(installer.DEFAULT_JUDGE_MODEL).toBe("openai/gpt-5.5");
    expect(installer.SUPPORTED_COMMANDS).not.toContain("fusion-status.md");
    expect(installer.SUPPORTED_COMMANDS).toContain("fusion-build.md");
    expect(installer.SUPPORTED_COMMANDS).toContain("fusion-no-build.md");
    expect(installer.SUPPORTED_COMMANDS).toContain("fusion-resume.md");
  });
});

describe("fusion-model set syncs agents (parseModelArgs roundtrip)", () => {
  test("parseModelArgs yields specs that syncNativeAgents preserves exactly", async () => {
    const { panelModels, judgeModel } = parseModelArgs(
      "opencode-go/kimi-k2.7-code, opencode-go/qwen3.7-max, opencode-go/minimax-m3, openai/gpt-5.4/high",
    );
    const result = await syncNativeAgents({ panelModels, judgeModel }, tmpAgentDir);
    expect(result.panelAgents.map((p) => p.modelId)).toEqual([
      "opencode-go/kimi-k2.7-code",
      "opencode-go/qwen3.7-max",
      "opencode-go/minimax-m3",
    ]);
    expect(result.judgeAgent.modelId).toBe("openai/gpt-5.4");
    expect(result.judgeAgent.reasoningEffort).toBe("high");
    const judge = await readFile(path.join(tmpAgentDir, "fusion-judge.md"), "utf8");
    expect(judge).toContain("variant: high");
  });
});

describe("panel execution plan and attempts trace", () => {
  test("nativePrepare returns panelExecutionPlan with staggered cascade and liveness capability", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    expect(prepare.panelExecutionPlan).toBeDefined();
    expect(prepare.panelExecutionPlan.staggered).toBe(true);
    expect(prepare.panelExecutionPlan.startGateTimeoutMs).toBe(60_000);
    expect(prepare.panelExecutionPlan.inactivityTimeoutMs).toBe(90_000);
    expect(prepare.panelExecutionPlan.maxAttemptsPerPanel).toBe(2);
    expect(prepare.panelExecutionPlan.stages).toHaveLength(3);
    expect(prepare.panelExecutionPlan.stages[0].startsAfter).toBe("immediately");
    expect(prepare.panelExecutionPlan.stages[1].startsAfter).toBe("previous_first_activity");
    expect(prepare.panelExecutionPlan.stages[2].startsAfter).toBe("previous_first_activity");
    expect(prepare.panelExecutionPlan.capability.streamActivityExposed).toBe(false);
    expect(prepare.panelExecutionPlan.capability.tokenLevelLiveness).toBe(false);
  });

  test("nativeCollect accepts panelAttempts and records them in state and result", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    const panelAttempts = [
      {
        logicalPanelIndex: 1,
        attempt: 1,
        model: "opencode-go/kimi-k2.7-code",
        startedAt: "2026-06-22T00:00:00.000Z",
        endedAt: "2026-06-22T00:01:30.000Z",
        status: "succeeded" as const,
        startReason: "cascade_activity" as const,
      },
      {
        logicalPanelIndex: 1,
        attempt: 2,
        model: "opencode-go/kimi-k2.7-code",
        startedAt: "2026-06-22T00:01:31.000Z",
        endedAt: "2026-06-22T00:02:30.000Z",
        status: "succeeded" as const,
        startReason: "retry" as const,
      },
      {
        logicalPanelIndex: 2,
        attempt: 1,
        model: "opencode-go/qwen3.7-max",
        startedAt: "2026-06-22T00:01:00.000Z",
        endedAt: "2026-06-22T00:02:30.000Z",
        status: "succeeded" as const,
        startReason: "start_gate_timeout" as const,
      },
      {
        logicalPanelIndex: 3,
        attempt: 1,
        model: "opencode-go/minimax-m3",
        startedAt: "2026-06-22T00:02:00.000Z",
        endedAt: "2026-06-22T00:03:30.000Z",
        status: "succeeded" as const,
        startReason: "start_gate_timeout" as const,
      },
    ];
    const collect = await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: completeCandidate },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate },
        ],
        panelAttempts,
      },
      { cwd: tmpCwd },
    );
    expect(collect.panelAttempts).toEqual(panelAttempts);
    expect(collect.panelLivenessCapability?.streamActivityExposed).toBe(false);
    expect(collect.panelLivenessCapability?.tokenLevelLiveness).toBe(false);
    // Verify state persisted
    const state = await loadRunState(tmpCwd, prepare.runId);
    expect(state.panelAttempts).toEqual(panelAttempts);
    expect(state.panelLivenessCapability?.streamActivityExposed).toBe(false);
  });

  test("finalize trace includes panelAttempts, liveness capability, and execution plan", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    const panelAttempts = [
      {
        logicalPanelIndex: 1,
        attempt: 1,
        model: "opencode-go/kimi-k2.7-code",
        startedAt: "2026-06-22T00:00:00.000Z",
        endedAt: "2026-06-22T00:01:30.000Z",
        status: "succeeded" as const,
        startReason: "cascade_activity" as const,
      },
      {
        logicalPanelIndex: 2,
        attempt: 1,
        model: "opencode-go/qwen3.7-max",
        startedAt: "2026-06-22T00:01:00.000Z",
        endedAt: "2026-06-22T00:02:30.000Z",
        status: "succeeded" as const,
        startReason: "start_gate_timeout" as const,
      },
    ];
    await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: completeCandidate },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate },
        ],
        panelAttempts,
      },
      { cwd: tmpCwd },
    );
    const finalize = await nativeFinalize(
      {
        runId: prepare.runId,
        judgeOutput: JSON.stringify({
          summary: "ok",
          finalRecommendation: "Proceed.",
          requirementChecklist: ["export add"],
          finalBuildGuidance: "Final build contract",
          requiredTests: ["probe"],
          finalOutput: "## Spec Compliance Verdict\nok",
        }),
      },
      { cwd: tmpCwd },
    );
    expect(finalize.trace.panelAttempts).toEqual(panelAttempts);
    expect(finalize.trace.panelLivenessCapability?.streamActivityExposed).toBe(false);
    expect(finalize.trace.panelLivenessCapability?.tokenLevelLiveness).toBe(false);
    expect(finalize.trace.panelExecutionPlan?.staggered).toBe(true);
    expect(finalize.trace.panelExecutionPlan?.startGateTimeoutMs).toBe(60_000);
    expect(finalize.traceSummary).toContain("Panel cascade");
    expect(finalize.traceSummary).toContain("staggered");
    expect(finalize.traceSummary).toContain("Panel liveness telemetry");
    expect(finalize.traceSummary).toContain("streamActivity=not exposed");
    expect(finalize.traceSummary).toContain("Panel attempts recorded");
  });

  test("trace summary shows panel attempts grouped by logical slot with retry visibility", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    const panelAttempts = [
      {
        logicalPanelIndex: 1,
        attempt: 1,
        model: "opencode-go/kimi-k2.7-code",
        startedAt: "2026-06-22T00:00:00.000Z",
        endedAt: "2026-06-22T00:01:00.000Z",
        status: "stalled" as const,
        startReason: "cascade_activity" as const,
        stallReason: "task_timeout" as const,
      },
      {
        logicalPanelIndex: 1,
        attempt: 2,
        model: "opencode-go/kimi-k2.7-code",
        startedAt: "2026-06-22T00:01:01.000Z",
        endedAt: "2026-06-22T00:02:30.000Z",
        status: "succeeded" as const,
        startReason: "retry" as const,
      },
    ];
    await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: completeCandidate },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate },
        ],
        panelAttempts,
      },
      { cwd: tmpCwd },
    );
    const finalize = await nativeFinalize(
      {
        runId: prepare.runId,
        judgeOutput: JSON.stringify({
          summary: "ok",
          finalRecommendation: "Proceed.",
          requirementChecklist: ["export add"],
          finalBuildGuidance: "Final build contract",
          requiredTests: ["probe"],
          finalOutput: "## Spec Compliance Verdict\nok",
        }),
      },
      { cwd: tmpCwd },
    );
    expect(finalize.traceSummary).toContain("fusion-panel-1 attempt 1: stalled");
    expect(finalize.traceSummary).toContain("fusion-panel-1 attempt 2: succeeded");
    expect(finalize.traceSummary).toContain("startReason=retry");
    expect(finalize.traceSummary).toContain("stallReason=task_timeout");
    // No fusion-panel-4 ever appears
    expect(finalize.traceSummary).not.toContain("fusion-panel-4");
  });
});

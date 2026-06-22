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
import { nativeCollect, nativeFinalize, nativeFinalizeAudit, nativePrepare, nativePrepareAudit, buildTodoPlan } from "../src/native/nativeCouncil.js";
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
    expect(panel1).toContain("edit: deny");
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
  test("nativePrepare returns identical prompt hash for all three panels", async () => {
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
    expect(hashes[0]).toBe(prepare.sharedPanelPromptHash);
    expect(prepare.sharedPanelPromptHash).toBe(hashSharedPanelPrompt(prepare.sharedPanelPrompt));
    expect(prepare.panelAgents.map((p) => p.nativeTask)).toEqual([true, true, true]);
    expect(prepare.panelAgents.map((p) => p.agentName)).toEqual(["fusion-panel-1", "fusion-panel-2", "fusion-panel-3"]);
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
  test("fusion-build todo plan includes consumer-test, audit, and verification stages", () => {
    const plan = buildTodoPlan({
      panelModelSpecs: defaultPanels,
      judgeModelSpec: { modelId: "openai/gpt-5.4" },
      command: "fusion-build",
      phase: "prepare",
    });
    expect(plan.map((p) => p.content)).toEqual([
      "Build Contract Gate and shared panel prompt",
      "Panel 1 analysis — opencode-go/kimi-k2.7-code",
      "Panel 2 analysis — opencode-go/qwen3.7-max",
      "Panel 3 analysis — opencode-go/minimax-m3",
      "Validate panel outputs and determine quorum",
      "Judge synthesis — openai/gpt-5.4",
      "Implement approved plan",
      "Create or update contract-focused consumer tests",
      "Post-build contract audit",
      "Resolve contract audit findings",
      "Final verification",
    ]);
    expect(plan[0].status).toBe("completed");
    expect(plan.slice(1).every((p) => p.status === "pending")).toBe(true);
  });

  test("fusion-no-build todo plan omits implement + verification stages", () => {
    const plan = buildTodoPlan({
      panelModelSpecs: defaultPanels,
      judgeModelSpec: { modelId: "openai/gpt-5.4" },
      command: "fusion-no-build",
      phase: "prepare",
    });
    expect(plan.map((p) => p.content)).not.toContain("Implement approved plan");
    expect(plan.map((p) => p.content)).not.toContain("Post-build contract audit");
    expect(plan).toHaveLength(6);
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
    expect(collect.judgePrompt).toContain("Council quorum status");
    expect(collect.judgePrompt).toContain("Contract Gate");
    expect(collect.judgePrompt).toContain("opencode-go/qwen3.7-max");
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

    const judgeJson = JSON.stringify({
      decision: "implement",
      summary: "Use the merged minimal candidate.",
      consensus: ["Keep add literal"],
      contradictions: [],
      uniqueInsights: [],
      risks: [],
      missingConsiderations: [],
      requirementChecklist: ["export add"],
      rejectedRiskyIdeas: ["no extra helpers"],
      finalBuildGuidance: "## Final build contract\nImplement add.",
      mustNotBreakConstraints: ["no speculative behavior"],
      requiredTests: ["probe add(2,3)=5"],
      finalRecommendation: "Proceed.",
      finalOutput: "## Spec Compliance Verdict\n## Required hidden tests\n- probe add",
      panelAssessments: [],
      implementationPlan: ["Create src/index.ts"],
      testPlan: ["Add vitest test"],
      knownTraps: ["do not emit extra files"],
      finalComplianceChecklist: ["exactly one public function"],
    });

    const finalize = await nativeFinalize(
      { runId: prepare.runId, judgeOutput: judgeJson, judgeSessionId: "judge-sess" },
      { cwd: tmpCwd },
    );

    expect(finalize.success).toBe(true);
    expect(finalize.executionMode).toBe("native_subagents");
    expect(finalize.trace.executionMode).toBe("native_subagents");
    expect(finalize.trace.sharedPanelPromptHash).toBe(prepare.sharedPanelPromptHash);
    expect(finalize.trace.panelSessions).toHaveLength(3);
    const sessionHashes = finalize.trace.panelSessions?.map((s) => s.promptHash);
    expect(new Set(sessionHashes).size).toBe(1);
    expect(finalize.trace.panelSessions?.[0].nativeTask).toBe(true);
    expect(finalize.trace.panelSessions?.map((s) => s.sessionId)).toEqual(["sess-1", "sess-2", "sess-3"]);
    expect(finalize.councilResult.summary).toBe("Use the merged minimal candidate.");
    expect(finalize.finalGuidance).toContain("Final build contract");
    expect(finalize.trace.contractGate?.publicExportsRequired).toBeInstanceOf(Array);
    expect(finalize.trace.postBuildAudit?.status).toBe("not_run");
    expect(finalize.traceSummary).toContain("native_subagents");
    expect(finalize.traceSummary).toContain(prepare.sharedPanelPromptHash);
    expect(finalize.artifactDir).toBeTruthy();
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
  test("panel agent files deny edit, task, and todowrite", async () => {
    for (let index = 1; index <= 3; index += 1) {
      const file = buildPanelAgentFile({ panelIndex: index, modelId: `provider/model-${index}` });
      expect(file.content).toContain("edit: deny");
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

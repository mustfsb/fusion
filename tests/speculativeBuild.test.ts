import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  nativeAdvance,
  nativeCollect,
  nativeFinalize,
  nativeFinalizeAudit,
  nativePrepare,
  nativePrepareAudit,
  nativeRecordMainBaseline,
} from "../src/native/nativeCouncil.js";
import {
  parseMergePatchContract,
  selectApprovedPatchItems,
} from "../src/native/speculativeBuild.js";
import { completeCandidate } from "./fixtures/candidates.js";

let tmpCwd: string;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-24T10:00:00.000Z"));
  tmpCwd = await mkdtemp(path.join(tmpdir(), "fusion-speculative-"));
  await mkdir(path.join(tmpCwd, "src"), { recursive: true });
  await writeFile(path.join(tmpCwd, "src", "index.ts"), "export const add = (a:number,b:number) => a + b;\n", "utf8");
  await writeFile(path.join(tmpCwd, "package.json"), JSON.stringify({ name: "speculative-test" }, null, 2), "utf8");
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(tmpCwd, { recursive: true, force: true });
});

describe("Merge Patch Contract parsing", () => {
  test("parses required sections and decisions", () => {
    const contractText = [
      "# Speculative Build Comparison",
      "",
      "## Main Baseline Status",
      "- verification status: passed",
      "",
      "## Panel Candidate Status",
      "- panel 1: usable",
      "",
      "## Literal Requirement Gaps in Main",
      "- severity: BLOCKER",
      "- literal requirement: export add",
      "- observed main behavior: not exported",
      "- evidence: src/index.ts:add",
      "- required correction: export add",
      "- required regression test: package-entry import test",
      "",
      "## Main Strengths to Preserve",
      "- pure arithmetic",
      "",
      "## Adopted Panel Insights",
      "- source panels: 1, 2",
      "- idea: keep function pure",
      "- why correct: task requires sum only",
      "- why it fits the main architecture: small module",
      "- exact implementation direction: no extra state",
      "",
      "## Rejected Panel Ideas",
      "- source panel: 3",
      "- idea: curry helper",
      "- reason: scope risk",
      "",
      "## Patch Plan",
      "1. src/index.ts",
      "   symbol: add",
      "   required change: add export",
      "   required regression test: package-entry import test",
      "   risk: low",
      "",
      "## Final Patch Decision",
      "- PATCH_REQUIRED",
    ].join("\n");

    const parsed = parseMergePatchContract(contractText);
    expect(parsed.finalDecision).toBe("PATCH_REQUIRED");
    expect(parsed.gaps).toHaveLength(1);
    expect(parsed.gaps[0]?.severity).toBe("BLOCKER");
    expect(parsed.patchPlan).toHaveLength(1);
    expect(parsed.rejectedIdeas).toHaveLength(1);

    const approved = selectApprovedPatchItems(parsed);
    expect(approved.blockers).toHaveLength(1);
    expect(approved.rejected).toHaveLength(0);
  });
});

describe("speculative parallel build smoke", () => {
  test("creates candidate workspaces, records overlap, writes Merge Patch Contract, and records audit patch items", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        buildStrategy: "speculative_parallel_build",
        command: "fusion-build",
        minSuccessfulPanels: 2,
        parallelExecutionSupported: true,
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    const advance = await nativeAdvance({ runId: prepare.runId }, { cwd: tmpCwd });

    expect(prepare.executionMode).toBe("native_subagents");
    expect(prepare.buildStrategy).toBe("speculative_parallel_build");
    expect(prepare.speculative?.candidateWorkspaces).toHaveLength(0);
    expect(advance.speculative?.candidateWorkspaces).toHaveLength(3);
    expect(prepare.panelAgents.map((p) => p.agentName)).toEqual(["fusion-panel-1", "fusion-panel-2", "fusion-panel-3"]);
    expect(advance.speculative?.isolationCapability.verified).toBe(true);
    expect(advance.speculative?.sourceArtifactDir).toContain(tmpCwd);
    expect(advance.speculative?.externalCandidateStagingDir).toBeTruthy();
    for (const workspace of advance.speculative?.candidateWorkspaces ?? []) {
      expect(workspace.workspacePath.startsWith(advance.speculative?.externalCandidateStagingDir ?? "")).toBe(true);
      expect(workspace.workspacePath.startsWith(tmpCwd)).toBe(false);
    }

    const mainBaseline = {
      startedAt: "2026-06-24T10:00:10.000Z",
      completedAt: "2026-06-24T10:01:30.000Z",
      status: "passed" as const,
      workspacePath: tmpCwd,
      changedFiles: ["src/index.ts"],
      verification: {
        typecheck: "pass" as const,
        test: "pass" as const,
        build: "pass" as const,
        commandsRun: ["npm run typecheck", "npm test", "npm run build"],
      },
    };

    const record = await nativeRecordMainBaseline(
      { runId: prepare.runId, mainBaseline },
      { cwd: tmpCwd },
    );
    expect(record.recorded).toBe(true);
    expect(record.mainBaseline.status).toBe("passed");

    const collect = await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: prepare.panelAgents[0].modelId, content: completeCandidate, sessionId: "p1" },
          { agentName: "fusion-panel-2", modelId: prepare.panelAgents[1].modelId, content: completeCandidate, sessionId: "p2" },
          { agentName: "fusion-panel-3", modelId: prepare.panelAgents[2].modelId, content: completeCandidate, sessionId: "p3" },
        ],
        panelAttempts: [
          {
            logicalPanelIndex: 1,
            attempt: 1,
            model: prepare.panelAgents[0].modelId,
            startedAt: "2026-06-24T10:00:00.000Z",
            endedAt: "2026-06-24T10:01:40.000Z",
            status: "succeeded",
            startReason: "cascade_activity",
          },
          {
            logicalPanelIndex: 2,
            attempt: 1,
            model: prepare.panelAgents[1].modelId,
            startedAt: "2026-06-24T10:01:00.000Z",
            endedAt: "2026-06-24T10:02:00.000Z",
            status: "succeeded",
            startReason: "start_gate_timeout",
          },
          {
            logicalPanelIndex: 3,
            attempt: 1,
            model: prepare.panelAgents[2].modelId,
            startedAt: "2026-06-24T10:02:00.000Z",
            endedAt: "2026-06-24T10:03:00.000Z",
            status: "succeeded",
            startReason: "start_gate_timeout",
          },
        ],
        mainBaseline,
      },
      { cwd: tmpCwd },
    );

    expect(collect.shouldProceed).toBe(true);
    expect(collect.speculative?.overlapObserved).toBe(true);
    expect(collect.speculative?.candidateWorkspaces).toHaveLength(3);
    expect(collect.judgePrompt).toContain("Merge Patch Contract");
    expect(collect.judgePrompt).toContain("Speculative Build Comparison");

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
      "- evidence: src/index.ts:add",
      "- required correction: add export keyword",
      "- required regression test: package-entry import test",
      "",
      "## Main Strengths to Preserve",
      "- pure arithmetic function",
      "",
      "## Adopted Panel Insights",
      "- source panels: 1, 2",
      "- idea: keep the implementation pure",
      "- why correct: task is literal add",
      "- why it fits the main architecture: single function module",
      "- exact implementation direction: no helpers",
      "- required test: add(2,3)=5",
      "",
      "## Rejected Panel Ideas",
      "- source panel: 3",
      "- idea: curry helper",
      "- reason: scope risk",
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
      { runId: prepare.runId, judgeOutput: judgeContract, judgeSessionId: "judge-1" },
      { cwd: tmpCwd },
    );

    expect(finalize.success).toBe(true);
    expect(finalize.speculative?.mergePatchDecision).toBe("PATCH_REQUIRED");
    expect(finalize.speculative?.mergePatchContractPath).toBeTruthy();
    expect(finalize.finalGuidance).toContain("Speculative Build Comparison");
    expect(finalize.trace.speculative?.panelCandidates).toHaveLength(3);
    expect(finalize.trace.speculative?.sourceArtifactDir).toBeTruthy();
    expect(finalize.trace.speculative?.externalCandidateStagingDir).toBeTruthy();
    expect(collect.judgePrompt).toContain(prepare.speculative?.externalCandidateStagingDir ?? "");
    expect(finalize.traceSummary).toContain("Speculative Parallel Build");
    expect(finalize.traceSummary).toContain("overlap observed: yes");
    expect(finalize.traceSummary).toContain("merge patch contract");

    const auditPrepare = await nativePrepareAudit({ runId: prepare.runId }, { cwd: tmpCwd });
    expect(auditPrepare.enabled).toBe(true);

    const auditFinalize = await nativeFinalizeAudit(
      {
        runId: prepare.runId,
        auditOutput: JSON.stringify({
          status: "PASS",
          summary: "audit ok",
          findings: [],
          finalOutput: "## Audit Verdict\nPASS",
        }),
        auditSessionId: "audit-1",
        appliedPatchItems: [
          { severity: "MUST_FIX", title: "export add from package root", status: "applied" },
        ],
      },
      { cwd: tmpCwd },
    );

    expect(auditFinalize.trace.speculative?.appliedPatchItems).toHaveLength(1);
    expect(auditFinalize.trace.speculative?.appliedPatchItems?.[0]?.status).toBe("applied");
    expect(auditFinalize.trace.postBuildAudit?.status).toBe("pass");
    expect(auditFinalize.traceSummary).toContain("Patch phase:");
    expect(auditFinalize.traceSummary).toContain("applied: 1");

    const contractText = await readFile(finalize.speculative?.mergePatchContractPath ?? "", "utf8");
    expect(contractText).toContain("PATCH_REQUIRED");
  });
});

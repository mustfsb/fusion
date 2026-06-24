import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { nativeAdvance, nativePrepare, nativeCollect } from "../src/native/nativeCouncil.js";
import { loadRunState } from "../src/native/runState.js";
import {
  buildPanelExecutionContext,
  buildPanelInlineDispatchPrompt,
  buildSpeculativeSharedPanelPrompt,
  parseCandidateWorkspaceUnusable,
  FUSION_CANDIDATE_WORKSPACE_UNUSABLE_PREFIX,
} from "../src/native/speculativeBuild.js";
import {
  assertNoUnresolvedPlaceholders,
  findUnresolvedPlaceholders,
} from "../src/native/placeholderGuard.js";
import { candidatePanelOutputPaths, collectCandidateReports } from "../src/native/candidateWorkspace.js";
import { buildPanelAgentFile } from "../src/native/agentTemplates.js";
import { physicalLineCount } from "../src/council/promptTransport.js";
import { completeCandidate } from "./fixtures/candidates.js";
import { TEST_RUN_ID_ADVISORY, TEST_RUN_ID_BIND } from "./fixtures/runIds.js";

const PLACEHOLDER_PATTERN = /<[A-Z][A-Z0-9_]*>/;

let sourceWorkspace: string;
let cacheRoot: string;
const previousCacheRoot = process.env.FUSION_SPECULATIVE_CACHE_ROOT;

beforeEach(async () => {
  sourceWorkspace = await mkdtemp(path.join(tmpdir(), "fusion-bind-src-"));
  cacheRoot = await mkdtemp(path.join(tmpdir(), "fusion-bind-cache-"));
  process.env.FUSION_SPECULATIVE_CACHE_ROOT = cacheRoot;
  await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
  await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const add = (a:number,b:number) => a+b;\n", "utf8");
  await writeFile(path.join(sourceWorkspace, "package.json"), JSON.stringify({ name: "bind-test" }), "utf8");
});

afterEach(async () => {
  if (previousCacheRoot === undefined) delete process.env.FUSION_SPECULATIVE_CACHE_ROOT;
  else process.env.FUSION_SPECULATIVE_CACHE_ROOT = previousCacheRoot;
  await Promise.all([
    rm(sourceWorkspace, { recursive: true, force: true }),
    rm(cacheRoot, { recursive: true, force: true }),
  ]);
});

async function prepareSpeculative() {
  const prepare = await nativePrepare(
    {
      task: "Build add(a,b) and export it from the package root.",
      mode: "build_prompt",
      panelMode: "candidate_build",
      buildStrategy: "speculative_parallel_build",
      command: "fusion-build",
      runId: TEST_RUN_ID_BIND,
      minSuccessfulPanels: 2,
      parallelExecutionSupported: true,
      panelModels: ["test/panel-a", "test/panel-b", "test/panel-c"],
      judgeModel: "test/judge",
      trace: { saveRunArtifacts: true, traceDir: "." },
    },
    { cwd: sourceWorkspace, traceDir: "." },
  );
  await nativeAdvance({ runId: prepare.runId }, { cwd: sourceWorkspace, traceDir: "." });
  const state = await loadRunState(sourceWorkspace, prepare.runId, ".");
  return {
    ...prepare,
    sharedPanelPrompt: state.sharedPanelPrompt,
    sharedPanelPromptHash: state.sharedPanelPromptHash,
    sharedPanelPromptPath: state.sharedPanelPromptPath,
    panelTransportPrompt: state.panelTransportPrompt,
    panelPromptTransport: state.panelPromptTransport,
    panelAgents: state.panelAgents,
    speculative: state.speculative ? {
      buildStrategy: state.speculative.buildStrategy,
      sourceWorkspace: state.speculative.sourceWorkspace,
      sourceArtifactDir: state.speculative.sourceArtifactDir,
      externalCandidateStagingDir: state.speculative.externalCandidateStagingDir,
      sourceBaselineManifestPath: state.speculative.sourceBaselineManifestPath,
      sourceBaselineSummaryPath: state.speculative.sourceBaselineSummaryPath,
      candidateWorkspaces: state.speculative.candidateWorkspaces,
      isolationCapability: state.speculative.isolationCapability,
      parallelExecutionSupported: state.speculative.parallelExecutionSupported,
      parallelCapabilityLimitation: state.speculative.parallelCapabilityLimitation,
      preflightDiagnostic: state.speculative.preflightDiagnostic,
      aborted: state.speculative.aborted,
      abortReason: state.speculative.abortReason,
      preparedAt: state.speculative.preparedAt,
      candidatePreparationCompletedAt: state.speculative.candidatePreparationCompletedAt,
      judgeEligibleAt: state.speculative.judgeEligibleAt,
      pathResolution: state.speculative.pathResolution!,
      sharedTaskPath: state.speculative.sharedTaskPath,
      panelExecutionAssignments: state.speculative.panelExecutionAssignments,
    } : undefined,
  };
}

describe("speculative per-panel execution binding", () => {
  test("each panel gets a distinct, fully resolved execution context (no placeholders)", async () => {
    const prepare = await prepareSpeculative();
    const assignments = prepare.speculative?.panelExecutionAssignments ?? [];
    expect(assignments).toHaveLength(3);

    const candidatePaths = new Set<string>();
    const contextPaths = new Set<string>();
    for (const assignment of assignments) {
      candidatePaths.add(assignment.assignedCandidateWorkspace);
      contextPaths.add(assignment.executionContextPath);
      expect(assignment.unresolvedPlaceholderCheck).toBe("passed");
      expect(assignment.nativeCwdScoped).toBe(false);
      expect(assignment.absolutePathModeRequired).toBe(true);
      expect(assignment.resolverVersion).toBe("external_staging_v1");
      // execution context file is written and free of unresolved placeholders
      const text = await readFile(assignment.executionContextPath, "utf8");
      expect(findUnresolvedPlaceholders(text)).toEqual([]);
      expect(text).toContain(assignment.assignedCandidateWorkspace);
      expect(text).toContain(assignment.prohibitedSourceWorkspace);
    }
    expect(candidatePaths.size).toBe(3);
    expect(contextPaths.size).toBe(3);
  });

  test("shared task is byte-identical across panels and contains no candidate-workspace placeholder", async () => {
    const prepare = await prepareSpeculative();
    const hashes = prepare.panelAgents.map((p) => p.promptHash);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(prepare.sharedPanelPromptHash);
    // all panels reference the same shared task path
    const sharedPaths = new Set(prepare.panelAgents.map((p) => p.sharedTaskPath));
    expect(sharedPaths.size).toBe(1);
    // shared prompt has no fusion placeholder token
    expect(prepare.sharedPanelPrompt).not.toContain("<CANDIDATE_WORKSPACE_PLACEHOLDER>");
    expect(prepare.sharedPanelPrompt).not.toMatch(PLACEHOLDER_PATTERN);
    const sharedFile = await readFile(prepare.speculative?.sharedTaskPath ?? "", "utf8");
    expect(sharedFile).not.toMatch(PLACEHOLDER_PATTERN);
  });

  test("each execution context carries candidate path, source path, candidate-local report path, no placeholders", async () => {
    const prepare = await prepareSpeculative();
    const workspaces = prepare.speculative?.candidateWorkspaces ?? [];
    for (const ws of workspaces) {
      const expectedReport = candidatePanelOutputPaths(ws.workspacePath).reportPath;
      expect(ws.candidateReportPath).toBe(expectedReport);
      const agent = prepare.panelAgents[ws.logicalPanelIndex - 1];
      const text = await readFile(agent.executionContextPath ?? "", "utf8");
      expect(text).toContain(ws.workspacePath);
      expect(text).toContain(sourceWorkspace);
      expect(text).toContain(expectedReport);
      expect(findUnresolvedPlaceholders(text)).toEqual([]);
    }
  });

  test("native dispatch receives the per-panel execution-context path and candidate path", async () => {
    const prepare = await prepareSpeculative();
    prepare.panelAgents.forEach((agent, index) => {
      const ws = prepare.speculative?.candidateWorkspaces[index];
      expect(agent.candidateWorkspacePath).toBe(ws?.workspacePath);
      expect(agent.sourceWorkspacePath).toBe(sourceWorkspace);
      expect(agent.executionContextPath).toContain(`panel-${index + 1}-execution-context.full.md`);
      expect(agent.panelReportPath).toBe(ws?.candidateReportPath);
      expect(agent.inlineDispatchPrompt).toBeTruthy();
    });
  });

  test("inline dispatch prompt requires reading execution context then shared task, and is <=50 lines with no placeholders", async () => {
    const prepare = await prepareSpeculative();
    for (const agent of prepare.panelAgents) {
      const inline = agent.inlineDispatchPrompt ?? "";
      expect(physicalLineCount(inline)).toBeLessThanOrEqual(50);
      expect(inline).toContain(agent.executionContextPath ?? "");
      expect(inline).toContain(agent.sharedTaskPath ?? "");
      // ordering: execution context referenced before shared task
      expect(inline.indexOf("Execution assignment FIRST")).toBeLessThan(inline.indexOf("Shared canonical task SECOND"));
      expect(findUnresolvedPlaceholders(inline)).toEqual([]);
    }
  });

  test("/fusion-no-build advisory prepare creates no panel execution contexts", async () => {
    const prepare = await nativePrepare(
      {
        task: "Advise on add(a,b).",
        mode: "plan",
        panelMode: "advisory",
        command: "fusion-no-build",
        runId: TEST_RUN_ID_ADVISORY,
        trace: { saveRunArtifacts: true, traceDir: "." },
      },
      { cwd: sourceWorkspace, traceDir: "." },
    );
    expect(prepare.speculative).toBeUndefined();
    for (const agent of prepare.panelAgents) {
      expect(agent.executionContextPath).toBeUndefined();
      expect(agent.inlineDispatchPrompt).toBeUndefined();
      expect(agent.candidateWorkspacePath).toBeUndefined();
    }
  });

  test("a panel with source-workspace CWD but a valid candidate path proceeds (absolute-path mode)", async () => {
    const prepare = await prepareSpeculative();
    for (const assignment of prepare.speculative?.panelExecutionAssignments ?? []) {
      expect(assignment.absolutePathModeRequired).toBe(true);
      expect(assignment.nativeCwdScoped).toBe(false);
      expect(assignment.prohibitedSourceWorkspace).toBe(sourceWorkspace);
    }
    // A panel returning a normal candidate (operating in absolute-path mode) is usable.
    const collect = await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: prepare.panelAgents[0].modelId, content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: prepare.panelAgents[1].modelId, content: completeCandidate },
          { agentName: "fusion-panel-3", modelId: prepare.panelAgents[2].modelId, content: completeCandidate },
        ],
        mainBaseline: { status: "passed", workspacePath: sourceWorkspace, changedFiles: ["src/index.ts"] },
      },
      { cwd: sourceWorkspace, traceDir: "." },
    );
    expect(collect.shouldProceed).toBe(true);
    expect(collect.quorum.usable).toBe(3);
  });

  test("FUSION_CANDIDATE_WORKSPACE_UNUSABLE marker marks a panel failed and produces no advisory report", async () => {
    const prepare = await prepareSpeculative();
    const badPath = prepare.speculative?.candidateWorkspaces[1].workspacePath ?? "/missing";
    const marker = `${FUSION_CANDIDATE_WORKSPACE_UNUSABLE_PREFIX} ${badPath}`;
    expect(parseCandidateWorkspaceUnusable(marker)).toEqual({ unusable: true, path: badPath });

    const collect = await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: prepare.panelAgents[0].modelId, content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: prepare.panelAgents[1].modelId, content: marker },
          { agentName: "fusion-panel-3", modelId: prepare.panelAgents[2].modelId, content: completeCandidate },
        ],
        mainBaseline: { status: "passed", workspacePath: sourceWorkspace, changedFiles: ["src/index.ts"] },
      },
      { cwd: sourceWorkspace, traceDir: "." },
    );
    const panel2 = collect.panelStatus.find((p) => p.agentName === "fusion-panel-2");
    expect(panel2?.success).toBe(false);
    expect(panel2?.errorType).toBe("validation");
    // blocked panel is not a usable candidate
    expect(collect.quorum.usable).toBe(2);
    // and it is not surfaced as a usable candidate trace entry
    const trace2 = collect.speculative?.panelCandidateTrace.find((c) => c.logicalPanelIndex === 2);
    expect(trace2?.status).toBe("failed");
  });

  test("panel report written inside candidate workspace is collected into source-side artifacts", async () => {
    const prepare = await prepareSpeculative();
    const ws = prepare.speculative?.candidateWorkspaces[0];
    if (!ws) throw new Error("missing candidate workspace");
    await mkdir(ws.candidateOutputDir, { recursive: true });
    await writeFile(ws.candidateReportPath, "# Candidate Status\n- completed\n", "utf8");

    const collected = await collectCandidateReports(prepare.speculative?.candidateWorkspaces ?? []);
    expect(collected[0].collected).toBe(true);
    const sourceSide = await readFile(ws.reportPath, "utf8");
    expect(sourceSide).toContain("# Candidate Status");
    // candidate report path lives inside the candidate workspace, not source-side
    expect(ws.candidateReportPath.startsWith(ws.workspacePath)).toBe(true);
    expect(ws.candidateReportPath.startsWith(sourceWorkspace)).toBe(false);
  });
});

describe("placeholder guard", () => {
  test("generic guard aborts on an unresolved uppercase-bracket placeholder", () => {
    expect(() =>
      assertNoUnresolvedPlaceholders([{ label: "inline prompt", text: "ws: <PANEL_WORKSPACE>" }]),
    ).toThrow(/unresolved placeholder/i);
  });

  test("forbidden-token guard aborts on a fusion placeholder but tolerates user generics", () => {
    expect(() =>
      assertNoUnresolvedPlaceholders(
        [{ label: "shared-panel-prompt.full.md", text: "task uses <CANDIDATE_WORKSPACE_PLACEHOLDER>" }],
        { mode: "forbidden_tokens" },
      ),
    ).toThrow(/CANDIDATE_WORKSPACE_PLACEHOLDER/);
    // user/code generics like Array<T> are not flagged by the forbidden-token guard
    expect(() =>
      assertNoUnresolvedPlaceholders(
        [{ label: "shared-panel-prompt.full.md", text: "function f(): Array<T> {}" }],
        { mode: "forbidden_tokens" },
      ),
    ).not.toThrow();
  });

  test("aborts when an unresolved placeholder is injected into any active dispatch artifact", () => {
    const labels = [
      "shared-panel-prompt.full.md",
      "panel-1-execution-context.full.md",
      "panel-1 inline dispatch prompt",
      "fusion-panel agent template",
    ];
    for (const label of labels) {
      expect(() =>
        assertNoUnresolvedPlaceholders([{ label, text: "leak: <CANDIDATE_WORKSPACE_PLACEHOLDER>" }]),
      ).toThrow(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  test("builders produce placeholder-free artifacts", () => {
    const shared = buildSpeculativeSharedPanelPrompt({
      task: "Build add",
      context: { summary: "s", files: [], omitted: [] },
      contractGate: {
        literalPublicSurface: [],
        behavioralBoundaries: [],
        consumerCompatibility: [],
        externalConsumerProbes: [],
        packageRootExports: [],
        requiredInstanceMethods: [],
        requiredTypesAndErrors: [],
        requiredOptionAndFieldNames: [],
        returnAndThrowContracts: [],
      },
    });
    expect(shared).not.toMatch(PLACEHOLDER_PATTERN);

    const ctx = buildPanelExecutionContext({
      logicalPanelIndex: 1,
      modelId: "test/panel-a",
      candidateWorkspacePath: "/abs/candidate-1",
      sourceWorkspacePath: "/abs/source",
      reportPath: "/abs/candidate-1/.fusion-panel-output/report.md",
      notesPath: "/abs/candidate-1/.fusion-panel-output/notes.md",
      sharedTaskPath: "/abs/source/run/shared-panel-prompt.full.md",
      resolverVersion: "external_staging_v1",
      runtimeModulePath: "/abs/dist/native/nativeCouncil.js",
    });
    expect(findUnresolvedPlaceholders(ctx)).toEqual([]);
    expect(ctx).toContain("FUSION_CANDIDATE_WORKSPACE_UNUSABLE: /abs/candidate-1");

    const inline = buildPanelInlineDispatchPrompt({
      logicalPanelIndex: 1,
      modelId: "test/panel-a",
      candidateWorkspacePath: "/abs/candidate-1",
      sourceWorkspacePath: "/abs/source",
      reportPath: "/abs/candidate-1/.fusion-panel-output/report.md",
      executionContextPath: "/abs/source/run/panel-1-execution-context.full.md",
      sharedTaskPath: "/abs/source/run/shared-panel-prompt.full.md",
    });
    expect(findUnresolvedPlaceholders(inline)).toEqual([]);
    expect(physicalLineCount(inline)).toBeLessThanOrEqual(50);
  });
});

describe("installed agent templates", () => {
  test("generated panel agent files contain no unresolved candidate-workspace placeholder", () => {
    for (let index = 1; index <= 3; index += 1) {
      const file = buildPanelAgentFile({ panelIndex: index, modelId: `provider/model-${index}` });
      expect(file.content).not.toContain("<CANDIDATE_WORKSPACE_PLACEHOLDER>");
      expect(file.content).not.toContain("<PANEL_WORKSPACE>");
      expect(file.content).not.toContain("<PANEL_INDEX>");
      // the only bracketed tokens are descriptive (lowercase / spaced), never fusion path placeholders
      expect(file.content).toContain("FUSION_CANDIDATE_WORKSPACE_UNUSABLE");
    }
  });
});

import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDefaultFusionConfig } from "../config.js";
import { buildQuorum, quorumMeetsRequirement } from "../council/runCouncil.js";
import { resolveModels } from "../modelConfig.js";
import { createRecoveredRunId, DEFAULT_TRACE_DIR, resolveTraceRoot } from "../trace/runTrace.js";
import { FusionCouncilError } from "../utils/errors.js";
import type {
  CandidateWorkspaceInfo,
  FusionTraceOptions,
  MainBaselineTrace,
  NativePanelAgentPlan,
  NativePanelResult,
  NativeResumeInput,
  NativeResumeResult,
  NativeTodoItem,
  PanelAttemptTrace,
  PanelResponse,
  RecoveredPanelCandidate,
  RecoveryMetadata,
  VerificationSummary,
} from "../types.js";
import { collectContext } from "../context/collectContext.js";
import { extractContractGate } from "../council/contractGate.js";
import { FUSION_PANEL_AGENT_NAMES } from "./agentTemplates.js";
import {
  captureBaselineManifest,
  diffAgainstBaseline,
  loadBaselineManifest,
  type BaselineManifest,
} from "./candidateWorkspace.js";
import { getRuntimeIdentity, buildTodoPlan } from "./nativeCouncil.js";
import {
  assertPanelWorkspacesExternal,
  buildSpeculativePathResolutionTrace,
  buildSpeculativeWorkspacePaths,
  isPathContainedWithin,
  resolveExternalStagingRoot,
  SPECULATIVE_RESOLVER_VERSION,
} from "./speculativeWorkspacePaths.js";
import {
  buildPanelExecutionContext,
  buildPanelInlineDispatchPrompt,
  buildSpeculativeSharedPanelPrompt,
  parsePanelExecutionContext,
} from "./speculativeBuild.js";
import { buildPanelExecutionPlan, PANEL_LIVENESS_CAPABILITY, PANEL_INACTIVITY_TIMEOUT_MS, PANEL_START_GATE_TIMEOUT_MS, MAX_PANEL_ATTEMPTS } from "./panelScheduler.js";
import {
  FUSION_RUN_STATE_LIFECYCLE_VERSION,
  hashSharedPanelPrompt,
  panelExecutionContextArtifactPath,
  runStatePath,
  sharedPromptArtifactPath,
  writeArtifactFile,
  writeRunState,
  type RunState,
} from "./runState.js";
import { createCandidateWorkspaces, honestIsolationCapability } from "./candidateWorkspace.js";
import { assertNoUnresolvedPlaceholders } from "./placeholderGuard.js";
import { assertValidFusionRunId, assertValidFusionRunLocator, resolveRunLocatorPaths } from "./runLocator.js";
import {
  assertPanelRedispatchIsRequired,
  buildRecoveryClassificationTrace,
  classifyRecoveredPanelCandidate,
  loadOrphanPanelAttempts,
  runWorkspaceVerification,
  writeRecoveryClassificationArtifacts,
  type RecoveryAttemptContext,
} from "./recoveryClassification.js";

export { runWorkspaceVerification } from "./recoveryClassification.js";

const ORPHAN_MARKER_FILES = [
  "baseline-manifest.json",
  "shared-panel-prompt.full.md",
  "panel-1-execution-context.full.md",
] as const;

export type OrphanAttemptDescriptor = {
  orphanSourceArtifactRoot: string;
  sourceWorkspace: string;
  sharedPromptPath: string;
  sharedPromptHash: string;
  sharedPromptText: string;
  baselineManifestPath: string;
  baselineManifest: BaselineManifest;
  taskText: string;
  panelContexts: Array<NonNullable<ReturnType<typeof parsePanelExecutionContext>> & { artifactPath: string }>;
  externalStagingDir: string;
  recoveredFromRunId: string | null;
  panelAttempts: PanelAttemptTrace[];
};

export type OrphanDiscoveryResult =
  | { status: "found"; attempt: OrphanAttemptDescriptor }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: string[] };

export async function discoverOrphanSpeculativeAttempt(cwd: string): Promise<OrphanDiscoveryResult> {
  const sourceWorkspace = path.resolve(cwd);
  const candidates: OrphanAttemptDescriptor[] = [];

  const rootsToScan = [sourceWorkspace];
  const defaultTraceRoot = resolveTraceRoot(sourceWorkspace, DEFAULT_TRACE_DIR);
  try {
    const entries = await readdir(defaultTraceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        rootsToScan.push(path.join(defaultTraceRoot, entry.name));
      }
    }
  } catch {
    // no standard trace root yet
  }

  for (const root of rootsToScan) {
    const attempt = await tryBuildOrphanAttempt(sourceWorkspace, root);
    if (attempt) candidates.push(attempt);
  }

  const unique = dedupeAttempts(candidates);
  if (unique.length === 0) return { status: "not_found" };
  if (unique.length > 1) {
    return {
      status: "ambiguous",
      candidates: unique.map((entry) => entry.orphanSourceArtifactRoot),
    };
  }
  return { status: "found", attempt: unique[0]! };
}

async function tryBuildOrphanAttempt(
  sourceWorkspace: string,
  artifactRoot: string,
): Promise<OrphanAttemptDescriptor | null> {
  const resolvedRoot = path.resolve(artifactRoot);
  if (!(await pathExists(resolvedRoot))) return null;

  for (const marker of ORPHAN_MARKER_FILES) {
    if (!(await pathExists(path.join(resolvedRoot, marker)))) return null;
  }

  const runStateAtRoot = path.join(resolvedRoot, "run-state.json");
  if (await pathExists(runStateAtRoot)) {
    try {
      const state = JSON.parse(await readFile(runStateAtRoot, "utf8")) as RunState;
      if (state.lifecycleVersion && state.runId && state.runId.trim()) {
        return null;
      }
    } catch {
      // malformed run-state at orphan root is still an orphan candidate
    }
  }

  const baselineManifestPath = path.join(resolvedRoot, "baseline-manifest.json");
  const baselineManifest = await loadBaselineManifest(baselineManifestPath);
  if (!baselineManifest) return null;

  const sharedPromptPath = (await pathExists(path.join(resolvedRoot, "shared-panel-prompt.full.md")))
    ? path.join(resolvedRoot, "shared-panel-prompt.full.md")
    : path.join(resolvedRoot, "shared-panel-prompt.md");
  if (!(await pathExists(sharedPromptPath))) return null;

  const sharedPromptText = await readFile(sharedPromptPath, "utf8");
  const sharedPromptHash = hashSharedPanelPrompt(sharedPromptText);
  const taskText = extractTaskFromSharedPrompt(sharedPromptText);
  if (!taskText) return null;

  const panelContexts: OrphanAttemptDescriptor["panelContexts"] = [];
  for (let index = 1; index <= 3; index += 1) {
    const artifactPath = path.join(resolvedRoot, `panel-${index}-execution-context.full.md`);
    if (!(await pathExists(artifactPath))) continue;
    const text = await readFile(artifactPath, "utf8");
    const parsed = parsePanelExecutionContext(text);
    if (!parsed || parsed.logicalPanelIndex !== index) return null;
    if (path.resolve(parsed.sourceWorkspacePath) !== sourceWorkspace) return null;
    if (path.resolve(parsed.sharedTaskPath) !== path.resolve(sharedPromptPath)) return null;
    if (hashSharedPanelPrompt(await readSharedPromptAt(parsed.sharedTaskPath)) !== sharedPromptHash) return null;
    panelContexts.push({ ...parsed, artifactPath });
  }

  if (panelContexts.length === 0) return null;

  const panelAttempts = await loadOrphanPanelAttempts(resolvedRoot);

  const externalStagingDir = inferExternalStagingDir(panelContexts.map((ctx) => ctx.candidateWorkspacePath));
  if (!externalStagingDir) return null;

  for (const ctx of panelContexts) {
    if (!ctx.candidateWorkspacePath.startsWith(externalStagingDir + path.sep)
      && path.resolve(ctx.candidateWorkspacePath) !== path.resolve(externalStagingDir)) {
      if (!isUnderDirectory(ctx.candidateWorkspacePath, externalStagingDir)) return null;
    }
    if (isPathContainedWithin(ctx.candidateWorkspacePath, sourceWorkspace)) return null;
  }

  return {
    orphanSourceArtifactRoot: resolvedRoot,
    sourceWorkspace,
    sharedPromptPath,
    sharedPromptHash,
    sharedPromptText,
    baselineManifestPath,
    baselineManifest,
    taskText,
    panelContexts,
    externalStagingDir: path.resolve(externalStagingDir),
    recoveredFromRunId: resolvedRoot === sourceWorkspace ? null : null,
    panelAttempts,
  };
}

function dedupeAttempts(attempts: OrphanAttemptDescriptor[]): OrphanAttemptDescriptor[] {
  const seen = new Set<string>();
  const out: OrphanAttemptDescriptor[] = [];
  for (const attempt of attempts) {
    const key = `${attempt.sharedPromptHash}:${attempt.orphanSourceArtifactRoot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(attempt);
  }
  return out;
}

function inferExternalStagingDir(candidatePaths: string[]): string | null {
  if (candidatePaths.length === 0) return null;
  const resolved = candidatePaths.map((entry) => path.resolve(entry));
  const parent = path.dirname(resolved[0]!);
  if (resolved.every((entry) => path.dirname(entry) === parent)) {
    return parent;
  }
  return parent;
}

function isUnderDirectory(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function readSharedPromptAt(sharedTaskPath: string): Promise<string> {
  return readFile(sharedTaskPath, "utf8");
}

function extractTaskFromSharedPrompt(prompt: string): string | null {
  const match = prompt.match(/USER TASK:\s*\n([\s\S]*?)(?:\n\n|$)/);
  if (match?.[1]?.trim()) return match[1].trim();
  return null;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function loadExplicitSpeculativeAttempt(
  cwd: string,
  runId: string,
  traceDir: string | undefined,
): Promise<{ attempt: OrphanAttemptDescriptor; state: RunState; artifactDir: string; candidateWorkspaces: CandidateWorkspaceInfo[] }> {
  assertValidFusionRunId(runId);
  const locator = resolveRunLocatorPaths(cwd, runId, traceDir);
  const state = await assertValidFusionRunLocator({
    runId,
    traceArtifactDir: locator.traceArtifactDir,
    runStatePath: locator.runStatePath,
    expectedSourceWorkspace: cwd,
  });
  if (state.buildStrategy !== "speculative_parallel_build" || !state.speculative) {
    throw new FusionCouncilError("FUSION_RESUME_RUN_NOT_SPECULATIVE: selected run is not a speculative /fusion-build run");
  }
  if (!state.speculative.sharedTaskPath && !state.sharedPanelPromptPath) {
    throw new FusionCouncilError("FUSION_RESUME_SHARED_TASK_MISSING: selected run does not have a shared task artifact path");
  }
  const sharedPromptPath = state.speculative.sharedTaskPath ?? state.sharedPanelPromptPath;
  const sharedPromptText = await readFile(sharedPromptPath, "utf8");
  const panelContexts: OrphanAttemptDescriptor["panelContexts"] = [];
  for (const assignment of state.speculative.panelExecutionAssignments ?? []) {
    if (!(await pathExists(assignment.executionContextPath))) continue;
    const text = await readFile(assignment.executionContextPath, "utf8");
    const parsed = parsePanelExecutionContext(text);
    if (!parsed) continue;
    panelContexts.push({ ...parsed, artifactPath: assignment.executionContextPath });
  }
  if (panelContexts.length === 0) {
    throw new FusionCouncilError("FUSION_RESUME_PANEL_CONTEXTS_MISSING: selected run has no valid panel execution context artifacts");
  }
  const baselineManifest = await loadBaselineManifest(state.speculative.sourceBaselineManifestPath);
  if (!baselineManifest) {
    throw new FusionCouncilError("FUSION_RESUME_BASELINE_INVALID: selected run baseline manifest is unreadable");
  }
  return {
    attempt: {
      orphanSourceArtifactRoot: locator.traceArtifactDir,
      sourceWorkspace: cwd,
      sharedPromptPath,
      sharedPromptHash: state.sharedPanelPromptHash,
      sharedPromptText,
      baselineManifestPath: state.speculative.sourceBaselineManifestPath,
      baselineManifest,
      taskText: state.task,
      panelContexts,
      externalStagingDir: state.speculative.externalCandidateStagingDir,
      recoveredFromRunId: runId,
      panelAttempts: state.panelAttempts ?? [],
    },
    state,
    artifactDir: locator.traceArtifactDir,
    candidateWorkspaces: state.speculative.candidateWorkspaces,
  };
}

function resolveTraceOptions(trace?: FusionTraceOptions): FusionTraceOptions {
  return {
    saveRunArtifacts: trace?.saveRunArtifacts ?? true,
    keepPanelSessions: trace?.keepPanelSessions ?? true,
    traceDir: trace?.traceDir ?? DEFAULT_TRACE_DIR,
    command: trace?.command ?? "fusion-resume",
  };
}

async function migrateOrphanArtifacts(
  attempt: OrphanAttemptDescriptor,
  recoveredArtifactDir: string,
  runId: string,
  traceDir: string | undefined,
  cwd: string,
): Promise<{ sharedPromptPath: string; panelAssignments: CandidateWorkspaceInfo[] }> {
  await mkdir(recoveredArtifactDir, { recursive: true });

  const sharedPromptPath = sharedPromptArtifactPath(cwd, runId, traceDir);
  await copyFile(attempt.sharedPromptPath, sharedPromptPath);

  await copyFile(attempt.baselineManifestPath, path.join(recoveredArtifactDir, "baseline-manifest.json"));

  const panelAssignments: CandidateWorkspaceInfo[] = [];
  for (const ctx of attempt.panelContexts) {
    const executionContextPath = panelExecutionContextArtifactPath(cwd, runId, ctx.logicalPanelIndex, traceDir);
    await copyFile(ctx.artifactPath, executionContextPath);

    const reportDest = path.join(recoveredArtifactDir, `panel-${ctx.logicalPanelIndex}-report.md`);
    const sourceSideReport = path.join(attempt.orphanSourceArtifactRoot, `panel-${ctx.logicalPanelIndex}-report.md`);
    if (await pathExists(sourceSideReport)) {
      await copyFile(sourceSideReport, reportDest);
    } else if (await pathExists(ctx.reportPath)) {
      await copyFile(ctx.reportPath, reportDest);
    }

    panelAssignments.push({
      logicalPanelIndex: ctx.logicalPanelIndex,
      workspacePath: ctx.candidateWorkspacePath,
      manifestPath: path.join(attempt.externalStagingDir, `panel-${ctx.logicalPanelIndex}-manifest.json`),
      reportPath: reportDest,
      patchPath: path.join(recoveredArtifactDir, `panel-${ctx.logicalPanelIndex}.patch`),
      gitInitialized: false,
      candidateOutputDir: path.join(ctx.candidateWorkspacePath, ".fusion-panel-output"),
      candidateReportPath: ctx.reportPath,
      candidateNotesPath: ctx.notesPath ?? path.join(ctx.candidateWorkspacePath, ".fusion-panel-output", "notes.md"),
    });
  }

  return { sharedPromptPath, panelAssignments };
}

export async function nativeResume(
  input: NativeResumeInput,
  options: { cwd: string; traceDir?: string },
): Promise<NativeResumeResult> {
  const cwd = options.cwd;
  const traceOptions = resolveTraceOptions(input.trace);
  const traceDir = traceOptions.traceDir;
  const explicit = input.runId
    ? await loadExplicitSpeculativeAttempt(cwd, input.runId, traceDir)
    : undefined;
  const discovery = explicit ? undefined : await discoverOrphanSpeculativeAttempt(cwd);

  if (!explicit && discovery?.status === "not_found") {
    throw new FusionCouncilError("FUSION_RESUME_NOT_FOUND: no orphaned speculative run matched the current workspace");
  }
  if (!explicit && discovery?.status === "ambiguous") {
    throw new FusionCouncilError(
      `FUSION_RESUME_AMBIGUOUS: multiple orphaned speculative attempts matched (${discovery.candidates.join(", ")})`,
    );
  }

  const attempt = explicit?.attempt ?? (discovery && discovery.status === "found" ? discovery.attempt : undefined);
  if (!attempt) {
    throw new FusionCouncilError("FUSION_RESUME_NOT_FOUND: no resumable speculative run matched the current workspace");
  }
  const config = getDefaultFusionConfig();
  const resolved = await resolveModels({ panelModels: input.panelModels, judgeModel: input.judgeModel });
  const panelModelSpecs = resolved.panelModels.slice(0, 3);
  while (panelModelSpecs.length < 3) panelModelSpecs.push(panelModelSpecs[0]!);
  const judgeModelSpec = resolved.judgeModel;

  if (path.resolve(attempt.baselineManifest.sourcePath) !== path.resolve(cwd)) {
    throw new FusionCouncilError(
      "FUSION_RESUME_BASELINE_MISMATCH: orphan baseline source path does not match current workspace",
    );
  }

  const workspaceDiff = explicit?.state.speculative?.mainBaseline
    ? {
      changedFiles: explicit.state.speculative.mainBaseline.changedFiles,
      addedFiles: [] as string[],
      removedFiles: [] as string[],
    }
    : await diffAgainstBaseline(cwd, attempt.baselineManifest);
  const mainVerification = explicit?.state.speculative?.mainBaseline?.verification ?? await runWorkspaceVerification(cwd);
  if ((mainVerification.typecheck === "fail" || mainVerification.test === "fail" || mainVerification.build === "fail") && !explicit) {
    throw new FusionCouncilError("FUSION_RESUME_BASELINE_VERIFICATION_FAILED: current main workspace verification failed");
  }

  const runId = explicit?.state.runId ?? createRecoveredRunId();
  const recoveredArtifactDir = explicit?.artifactDir ?? path.join(resolveTraceRoot(cwd, traceDir), runId);
  if (path.resolve(recoveredArtifactDir) === path.resolve(cwd)) {
    throw new FusionCouncilError("FUSION_RESUME_LOCATOR_INVALID: recovered trace directory must not equal source workspace");
  }

  const { sharedPromptPath, panelAssignments: recoveredWorkspaces } = explicit
    ? {
      sharedPromptPath: explicit.attempt.sharedPromptPath,
      panelAssignments: explicit.candidateWorkspaces,
    }
    : await migrateOrphanArtifacts(
      attempt,
      recoveredArtifactDir,
      runId,
      traceDir,
      cwd,
    );

  const recoveryAttempt: RecoveryAttemptContext = {
    sourceWorkspace: attempt.sourceWorkspace,
    orphanSourceArtifactRoot: attempt.orphanSourceArtifactRoot,
    sharedPromptHash: attempt.sharedPromptHash,
    baselineManifest: attempt.baselineManifest,
    externalStagingDir: attempt.externalStagingDir,
    panelContexts: attempt.panelContexts,
    panelAttempts: attempt.panelAttempts,
  };

  const classifiedPanels: RecoveredPanelCandidate[] = [];
  const recoveredPanelResults: NativePanelResult[] = [];

  for (let index = 1; index <= 3; index += 1) {
    const agentName = FUSION_PANEL_AGENT_NAMES[index - 1] ?? FUSION_PANEL_AGENT_NAMES[0]!;
    const modelId = panelModelSpecs[index - 1]?.modelId ?? panelModelSpecs[0]!.modelId;
    const classified = await classifyRecoveredPanelCandidate({
      logicalPanelIndex: index,
      attempt: recoveryAttempt,
      agentName,
      modelId,
    });
    classifiedPanels.push(classified);
    if ((classified.classification === "usable" || classified.classification === "partial") && classified.reportContent) {
      recoveredPanelResults.push({
        agentName,
        modelId,
        content: classified.reportContent,
      });
    }
  }

  const classificationTrace = buildRecoveryClassificationTrace(classifiedPanels);
  const panelResponses = buildResumePanelResponsesFromClassification(
    classifiedPanels,
    panelModelSpecs,
    attempt.sharedPromptText,
  );
  const quorumInput = {
    task: attempt.taskText,
    mode: "build_prompt" as const,
    requireAllPanels: input.requireAllPanels,
    minSuccessfulPanels: input.minSuccessfulPanels ?? 2,
    allowDegradedJudge: input.allowDegradedJudge ?? true,
  };
  const quorum = buildQuorum(panelResponses, quorumInput, panelModelSpecs.length);
  const judgeEligible = quorumMeetsRequirement(quorum, quorumInput) && quorum.usable > 0;

  const classificationArtifacts = await writeRecoveryClassificationArtifacts(
    recoveredArtifactDir,
    classificationTrace,
    judgeEligible,
  );

  const recoveredPanelIndexes = classificationTrace.reusedPanelIndexes;
  const partialPanelIndexes = classificationTrace.partialPanelIndexes;
  const rerunPanelIndexes = classificationTrace.rerunPanelIndexes;
  const invalidPanelIndexes = classifiedPanels
    .filter((entry) => entry.classification === "invalid")
    .map((entry) => entry.logicalPanelIndex);

  const freshWorkspaces: CandidateWorkspaceInfo[] = [];
  const panelAgents: NativePanelAgentPlan[] = [];
  const panelsToRerun: NativePanelAgentPlan[] = [];

  const workspacePaths = buildSpeculativeWorkspacePaths({
    sourceWorkspace: cwd,
    sourceArtifactDir: recoveredArtifactDir,
    runId,
    panelCount: 3,
  });

  if (rerunPanelIndexes.length > 0) {
    assertPanelWorkspacesExternal({
      sourceWorkspace: workspacePaths.sourceWorkspace,
      sourceArtifactDir: workspacePaths.sourceArtifactDir,
      externalStagingDir: workspacePaths.externalStagingDir,
      panelWorkspacePaths: workspacePaths.panelWorkspacePaths,
      resolverVersion: SPECULATIVE_RESOLVER_VERSION,
    });
    const preflight = await createCandidateWorkspaces({
      paths: workspacePaths,
      panelCount: 3,
    });
    if (!preflight.ok) {
      throw new FusionCouncilError(`FUSION_RESUME_STAGING_FAILED: ${preflight.diagnostic ?? "candidate workspace preflight failed"}`);
    }
    for (const index of rerunPanelIndexes) {
      const candidate = classifiedPanels.find((entry) => entry.logicalPanelIndex === index);
      if (candidate) assertPanelRedispatchIsRequired(candidate);
      const ws = preflight.workspaces.find((entry) => entry.logicalPanelIndex === index);
      if (ws) freshWorkspaces.push(ws);
    }
  }

  const reusedWorkspaces = recoveredWorkspaces.filter((ws) =>
    recoveredPanelIndexes.includes(ws.logicalPanelIndex) || partialPanelIndexes.includes(ws.logicalPanelIndex),
  );
  const allCandidateWorkspaces = [...reusedWorkspaces, ...freshWorkspaces].sort(
    (a, b) => a.logicalPanelIndex - b.logicalPanelIndex,
  );

  for (let index = 1; index <= 3; index += 1) {
    const spec = panelModelSpecs[index - 1] ?? panelModelSpecs[0]!;
    const agentName = FUSION_PANEL_AGENT_NAMES[index - 1] ?? FUSION_PANEL_AGENT_NAMES[0]!;
    const classified = classifiedPanels.find((entry) => entry.logicalPanelIndex === index);
    const ws = allCandidateWorkspaces.find((entry) => entry.logicalPanelIndex === index);
    const sharedHash = attempt.sharedPromptHash;

    const baseAgent: NativePanelAgentPlan = {
      panelIndex: index,
      agentName,
      modelId: spec.modelId,
      reasoningEffort: spec.reasoningEffort,
      promptHash: sharedHash,
      nativeTask: true,
    };

    if (classified && (classified.classification === "usable" || classified.classification === "partial") && ws) {
      panelAgents.push({
        ...baseAgent,
        candidateWorkspacePath: ws.workspacePath,
        sourceWorkspacePath: cwd,
        panelReportPath: ws.reportPath,
        sharedTaskPath: sharedPromptPath,
      });
      continue;
    }

    if (!classified?.rerunEligible || !ws) {
      panelAgents.push(baseAgent);
      continue;
    }

    assertPanelRedispatchIsRequired(classified);

    const executionContextPath = panelExecutionContextArtifactPath(cwd, runId, index, traceDir);
    const executionContext = buildPanelExecutionContext({
      logicalPanelIndex: index,
      modelId: spec.modelId,
      candidateWorkspacePath: ws.workspacePath,
      sourceWorkspacePath: cwd,
      reportPath: ws.candidateReportPath,
      notesPath: ws.candidateNotesPath,
      sharedTaskPath: sharedPromptPath,
      resolverVersion: SPECULATIVE_RESOLVER_VERSION,
    });
    const inlineDispatchPrompt = buildPanelInlineDispatchPrompt({
      logicalPanelIndex: index,
      modelId: spec.modelId,
      candidateWorkspacePath: ws.workspacePath,
      sourceWorkspacePath: cwd,
      reportPath: ws.candidateReportPath,
      executionContextPath,
      sharedTaskPath: sharedPromptPath,
    });

    assertNoUnresolvedPlaceholders(
      [
        { label: `panel-${index}-execution-context.full.md`, text: executionContext },
        { label: `panel-${index} inline dispatch prompt`, text: inlineDispatchPrompt },
      ],
      { mode: "generic" },
    );

    await writeArtifactFile(executionContextPath, executionContext);

    const rerunAgent: NativePanelAgentPlan = {
      ...baseAgent,
      executionContextPath,
      executionContextHash: hashSharedPanelPrompt(executionContext),
      candidateWorkspacePath: ws.workspacePath,
      sourceWorkspacePath: cwd,
      panelReportPath: ws.candidateReportPath,
      panelNotesPath: ws.candidateNotesPath,
      sharedTaskPath: sharedPromptPath,
      inlineDispatchPrompt,
    };
    panelAgents.push(rerunAgent);
    panelsToRerun.push(rerunAgent);
  }

  const panelExecutionPlan = buildPanelExecutionPlan(
    panelAgents.map((agent) => ({ panelIndex: agent.panelIndex, agentName: agent.agentName, modelId: agent.modelId })),
    panelModelSpecs,
    {
      startGateTimeoutMs: PANEL_START_GATE_TIMEOUT_MS,
      inactivityTimeoutMs: PANEL_INACTIVITY_TIMEOUT_MS,
      maxAttempts: MAX_PANEL_ATTEMPTS,
      capability: PANEL_LIVENESS_CAPABILITY,
    },
  );

  const context = await collectContext({ cwd });
  const contractGate = extractContractGate(attempt.taskText);
  const sharedPanelPrompt = attempt.sharedPromptText;

  const recoveryStartedAt = new Date().toISOString();
  const mainBaseline: MainBaselineTrace = explicit?.state.speculative?.mainBaseline ?? {
    status: "passed",
    workspacePath: cwd,
    changedFiles: [...workspaceDiff.changedFiles, ...workspaceDiff.addedFiles, ...workspaceDiff.removedFiles],
    manifestPath: path.join(recoveredArtifactDir, "main-baseline-manifest.json"),
    verification: mainVerification,
    startedAt: recoveryStartedAt,
    completedAt: recoveryStartedAt,
  };

  if (!explicit) {
    await writeFile(
      mainBaseline.manifestPath!,
      `${JSON.stringify(await captureBaselineManifest(cwd), null, 2)}\n`,
      "utf8",
    );
  }

  const recovery: RecoveryMetadata = {
    recovered: true,
    recoveredFromRunId: explicit ? explicit.state.runId : attempt.recoveredFromRunId,
    orphanSourceArtifactRoot: attempt.orphanSourceArtifactRoot,
    originalSharedPromptHash: attempt.sharedPromptHash,
    recoveryStartedAt,
    mainBaselineReused: true,
    recoveredPanelIndexes,
    partialPanelIndexes,
    invalidPanelIndexes,
    rerunPanelIndexes,
  };

  const pathResolution = buildSpeculativePathResolutionTrace({
    paths: workspacePaths,
    runtimeModulePath: getRuntimeIdentity().modulePath,
  });

  const speculativePrepare = {
    buildStrategy: "speculative_parallel_build" as const,
    sourceWorkspace: cwd,
    sourceArtifactDir: recoveredArtifactDir,
    externalCandidateStagingDir: workspacePaths.externalStagingDir,
    sourceBaselineManifestPath: path.join(recoveredArtifactDir, "baseline-manifest.json"),
    sourceBaselineSummaryPath: path.join(recoveredArtifactDir, "baseline-summary.md"),
    candidateWorkspaces: allCandidateWorkspaces,
    isolationCapability: honestIsolationCapability({ hardLinkSafe: true, symlinkSafe: true }),
    parallelExecutionSupported: true,
    aborted: false,
    pathResolution,
    sharedTaskPath: sharedPromptPath,
    panelExecutionAssignments: panelAgents
      .filter((agent) => agent.executionContextPath)
      .map((agent) => ({
        logicalPanelIndex: agent.panelIndex,
        sharedTaskPath: sharedPromptPath,
        executionContextPath: agent.executionContextPath!,
        assignedCandidateWorkspace: agent.candidateWorkspacePath!,
        prohibitedSourceWorkspace: cwd,
        panelOutputPath: agent.panelReportPath!,
        sharedTaskHash: attempt.sharedPromptHash,
        executionContextHash: agent.executionContextHash ?? "",
        unresolvedPlaceholderCheck: "passed" as const,
        nativeCwdScoped: false as const,
        absolutePathModeRequired: true,
        resolverVersion: SPECULATIVE_RESOLVER_VERSION,
        runtimeModulePath: getRuntimeIdentity().modulePath,
      })),
  };

  const state: RunState = {
    lifecycleVersion: FUSION_RUN_STATE_LIFECYCLE_VERSION,
    runId,
    timestamp: recoveryStartedAt,
    sourceWorkspace: cwd,
    command: "fusion-resume",
    task: attempt.taskText,
    mode: "build_prompt",
    panelMode: "candidate_build",
    buildStrategy: "speculative_parallel_build",
    context,
    contractGate,
    panelModelSpecs,
    judgeModelSpec,
    sharedPanelPrompt,
    sharedPanelPromptHash: attempt.sharedPromptHash,
    sharedPanelPromptPath: sharedPromptPath,
    panelAgents,
    panelExecutionPlan,
    judgeAgent: {
      agentName: "fusion-judge",
      modelId: judgeModelSpec.modelId,
      reasoningEffort: judgeModelSpec.reasoningEffort,
    },
    requireAllPanels: input.requireAllPanels,
    minSuccessfulPanels: input.minSuccessfulPanels ?? 2,
    allowDegradedJudge: input.allowDegradedJudge ?? true,
    promptVerbosity: "compact",
    traceOptions,
    postBuildContractAudit: config.defaults.postBuildContractAudit,
    maxPostBuildAuditFixCycles: config.defaults.maxPostBuildAuditFixCycles,
    panelLivenessCapability: PANEL_LIVENESS_CAPABILITY,
    panelResults: recoveredPanelResults.length > 0 ? recoveredPanelResults : undefined,
    recovery,
    speculative: {
      buildStrategy: "speculative_parallel_build",
      sourceWorkspace: cwd,
      sourceArtifactDir: recoveredArtifactDir,
      externalCandidateStagingDir: workspacePaths.externalStagingDir,
      sourceBaselineManifestPath: speculativePrepare.sourceBaselineManifestPath,
      sourceBaselineSummaryPath: speculativePrepare.sourceBaselineSummaryPath,
      candidateWorkspaces: allCandidateWorkspaces,
      isolationCapability: speculativePrepare.isolationCapability,
      parallelExecutionSupported: true,
      aborted: false,
      pathResolution,
      sharedTaskPath: sharedPromptPath,
      panelExecutionAssignments: speculativePrepare.panelExecutionAssignments,
      mainBaseline,
      mainBaselineManifestPath: mainBaseline.manifestPath,
    },
  };

  const runStateFile = await writeRunState(state, cwd, traceDir);

  const todoPlan: NativeTodoItem[] = buildTodoPlan({
    panelModelSpecs,
    judgeModelSpec,
    command: "fusion-resume",
    phase: "prepare",
    buildStrategy: "speculative_parallel_build",
  });

  if (panelsToRerun.length > 0) {
    todoPlan.unshift({
      content: `Rerun ${panelsToRerun.length} missing/invalid panel slot(s): ${panelsToRerun.map((agent) => agent.agentName).join(", ")}`,
      status: "pending",
      priority: "high",
    });
  } else if (judgeEligible) {
    todoPlan.unshift({ content: "Dispatch fusion-judge (recovered quorum ready; no panel redispatch required)", status: "pending", priority: "high" });
  }

  return {
    executionMode: "native_subagents",
    runId,
    artifactDir: recoveredArtifactDir,
    traceArtifactDir: recoveredArtifactDir,
    runStatePath: runStateFile,
    recovery,
    classification: classificationTrace,
    recoveryClassificationPath: classificationArtifacts.classificationPath,
    recoveryPanelPlanPath: classificationArtifacts.panelPlanPath,
    recoverySummaryMarkdown: classificationArtifacts.summaryMarkdown,
    sharedPanelPromptHash: attempt.sharedPromptHash,
    mainBaseline,
    judgeEligible,
    quorum,
    recoveredPanelResults,
    panelsToRerun,
    panelAgents,
    panelExecutionPlan,
    judgeAgent: state.judgeAgent,
    todoPlan,
    speculative: speculativePrepare,
    runtimeIdentity: getRuntimeIdentity(),
  };
}

function buildResumePanelResponsesFromClassification(
  classifiedPanels: RecoveredPanelCandidate[],
  panelModelSpecs: import("../types.js").FusionModelSpec[],
  sharedPrompt: string,
): PanelResponse[] {
  return classifiedPanels.map((classified) => {
    const modelId = classified.model ?? panelModelSpecs[classified.logicalPanelIndex - 1]?.modelId ?? "unknown";
    if (classified.classification === "usable" || classified.classification === "partial") {
      const content = classified.reportContent ?? "";
      const success = classified.classification === "usable";
      return {
        modelId,
        provider: "native",
        success,
        content,
        attempts: 1,
        prompt: sharedPrompt,
        latencyMs: 0,
        candidateValidationPassed: success,
        candidateValidationStatus: classified.classification === "partial" ? "usable_with_warnings" : "passed",
        candidateValidationScore: classified.evidence.meaningfulChangedFiles,
        candidateValidationWarnings: classified.evidence.warnings,
        candidateValidationMissingItems: classified.classification === "partial" ? [classified.rerunReason ?? "candidate evidence incomplete"] : [],
      } satisfies PanelResponse;
    }
    return {
      modelId,
      provider: "native",
      success: false,
      error: classified.rerunReason ?? `Panel classified ${classified.classification}`,
      attempts: 0,
      prompt: sharedPrompt,
      latencyMs: 0,
    } satisfies PanelResponse;
  });
}

export { resolveExternalStagingRoot };

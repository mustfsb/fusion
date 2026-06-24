import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { captureBaselineManifest } from "../src/native/candidateWorkspace.js";
import {
  assertPanelRedispatchIsRequired,
  assessReportContent,
  classifyRecoveredPanelCandidate,
  isWeakRerunReason,
  RECOVERY_CLASSIFICATION_JSON,
  type RecoveryAttemptContext,
} from "../src/native/recoveryClassification.js";
import { buildPanelExecutionContext, parsePanelExecutionContext } from "../src/native/speculativeBuild.js";
import { completeCandidate } from "./fixtures/candidates.js";

const PASS_SCRIPTS = {
  typecheck: "node -e \"process.exit(0)\"",
  test: "node -e \"process.exit(0)\"",
  build: "node -e \"process.exit(0)\"",
};

let sourceWorkspace: string;
let cacheRoot: string;

async function writePassingPackageJson(root: string) {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: path.basename(root), scripts: PASS_SCRIPTS }),
    "utf8",
  );
}

async function buildAttempt(options: {
  panelIndex: number;
  changed?: boolean;
  sourceReport?: string;
  localReport?: string;
  priorSucceeded?: boolean;
}): Promise<{ attempt: RecoveryAttemptContext; agentName: string; modelId: string }> {
  const sharedPromptPath = path.join(sourceWorkspace, "shared-panel-prompt.full.md");
  const sharedPrompt = [
    "USER TASK:",
    "Build add(a,b) exported from package root.",
    "",
  ].join("\n");
  await writeFile(sharedPromptPath, sharedPrompt, "utf8");

  const baseline = await captureBaselineManifest(sourceWorkspace);
  await writeFile(path.join(sourceWorkspace, "baseline-manifest.json"), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

  const externalStagingDir = path.join(cacheRoot, "speculative-runs");
  const panelWorkspace = path.join(externalStagingDir, `panel-${options.panelIndex}-workspace`);
  await mkdir(path.join(panelWorkspace, "src"), { recursive: true });
  await writeFile(path.join(panelWorkspace, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writePassingPackageJson(panelWorkspace);
  const panelBaseline = await captureBaselineManifest(panelWorkspace);
  await writeFile(
    path.join(externalStagingDir, `panel-${options.panelIndex}-manifest.json`),
    `${JSON.stringify(panelBaseline, null, 2)}\n`,
    "utf8",
  );

  if (options.changed) {
    await writeFile(path.join(panelWorkspace, "src", "index.ts"), `export const panel${options.panelIndex} = ${options.panelIndex};\n`, "utf8");
  }

  const executionContextPath = path.join(sourceWorkspace, `panel-${options.panelIndex}-execution-context.full.md`);
  const localReportPath = path.join(panelWorkspace, ".fusion-panel-output", "report.md");
  const executionContext = buildPanelExecutionContext({
    logicalPanelIndex: options.panelIndex,
    modelId: "test/panel-a",
    candidateWorkspacePath: panelWorkspace,
    sourceWorkspacePath: sourceWorkspace,
    reportPath: localReportPath,
    notesPath: path.join(panelWorkspace, ".fusion-panel-output", "notes.md"),
    sharedTaskPath: sharedPromptPath,
    resolverVersion: "external_staging_v1",
  });
  await writeFile(executionContextPath, executionContext, "utf8");
  const parsed = parsePanelExecutionContext(executionContext);
  if (!parsed) throw new Error("failed to parse execution context in test fixture");

  if (options.sourceReport !== undefined) {
    await writeFile(path.join(sourceWorkspace, `panel-${options.panelIndex}-report.md`), options.sourceReport, "utf8");
  }
  if (options.localReport !== undefined) {
    await mkdir(path.dirname(localReportPath), { recursive: true });
    await writeFile(localReportPath, options.localReport, "utf8");
  }

  const { hashSharedPanelPrompt } = await import("../src/native/runState.js");
  const attempt: RecoveryAttemptContext = {
    sourceWorkspace,
    orphanSourceArtifactRoot: sourceWorkspace,
    sharedPromptHash: hashSharedPanelPrompt(sharedPrompt),
    baselineManifest: baseline,
    externalStagingDir,
    panelContexts: [{ ...parsed, artifactPath: executionContextPath }],
    panelAttempts: options.priorSucceeded
      ? [{
          logicalPanelIndex: options.panelIndex,
          attempt: 1,
          model: "test/panel-a",
          startedAt: new Date().toISOString(),
          status: "succeeded" as const,
          startReason: "cascade_activity" as const,
        }]
      : [],
  };

  return { attempt, agentName: `fusion-panel-${options.panelIndex}`, modelId: "test/panel-a" };
}

beforeEach(async () => {
  sourceWorkspace = await mkdtemp(path.join(tmpdir(), "recovery-src-"));
  cacheRoot = await mkdtemp(path.join(tmpdir(), "recovery-cache-"));
  process.env.FUSION_SPECULATIVE_CACHE_ROOT = cacheRoot;
  await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
  await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writePassingPackageJson(sourceWorkspace);
});

afterEach(async () => {
  delete process.env.FUSION_SPECULATIVE_CACHE_ROOT;
  await Promise.all([
    rm(sourceWorkspace, { recursive: true, force: true }),
    rm(cacheRoot, { recursive: true, force: true }),
  ]);
});

describe("recovery classification", () => {
  test("source-side report plus workspace changes is usable without local report", async () => {
    const { attempt, agentName, modelId } = await buildAttempt({
      panelIndex: 1,
      changed: true,
      sourceReport: completeCandidate,
    });
    const result = await classifyRecoveredPanelCandidate({
      logicalPanelIndex: 1,
      attempt,
      agentName,
      modelId,
    });
    expect(result.classification).toBe("usable");
    expect(result.evidence.sourceSideReport).toBe(true);
    expect(result.evidence.candidateLocalReport).toBe(false);
    expect(result.rerunEligible).toBe(false);
  });

  test("prior successful attempt plus workspace changes is usable without reports", async () => {
    const { attempt, agentName, modelId } = await buildAttempt({
      panelIndex: 2,
      changed: true,
      priorSucceeded: true,
    });
    const result = await classifyRecoveredPanelCandidate({
      logicalPanelIndex: 2,
      attempt,
      agentName,
      modelId,
    });
    expect(result.classification).toBe("usable");
    expect(result.evidence.priorSucceededAttempt).toBe(true);
    expect(result.rerunEligible).toBe(false);
  });

  test("missing report alone does not make candidate rerun-eligible when workspace unchanged", async () => {
    const { attempt, agentName, modelId } = await buildAttempt({ panelIndex: 1, changed: false });
    const result = await classifyRecoveredPanelCandidate({
      logicalPanelIndex: 1,
      attempt,
      agentName,
      modelId,
    });
    expect(result.classification).toBe("invalid");
    expect(result.rerunReason).toMatch(/untouched baseline copy/i);
    expect(isWeakRerunReason("missing local report")).toBe(true);
  });

  test("untouched baseline copy is invalid and rerun-eligible with concrete reason", async () => {
    const { attempt, agentName, modelId } = await buildAttempt({ panelIndex: 3, changed: false });
    const result = await classifyRecoveredPanelCandidate({
      logicalPanelIndex: 3,
      attempt,
      agentName,
      modelId,
    });
    expect(result.classification).toBe("invalid");
    expect(result.rerunEligible).toBe(true);
    expect(() => assertPanelRedispatchIsRequired(result)).not.toThrow();
  });

  test("advisory-only report with no changes is invalid", async () => {
    const { attempt, agentName, modelId } = await buildAttempt({
      panelIndex: 1,
      changed: false,
      sourceReport: "FUSION_ADVISORY: no implementation\n",
    });
    const result = await classifyRecoveredPanelCandidate({
      logicalPanelIndex: 1,
      attempt,
      agentName,
      modelId,
    });
    expect(result.classification).toBe("invalid");
    expect(assessReportContent("FUSION_ADVISORY: no implementation\n").valid).toBe(false);
  });

  test("assertPanelRedispatchIsRequired rejects weak reasons", () => {
    const candidate = {
      logicalPanelIndex: 1,
      classification: "invalid" as const,
      evidence: {
        executionContext: true,
        candidateWorkspace: true,
        candidateChanges: false,
        candidateLocalReport: false,
        sourceSideReport: false,
        priorSucceededAttempt: false,
        verificationRan: true,
      },
      evidenceSourcesChecked: [
        "execution_context",
        "candidate_workspace",
        "candidate_changes",
        "candidate_local_report",
        "source_side_report",
        "prior_succeeded_attempt",
        "verification",
      ],
      rerunEligible: true,
      rerunReason: "missing local report",
    };
    expect(() => assertPanelRedispatchIsRequired(candidate)).toThrow(/weak/i);
    expect(isWeakRerunReason("old collect failed")).toBe(true);
    expect(isWeakRerunReason("empty old run id")).toBe(true);
  });
});

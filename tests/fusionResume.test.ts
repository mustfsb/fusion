import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fusionCouncilPlugin from "../src/plugin.js";
import { collectContext } from "../src/context/collectContext.js";
import { extractContractGate } from "../src/council/contractGate.js";
import {
  captureBaselineManifest,
  candidatePanelOutputPaths,
} from "../src/native/candidateWorkspace.js";
import { RECOVERY_CLASSIFICATION_JSON } from "../src/native/recoveryClassification.js";
import { hashSharedPanelPrompt } from "../src/native/runState.js";
import {
  buildPanelExecutionContext,
  buildSpeculativeSharedPanelPrompt,
} from "../src/native/speculativeBuild.js";
import { isValidFusionRunId } from "../src/native/runLocator.js";
import { completeCandidate } from "./fixtures/candidates.js";
import type { PanelAttemptTrace } from "../src/types.js";

const ORPHAN_SHARED_PROMPT_FIXTURE = new URL("./fixtures/orphan-shared-prompt.full.md", import.meta.url);
const ORPHAN_SHARED_PROMPT_HASH = "ee7263bc5565dd0d4118cefada632b290a1312d041023d4bc73cbf5c63d29c05";

const PASS_SCRIPTS = {
  typecheck: "node -e \"process.exit(0)\"",
  test: "node -e \"process.exit(0)\"",
  build: "node -e \"process.exit(0)\"",
};

type AnyContext = {
  directory: string;
  sessionID: string;
  messageID: string;
  agent: string;
  worktree: string;
  abort: AbortSignal;
  metadata: (input: unknown) => void;
  ask: (input: unknown) => Promise<void>;
};

function makeContext(directory: string): AnyContext {
  return {
    directory,
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test",
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

async function getFusionNativeTool() {
  const plugin = await fusionCouncilPlugin({ client: {} as never } as never, undefined as never);
  const fusionNative = plugin.tool?.fusion_native;
  if (!fusionNative) throw new Error("fusion_native tool not exported by plugin");
  return fusionNative;
}

let sourceWorkspace: string;
let cacheRoot: string;
const previousCacheRoot = process.env.FUSION_SPECULATIVE_CACHE_ROOT;

async function writePassingPackageJson(root: string) {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: path.basename(root), scripts: PASS_SCRIPTS }),
    "utf8",
  );
}

async function writePanelWorkspace(input: {
  panelIndex: number;
  externalStagingDir: string;
  changed: boolean;
  sourceReport?: string;
  localReport?: string;
}) {
  const panelWorkspace = path.join(input.externalStagingDir, `panel-${input.panelIndex}-workspace`);
  await mkdir(path.join(panelWorkspace, "src"), { recursive: true });
  await writeFile(path.join(panelWorkspace, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writePassingPackageJson(panelWorkspace);
  const panelBaseline = await captureBaselineManifest(panelWorkspace);
  await writeFile(
    path.join(input.externalStagingDir, `panel-${input.panelIndex}-manifest.json`),
    `${JSON.stringify(panelBaseline, null, 2)}\n`,
    "utf8",
  );
  if (input.changed) {
    await writeFile(
      path.join(panelWorkspace, "src", "index.ts"),
      `export const panel${input.panelIndex} = ${input.panelIndex};\n`,
      "utf8",
    );
  }
  const candidateOutput = candidatePanelOutputPaths(panelWorkspace);
  if (input.localReport !== undefined) {
    await mkdir(path.dirname(candidateOutput.reportPath), { recursive: true });
    await writeFile(candidateOutput.reportPath, input.localReport, "utf8");
  }
  if (input.sourceReport !== undefined) {
    await writeFile(path.join(sourceWorkspace, `panel-${input.panelIndex}-report.md`), input.sourceReport, "utf8");
  }
  return { panelWorkspace, candidateOutput };
}

async function setupOrphanAttempt(options: {
  panels: Array<{
    index: number;
    changed: boolean;
    sourceReport?: string;
    localReport?: string;
  }>;
  panelAttempts?: PanelAttemptTrace[];
  fixedSharedPrompt?: string;
}) {
  const task = "Build add(a,b) exported from package root with typed errors.";
  await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
  await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writePassingPackageJson(sourceWorkspace);

  const baseline = await captureBaselineManifest(sourceWorkspace);
  await writeFile(path.join(sourceWorkspace, "baseline-manifest.json"), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

  const context = await collectContext({ cwd: sourceWorkspace });
  const contractGate = extractContractGate(task);
  const sharedPrompt = options.fixedSharedPrompt ?? buildSpeculativeSharedPanelPrompt({
    task,
    context,
    contractGate,
    promptVerbosity: "compact",
  });
  const sharedPromptPath = path.join(sourceWorkspace, "shared-panel-prompt.full.md");
  await writeFile(sharedPromptPath, sharedPrompt, "utf8");

  const externalStagingDir = path.join(cacheRoot, "speculative-runs");
  await mkdir(externalStagingDir, { recursive: true });

  const panelModels = ["test/panel-a", "test/panel-b", "test/panel-c"];

  for (const panel of options.panels) {
    const { panelWorkspace, candidateOutput } = await writePanelWorkspace({
      panelIndex: panel.index,
      externalStagingDir,
      changed: panel.changed,
      sourceReport: panel.sourceReport,
      localReport: panel.localReport,
    });

    const executionContextPath = path.join(sourceWorkspace, `panel-${panel.index}-execution-context.full.md`);
    const executionContext = buildPanelExecutionContext({
      logicalPanelIndex: panel.index,
      modelId: panelModels[panel.index - 1]!,
      candidateWorkspacePath: panelWorkspace,
      sourceWorkspacePath: sourceWorkspace,
      reportPath: candidateOutput.reportPath,
      notesPath: candidateOutput.notesPath,
      sharedTaskPath: sharedPromptPath,
      resolverVersion: "external_staging_v1",
    });
    await writeFile(executionContextPath, executionContext, "utf8");
  }

  if (options.panelAttempts) {
    await writeFile(
      path.join(sourceWorkspace, "panel-attempts.json"),
      `${JSON.stringify(options.panelAttempts, null, 2)}\n`,
      "utf8",
    );
  }

  return { sharedPrompt, sharedPromptPath, externalStagingDir };
}

beforeEach(async () => {
  sourceWorkspace = await mkdtemp(path.join(tmpdir(), "candidate-b-"));
  cacheRoot = await mkdtemp(path.join(tmpdir(), "fusion-cache-"));
  process.env.FUSION_SPECULATIVE_CACHE_ROOT = cacheRoot;
});

afterEach(async () => {
  if (previousCacheRoot === undefined) delete process.env.FUSION_SPECULATIVE_CACHE_ROOT;
  else process.env.FUSION_SPECULATIVE_CACHE_ROOT = previousCacheRoot;
  await Promise.all([
    rm(sourceWorkspace, { recursive: true, force: true }),
    rm(cacheRoot, { recursive: true, force: true }),
  ]);
});

describe("/fusion-resume orphan recovery", () => {
  test("outboxkit-shaped recovery reuses three completed panels and dispatches no panel models", async () => {
    const sharedPrompt = await readFile(ORPHAN_SHARED_PROMPT_FIXTURE, "utf8");
    expect(hashSharedPanelPrompt(sharedPrompt)).toBe(ORPHAN_SHARED_PROMPT_HASH);

    const panelAttempts: PanelAttemptTrace[] = [
      { logicalPanelIndex: 1, attempt: 1, model: "test/panel-a", startedAt: "2026-06-24T10:00:00.000Z", status: "succeeded", startReason: "cascade_activity" },
      { logicalPanelIndex: 2, attempt: 1, model: "test/panel-b", startedAt: "2026-06-24T10:01:00.000Z", status: "stalled", startReason: "cascade_activity", stallReason: "inactivity_timeout" },
      { logicalPanelIndex: 2, attempt: 2, model: "test/panel-b", startedAt: "2026-06-24T10:05:00.000Z", status: "succeeded", startReason: "retry" },
      { logicalPanelIndex: 3, attempt: 1, model: "test/panel-c", startedAt: "2026-06-24T10:02:00.000Z", status: "succeeded", startReason: "cascade_activity" },
    ];

    await setupOrphanAttempt({
      fixedSharedPrompt: sharedPrompt,
      panelAttempts,
      panels: [
        { index: 1, changed: true, sourceReport: completeCandidate },
        { index: 2, changed: true, sourceReport: completeCandidate },
        { index: 3, changed: true, sourceReport: completeCandidate },
      ],
    });

    await writeFile(
      path.join(sourceWorkspace, "src", "index.ts"),
      "export function add(a: number, b: number) { return a + b; }\n",
      "utf8",
    );

    const fusionNative = await getFusionNativeTool();
    const raw = await fusionNative.execute(
      {
        stage: "resume",
        panelModels: ["test/panel-a", "test/panel-b", "test/panel-c"],
        judgeModel: "test/judge",
        minSuccessfulPanels: 2,
      } as never,
      makeContext(sourceWorkspace) as never,
    );

    const result = JSON.parse(typeof raw === "string" ? raw : (raw as { output: string }).output);

    expect(result.panelsToRerun).toHaveLength(0);
    expect(result.recovery.recoveredPanelIndexes.sort()).toEqual([1, 2, 3]);
    expect(result.recovery.rerunPanelIndexes).toEqual([]);
    expect(result.judgeEligible).toBe(true);
    expect(result.recovery.mainBaselineReused).toBe(true);
    expect(await readFile(path.join(result.traceArtifactDir, RECOVERY_CLASSIFICATION_JSON), "utf8")).toContain('"classification": "usable"');
    expect(result.todoPlan[0].content).toMatch(/Dispatch fusion-judge/i);
    expect(result.todoPlan[0].content).not.toMatch(/Rerun 3/i);
  });

  test("recovers two usable panels from source-side reports without local reports", async () => {
    await setupOrphanAttempt({
      panels: [
        { index: 1, changed: true, sourceReport: completeCandidate },
        { index: 2, changed: true, sourceReport: completeCandidate },
        { index: 3, changed: false, sourceReport: "FUSION_ADVISORY: incomplete\n" },
      ],
    });

    const fusionNative = await getFusionNativeTool();
    const raw = await fusionNative.execute(
      {
        stage: "resume",
        panelModels: ["test/panel-a", "test/panel-b", "test/panel-c"],
        judgeModel: "test/judge",
        minSuccessfulPanels: 2,
      } as never,
      makeContext(sourceWorkspace) as never,
    );

    const result = JSON.parse(typeof raw === "string" ? raw : (raw as { output: string }).output);
    expect(result.recovery.recoveredPanelIndexes.sort()).toEqual([1, 2]);
    expect(result.panelsToRerun).toHaveLength(1);
    expect(result.panelsToRerun[0].agentName).toBe("fusion-panel-3");
    expect(result.judgeEligible).toBe(true);
  });

  test("with only one valid candidate reruns only invalid slots", async () => {
    await setupOrphanAttempt({
      panels: [
        { index: 1, changed: true, sourceReport: completeCandidate },
        { index: 2, changed: false },
        { index: 3, changed: false },
      ],
    });

    const fusionNative = await getFusionNativeTool();
    const raw = await fusionNative.execute(
      {
        stage: "resume",
        panelModels: ["test/panel-a", "test/panel-b", "test/panel-c"],
        judgeModel: "test/judge",
        minSuccessfulPanels: 2,
      } as never,
      makeContext(sourceWorkspace) as never,
    );

    const result = JSON.parse(typeof raw === "string" ? raw : (raw as { output: string }).output);
    expect(result.recovery.mainBaselineReused).toBe(true);
    expect(result.recovery.recoveredPanelIndexes).toEqual([1]);
    expect(result.panelsToRerun).toHaveLength(2);
    expect(result.judgeEligible).toBe(false);
  });

  test("writes recovery classification artifacts before any redispatch plan", async () => {
    await setupOrphanAttempt({
      panels: [
        { index: 1, changed: true, sourceReport: completeCandidate },
        { index: 2, changed: true, sourceReport: completeCandidate },
        { index: 3, changed: false },
      ],
    });

    const fusionNative = await getFusionNativeTool();
    const raw = await fusionNative.execute({ stage: "resume" } as never, makeContext(sourceWorkspace) as never);
    const result = JSON.parse(typeof raw === "string" ? raw : (raw as { output: string }).output);
    expect(result.recoveryClassificationPath).toContain(RECOVERY_CLASSIFICATION_JSON);
    expect(result.recoveryPanelPlanPath).toContain("recovery-panel-plan.md");
    expect(result.recoverySummaryMarkdown).toMatch(/Recovered panel candidates/);
  });

  test("discovery and validation require no model calls", async () => {
    await setupOrphanAttempt({
      panels: [
        { index: 1, changed: true, sourceReport: completeCandidate },
        { index: 2, changed: true, sourceReport: completeCandidate },
        { index: 3, changed: false },
      ],
    });
    const modelSpy = vi.fn();
    const fusionNative = await getFusionNativeTool();
    await fusionNative.execute({ stage: "resume" } as never, makeContext(sourceWorkspace) as never);
    expect(modelSpy).not.toHaveBeenCalled();
  });
});

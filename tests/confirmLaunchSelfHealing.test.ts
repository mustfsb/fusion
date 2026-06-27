import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 200_000 });

import {
  hybridLaunch,
  hybridBeginNativeWave,
  hybridConfirmLaunch,
  hybridCollect,
  hybridFinalize,
  hybridCancel,
  type BootstrapInput,
  type SupervisorDeps,
  type HybridLaunchPlan,
} from "../src/native/fusionSupervisor.js";
import { loadSupervisorState } from "../src/native/supervisorState.js";
import { loadSupervisorStateByRunId } from "../src/native/supervisorLaunch.js";
import { WORKER_ID } from "../src/native/supervisorTypes.js";
import { renderSupervisorTrace } from "../src/native/supervisorTrace.js";
import { isPidAlive } from "../src/native/workerRunner.js";
import { NATIVE_TASK_DISPATCH_MECHANISM } from "../src/native/nativeSubagentDispatch.js";
import { buildOrchestratorAgentFile } from "../src/native/agentTemplates.js";
import { DEFAULT_TRACE_DIR, resolveTraceRoot } from "../src/trace/runTrace.js";
import { createOpenCodeProcessWorkerRunner, type WorkerRunner } from "../src/native/workerRunner.js";
import {
  assertForegroundProtocolCompatible,
  installedFusionBuildCommandPath,
  installedFusionOrchestratorPath,
} from "../src/native/runtimeInstall.js";
import {
  FUSION_FOREGROUND_PROTOCOL_VERSION,
  fusionBuildCommandTemplateMarker,
  fusionForegroundProtocolMarker,
} from "../src/runtimeManifest.js";

const FAKE = fileURLToPath(new URL("./fixtures/fakeOpencode.mjs", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const distPluginPath = path.join(projectRoot, "dist", "plugin.js");
const distSupervisorPath = path.join(projectRoot, "dist", "native", "fusionSupervisor.js");
const BUILD_TIMEOUT_MS = 180_000;
const OLD_EVIDENCE_ERROR = "only 0/3 native panel dispatches have runtime evidence";

let sourceRoot: string;
let traceRoot: string;
let stagingRoot: string;
let behaviorPath: string;
let runCounter = 0;

function freshRunId(): string {
  runCounter += 1;
  const hex = runCounter.toString(16).padStart(6, "0");
  return `fusion-20260627-175157-${hex}`;
}

function fakeRunner(): WorkerRunner {
  return createOpenCodeProcessWorkerRunner({ opencodeBin: process.execPath, buildArgs: () => [FAKE] });
}

async function writeBehavior(behavior: Record<string, unknown>): Promise<void> {
  await writeFile(behaviorPath, JSON.stringify(behavior), "utf8");
  process.env.FUSION_FAKE_BEHAVIOR = behaviorPath;
}

function baseInput(runId: string): BootstrapInput {
  return {
    runId,
    task: "Add a feature flag to the config loader.",
    command: "fusion-build",
    mainModel: { modelId: "prov/main-model" },
    panelModels: [{ modelId: "prov/panel-1" }, { modelId: "prov/panel-2" }, { modelId: "prov/panel-3" }],
    judgeModel: { modelId: "prov/judge-model" },
    modelConfigFingerprint: "test-config-fingerprint",
    sourceWorkspace: sourceRoot,
  };
}

function deps(runner: WorkerRunner): SupervisorDeps {
  return {
    cwd: sourceRoot,
    traceDir: traceRoot,
    runner,
    skipNativeAgentValidation: true,
    pollIntervalMs: 15,
    timeouts: {
      mainSoftSuspectMs: 9_000,
      mainHardTimeoutMs: 9_000,
      panelSoftSuspectMs: 9_000,
      panelHardTimeoutMs: 9_000,
      judgeSoftSuspectMs: 9_000,
      judgeHardTimeoutMs: 9_000,
    },
  };
}

async function readJson(p: string): Promise<any> {
  return JSON.parse(await readFile(p, "utf8"));
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function mutateCandidatesMeaningfully(plan: HybridLaunchPlan): Promise<void> {
  for (const spec of plan.panelDispatchSpecs) {
    const changed = path.join(spec.candidateWorkspace, `src/panel-${spec.logicalPanelIndex}-impl.ts`);
    await mkdir(path.dirname(changed), { recursive: true });
    await writeFile(changed, `export const panel${spec.logicalPanelIndex} = true;\n`, "utf8");
  }
}

beforeAll(() => {
  let needsBuild = true;
  try {
    const built = execFileSync("node", ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(distSupervisorPath)}, 'utf8'))`], { encoding: "utf8" });
    needsBuild = !built.includes("LAUNCH_CONFIRMED") || built.includes(OLD_EVIDENCE_ERROR);
  } catch {
    needsBuild = true;
  }
  if (needsBuild) {
    execFileSync(process.execPath, [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(projectRoot, "tsconfig.json")], {
      cwd: projectRoot,
      timeout: BUILD_TIMEOUT_MS,
      stdio: "inherit",
    });
  }
}, BUILD_TIMEOUT_MS);

beforeEach(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "fusion-sh-src-"));
  traceRoot = DEFAULT_TRACE_DIR;
  stagingRoot = await mkdtemp(path.join(tmpdir(), "fusion-sh-stage-"));
  behaviorPath = path.join(stagingRoot, "behavior.json");
  process.env.FUSION_SPECULATIVE_CACHE_ROOT = stagingRoot;
  process.env.FUSION_RUN_REGISTRY_PATH = path.join(stagingRoot, "fusion-run-registry.json");
  delete process.env.FUSION_FAKE_BEHAVIOR;
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "index.ts"), "export const base = true;\n", "utf8");
  await writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
});

afterEach(async () => {
  delete process.env.FUSION_SPECULATIVE_CACHE_ROOT;
  delete process.env.FUSION_FAKE_BEHAVIOR;
  delete process.env.FUSION_RUN_REGISTRY_PATH;
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(stagingRoot, { recursive: true, force: true });
});

describe("protocol v6 production contract", () => {
  test("1: confirm_launch with runId + waveDispatchedAt returns LAUNCH_CONFIRMED and never throws for 0/3 evidence", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 4_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));

    const result = await hybridConfirmLaunch({ runId, waveDispatchedAt: new Date().toISOString() }, deps(fakeRunner()));
    expect(result.status).toBe("LAUNCH_CONFIRMED");
    expect(result.confirmed).toBe(true);
    expect(result.nextStage).toBe("collect");
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("2: old 0/3 runtime-evidence error absent from built dist confirm_launch path", async () => {
    const supervisor = await readFile(distSupervisorPath, "utf8");
    expect(supervisor).not.toContain(OLD_EVIDENCE_ERROR);
    expect(supervisor).toContain("LAUNCH_CONFIRMED");
  });

  test("3: mutated candidates without metadata → confirm LAUNCH_CONFIRMED, collect usable_degraded, judge eligible after promotion", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 1_500, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await mutateCandidatesMeaningfully(plan);
    const confirm = await hybridConfirmLaunch({ runId, waveDispatchedAt: new Date().toISOString() }, deps(fakeRunner()));
    expect(confirm.status).toBe("LAUNCH_CONFIRMED");

    await waitFor(async () => {
      const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
      return !isPidAlive(state.workers[WORKER_ID.main].pid);
    });
    const collected = await hybridCollect({ runId }, deps(fakeRunner()));
    const runDir = path.join(resolveTraceRoot(sourceRoot, traceRoot), runId);
    for (const i of [1, 2, 3]) {
      const report = await readJson(path.join(runDir, "panel-evidence", `panel-${i}.json`));
      expect(report.reconciledStatus).toBe("usable_degraded");
    }
    expect(collected.main.promoted).toBe(true);
    expect(collected.judge.eligible).toBe(true);
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("4: zero panel mutations after wave returned → confirm succeeds, collect completed_no_output, judge still eligible", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 1_500, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    const confirm = await hybridConfirmLaunch({ runId, waveDispatchedAt: new Date().toISOString() }, deps(fakeRunner()));
    expect(confirm.status).toBe("LAUNCH_CONFIRMED");

    await waitFor(async () => !isPidAlive((await loadSupervisorState(sourceRoot, runId, traceRoot))!.workers[WORKER_ID.main].pid));
    const collected = await hybridCollect({ runId }, deps(fakeRunner()));
    const runDir = path.join(resolveTraceRoot(sourceRoot, traceRoot), runId);
    for (const i of [1, 2, 3]) {
      const report = await readJson(path.join(runDir, "panel-evidence", `panel-${i}.json`));
      expect(report.reconciledStatus).toBe("completed_no_output");
    }
    expect(collected.main.promoted).toBe(true);
    expect(collected.judge.eligible).toBe(true);
    if (collected.judge.eligible) {
      expect(collected.judge.usablePanelIndexes).toEqual([]);
    }
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("5: parent templates call confirm_launch then collect and never require panelOutcomes", async () => {
    const command = await readFile(path.join(projectRoot, "examples/commands/fusion-build.md"), "utf8");
    const orchestrator = buildOrchestratorAgentFile().content;
    expect(command).toContain("LAUNCH_CONFIRMED");
    expect(command).toContain("IMMEDIATELY after confirm_launch returns");
    expect(command).toContain("stage: collect");
    expect(command).not.toContain("NEVER call confirm_launch with only `runId`");
    expect(orchestrator).toContain("confirm_launch` with `runId` and `waveDispatchedAt`, then IMMEDIATELY call `collect`");
    expect(orchestrator).toContain("never gates panel evidence");
  });

  test("6: repeated collect calls are idempotent", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 1_500, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await mutateCandidatesMeaningfully(plan);
    await hybridConfirmLaunch({ runId, waveDispatchedAt: new Date().toISOString() }, deps(fakeRunner()));
    await waitFor(async () => !isPidAlive((await loadSupervisorState(sourceRoot, runId, traceRoot))!.workers[WORKER_ID.main].pid));
    const first = await hybridCollect({ runId }, deps(fakeRunner()));
    const second = await hybridCollect({ runId }, deps(fakeRunner()));
    expect(first.panelEvidenceReportDir).toBe(second.panelEvidenceReportDir);
    expect(first.allPanelsClassified).toBe(second.allPanelsClassified);
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("7: fusion_trace run lookup works from a different cwd via registry", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 4_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await mutateCandidatesMeaningfully(plan);
    await hybridConfirmLaunch({ runId, waveDispatchedAt: new Date().toISOString() }, deps(fakeRunner()));

    const otherCwd = await mkdtemp(path.join(tmpdir(), "fusion-sh-other-"));
    try {
      const located = await loadSupervisorStateByRunId(runId, otherCwd, undefined);
      expect(located).toBeDefined();
      expect(located!.state.runId).toBe(runId);
      const trace = renderSupervisorTrace(located!.state);
      expect(trace).toContain(runId);
    } finally {
      await rm(otherCwd, { recursive: true, force: true });
    }
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("8: canonical run path is always .opencode/fusion-runs/<runId>", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 3_000, changedFile: "src/main-impl.ts" } });
    const runId = freshRunId();
    await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    const canonical = path.join(sourceRoot, DEFAULT_TRACE_DIR, runId, "supervisor-state.json");
    await stat(canonical);
    const legacy = path.join(sourceRoot, runId);
    await expect(stat(legacy)).rejects.toThrow();
    await hybridCancel({ runId }, deps(fakeRunner()));
  });

  test("9: stale v5 command/agent rejected before worker launch with FUSION_RUNTIME_PROTOCOL_MISMATCH", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "fusion-stale-config-"));
    const commandPath = path.join(configDir, "commands", "fusion-build.md");
    const orchestratorPath = path.join(configDir, "agent", "fusion-orchestrator.md");
    const manifestPath = path.join(configDir, "fusion-runtime-manifest.json");
    await mkdir(path.dirname(commandPath), { recursive: true });
    await mkdir(path.dirname(orchestratorPath), { recursive: true });
    await writeFile(
      commandPath,
      `<!-- FUSION_COMMAND_TEMPLATE_VERSION: fusion-build-hybrid-v5 -->\n<!-- FUSION_FOREGROUND_PROTOCOL_VERSION: 5 -->\n`,
      "utf8",
    );
    await writeFile(
      orchestratorPath,
      `FUSION_ORCHESTRATOR_TEMPLATE_VERSION: fusion-orchestrator-hybrid-v5\nFUSION_FOREGROUND_PROTOCOL_VERSION: 5\n`,
      "utf8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          foregroundProtocolVersion: 5,
          pluginBuildId: "fusion-council-hybrid-v5",
          defaultBuildStrategy: "hybrid_external_main_native_panels",
          expectedCommandTemplateVersion: "fusion-build-hybrid-v5",
          expectedOrchestratorTemplateVersion: "fusion-orchestrator-hybrid-v5",
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.FUSION_OPENCODE_CONFIG_DIR = configDir;
    try {
      await expect(assertForegroundProtocolCompatible()).rejects.toThrow(/FUSION_RUNTIME_PROTOCOL_MISMATCH/);
      await expect(assertForegroundProtocolCompatible()).rejects.toThrow(manifestPath);
    } finally {
      delete process.env.FUSION_OPENCODE_CONFIG_DIR;
      await rm(configDir, { recursive: true, force: true });
    }
  });

  test("10: native panels remain Task subagents and judge remains native Task", async () => {
    await writeBehavior({ [WORKER_ID.main]: { sleepMs: 4_000, changedFile: "src/main-impl.ts", observedModel: "prov/main-model" } });
    const runId = freshRunId();
    const plan = await hybridLaunch(baseInput(runId), deps(fakeRunner()));
    await hybridBeginNativeWave({ runId }, deps(fakeRunner()));
    await mutateCandidatesMeaningfully(plan);
    await hybridConfirmLaunch({ runId, waveDispatchedAt: new Date().toISOString() }, deps(fakeRunner()));

    const state = (await loadSupervisorState(sourceRoot, runId, traceRoot))!;
    expect(state.concurrency.noPanelViaExternalCli).toBe(true);
    for (const i of [1, 2, 3]) {
      const panel = state.workers[WORKER_ID.panel(i)];
      expect(panel.executionKind).toBe("native_subagent");
      expect(panel.dispatchMechanism).toBe(NATIVE_TASK_DISPATCH_MECHANISM);
    }
    const root = resolveTraceRoot(sourceRoot, traceRoot);
    const entries = (await readdir(root)).filter((name) => name.startsWith("fusion-"));
    expect(entries).toEqual([runId]);
    await hybridCancel({ runId }, deps(fakeRunner()));
  });
});

describe("installed runtime markers after build", () => {
  test("dist plugin + templates advertise protocol v6", async () => {
    const plugin = await readFile(distPluginPath, "utf8");
    expect(plugin).toContain("confirm_launch");
    expect(plugin).toContain("collect");

    const command = await readFile(path.join(projectRoot, "examples/commands/fusion-build.md"), "utf8");
    expect(command).toContain(fusionBuildCommandTemplateMarker());
    expect(command).toContain(fusionForegroundProtocolMarker());
    expect(command).toContain(`FUSION_FOREGROUND_PROTOCOL_VERSION: ${FUSION_FOREGROUND_PROTOCOL_VERSION}`);

    const orchestrator = buildOrchestratorAgentFile().content;
    expect(orchestrator).toContain(fusionForegroundProtocolMarker());
    expect(orchestrator).toContain("LAUNCH_CONFIRMED");
  });
});

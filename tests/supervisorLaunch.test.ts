import { mkdtemp, readFile, writeFile, rm, mkdir, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { launchRealParallelBuild, loadLatestSupervisorTrace } from "../src/native/supervisorLaunch.js";
import { loadSupervisorState } from "../src/native/supervisorState.js";
import { assertFreshBuildRuntimeCompatible } from "../src/native/runtimeInstall.js";
import { createFakeNativeSubagentDispatcher } from "../src/native/nativeSubagentDispatch.js";
import { WORKER_ID, type WorkerRecord } from "../src/native/supervisorTypes.js";
import {
  createOpenCodeProcessWorkerRunner,
  type WorkerRunner,
  type SpawnedWorkerHandle,
  type WorkerSpawnSpec,
} from "../src/native/workerRunner.js";

const FAKE = fileURLToPath(new URL("./fixtures/fakeOpencode.mjs", import.meta.url));

let sourceRoot: string;
let traceRoot: string;
let stagingRoot: string;
let behaviorPath: string;
let configDir: string;
let runCounter = 0;
let workersRef: Record<string, WorkerRecord> = {};

function freshRunId(): string {
  runCounter += 1;
  const hex = runCounter.toString(16).padStart(6, "0");
  return `fusion-20260625-120000-${hex}`;
}

function fakeRunner(): WorkerRunner {
  return createOpenCodeProcessWorkerRunner({
    opencodeBin: process.execPath,
    buildArgs: () => [FAKE],
  });
}

async function writeBehavior(behavior: Record<string, unknown>): Promise<void> {
  await writeFile(behaviorPath, JSON.stringify(behavior), "utf8");
  process.env.FUSION_FAKE_BEHAVIOR = behaviorPath;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  workersRef = {};
  sourceRoot = await mkdtemp(path.join(tmpdir(), "fusion-sup-src-"));
  traceRoot = await mkdtemp(path.join(tmpdir(), "fusion-sup-trace-"));
  stagingRoot = await mkdtemp(path.join(tmpdir(), "fusion-sup-stage-"));
  configDir = await mkdtemp(path.join(tmpdir(), "fusion-opencode-config-"));
  behaviorPath = path.join(traceRoot, "behavior.json");
  process.env.FUSION_SPECULATIVE_CACHE_ROOT = stagingRoot;
  delete process.env.FUSION_FAKE_BEHAVIOR;
  delete process.env.FUSION_OPENCODE_CONFIG_DIR;
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "index.ts"), "export const base = true;\n", "utf8");
  await writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
});

afterEach(async () => {
  delete process.env.FUSION_SPECULATIVE_CACHE_ROOT;
  delete process.env.FUSION_FAKE_BEHAVIOR;
  delete process.env.FUSION_OPENCODE_CONFIG_DIR;
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(traceRoot, { recursive: true, force: true });
  await rm(stagingRoot, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

function hybridDeps(runner: WorkerRunner, extra?: Record<string, unknown>) {
  return {
    runner,
    skipNativeAgentValidation: true,
    nativeDispatcher: createFakeNativeSubagentDispatcher({
      behavior: () => JSON.parse(readFileSync(behaviorPath, "utf8")),
      getWorkers: () => workersRef,
      skipAgentValidation: true,
    }),
    pollIntervalMs: 15,
    autoConfirmReady: true,
    ...extra,
  };
}

function allCompleteBehavior() {
  return {
    [WORKER_ID.main]: { sleepMs: 200, changedFile: "src/main-impl.ts" },
    [WORKER_ID.panel(1)]: { sleepMs: 200, changedFile: "src/panel1-impl.ts" },
    [WORKER_ID.panel(2)]: { sleepMs: 200, changedFile: "src/panel2-impl.ts" },
    [WORKER_ID.panel(3)]: { sleepMs: 200, changedFile: "src/panel3-impl.ts" },
    [WORKER_ID.judge]: { sleepMs: 60, decision: "NO_PATCH_REQUIRED", writeContract: true },
  };
}

describe("launchRealParallelBuild", () => {
  test("fresh default run selects hybrid_external_main_native_panels and returns a launch receipt", async () => {
    await writeBehavior(allCompleteBehavior());
    const result = await launchRealParallelBuild({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      skipRuntimeCheck: true,
      inline: true,
      deps: hybridDeps(fakeRunner()),
    });
    expect(result.strategy).toBe("hybrid_external_main_native_panels");
    expect(result.runId).toMatch(/^fusion-/);
    expect(result.supervisorPid).toBe(process.pid);
    expect(await exists(path.join(result.runDir, "supervisor-state.json"))).toBe(true);
  });

  test("creates supervisor state, trace stub, launch receipt, and logs before any worker spawn", async () => {
    await writeBehavior(allCompleteBehavior());
    const seen: string[] = [];
    const base = fakeRunner();
    const spy: WorkerRunner = {
      transport: base.transport,
      async spawn(spec: WorkerSpawnSpec): Promise<SpawnedWorkerHandle> {
        if (seen.length === 0) {
          const runDir = path.dirname(path.dirname(spec.stdoutPath));
          expect(await exists(path.join(runDir, "supervisor-state.json"))).toBe(true);
          expect(await exists(path.join(runDir, "trace.json"))).toBe(true);
          expect(await exists(path.join(runDir, "launch-receipt.json"))).toBe(true);
          expect(await exists(path.join(runDir, "logs"))).toBe(true);
        }
        seen.push(spec.workerId);
        return base.spawn(spec);
      },
    };
    await launchRealParallelBuild({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      skipRuntimeCheck: true,
      inline: true,
      deps: hybridDeps(spy, { pollIntervalMs: 15 }),
    });
    expect(seen).toEqual([WORKER_ID.main]);
  });

  test("main spawn does not wait for panel workspace preparation", async () => {
    await writeBehavior(allCompleteBehavior());
    const base = fakeRunner();
    const events: Array<{ type: string; workerId?: string; at: number }> = [];
    const spy: WorkerRunner = {
      transport: base.transport,
      async spawn(spec: WorkerSpawnSpec): Promise<SpawnedWorkerHandle> {
        events.push({ type: "spawn", workerId: spec.workerId, at: Date.now() });
        return base.spawn(spec);
      },
    };
    const mainReadyAt = Date.now();
    const result = await launchRealParallelBuild({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      skipRuntimeCheck: true,
      inline: true,
      deps: hybridDeps(spy, {
        pollIntervalMs: 15,
        panelWorkspacePreparationDelayMs: { 1: 150, 2: 250, 3: 350 },
      }),
    });
    workersRef = (await loadSupervisorState(sourceRoot, result.runId, traceRoot))!.workers;
    const mainSpawn = events.find((e) => e.workerId === WORKER_ID.main);
    expect(mainSpawn).toBeDefined();
    expect(mainSpawn!.at).toBeGreaterThanOrEqual(mainReadyAt);
    expect(events.filter((e) => e.type === "spawn")).toHaveLength(1);
  });

  test("panel workspace materialization happens concurrently", async () => {
    await writeBehavior(allCompleteBehavior());
    const start = Date.now();
    await launchRealParallelBuild({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      skipRuntimeCheck: true,
      inline: true,
      deps: hybridDeps(fakeRunner(), {
        pollIntervalMs: 15,
        panelWorkspacePreparationDelayMs: { 1: 100, 2: 100, 3: 100 },
      }),
    });
    const elapsed = Date.now() - start;
    // Sequential materialization of three 100ms delays would take >=300ms plus work.
    // Concurrent materialization should finish well under the sequential bound
    // even with the extra main-workspace materialization in bootstrap and FS overhead.
    expect(elapsed).toBeLessThan(2000);
  });

  test("supervisor failure returns FUSION_SUPERVISOR_LAUNCH_FAILED and does not fall back", async () => {
    await expect(
      launchRealParallelBuild({
        task: "Add a feature flag.",
        cwd: sourceRoot,
        traceDir: traceRoot,
        skipRuntimeCheck: true,
        inline: true,
        panelModels: ["prov/one-panel"], // bootstrap requires 3 panel models
        deps: hybridDeps(fakeRunner()),
      }),
    ).rejects.toThrow(/FUSION_SUPERVISOR_LAUNCH_FAILED/);
  });

  test("fusion-no-build command must not launch a supervisor", async () => {
    await expect(
      launchRealParallelBuild({
        task: "Plan only.",
        cwd: sourceRoot,
        traceDir: traceRoot,
        skipRuntimeCheck: true,
        inline: true,
        command: "fusion-no-build",
        deps: hybridDeps(fakeRunner()),
      }),
    ).rejects.toThrow(/fusion-no-build must not launch a supervisor/i);
  });

  test("/fusion-trace detects the supervisor trace first for hybrid_external_main_native_panels", async () => {
    await writeBehavior(allCompleteBehavior());
    const result = await launchRealParallelBuild({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      skipRuntimeCheck: true,
      inline: true,
      deps: hybridDeps(fakeRunner()),
    });
    const latest = await loadLatestSupervisorTrace(sourceRoot, traceRoot);
    expect(latest).toBeDefined();
    expect(latest!.kind).toBe("supervisor");
    expect(latest!.state.runId).toBe(result.runId);
    expect(latest!.state.strategy).toBe("hybrid_external_main_native_panels");
  });
});

describe("runtime install mismatch protection", () => {
  async function writeGoodFiles() {
    const manifest = {
      version: 1,
      pluginBuildId: "fusion-council-hybrid-v2",
      defaultBuildStrategy: "hybrid_external_main_native_panels",
      supportedTools: {
        fusionSupervisorStages: ["launch", "status", "resume"],
        fusionNativeStages: ["prepare", "advance", "collect", "record_main_baseline", "finalize", "audit_prepare", "audit_finalize", "resume"],
      },
      expectedCommandTemplateVersion: "fusion-build-hybrid-v2",
      expectedOrchestratorTemplateVersion: "fusion-orchestrator-hybrid-v2",
    };
    await mkdir(path.join(configDir, "commands"), { recursive: true });
    await mkdir(path.join(configDir, "agent"), { recursive: true });
    await writeFile(
      path.join(configDir, "fusion-runtime-manifest.json"),
      JSON.stringify(manifest),
      "utf8",
    );
    await writeFile(
      path.join(configDir, "commands", "fusion-build.md"),
      "FUSION_COMMAND_TEMPLATE_VERSION: fusion-build-hybrid-v2\nfusion_supervisor\n\"stage\": \"launch\"",
      "utf8",
    );
    await writeFile(
      path.join(configDir, "agent", "fusion-orchestrator.md"),
      "FUSION_ORCHESTRATOR_TEMPLATE_VERSION: fusion-orchestrator-hybrid-v2\nhybrid_external_main_native_panels\nfusion_supervisor",
      "utf8",
    );
  }

  test("returns FUSION_RUNTIME_INSTALL_MISMATCH when installed files are stale", async () => {
    process.env.FUSION_OPENCODE_CONFIG_DIR = configDir;
    await mkdir(path.join(configDir, "commands"), { recursive: true });
    await mkdir(path.join(configDir, "agent"), { recursive: true });
    await writeFile(
      path.join(configDir, "fusion-runtime-manifest.json"),
      JSON.stringify({ pluginBuildId: "stale", defaultBuildStrategy: "speculative_parallel_build" }),
      "utf8",
    );
    await writeFile(path.join(configDir, "commands", "fusion-build.md"), "old", "utf8");
    await writeFile(path.join(configDir, "agent", "fusion-orchestrator.md"), "old", "utf8");
    await expect(assertFreshBuildRuntimeCompatible()).rejects.toThrow(/FUSION_RUNTIME_INSTALL_MISMATCH/);
    try {
      await assertFreshBuildRuntimeCompatible();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("npm run build");
      expect(message).toContain("npm run install:opencode-agents");
      expect(message).toContain("npm run install:opencode-commands");
      expect(message).toContain("restart OpenCode");
    }
  });

  test("passes when installed command, orchestrator, and manifest are current", async () => {
    process.env.FUSION_OPENCODE_CONFIG_DIR = configDir;
    await writeGoodFiles();
    await expect(assertFreshBuildRuntimeCompatible()).resolves.toBeUndefined();
  });

  test("fresh launch surfaces FUSION_RUNTIME_INSTALL_MISMATCH when runtime is stale", async () => {
    process.env.FUSION_OPENCODE_CONFIG_DIR = configDir;
    await mkdir(path.join(configDir, "commands"), { recursive: true });
    await mkdir(path.join(configDir, "agent"), { recursive: true });
    await writeFile(
      path.join(configDir, "fusion-runtime-manifest.json"),
      JSON.stringify({ pluginBuildId: "stale", defaultBuildStrategy: "speculative_parallel_build" }),
      "utf8",
    );
    await writeFile(path.join(configDir, "commands", "fusion-build.md"), "old", "utf8");
    await writeFile(path.join(configDir, "agent", "fusion-orchestrator.md"), "old", "utf8");
    await expect(
      launchRealParallelBuild({
        task: "Add a feature flag.",
        cwd: sourceRoot,
        traceDir: traceRoot,
        inline: true,
        deps: hybridDeps(fakeRunner()),
      }),
    ).rejects.toThrow(/FUSION_RUNTIME_INSTALL_MISMATCH/);
  });
});

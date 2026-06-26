import { mkdtemp, readFile, writeFile, rm, mkdir, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import fusionCouncilPlugin from "../src/plugin.js";
import {
  buildDetachedSupervisorArgv,
  launchRealParallelBuild,
  resolveSupervisorNodeExecutable,
  supervisorMainEntry,
} from "../src/native/supervisorLaunch.js";
import { loadSupervisorState } from "../src/native/supervisorState.js";
import {
  parseSupervisorMainArgs,
  probeNodeRuntimeVersion,
  supervisorLogIndicatesOpenCodeHelp,
  SUPERVISOR_READY_FILENAME,
} from "../src/native/supervisorStartup.js";
import { createFakeNativeSubagentDispatcher } from "../src/native/nativeSubagentDispatch.js";
import { WORKER_ID, type WorkerRecord } from "../src/native/supervisorTypes.js";
import {
  createOpenCodeProcessWorkerRunner,
  type WorkerRunner,
  type WorkerSpawnSpec,
} from "../src/native/workerRunner.js";

const FAKE = fileURLToPath(new URL("./fixtures/fakeOpencode.mjs", import.meta.url));
const FAKE_INVALID_NODE = fileURLToPath(new URL("./fixtures/fakeInvalidNode.mjs", import.meta.url));
const FAKE_OPENCODE_HELP = fileURLToPath(new URL("./fixtures/fakeOpencodeHelp.mjs", import.meta.url));
const FAKE_NODE_THEN_HELP = fileURLToPath(new URL("./fixtures/fakeNodeValidationOnly.mjs", import.meta.url));

let sourceRoot: string;
let traceRoot: string;
let stagingRoot: string;
let behaviorPath: string;
let workersRef: Record<string, WorkerRecord> = {};

function hybridDeps(runner: WorkerRunner, extra?: Record<string, unknown>) {
  return {
    runner,
    pollIntervalMs: 25,
    autoConfirmReady: true,
    skipNativeAgentValidation: true,
    nativeDispatcher: createFakeNativeSubagentDispatcher({
      behavior: () => JSON.parse(readFileSync(behaviorPath, "utf8")),
      getWorkers: () => workersRef,
      skipAgentValidation: true,
    }),
    ...extra,
  };
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

function allCompleteBehavior() {
  return {
    [WORKER_ID.main]: { sleepMs: 200, changedFile: "src/main-impl.ts" },
    [WORKER_ID.panel(1)]: { sleepMs: 200, changedFile: "src/panel1-impl.ts" },
    [WORKER_ID.panel(2)]: { sleepMs: 200, changedFile: "src/panel2-impl.ts" },
    [WORKER_ID.panel(3)]: { sleepMs: 200, changedFile: "src/panel3-impl.ts" },
    [WORKER_ID.judge]: { sleepMs: 60, decision: "NO_PATCH_REQUIRED", writeContract: true },
  };
}

async function waitForWorkerSpawnAttempt(
  runDir: string,
  workerId: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statePath = path.join(runDir, "supervisor-state.json");
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        workers: Record<string, { status: string }>;
      };
      const status = state.workers[workerId]?.status;
      if (status && status !== "queued") return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${workerId} to leave queued state`);
}

beforeEach(async () => {
  workersRef = {};
  sourceRoot = await mkdtemp(path.join(tmpdir(), "fusion-det-src-"));
  traceRoot = await mkdtemp(path.join(tmpdir(), "fusion-det-trace-"));
  stagingRoot = await mkdtemp(path.join(tmpdir(), "fusion-det-stage-"));
  behaviorPath = path.join(traceRoot, "behavior.json");
  process.env.FUSION_SPECULATIVE_CACHE_ROOT = stagingRoot;
  process.env.FUSION_OPENCODE_BIN = process.execPath;
  process.env.FUSION_OPENCODE_TEST_ENTRY = FAKE;
  delete process.env.FUSION_FAKE_BEHAVIOR;
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "index.ts"), "export const base = true;\n", "utf8");
  await writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
});

afterEach(async () => {
  delete process.env.FUSION_SPECULATIVE_CACHE_ROOT;
  delete process.env.FUSION_FAKE_BEHAVIOR;
  delete process.env.FUSION_OPENCODE_BIN;
  delete process.env.FUSION_OPENCODE_TEST_ENTRY;
  delete process.env.FUSION_NODE_BIN;
  await rm(sourceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(traceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(stagingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("supervisor node runtime resolution", () => {
  test("resolveSupervisorNodeExecutable rejects invalid Node candidates", async () => {
    await expect(
      resolveSupervisorNodeExecutable({ candidates: [FAKE_INVALID_NODE] }),
    ).rejects.toThrow(/No valid Node.js runtime/);
  });

  test("FUSION_NODE_BIN is used only when it validates as Node", async () => {
    process.env.FUSION_NODE_BIN = process.execPath;
    const resolved = await resolveSupervisorNodeExecutable();
    expect(resolved).toBe(process.execPath);
    expect(probeNodeRuntimeVersion(resolved)).toBeTruthy();
  });

  test("supervisorLogIndicatesOpenCodeHelp detects OpenCode CLI help output", () => {
    const help = "opencode - OpenCode CLI\nUsage: opencode <command>\nCommands: run, agent";
    expect(supervisorLogIndicatesOpenCodeHelp(help)).toBe(true);
    expect(supervisorLogIndicatesOpenCodeHelp("[fake-opencode] fusion-main-builder starting")).toBe(false);
  });
});

describe("detached supervisor launch contract", () => {
  test("supervisor spawn contract uses Node with supervisorMain.js as script argv", () => {
    const entrypointPath = supervisorMainEntry();
    const nodeExecutable = process.execPath;
    expect(probeNodeRuntimeVersion(nodeExecutable)).toBeTruthy();
    expect(path.basename(nodeExecutable).toLowerCase()).not.toMatch(/^opencode/);

    const { entrypointPath: resolvedEntrypoint, argv } = buildDetachedSupervisorArgv({
      runId: "fusion-contract-run",
      runDir: path.join(traceRoot, "fusion-contract-run"),
      sourceWorkspace: sourceRoot,
      workingDirectory: sourceRoot,
      traceDir: traceRoot,
    });
    expect(resolvedEntrypoint).toBe(entrypointPath);
    expect(nodeExecutable).not.toBe(resolvedEntrypoint);
    expect(argv.includes(resolvedEntrypoint) || argv[argv.indexOf("tsx") + 1] === resolvedEntrypoint).toBe(true);
    expect(argv).not.toContain(FAKE_OPENCODE_HELP);
  });

  test("FUSION_OPENCODE_BIN does not change supervisor Node resolution", async () => {
    process.env.FUSION_OPENCODE_BIN = FAKE_OPENCODE_HELP;
    const withoutOpencode = await resolveSupervisorNodeExecutable();
    delete process.env.FUSION_OPENCODE_BIN;
    const baseline = await resolveSupervisorNodeExecutable();
    expect(withoutOpencode).toBe(baseline);
    expect(probeNodeRuntimeVersion(withoutOpencode)).toBeTruthy();
    expect(withoutOpencode).not.toBe(FAKE_OPENCODE_HELP);
  });

  test("fake opencode help executable is no longer used for hybrid bootstrap launch", async () => {
    await writeBehavior(allCompleteBehavior());
    const result = await launchRealParallelBuild({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      skipRuntimeCheck: true,
      supervisorNodeCandidates: [FAKE_NODE_THEN_HELP],
      deps: hybridDeps(fakeRunner()),
    });
    expect(result.readyAt).toBeTruthy();
    expect(result.detached).toBe(false);
  });

  test("invalid supervisor Node runtime is ignored for hybrid bootstrap launch", async () => {
    const result = await launchRealParallelBuild({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      skipRuntimeCheck: true,
      supervisorNodeCandidates: [FAKE_INVALID_NODE],
      deps: hybridDeps(fakeRunner()),
    });
    expect(result.readyAt).toBeTruthy();
  });

  test("OpenCode CLI help in supervisor log before ready is startup failure", async () => {
    const runDir = path.join(traceRoot, "fusion-help-log-run");
    const logPath = path.join(runDir, "logs", "supervisor.log");
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(
      logPath,
      "opencode - OpenCode CLI\nUsage: opencode <command>\nCommands: run, agent\n",
      "utf8",
    );
    const child = nodeSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true });
    const { waitForSupervisorReady } = await import("../src/native/supervisorStartup.js");
    await expect(
      waitForSupervisorReady(runDir, {
        timeoutMs: 500,
        supervisorLogPath: logPath,
        child,
        supervisorPid: child.pid,
      }),
    ).rejects.toThrow(/OpenCode CLI help/);
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  });


  test("FUSION_OPENCODE_BIN fake help does not block supervisor-ready.json", async () => {
    await writeBehavior(allCompleteBehavior());
    process.env.FUSION_OPENCODE_BIN = FAKE_OPENCODE_HELP;
    const result = await launchRealParallelBuild({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      skipRuntimeCheck: true,
      deps: hybridDeps(fakeRunner()),
      startupTimeoutMs: 15000,
    });
    const readyPath = path.join(result.runDir, SUPERVISOR_READY_FILENAME);
    expect(await exists(readyPath)).toBe(true);
    const ready = JSON.parse(await readFile(readyPath, "utf8"));
    expect(ready.nodeExecutable).toBeTruthy();
    expect(probeNodeRuntimeVersion(ready.nodeExecutable)).toBeTruthy();
  });
  test("buildDetachedSupervisorArgv uses the entrypoint file and a valid working directory", async () => {
    const entrypointPath = supervisorMainEntry();
    const runDir = path.join(traceRoot, "fusion-contract-run");
    const { entrypointPath: resolvedEntrypoint, argv } = buildDetachedSupervisorArgv({
      runId: "fusion-contract-run",
      runDir,
      sourceWorkspace: sourceRoot,
      workingDirectory: sourceRoot,
      traceDir: traceRoot,
    });
    expect(resolvedEntrypoint).toBe(entrypointPath);
    expect(argv).toContain(resolvedEntrypoint);
    expect((await stat(resolvedEntrypoint)).isFile()).toBe(true);
    expect((await stat(sourceRoot)).isDirectory()).toBe(true);
    expect(argv).toContain("--working-directory");
    expect(argv).toContain(sourceRoot);
    expect(argv).not.toContain("--dir");
  });

  test("never passes supervisorMain.js as cwd, --dir, source workspace, or run directory", () => {
    const entrypointPath = supervisorMainEntry();
    const runDir = path.join(traceRoot, "fusion-contract-run");
    const { argv } = buildDetachedSupervisorArgv({
      runId: "fusion-contract-run",
      runDir,
      sourceWorkspace: sourceRoot,
      workingDirectory: sourceRoot,
      traceDir: traceRoot,
    });
    expect(argv).not.toContain("--dir");
    const runDirArg = argv[argv.indexOf("--run-dir") + 1];
    const sourceArg = argv[argv.indexOf("--source-workspace") + 1];
    const workingArg = argv[argv.indexOf("--working-directory") + 1];
    for (const value of [runDirArg, sourceArg, workingArg]) {
      expect(path.resolve(value)).not.toBe(path.resolve(entrypointPath));
    }
    expect(runDir).not.toBe(entrypointPath);
  });

  test("supervisorMain argument parsing treats argv[1] as script path, not workspace", () => {
    const parsed = parseSupervisorMainArgs([
      "--run-id",
      "fusion-test-run",
      "--run-dir",
      traceRoot,
      "--source-workspace",
      sourceRoot,
      "--working-directory",
      sourceRoot,
    ]);
    expect(parsed.runId).toBe("fusion-test-run");
    expect(parsed.sourceWorkspace).toBe(path.resolve(sourceRoot));
    expect(parsed.workingDirectory).toBe(path.resolve(sourceRoot));
    expect(parsed.runDir).toBe(path.resolve(traceRoot));
  });

  test("reaches running phase and writes supervisor-ready.json", async () => {
    await writeBehavior(allCompleteBehavior());
    const result = await launchRealParallelBuild({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      skipRuntimeCheck: true,
      deps: hybridDeps(fakeRunner()),
      startupTimeoutMs: 15000,
    });
    expect(result.readyAt).toBeTruthy();
    const readyPath = path.join(result.runDir, SUPERVISOR_READY_FILENAME);
    expect(await exists(readyPath)).toBe(true);
    const ready = JSON.parse(await readFile(readyPath, "utf8"));
    expect(ready.runId).toBe(result.runId);
    expect(ready.workingDirectory).toBe(path.resolve(sourceRoot));
    expect(ready.entrypointPath).toBe(supervisorMainEntry());
    expect(ready.nodeExecutable).toBeTruthy();
    expect(probeNodeRuntimeVersion(ready.nodeExecutable)).toBeTruthy();
    const state = await loadSupervisorState(sourceRoot, result.runId, traceRoot);
    expect(state?.phase === "running" || state?.phase === "workers_running" || state?.phase === "done").toBe(true);
  });

  test("returns launch receipt only after the ready handshake succeeds", async () => {
    await writeBehavior(allCompleteBehavior());
    const result = await launchRealParallelBuild({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      skipRuntimeCheck: true,
      deps: hybridDeps(fakeRunner()),
      startupTimeoutMs: 15000,
    });
    expect(result.readyAt).toBeTruthy();
    const receipt = JSON.parse(await readFile(path.join(result.runDir, "launch-receipt.json"), "utf8"));
    expect(receipt.readyAt).toBe(result.readyAt);
    expect(receipt.supervisorPid).toBeTruthy();
  });

  test("invalid supervisor working directory returns FUSION_SUPERVISOR_LAUNCH_FAILED", async () => {
    const invalidWorkingDirectory = path.join(sourceRoot, "not-a-directory");
    await writeFile(invalidWorkingDirectory, "file-not-dir", "utf8");
    const { confirmSupervisorReady } = await import("../src/native/supervisorStartup.js");
    await expect(
      confirmSupervisorReady({
        runId: "fusion-invalid-cwd",
        runDir: path.join(traceRoot, "fusion-invalid-cwd"),
        sourceWorkspace: sourceRoot,
        workingDirectory: invalidWorkingDirectory,
        entrypointPath: supervisorMainEntry(),
        traceDir: traceRoot,
      }),
    ).rejects.toThrow(/working directory/i);
  });

  test("after ready state, hybrid bootstrap leaves primary workers queued until orchestrator sync", async () => {
    await writeBehavior(allCompleteBehavior());
    const result = await launchRealParallelBuild({
      task: "Add a feature flag.",
      cwd: sourceRoot,
      traceDir: traceRoot,
      skipRuntimeCheck: true,
      deps: hybridDeps(fakeRunner()),
      startupTimeoutMs: 15000,
    });
    const state = await loadSupervisorState(sourceRoot, result.runId, traceRoot);
    expect(state?.phase).toBe("running");
    for (const workerId of [WORKER_ID.main, WORKER_ID.panel(1), WORKER_ID.panel(2), WORKER_ID.panel(3)]) {
      expect(state?.workers[workerId].status).toBe("queued");
    }
  });

  test("worker spawn failure becomes failed with a concrete error instead of staying queued", async () => {
    const brokenRunner: WorkerRunner = {
      transport: "broken",
      async spawn(spec: WorkerSpawnSpec) {
        throw new Error(`intentional spawn failure for ${spec.workerId}`);
      },
    };
    await writeBehavior(allCompleteBehavior());
    const { bootstrapRealParallelBuild, superviseRun } = await import("../src/native/fusionSupervisor.js");
    const runId = "fusion-20260625-120000-a00001";
    await bootstrapRealParallelBuild(
      {
        runId,
        task: "Add a feature flag.",
        command: "fusion-build",
        mainModel: { modelId: "prov/main-model" },
        panelModels: [{ modelId: "prov/panel-1" }, { modelId: "prov/panel-2" }, { modelId: "prov/panel-3" }],
        judgeModel: { modelId: "prov/judge-model" },
        sourceWorkspace: sourceRoot,
      },
      { cwd: sourceRoot, traceDir: traceRoot, runner: brokenRunner, autoConfirmReady: true, skipNativeAgentValidation: true, nativeDispatcher: createFakeNativeSubagentDispatcher({ behavior: () => JSON.parse(readFileSync(behaviorPath, "utf8")), getWorkers: () => workersRef, skipAgentValidation: true }) },
    );
    workersRef = (await loadSupervisorState(sourceRoot, runId, traceRoot))!.workers;
    await superviseRun(runId, { cwd: sourceRoot, traceDir: traceRoot, runner: brokenRunner, autoConfirmReady: true, skipNativeAgentValidation: true, nativeDispatcher: createFakeNativeSubagentDispatcher({ behavior: () => JSON.parse(readFileSync(behaviorPath, "utf8")), getWorkers: () => workersRef, skipAgentValidation: true }) });
    const state = await loadSupervisorState(sourceRoot, runId, traceRoot);
    const main = state!.workers[WORKER_ID.main];
    expect(main.status).toBe("failed");
    expect(main.statusTransitions.some((entry) => entry.status === "spawning")).toBe(true);
    expect(main.statusTransitions.at(-1)?.reason).toMatch(/intentional spawn failure/);
  });
});

describe("fusion_supervisor runtime route", () => {
  test("plugin launch stage uses hybrid_external_main_native_panels, not legacy fusion_native", async () => {
    await writeBehavior(allCompleteBehavior());
    const configDir = await mkdtemp(path.join(tmpdir(), "fusion-plugin-config-"));
    process.env.FUSION_OPENCODE_CONFIG_DIR = configDir;
    await mkdir(path.join(configDir, "commands"), { recursive: true });
    await mkdir(path.join(configDir, "agent"), { recursive: true });
    await writeFile(
      path.join(configDir, "fusion-runtime-manifest.json"),
      JSON.stringify({
        version: 1,
        pluginBuildId: "fusion-council-hybrid-v2",
        defaultBuildStrategy: "hybrid_external_main_native_panels",
        supportedTools: {
          fusionSupervisorStages: ["launch", "status", "resume"],
          fusionNativeStages: ["prepare", "advance", "collect", "record_main_baseline", "finalize", "audit_prepare", "audit_finalize", "resume"],
        },
        expectedCommandTemplateVersion: "fusion-build-hybrid-v2",
        expectedOrchestratorTemplateVersion: "fusion-orchestrator-hybrid-v2",
      }),
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

    const plugin = await fusionCouncilPlugin({ client: {} as never } as never, {
      saveRunArtifacts: true,
      traceDir: traceRoot,
    } as never);
    const fusionSupervisor = plugin.tool?.fusion_supervisor;
    expect(fusionSupervisor).toBeDefined();
    const raw = await fusionSupervisor!.execute(
      {
        stage: "launch",
        task: "Add a feature flag.",
        command: "fusion-build",
        inline: false,
        traceDir: traceRoot,
      } as never,
      {
        directory: sourceRoot,
        sessionID: "test",
        messageID: "test",
        agent: "test",
        worktree: sourceRoot,
        abort: new AbortController().signal,
        metadata: () => undefined,
        ask: async () => undefined,
      } as never,
    );
    const result = JSON.parse(typeof raw === "string" ? raw : (raw as { output: string }).output);
    expect(result.strategy).toBe("hybrid_external_main_native_panels");
    expect(result.readyAt).toBeTruthy();
    expect(result.detached).toBe(false);
    delete process.env.FUSION_OPENCODE_CONFIG_DIR;
    await rm(configDir, { recursive: true, force: true });
  });
});

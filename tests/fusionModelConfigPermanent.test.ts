import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  assertJudgeDispatchModelConsistency,
  FusionRestartRequiredAfterAgentResyncError,
  reconcileNativeAgentsAtLaunch,
} from "../src/native/nativeSubagentDispatch.js";
import {
  buildJudgeAgentFile,
  buildPanelAgentFile,
  FUSION_AGENT_NAMES,
  FUSION_PANEL_AGENT_NAMES,
} from "../src/native/agentTemplates.js";
import {
  computeModelConfigFingerprint,
  loadSavedModelConfig,
  resolveModels,
  saveSavedModelConfig,
} from "../src/modelConfig.js";
import { syncNativeAgentsFromCanonicalConfig } from "../src/native/agentSync.js";
import { launchForegroundHybrid } from "../src/native/supervisorLaunch.js";
import { createOpenCodeProcessWorkerRunner } from "../src/native/workerRunner.js";

const FAKE = fileURLToPath(new URL("./fixtures/fakeOpencode.mjs", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

let agentDir: string;
let configPath: string;
let configDir: string;
let sourceRoot: string;
let traceRoot: string;

const PANEL_MODELS = [
  "opencode-go/mimo-v2.5-pro",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/qwen3.7-max",
];
const JUDGE_MODEL = "openai/gpt-5.4-mini";
const STALE_AGENT_MODEL = "opencode-go/qwen3.7-max";

async function writeCanonicalConfig(): Promise<string> {
  const saved = await saveSavedModelConfig(
    {
      panelModels: PANEL_MODELS.map((modelId) => ({ modelId })),
      judgeModel: { modelId: JUDGE_MODEL },
    },
    configPath,
  );
  return saved.fingerprint;
}

beforeEach(async () => {
  agentDir = await mkdtemp(path.join(tmpdir(), "fusion-agentdir-"));
  configDir = await mkdtemp(path.join(tmpdir(), "fusion-cfg-"));
  configPath = path.join(configDir, "fusion-council-models.json");
  process.env.FUSION_COUNCIL_MODELS_CONFIG_PATH = configPath;
  sourceRoot = await mkdtemp(path.join(tmpdir(), "fusion-src-"));
  traceRoot = path.join(sourceRoot, ".opencode", "fusion-runs");
  await writeFile(path.join(sourceRoot, "package.json"), "{}\n", "utf8");
});

afterEach(async () => {
  delete process.env.FUSION_COUNCIL_MODELS_CONFIG_PATH;
  await rm(agentDir, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(sourceRoot, { recursive: true, force: true });
  delete process.env.FUSION_FAKE_BEHAVIOR;
});

describe("canonical model config and agent sync", () => {
  test("install:opencode-agents writes Panel 2 = Mimo from canonical config, never stale Qwen", async () => {
    const fingerprint = await writeCanonicalConfig();
    const sync = await syncNativeAgentsFromCanonicalConfig(configPath, agentDir);
    expect(sync.panelAgents[1]?.modelId).toBe(PANEL_MODELS[1]);
    const panel2 = await readFile(path.join(agentDir, "fusion-panel-2.md"), "utf8");
    expect(panel2).toContain(`model: ${PANEL_MODELS[1]}`);
    expect(panel2).not.toContain(STALE_AGENT_MODEL);
    expect(panel2).toContain(`FUSION_MODEL_CONFIG_FINGERPRINT: ${fingerprint}`);
  });

  test("custom four-model selection survives syncNativeAgentsFromCanonicalConfig unchanged", async () => {
    const custom = {
      panelModels: [
        { modelId: "custom/panel-a" },
        { modelId: "custom/panel-b" },
        { modelId: "custom/panel-c" },
      ],
      judgeModel: { modelId: "custom/judge-d" },
    };
    await saveSavedModelConfig(custom, configPath);
    const before = await readFile(configPath, "utf8");
    await syncNativeAgentsFromCanonicalConfig(configPath, agentDir);
    const after = await readFile(configPath, "utf8");
    expect(after).toBe(before);
    const sync = await syncNativeAgentsFromCanonicalConfig(configPath, agentDir);
    expect(sync.panelAgents.map((p) => p.modelId)).toEqual(custom.panelModels.map((s) => s.modelId));
    expect(sync.judgeAgent.modelId).toBe(custom.judgeModel.modelId);
  });

  test("agent files and config receive the same fingerprint", async () => {
    const fingerprint = await writeCanonicalConfig();
    await syncNativeAgentsFromCanonicalConfig(configPath, agentDir);
    const saved = await loadSavedModelConfig(configPath);
    expect(saved?.fingerprint).toBe(fingerprint);
    const panel1 = await readFile(path.join(agentDir, "fusion-panel-1.md"), "utf8");
    expect(panel1).toContain(`FUSION_MODEL_CONFIG_FINGERPRINT: ${fingerprint}`);
    const judge = await readFile(path.join(agentDir, "fusion-judge.md"), "utf8");
    expect(judge).toContain(`FUSION_MODEL_CONFIG_FINGERPRINT: ${fingerprint}`);
  });

  test("stale agent file is regenerated from config at launch and returns FUSION_RESTART_REQUIRED_AFTER_AGENT_RESYNC", async () => {
    const fingerprint = await writeCanonicalConfig();
    for (let i = 1; i <= 3; i += 1) {
      const file = buildPanelAgentFile({ panelIndex: i, modelId: STALE_AGENT_MODEL });
      await writeFile(path.join(agentDir, `${FUSION_PANEL_AGENT_NAMES[i - 1]}.md`), file.content, "utf8");
    }
    const judgeFile = buildJudgeAgentFile({ modelId: STALE_AGENT_MODEL });
    await writeFile(path.join(agentDir, `${FUSION_AGENT_NAMES.judge}.md`), judgeFile.content, "utf8");

    const before = await readFile(configPath, "utf8");
    await expect(
      reconcileNativeAgentsAtLaunch({
        panelModels: PANEL_MODELS.map((modelId) => ({ modelId })),
        judgeModel: { modelId: JUDGE_MODEL },
        configFingerprint: fingerprint,
        agentDir,
      }),
    ).rejects.toBeInstanceOf(FusionRestartRequiredAfterAgentResyncError);

    const after = await readFile(configPath, "utf8");
    expect(after).toBe(before);

    const repaired = await readFile(path.join(agentDir, "fusion-panel-2.md"), "utf8");
    expect(repaired).toContain(`model: ${PANEL_MODELS[1]}`);
    expect(repaired).toContain(`FUSION_MODEL_CONFIG_FINGERPRINT: ${fingerprint}`);
  });

  test("stale-agent launch returns FUSION_RESTART_REQUIRED_AFTER_AGENT_RESYNC with no workers spawned", async () => {
    const fingerprint = await writeCanonicalConfig();
    for (let i = 1; i <= 3; i += 1) {
      const file = buildPanelAgentFile({ panelIndex: i, modelId: STALE_AGENT_MODEL });
      await writeFile(path.join(agentDir, `${FUSION_PANEL_AGENT_NAMES[i - 1]}.md`), file.content, "utf8");
    }
    await writeFile(
      path.join(agentDir, `${FUSION_AGENT_NAMES.judge}.md`),
      buildJudgeAgentFile({ modelId: STALE_AGENT_MODEL }).content,
      "utf8",
    );

    await expect(
      launchForegroundHybrid({
        task: "Add feature",
        cwd: sourceRoot,
        traceDir: traceRoot,
        invokingSessionModelId: "prov/active-main",
        skipRuntimeCheck: true,
        skipDuplicateRunGuard: true,
        deps: {
          cwd: sourceRoot,
          traceDir: traceRoot,
          agentDir,
          runner: createOpenCodeProcessWorkerRunner({
            opencodeBin: process.execPath,
            buildArgs: () => [FAKE],
          }),
        },
      }),
    ).rejects.toThrow(/FUSION_RESTART_REQUIRED_AFTER_AGENT_RESYNC/);

    const runEntries = await readdir(traceRoot).catch(() => []);
    expect(runEntries).toEqual([]);
  });

  test("resolveModels ignores launch-time panel/judge overrides", async () => {
    await saveSavedModelConfig(
      {
        panelModels: [{ modelId: PANEL_MODELS[0] }, { modelId: PANEL_MODELS[1] }, { modelId: PANEL_MODELS[2] }],
        judgeModel: { modelId: JUDGE_MODEL },
      },
      configPath,
    );
    const resolved = await resolveModels(
      { panelModels: ["other/p1", "other/p2", "other/p3"], judgeModel: "other/judge" },
      configPath,
    );
    expect(resolved.panelModels.map((s) => s.modelId)).toEqual(PANEL_MODELS);
    expect(resolved.judgeModel.modelId).toBe(JUDGE_MODEL);
  });

  test("main builder uses active invoking session model even when Panel 1 differs", async () => {
    await writeCanonicalConfig();
    await syncNativeAgentsFromCanonicalConfig(configPath, agentDir);
    process.env.FUSION_FAKE_BEHAVIOR = path.join(sourceRoot, "behavior.json");
    await writeFile(
      process.env.FUSION_FAKE_BEHAVIOR,
      JSON.stringify({ "fusion-main-builder": { sleepMs: 50, changedFile: "src/main.ts", observedModel: "prov/active-main" } }),
      "utf8",
    );

    const plan = await launchForegroundHybrid({
      task: "Add feature",
      cwd: sourceRoot,
      traceDir: traceRoot,
      invokingSessionModelId: "prov/active-main",
      skipRuntimeCheck: true,
      skipDuplicateRunGuard: true,
      deps: {
        cwd: sourceRoot,
        traceDir: traceRoot,
        agentDir,
        runner: createOpenCodeProcessWorkerRunner({
          opencodeBin: process.execPath,
          buildArgs: () => [FAKE],
        }),
      },
    });
    expect(plan.main.requestedModelId).toBe("prov/active-main");
    expect(plan.panelDispatchSpecs[0]?.configuredModelId).toBe(PANEL_MODELS[0]);
    expect(plan.main.requestedModelId).not.toBe(PANEL_MODELS[0]);
  });

  test("judge dispatch rejects configured vs agent-file vs dispatch model mismatch", () => {
    expect(() =>
      assertJudgeDispatchModelConsistency({
        configuredJudgeModelId: JUDGE_MODEL,
        agentFileJudgeModelId: "openai/gpt-5.5",
        dispatchJudgeModelId: JUDGE_MODEL,
      }),
    ).toThrow(/FUSION_JUDGE_MODEL_CONFIG_MISMATCH/);
  });

  test("dist plugin and built agent sync exports expose canonical-config install path", async () => {
    execFileSync(process.execPath, [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(projectRoot, "tsconfig.json")], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    const agentSync = await import(path.join(projectRoot, "dist", "native", "agentSync.js"));
    const plugin = await readFile(path.join(projectRoot, "dist", "plugin.js"), "utf8");
    expect(typeof agentSync.syncNativeAgentsFromCanonicalConfig).toBe("function");
    expect(plugin).toContain("inspectModelSyncStatus");
    expect(plugin).toContain("writeInstalledRuntimeManifest");
  });

  test("fingerprint is deterministic for the same model selection", () => {
    const input = {
      panelModels: PANEL_MODELS.map((modelId) => ({ modelId })),
      judgeModel: { modelId: JUDGE_MODEL },
    };
    expect(computeModelConfigFingerprint(input)).toBe(computeModelConfigFingerprint(input));
  });
});

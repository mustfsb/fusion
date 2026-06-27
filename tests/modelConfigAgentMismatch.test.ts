import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  FusionRestartRequiredAfterAgentResyncError,
  reconcileNativeAgentsAtLaunch,
} from "../src/native/nativeSubagentDispatch.js";
import {
  buildJudgeAgentFile,
  buildPanelAgentFile,
  FUSION_AGENT_NAMES,
  FUSION_PANEL_AGENT_NAMES,
} from "../src/native/agentTemplates.js";
import { loadSavedModelConfig, resolveModels, saveSavedModelConfig } from "../src/modelConfig.js";

let agentDir: string;
let configPath: string;

const SELECTED_PANEL_MODELS = ["prov/panel-A", "prov/panel-B", "prov/panel-C"];
const SELECTED_JUDGE_MODEL = "prov/judge-X";
const STALE_AGENT_MODEL = "prov/STALE-installed-model";

beforeEach(async () => {
  agentDir = await mkdtemp(path.join(tmpdir(), "fusion-agentdir-"));
  const configDir = await mkdtemp(path.join(tmpdir(), "fusion-cfg-"));
  configPath = path.join(configDir, "fusion-council-models.json");

  await saveSavedModelConfig(
    {
      panelModels: SELECTED_PANEL_MODELS.map((modelId) => ({ modelId })),
      judgeModel: { modelId: SELECTED_JUDGE_MODEL },
    },
    configPath,
  );

  for (let i = 1; i <= 3; i += 1) {
    const file = buildPanelAgentFile({ panelIndex: i, modelId: STALE_AGENT_MODEL });
    await writeFile(path.join(agentDir, `${FUSION_PANEL_AGENT_NAMES[i - 1]}.md`), file.content, "utf8");
  }
  const judgeFile = buildJudgeAgentFile({ modelId: STALE_AGENT_MODEL });
  await writeFile(path.join(agentDir, `${FUSION_AGENT_NAMES.judge}.md`), judgeFile.content, "utf8");
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
  await rm(path.dirname(configPath), { recursive: true, force: true });
});

describe("native agent / persisted model config mismatch", () => {
  test("stale panel agent files trigger resync and FUSION_RESTART_REQUIRED_AFTER_AGENT_RESYNC", async () => {
    const saved = await loadSavedModelConfig(configPath);
    await expect(
      reconcileNativeAgentsAtLaunch({
        panelModels: SELECTED_PANEL_MODELS.map((modelId) => ({ modelId })),
        judgeModel: { modelId: SELECTED_JUDGE_MODEL },
        configFingerprint: saved!.fingerprint,
        agentDir,
      }),
    ).rejects.toBeInstanceOf(FusionRestartRequiredAfterAgentResyncError);

    try {
      await reconcileNativeAgentsAtLaunch({
        panelModels: SELECTED_PANEL_MODELS.map((modelId) => ({ modelId })),
        judgeModel: { modelId: SELECTED_JUDGE_MODEL },
        configFingerprint: saved!.fingerprint,
        agentDir,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("FUSION_RESTART_REQUIRED_AFTER_AGENT_RESYNC");
      expect(message).toContain("Restart OpenCode");
      expect(message).not.toContain("npm run install:opencode-agents");
      expect(message).toContain(saved!.fingerprint);
    }
  });

  test("a config/agent mismatch does NOT mutate the persisted user model config", async () => {
    const before = await readFile(configPath, "utf8");
    const saved = await loadSavedModelConfig(configPath);

    await expect(
      reconcileNativeAgentsAtLaunch({
        panelModels: SELECTED_PANEL_MODELS.map((modelId) => ({ modelId })),
        judgeModel: { modelId: SELECTED_JUDGE_MODEL },
        configFingerprint: saved!.fingerprint,
        agentDir,
      }),
    ).rejects.toBeInstanceOf(FusionRestartRequiredAfterAgentResyncError);

    const after = await readFile(configPath, "utf8");
    expect(after).toBe(before);

    const reloaded = await loadSavedModelConfig(configPath);
    expect(reloaded?.panelModels.map((s) => s.modelId)).toEqual(SELECTED_PANEL_MODELS);
    expect(reloaded?.judgeModel.modelId).toBe(SELECTED_JUDGE_MODEL);
    const resolved = await resolveModels(undefined, configPath);
    expect(resolved.source).toBe("saved");
    expect(resolved.panelModels.map((s) => s.modelId)).toEqual(SELECTED_PANEL_MODELS);
  });
});

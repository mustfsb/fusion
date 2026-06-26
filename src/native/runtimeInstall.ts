import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildRuntimeManifest,
  FUSION_RUNTIME_MANIFEST_FILENAME,
  fusionBuildCommandTemplateMarker,
  fusionOrchestratorTemplateMarker,
  type FusionRuntimeManifest,
} from "../runtimeManifest.js";

export function resolveOpenCodeConfigDir(): string {
  return path.resolve(process.env.FUSION_OPENCODE_CONFIG_DIR ?? path.join(homedir(), ".config", "opencode"));
}

export function installedFusionBuildCommandPath(configDir = resolveOpenCodeConfigDir()): string {
  return path.join(configDir, "commands", "fusion-build.md");
}

export function installedFusionOrchestratorPath(configDir = resolveOpenCodeConfigDir()): string {
  return path.join(configDir, "agent", "fusion-orchestrator.md");
}

export function installedRuntimeManifestPath(configDir = resolveOpenCodeConfigDir()): string {
  return path.join(configDir, FUSION_RUNTIME_MANIFEST_FILENAME);
}

async function readUtf8(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function loadInstalledManifest(configDir: string): Promise<FusionRuntimeManifest | undefined> {
  const text = await readUtf8(installedRuntimeManifestPath(configDir));
  if (!text) return undefined;
  try {
    return JSON.parse(text) as FusionRuntimeManifest;
  } catch {
    return undefined;
  }
}

function mismatchError(details: string[]): Error {
  const detailBlock = details.length ? `${details.map((entry) => `- ${entry}`).join("\n")}\n` : "";
  return new Error(
    [
      "FUSION_RUNTIME_INSTALL_MISMATCH",
      detailBlock.trimEnd(),
      "npm run build",
      "npm run install:opencode-agents",
      "npm run install:opencode-commands",
      "restart OpenCode",
    ].filter(Boolean).join("\n"),
  );
}

export async function assertFreshBuildRuntimeCompatible(): Promise<void> {
  const expected = buildRuntimeManifest();
  const configDir = resolveOpenCodeConfigDir();
  const [manifest, commandText, orchestratorText] = await Promise.all([
    loadInstalledManifest(configDir),
    readUtf8(installedFusionBuildCommandPath(configDir)),
    readUtf8(installedFusionOrchestratorPath(configDir)),
  ]);

  const problems: string[] = [];
  if (!manifest) {
    problems.push(`missing or unreadable ${installedRuntimeManifestPath(configDir)}`);
  } else {
    if (manifest.pluginBuildId !== expected.pluginBuildId) {
      problems.push(`plugin build ID mismatch (${manifest.pluginBuildId} != ${expected.pluginBuildId})`);
    }
    if (manifest.defaultBuildStrategy !== expected.defaultBuildStrategy) {
      problems.push(`default build strategy mismatch (${manifest.defaultBuildStrategy} != ${expected.defaultBuildStrategy})`);
    }
    if (!manifest.supportedTools?.fusionSupervisorStages?.includes("launch")) {
      problems.push("installed manifest does not advertise fusion_supervisor launch");
    }
    if (manifest.expectedCommandTemplateVersion !== expected.expectedCommandTemplateVersion) {
      problems.push(
        `fusion-build command template version mismatch (${manifest.expectedCommandTemplateVersion} != ${expected.expectedCommandTemplateVersion})`,
      );
    }
    if (manifest.expectedOrchestratorTemplateVersion !== expected.expectedOrchestratorTemplateVersion) {
      problems.push(
        `fusion-orchestrator template version mismatch (${manifest.expectedOrchestratorTemplateVersion} != ${expected.expectedOrchestratorTemplateVersion})`,
      );
    }
  }

  if (!commandText) {
    problems.push(`missing ${installedFusionBuildCommandPath(configDir)}`);
  } else {
    if (!commandText.includes(fusionBuildCommandTemplateMarker())) {
      problems.push("installed fusion-build command marker is stale");
    }
    if (!commandText.includes("fusion_supervisor")) {
      problems.push("installed fusion-build command does not route through fusion_supervisor");
    }
    if (!commandText.includes('"stage": "launch"')) {
      problems.push("installed fusion-build command does not call fusion_supervisor launch");
    }
  }

  if (!orchestratorText) {
    problems.push(`missing ${installedFusionOrchestratorPath(configDir)}`);
  } else {
    if (!orchestratorText.includes(fusionOrchestratorTemplateMarker())) {
      problems.push("installed fusion-orchestrator marker is stale");
    }
    if (!orchestratorText.includes("hybrid_external_main_native_panels")) {
      problems.push("installed fusion-orchestrator does not describe hybrid_external_main_native_panels");
    }
    if (!orchestratorText.includes("fusion_supervisor")) {
      problems.push("installed fusion-orchestrator does not route /fusion-build through fusion_supervisor");
    }
  }

  if (problems.length > 0) {
    throw mismatchError(problems);
  }
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildRuntimeManifest,
  FUSION_FOREGROUND_PROTOCOL_VERSION,
  FUSION_RUNTIME_MANIFEST_FILENAME,
  fusionBuildCommandTemplateMarker,
  fusionForegroundProtocolMarker,
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

function protocolMismatchError(stalePath: string, detail: string): Error {
  return new Error(`FUSION_RUNTIME_PROTOCOL_MISMATCH: ${detail}\nstale file: ${stalePath}`);
}

/**
 * Verify the installed command, orchestrator, and runtime manifest all advertise
 * the active foreground protocol version before any worker launch begins.
 */
export async function assertForegroundProtocolCompatible(): Promise<void> {
  const expected = buildRuntimeManifest();
  const configDir = resolveOpenCodeConfigDir();
  const commandPath = installedFusionBuildCommandPath(configDir);
  const orchestratorPath = installedFusionOrchestratorPath(configDir);
  const manifestPath = installedRuntimeManifestPath(configDir);
  const [manifest, commandText, orchestratorText] = await Promise.all([
    loadInstalledManifest(configDir),
    readUtf8(commandPath),
    readUtf8(orchestratorPath),
  ]);

  if (!manifest) {
    throw protocolMismatchError(manifestPath, "missing or unreadable runtime manifest");
  }
  if ((manifest.foregroundProtocolVersion ?? 0) !== FUSION_FOREGROUND_PROTOCOL_VERSION) {
    throw protocolMismatchError(
      manifestPath,
      `runtime manifest foregroundProtocolVersion=${manifest.foregroundProtocolVersion ?? "missing"} expected ${FUSION_FOREGROUND_PROTOCOL_VERSION}`,
    );
  }
  if (manifest.expectedCommandTemplateVersion !== expected.expectedCommandTemplateVersion) {
    throw protocolMismatchError(
      manifestPath,
      `command template version mismatch (${manifest.expectedCommandTemplateVersion} != ${expected.expectedCommandTemplateVersion})`,
    );
  }
  if (manifest.expectedOrchestratorTemplateVersion !== expected.expectedOrchestratorTemplateVersion) {
    throw protocolMismatchError(
      manifestPath,
      `orchestrator template version mismatch (${manifest.expectedOrchestratorTemplateVersion} != ${expected.expectedOrchestratorTemplateVersion})`,
    );
  }
  if (manifest.pluginBuildId !== expected.pluginBuildId) {
    throw protocolMismatchError(manifestPath, `plugin build ID mismatch (${manifest.pluginBuildId} != ${expected.pluginBuildId})`);
  }

  if (!commandText) {
    throw protocolMismatchError(commandPath, "missing fusion-build command");
  }
  if (!commandText.includes(fusionBuildCommandTemplateMarker())) {
    throw protocolMismatchError(commandPath, "fusion-build command template marker is stale");
  }
  if (!commandText.includes(fusionForegroundProtocolMarker())) {
    throw protocolMismatchError(commandPath, "fusion-build command missing foreground protocol marker");
  }

  if (!orchestratorText) {
    throw protocolMismatchError(orchestratorPath, "missing fusion-orchestrator agent");
  }
  if (!orchestratorText.includes(fusionOrchestratorTemplateMarker())) {
    throw protocolMismatchError(orchestratorPath, "fusion-orchestrator template marker is stale");
  }
  if (!orchestratorText.includes(fusionForegroundProtocolMarker())) {
    throw protocolMismatchError(orchestratorPath, "fusion-orchestrator missing foreground protocol marker");
  }
}

/** @deprecated use assertForegroundProtocolCompatible */
export async function assertFreshBuildRuntimeCompatible(): Promise<void> {
  await assertForegroundProtocolCompatible();
}

export async function writeInstalledRuntimeManifest(
  modelConfigFingerprint?: string,
  configDir = resolveOpenCodeConfigDir(),
): Promise<string> {
  const manifestPath = installedRuntimeManifestPath(configDir);
  await mkdir(configDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(buildRuntimeManifest(modelConfigFingerprint), null, 2)}\n`, "utf8");
  return manifestPath;
}

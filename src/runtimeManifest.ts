import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const FUSION_RUNTIME_MANIFEST_VERSION = 1;
export const FUSION_PLUGIN_BUILD_ID = "fusion-council-hybrid-v2";
export const FUSION_BUILD_COMMAND_TEMPLATE_VERSION = "fusion-build-hybrid-v2";
export const FUSION_ORCHESTRATOR_TEMPLATE_VERSION = "fusion-orchestrator-hybrid-v2";
export const FUSION_RUNTIME_MANIFEST_FILENAME = "fusion-runtime-manifest.json";

export type FusionBuildStrategy = "hybrid_external_main_native_panels";

export type FusionRuntimeManifest = {
  version: number;
  pluginBuildId: string;
  defaultBuildStrategy: FusionBuildStrategy;
  supportedTools: {
    fusionSupervisorStages: Array<"launch" | "status" | "resume">;
    fusionNativeStages: Array<
      "prepare"
      | "advance"
      | "collect"
      | "record_main_baseline"
      | "finalize"
      | "audit_prepare"
      | "audit_finalize"
      | "resume"
    >;
  };
  expectedCommandTemplateVersion: string;
  expectedOrchestratorTemplateVersion: string;
};

export function buildRuntimeManifest(): FusionRuntimeManifest {
  return {
    version: FUSION_RUNTIME_MANIFEST_VERSION,
    pluginBuildId: FUSION_PLUGIN_BUILD_ID,
    defaultBuildStrategy: "hybrid_external_main_native_panels",
    supportedTools: {
      fusionSupervisorStages: ["launch", "status", "resume"],
      fusionNativeStages: [
        "prepare",
        "advance",
        "collect",
        "record_main_baseline",
        "finalize",
        "audit_prepare",
        "audit_finalize",
        "resume",
      ],
    },
    expectedCommandTemplateVersion: FUSION_BUILD_COMMAND_TEMPLATE_VERSION,
    expectedOrchestratorTemplateVersion: FUSION_ORCHESTRATOR_TEMPLATE_VERSION,
  };
}

export function fusionBuildCommandTemplateMarker(): string {
  return `FUSION_COMMAND_TEMPLATE_VERSION: ${FUSION_BUILD_COMMAND_TEMPLATE_VERSION}`;
}

export function fusionOrchestratorTemplateMarker(): string {
  return `FUSION_ORCHESTRATOR_TEMPLATE_VERSION: ${FUSION_ORCHESTRATOR_TEMPLATE_VERSION}`;
}

export function runtimeManifestText(): string {
  return `${JSON.stringify(buildRuntimeManifest(), null, 2)}\n`;
}

export function runtimeManifestPathFromModule(moduleUrl: string | URL = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  return path.join(path.dirname(modulePath), FUSION_RUNTIME_MANIFEST_FILENAME);
}

export async function loadBundledRuntimeManifest(moduleUrl: string | URL = import.meta.url): Promise<FusionRuntimeManifest> {
  const text = await readFile(runtimeManifestPathFromModule(moduleUrl), "utf8");
  return JSON.parse(text) as FusionRuntimeManifest;
}

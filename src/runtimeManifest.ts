import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const FUSION_FOREGROUND_PROTOCOL_VERSION = 6;
export const FUSION_RUNTIME_MANIFEST_VERSION = 1;
export const FUSION_PLUGIN_BUILD_ID = "fusion-council-hybrid-v6";
export const FUSION_BUILD_COMMAND_TEMPLATE_VERSION = "fusion-build-hybrid-v6";
export const FUSION_ORCHESTRATOR_TEMPLATE_VERSION = "fusion-orchestrator-hybrid-v6";
export const FUSION_RUNTIME_MANIFEST_FILENAME = "fusion-runtime-manifest.json";

/**
 * Canonical descriptor of the foreground hybrid protocol. The fingerprint of this
 * descriptor is recorded in the runtime manifest and the per-run runtime-identity
 * so a stale install that no longer supports the expected lifecycle can be
 * detected at launch.
 */
export const FUSION_CONFIRM_LAUNCH_SCHEMA = {
  tool: "fusion_supervisor",
  stage: "confirm_launch",
  foregroundProtocolVersion: FUSION_FOREGROUND_PROTOCOL_VERSION,
  panelOutcomesField: "panelOutcomes",
  panelOutcomesEntryFields: [
    "panelId",
    "agentId",
    "logicalPanelIndex",
    "status",
    "sessionId",
    "taskId",
    "taskResultSummary",
    "candidateWorkspace",
    "canonicalTaskHash",
    "receiptPath",
    "completedAt",
  ],
  resultStatuses: ["LAUNCH_CONFIRMED", "MAIN_PROCESS_UNAVAILABLE"],
  panelEvidenceOwnerStage: "collect",
  panelEvidenceStatuses: [
    "usable",
    "usable_degraded",
    "awaiting",
    "completed_no_output",
    "evidence_rejected",
  ],
} as const;

/** Deterministic fingerprint of the active foreground protocol schema. */
export function fusionPluginSchemaFingerprint(): string {
  return createHash("sha256")
    .update(JSON.stringify(FUSION_CONFIRM_LAUNCH_SCHEMA), "utf8")
    .digest("hex")
    .slice(0, 16);
}

export type FusionBuildStrategy = "hybrid_external_main_native_panels";

export type FusionRuntimeManifest = {
  version: number;
  foregroundProtocolVersion: number;
  pluginBuildId: string;
  defaultBuildStrategy: FusionBuildStrategy;
  supportedTools: {
    fusionSupervisorStages: Array<
      "launch" | "begin_native_wave" | "confirm_launch" | "collect" | "finalize" | "cancel" | "status" | "resume"
    >;
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
  /** Fingerprint of the confirm_launch/collect schema. Optional for back-compat with older installs. */
  pluginSchemaFingerprint?: string;
  /** Fingerprint of the canonical /fusion-model panel/judge configuration. */
  modelConfigFingerprint?: string;
};

export function buildRuntimeManifest(modelConfigFingerprint?: string): FusionRuntimeManifest {
  return {
    version: FUSION_RUNTIME_MANIFEST_VERSION,
    foregroundProtocolVersion: FUSION_FOREGROUND_PROTOCOL_VERSION,
    pluginBuildId: FUSION_PLUGIN_BUILD_ID,
    pluginSchemaFingerprint: fusionPluginSchemaFingerprint(),
    defaultBuildStrategy: "hybrid_external_main_native_panels",
    supportedTools: {
      fusionSupervisorStages: ["launch", "begin_native_wave", "confirm_launch", "collect", "finalize", "cancel", "status", "resume"],
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
    ...(modelConfigFingerprint ? { modelConfigFingerprint } : {}),
  };
}

export type FusionRuntimeIdentity = {
  recordedAt: string;
  foregroundProtocolVersion: number;
  pluginBuildId: string;
  pluginSchemaFingerprint: string;
  defaultBuildStrategy: FusionBuildStrategy;
  commandTemplateVersion: string;
  orchestratorTemplateVersion: string;
  agentFileVersion: string;
  supervisorStages: FusionRuntimeManifest["supportedTools"]["fusionSupervisorStages"];
  confirmLaunchSchema: {
    panelOutcomesSupported: boolean;
    fields: string[];
    resultStatuses: string[];
    panelEvidenceOwnerStage: string;
  };
  invokingSessionModelId?: string;
  requestedMainModelId?: string;
  panelConfigModels?: string[];
  judgeConfigModel?: string;
  canonicalConfigFingerprint?: string;
  installedAgentFingerprint?: string;
  installedAgentModels?: {
    panelModels: string[];
    judgeModel: string;
  };
};

export type RuntimeIdentityLaunchSnapshot = {
  invokingSessionModelId?: string;
  requestedMainModelId?: string;
  panelConfigModels?: string[];
  judgeConfigModel?: string;
  canonicalConfigFingerprint?: string;
  installedAgentFingerprint?: string;
  installedAgentModels?: {
    panelModels: string[];
    judgeModel: string;
  };
};

/** Snapshot of the active runtime identity, written to <runDir>/runtime-identity.json at launch. */
export function buildRuntimeIdentity(
  now: () => number = Date.now,
  launch?: RuntimeIdentityLaunchSnapshot,
): FusionRuntimeIdentity {
  return {
    recordedAt: new Date(now()).toISOString(),
    foregroundProtocolVersion: FUSION_FOREGROUND_PROTOCOL_VERSION,
    pluginBuildId: FUSION_PLUGIN_BUILD_ID,
    pluginSchemaFingerprint: fusionPluginSchemaFingerprint(),
    defaultBuildStrategy: "hybrid_external_main_native_panels",
    commandTemplateVersion: FUSION_BUILD_COMMAND_TEMPLATE_VERSION,
    orchestratorTemplateVersion: FUSION_ORCHESTRATOR_TEMPLATE_VERSION,
    agentFileVersion: FUSION_ORCHESTRATOR_TEMPLATE_VERSION,
    supervisorStages: buildRuntimeManifest().supportedTools.fusionSupervisorStages,
    confirmLaunchSchema: {
      panelOutcomesSupported: true,
      fields: [...FUSION_CONFIRM_LAUNCH_SCHEMA.panelOutcomesEntryFields],
      resultStatuses: [...FUSION_CONFIRM_LAUNCH_SCHEMA.resultStatuses],
      panelEvidenceOwnerStage: FUSION_CONFIRM_LAUNCH_SCHEMA.panelEvidenceOwnerStage,
    },
    invokingSessionModelId: launch?.invokingSessionModelId,
    requestedMainModelId: launch?.requestedMainModelId,
    panelConfigModels: launch?.panelConfigModels,
    judgeConfigModel: launch?.judgeConfigModel,
    canonicalConfigFingerprint: launch?.canonicalConfigFingerprint,
    installedAgentFingerprint: launch?.installedAgentFingerprint,
    installedAgentModels: launch?.installedAgentModels,
  };
}

export function fusionBuildCommandTemplateMarker(): string {
  return `FUSION_COMMAND_TEMPLATE_VERSION: ${FUSION_BUILD_COMMAND_TEMPLATE_VERSION}`;
}

export function fusionForegroundProtocolMarker(): string {
  return `FUSION_FOREGROUND_PROTOCOL_VERSION: ${FUSION_FOREGROUND_PROTOCOL_VERSION}`;
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

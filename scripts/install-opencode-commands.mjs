#!/usr/bin/env node
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FUSION_RUNTIME_MANIFEST_VERSION = 1;
const FUSION_PLUGIN_BUILD_ID = "fusion-council-hybrid-v2";
const FUSION_BUILD_COMMAND_TEMPLATE_VERSION = "fusion-build-hybrid-v2";
const FUSION_ORCHESTRATOR_TEMPLATE_VERSION = "fusion-orchestrator-hybrid-v2";
const FUSION_RUNTIME_MANIFEST_FILENAME = "fusion-runtime-manifest.json";

function buildRuntimeManifest() {
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

/**
 * Cross-platform installer for OpenCode Fusion Council slash-command files.
 *
 * Copies the supported command markdown files from examples/commands/ into the
 * user's OpenCode commands directory (~/.config/opencode/commands on all
 * platforms). Node's os.homedir() resolves correctly on macOS, Linux, and
 * Windows.
 */

const SUPPORTED_COMMANDS = [
  "fusion-build.md",
  "fusion-decision.md",
  "fusion-model.md",
  "fusion-no-build.md",
  "fusion-plan.md",
  "fusion-prompt.md",
  "fusion-review.md",
  "fusion-resume.md",
  "fusion-trace.md",
];

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = join(scriptPath, "..", "..");
const sourceDir = join(projectRoot, "examples", "commands");
const commandsDir = join(homedir(), ".config", "opencode", "commands");

async function main() {
  // Verify source files exist before touching the destination.
  const availableSources = new Set(await readdir(sourceDir));
  const missing = SUPPORTED_COMMANDS.filter((name) => !availableSources.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Missing expected command source files in ${sourceDir}:\n  - ${missing.join("\n  - ")}`,
    );
  }

  await mkdir(commandsDir, { recursive: true });

  for (const fileName of SUPPORTED_COMMANDS) {
    const sourcePath = join(sourceDir, fileName);
    const destPath = join(commandsDir, fileName);
    await copyFile(sourcePath, destPath);
    console.log(`Installed ${destPath}`);
  }

  const manifestPath = join(commandsDir, "..", FUSION_RUNTIME_MANIFEST_FILENAME);
  await writeFile(manifestPath, `${JSON.stringify(buildRuntimeManifest(), null, 2)}\n`, "utf8");
  console.log(`Installed ${manifestPath}`);

  console.log(`\nAll ${SUPPORTED_COMMANDS.length} Fusion Council commands installed to:`);
  console.log(commandsDir);
  console.log("\nRestart OpenCode or reload your workspace for the commands to appear.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

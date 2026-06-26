#!/usr/bin/env node
/**
 * Cross-platform installer for OpenCode Fusion Council slash-command files AND
 * native subagent agent files.
 *
 * - Copies supported command markdown files from examples/commands/ into
 *   ~/.config/opencode/commands/ on macOS, Linux, and Windows.
 * - Generates the fusion-orchestrator primary agent and the default
 *   fusion-panel-1/2/3 and fusion-judge subagent agent files into
 *   ~/.config/opencode/agent/ via the compiled agent templates (no duplicated
 *   prompt text, so installed agents never drift from src/native/agentTemplates.ts).
 * - Writes the fusion-runtime-manifest.json via the compiled runtime manifest.
 *
 * Node's os.homedir() resolves correctly on macOS, Linux, and Windows.
 * Unrelated user agent/command files are never touched.
 *
 * Run `npm run build` before this script so dist/ is current.
 */

import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FUSION_RUNTIME_MANIFEST_FILENAME = "fusion-runtime-manifest.json";

export const SUPPORTED_COMMANDS = [
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
const projectRoot = join(dirname(scriptPath), "..");
const sourceCommandsDir = join(projectRoot, "examples", "commands");
const opencodeDir = join(homedir(), ".config", "opencode");
const commandsDir = join(opencodeDir, "commands");
const agentDir = join(opencodeDir, "agent");

async function loadDistModules() {
  const agentSyncPath = join(projectRoot, "dist", "native", "agentSync.js");
  const runtimeManifestPath = join(projectRoot, "dist", "runtimeManifest.js");
  let agentSyncModule;
  let runtimeManifestModule;
  try {
    agentSyncModule = await import(agentSyncPath);
  } catch (error) {
    throw new Error(
      `Cannot load compiled agent module from ${agentSyncPath}. Run \`npm run build\` first.\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    runtimeManifestModule = await import(runtimeManifestPath);
  } catch (error) {
    throw new Error(
      `Cannot load compiled runtime manifest from ${runtimeManifestPath}. Run \`npm run build\` first.\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { agentSyncModule, runtimeManifestModule };
}

async function main() {
  const availableCommands = new Set(await readdir(sourceCommandsDir));
  const missingCommands = SUPPORTED_COMMANDS.filter((name) => !availableCommands.has(name));
  if (missingCommands.length > 0) {
    throw new Error(
      `Missing expected command source files in ${sourceCommandsDir}:\n  - ${missingCommands.join("\n  - ")}`,
    );
  }

  const { agentSyncModule, runtimeManifestModule } = await loadDistModules();
  if (typeof agentSyncModule.syncDefaultNativeAgents !== "function") {
    throw new Error("dist/native/agentSync.js does not export syncDefaultNativeAgents. Run `npm run build`.");
  }
  if (typeof runtimeManifestModule.buildRuntimeManifest !== "function") {
    throw new Error("dist/runtimeManifest.js does not export buildRuntimeManifest. Run `npm run build`.");
  }

  await mkdir(commandsDir, { recursive: true });
  const installed = [];

  for (const fileName of SUPPORTED_COMMANDS) {
    const dest = join(commandsDir, fileName);
    await copyFile(join(sourceCommandsDir, fileName), dest);
    installed.push(dest);
  }

  const sync = await agentSyncModule.syncDefaultNativeAgents(agentDir);
  // sync.wrote entries already include the .md extension (e.g. "fusion-judge.md").
  installed.push(...sync.wrote.map((name) => join(agentDir, name)));

  const manifestPath = join(opencodeDir, FUSION_RUNTIME_MANIFEST_FILENAME);
  await writeFile(manifestPath, `${JSON.stringify(runtimeManifestModule.buildRuntimeManifest(), null, 2)}\n`, "utf8");
  installed.push(manifestPath);

  console.log("Installed Fusion commands into:", commandsDir);
  console.log("Installed Fusion agents into:", agentDir);
  console.log("\nFiles:");
  for (const file of installed) console.log(`  ${file}`);

  console.log("\nDefault panel models:");
  sync.panelAgents.forEach((panel) => console.log(`  fusion-panel-${panel.panelIndex} -> ${panel.modelId}`));
  console.log(`  fusion-judge -> ${sync.judgeAgent.modelId}`);
  console.log("\nRestart OpenCode so the new agent definitions and commands take effect.");
  console.log("Run `/fusion-model set ...` to change panel/judge models and regenerate agent files.");
}

const isMain = (() => {
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

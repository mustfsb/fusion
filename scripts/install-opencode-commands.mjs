#!/usr/bin/env node
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

  console.log(`\nAll ${SUPPORTED_COMMANDS.length} Fusion Council commands installed to:`);
  console.log(commandsDir);
  console.log("\nRestart OpenCode or reload your workspace for the commands to appear.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

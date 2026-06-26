/**
 * Detached supervisor entrypoint.
 *
 * The plugin/bootstrap spawns this file as a detached, independent Node process:
 *
 *   node dist/native/supervisorMain.js \
 *     --run-id <runId> \
 *     --run-dir <absolute run artifact dir> \
 *     --source-workspace <absolute user workspace> \
 *     --working-directory <absolute existing directory>
 *
 * `process.argv[1]` is always the script path and must never be treated as a
 * workspace directory. Configuration may also arrive via env for backward
 * compatibility, but CLI args take precedence.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { superviseRun } from "./fusionSupervisor.js";
import {
  confirmSupervisorReady,
  parseSupervisorMainArgs,
  supervisorMainEntry,
  SupervisorStartupError,
  type SupervisorLaunchPaths,
} from "./supervisorStartup.js";

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(path.resolve(entry)));
  } catch {
    return false;
  }
}

export async function runSupervisorMain(argv = process.argv.slice(2)): Promise<number> {
  let launch: SupervisorLaunchPaths;
  try {
    const parsed = parseSupervisorMainArgs(argv);
    launch = {
      ...parsed,
      entrypointPath: supervisorMainEntry(),
    };
    await confirmSupervisorReady(launch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Fusion supervisor startup failed: ${message}\n`);
    return error instanceof SupervisorStartupError ? 2 : 1;
  }

  try {
    const state = await superviseRun(launch.runId, {
      cwd: launch.workingDirectory,
      traceDir: launch.traceDir,
      pollIntervalMs: process.env.FUSION_SUPERVISOR_POLL_MS
        ? Number.parseInt(process.env.FUSION_SUPERVISOR_POLL_MS, 10)
        : undefined,
    });
    process.stdout.write(`Fusion supervisor finished run ${launch.runId} in phase ${state.phase}.\n`);
    return state.phase === "aborted" ? 1 : 0;
  } catch (error) {
    process.stderr.write(`Fusion supervisor crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isDirectExecution()) {
  runSupervisorMain().then((code) => {
    process.exitCode = code;
  });
}

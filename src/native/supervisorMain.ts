/**
 * Detached supervisor entrypoint.
 *
 * The plugin/bootstrap spawns this file as a detached, independent Node process
 * (`node dist/native/supervisorMain.js`). It owns the run lifecycle after
 * bootstrap and is fully decoupled from the parent OpenCode/orchestrator
 * session: closing the chat, reloading the plugin, or restarting the UI does not
 * stop it. Configuration arrives via env so no parent IPC channel is required.
 *
 *   FUSION_SUPERVISOR_RUN_ID   required run id
 *   FUSION_SUPERVISOR_CWD      project directory (defaults to process.cwd())
 *   FUSION_SUPERVISOR_TRACE_DIR  optional trace root override
 *   FUSION_SUPERVISOR_POLL_MS   optional liveness poll interval
 */
import { superviseRun } from "./fusionSupervisor.js";

export async function runSupervisorMain(argv = process.argv.slice(2)): Promise<number> {
  const runId = process.env.FUSION_SUPERVISOR_RUN_ID ?? argv[0];
  if (!runId) {
    process.stderr.write("FUSION_SUPERVISOR_RUN_ID is required.\n");
    return 2;
  }
  const cwd = process.env.FUSION_SUPERVISOR_CWD ?? process.cwd();
  const traceDir = process.env.FUSION_SUPERVISOR_TRACE_DIR || undefined;
  const pollIntervalMs = process.env.FUSION_SUPERVISOR_POLL_MS
    ? Number.parseInt(process.env.FUSION_SUPERVISOR_POLL_MS, 10)
    : undefined;
  try {
    const state = await superviseRun(runId, { cwd, traceDir, pollIntervalMs });
    process.stdout.write(`Fusion supervisor finished run ${runId} in phase ${state.phase}.\n`);
    return state.phase === "aborted" ? 1 : 0;
  } catch (error) {
    process.stderr.write(`Fusion supervisor crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// Execute when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  runSupervisorMain().then((code) => {
    process.exitCode = code;
  });
}

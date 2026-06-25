import { WORKER_ID, type SupervisorState, type WorkerRecord } from "./supervisorTypes.js";

/**
 * Render the human-readable supervisor trace. It reports real process evidence
 * (PIDs, workspaces, model ids, spawn/first-activity/end times), true overlap,
 * judge/patch lifecycle, and an explicit concurrency verdict.
 */
export function renderSupervisorTrace(state: SupervisorState): string {
  const lines: string[] = [];
  lines.push(`# Fusion Supervisor Trace — ${state.runId}`);
  lines.push("");
  lines.push(`- strategy: ${state.strategy}`);
  lines.push(`- command: ${state.command}`);
  lines.push(`- phase: ${state.phase}`);
  lines.push(`- source workspace: ${state.sourceWorkspace} (lock state: ${state.runLock ? `held by pid ${state.runLock.pid}` : "unlocked"})`);
  lines.push("");

  lines.push("## Bootstrap");
  lines.push(`- immutable source snapshot: ${state.snapshot.startedAt} → ${state.snapshot.completedAt ?? "?"} (${state.snapshot.durationMs ?? "?"}ms)`);
  lines.push(`- panel workspace materialization: ${state.snapshot.materializationDurationMs ?? "?"}ms`);
  lines.push(`- canonical task hash: ${state.taskArtifactHash.slice(0, 16)}…`);
  if (state.conflicts.length) {
    lines.push(`- SOURCE CONFLICTS: ${state.conflicts.map((c) => c.detail).join("; ")}`);
  }
  lines.push("");

  lines.push("## Workers");
  for (const worker of orderedWorkers(state)) {
    lines.push(renderWorkerLine(worker));
  }
  lines.push("");

  lines.push("## Concurrency");
  lines.push(`- panels overlapping main: ${state.concurrency.panelsOverlappingMain}`);
  lines.push(`- max overlap duration: ${state.concurrency.overlapDurationMs}ms`);
  lines.push(`- **${state.concurrency.verdict}**`);
  if (state.concurrency.blockingReason) {
    lines.push(`- blocking reason: ${state.concurrency.blockingReason}`);
  }
  lines.push("");

  lines.push("## Candidate Validation");
  for (let index = 1; index <= 3; index += 1) {
    const worker = state.workers[WORKER_ID.panel(index)];
    const c = worker?.candidate;
    lines.push(
      `- panel ${index}: ${c?.classification ?? "pending"} ` +
        `(workspaceSafe=${c?.workspaceSafe ?? "?"}, taskHash=${c?.taskHashMatches ?? "?"}, ` +
        `changes=${c?.meaningfulChangedFiles ?? 0}, verify=${c?.verificationPassing ?? "?"}, ` +
        `terminalResult=${c?.hasTerminalResult ?? "?"})`,
    );
  }
  lines.push("");

  lines.push("## Judge");
  lines.push(`- eligible at: ${state.judge.eligibleAt ?? "—"}`);
  lines.push(`- dispatched at: ${state.judge.dispatchedAt ?? "—"}`);
  lines.push(`- completed at: ${state.judge.completedAt ?? "—"}`);
  lines.push(`- usable panels: [${(state.judge.usablePanelIndexes ?? []).join(", ")}], late/excluded: [${(state.judge.excludedPanelIndexes ?? []).join(", ")}]`);
  lines.push(`- decision: ${state.judge.decision ?? "—"}`);
  lines.push("");

  lines.push("## Patch Worker");
  lines.push(`- required: ${state.patch.required}`);
  lines.push(`- dispatched at: ${state.patch.dispatchedAt ?? "—"}`);
  lines.push(`- status: ${state.patch.status ?? "—"}`);
  lines.push("");

  lines.push("## Final Audit");
  if (state.finalVerification) {
    lines.push(`- typecheck: ${state.finalVerification.typecheck ?? "?"}, test: ${state.finalVerification.test ?? "?"}, build: ${state.finalVerification.build ?? "?"}`);
  } else {
    lines.push("- not recorded");
  }
  if (state.abortReason) {
    lines.push("");
    lines.push(`## Abort Reason\n- ${state.abortReason}`);
  }
  return lines.join("\n");
}

function orderedWorkers(state: SupervisorState): WorkerRecord[] {
  const order = [
    WORKER_ID.main,
    WORKER_ID.panel(1),
    WORKER_ID.panel(2),
    WORKER_ID.panel(3),
    WORKER_ID.judge,
    WORKER_ID.patch,
  ];
  return order.map((id) => state.workers[id]).filter((w): w is WorkerRecord => Boolean(w));
}

function renderWorkerLine(worker: WorkerRecord): string {
  return [
    `- ${worker.workerId} [${worker.status}]`,
    `model=${worker.modelId}`,
    `pid=${worker.pid ?? "—"}`,
    `ws=${worker.workspacePath}`,
    `spawn=${worker.spawnedAt ?? "—"}`,
    `firstActivity=${worker.firstActivityAt ?? "—"}`,
    `end=${worker.endedAt ?? "—"}`,
    `exit=${worker.exitCode ?? "—"}`,
    worker.timedOutReason ? `timeout=${worker.timedOutReason}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

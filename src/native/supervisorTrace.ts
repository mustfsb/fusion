import {
  WORKER_ID,
  type ExternalMainWorkerTrace,
  type NativePanelEvidenceAcceptance,
  type NativePanelRuntimeEvidence,
  type SupervisorState,
  type WorkerRecord,
} from "./supervisorTypes.js";

/** Derive accept/reject/await when an older trace lacks the persisted verdict. */
function deriveAcceptance(ev: NativePanelRuntimeEvidence): NativePanelEvidenceAcceptance {
  if (ev.contractMismatchErrors?.length) return "rejected";
  if (ev.receiptValidity === "invalid") return "rejected";
  if (
    ev.reconciledStatus === "completed_with_session" ||
    ev.reconciledStatus === "completed_with_receipt" ||
    ev.reconciledStatus === "completed_with_task"
  ) {
    return "accepted";
  }
  return "awaiting";
}

/**
 * Render the human-readable supervisor trace for the hybrid
 * `hybrid_external_main_native_panels` `/fusion-build` pipeline.
 *
 * The trace must clearly separate the ONE external main builder from the
 * THREE native visible panel subagents and the native judge, and surface an
 * evidence-based `HYBRID_PARALLEL_LAUNCH_CONFIRMED` verdict.
 */
export function renderSupervisorTrace(state: SupervisorState): string {
  const lines: string[] = [];
  lines.push(`# Fusion Supervisor Trace — ${state.runId}`);
  lines.push("");
  lines.push(`Build strategy: ${state.strategy}`);
  lines.push(`- command: ${state.command}`);
  lines.push(`- phase: ${state.phase}`);
  lines.push(`- source workspace: ${state.sourceWorkspace}`);
  lines.push("");

  // ---- Main builder ----
  const main = state.externalMain ?? toExternalMainTrace(state.workers[WORKER_ID.main]);
  lines.push("Main builder:");
  lines.push(`- execution: external_opencode_cli`);
  lines.push(`- invoking session model: ${main?.invokingSessionModelId ?? state.invokingSessionModelId ?? "—"}`);
  lines.push(`- requested model: ${main?.requestedModelId ?? "—"}`);
  lines.push(`- observed model: ${main?.observedModelId ?? "—"}`);
  lines.push(`- candidate workspace: ${main?.workspace ?? "—"}`);
  lines.push(`- local canonical task path: ${main?.localCanonicalTaskPath ?? "—"}`);
  lines.push(`- workspace contract validated: ${main?.workspaceContractValidated ? "yes" : "no"}`);
  lines.push(`- PID: ${main?.pid ?? "—"}`);
  lines.push(`- status: ${main?.status ?? "—"}`);
  lines.push(`- promotion: ${state.mainPromotion.status ?? "pending"}`);
  lines.push(`- failure reason: ${main?.failureReason ?? state.mainPromotion.detail ?? state.abortReason ?? "—"}`);
  lines.push(`- logs: ${main ? `${main.stdoutPath} / ${main.stderrPath}` : "—"}`);
  lines.push("");

  // ---- Panels ----
  const nativePanels = state.nativePanels ?? buildNativePanelTrace(state);
  for (let index = 1; index <= 3; index += 1) {
    const panel = nativePanels.find((p) => p.panelNumber === index);
    lines.push(`Panel ${index}:`);
    lines.push(`- execution: native_visible_subagent`);
    lines.push(`- native session ID: ${panel?.sessionId ?? "—"}`);
    lines.push(`- agent ID: ${panel?.agentId ?? "—"}`);
    lines.push(`- configured model: ${panel?.configuredModelId ?? "—"}`);
    lines.push(`- candidate workspace: ${panel?.candidateWorkspace ?? "—"}`);
    lines.push(`- dispatch time: ${panel?.dispatchedAt ?? "—"}`);
    lines.push(`- terminal time: ${panel?.terminalAt ?? "—"}`);
    lines.push(`- status: ${panel?.status ?? "—"}`);
    lines.push(`- result artifact: ${panel?.resultArtifactPath ?? "—"}`);
    const ev = panel?.runtimeEvidence;
    if (ev) {
      lines.push("Native panel evidence:");
      lines.push(`- agent ID: ${ev.agentId}`);
      lines.push(`- Native task returned: ${ev.taskCompletionEvidence ? "yes" : "no"}`);
      lines.push(`- Native session ID: ${ev.nativeSessionIdAvailable ? "available" : "unavailable"}`);
      lines.push(`- native session ID: ${ev.nativeSessionIdAvailable ? ev.sessionId ?? "available" : "unavailable"}`);
      lines.push(`- Task ID: ${ev.taskId ? "available" : "unavailable"}`);
      lines.push(`- Task result summary: ${ev.taskCompletionSummary ? "available" : "unavailable"}`);
      lines.push(`- Task completion evidence: ${ev.taskCompletionEvidence ? "yes" : "no"}`);
      lines.push(`- receipt artifact: ${ev.receiptArtifactPath ?? "—"}`);
      lines.push(`- Receipt: ${ev.receiptValidity}`);
      lines.push(`- receipt validity: ${ev.receiptValidity}`);
      lines.push(`- Candidate mutation: ${ev.candidateMutationEvidence ? "yes" : "no"}`);
      lines.push(`- candidate mutation evidence: ${ev.candidateMutationEvidence ? "yes" : "no"}`);
      lines.push(`- Reconciled runtime evidence: ${ev.acceptance ?? deriveAcceptance(ev)}`);
      lines.push(`- reconciled status: ${ev.reconciledStatus}`);
      if (ev.contractMismatchErrors?.length) {
        lines.push(`- contract mismatch: ${ev.contractMismatchErrors.join("; ")}`);
      }
      if (ev.receiptValidationErrors?.length) {
        lines.push(`- receipt errors: ${ev.receiptValidationErrors.join("; ")}`);
      }
    } else {
      lines.push("Native panel evidence:");
      lines.push(`- Native task returned: no`);
      lines.push(`- Native session ID: unavailable`);
      lines.push(`- Task ID: unavailable`);
      lines.push(`- Task result summary: unavailable`);
      lines.push(`- Receipt: missing`);
      lines.push(`- Candidate mutation: no`);
      lines.push(`- Reconciled runtime evidence: awaiting`);
    }
    // Plugin-owned auto-harvest summary, required by /fusion-trace per panel.
    const panelWorker = state.workers[WORKER_ID.panel(index)];
    lines.push("Auto-harvest:");
    lines.push(`- Native Task returned: ${ev?.taskCompletionEvidence ? "yes" : "no"}`);
    lines.push(`- Parent outcome received: ${ev?.parentOutcomeProvided ? "yes" : "no"}`);
    lines.push(`- Native session ID: ${ev?.nativeSessionIdAvailable ? ev.sessionId ?? "available" : "unavailable"}`);
    lines.push(`- Task ID: ${ev?.taskId ?? "unavailable"}`);
    lines.push(`- Panel receipt: ${ev?.receiptValidity ?? "missing"}`);
    lines.push(`- Candidate mutation: ${ev?.candidateMutationEvidence ? "yes" : "no"}`);
    lines.push(`- Auto-harvest report: panel-evidence/panel-${index}.json`);
    lines.push(`- Reconciled evidence status: ${ev?.reconciledStatus ?? "awaiting_native_completion"}`);
    lines.push(`- Classification: ${panelWorker?.candidate?.classification ?? "pending"}`);
    lines.push("");
  }

  // ---- Judge ----
  const nativeJudge = state.nativeJudge ?? toNativeJudgeTrace(state.workers[WORKER_ID.judge], state.judge.contractPath);
  lines.push("Judge:");
  lines.push(`- execution: native_visible_subagent`);
  lines.push(`- native session ID: ${nativeJudge?.sessionId ?? "—"}`);
  lines.push(`- agent ID: ${nativeJudge?.agentId ?? "—"}`);
  lines.push(`- configured model: ${nativeJudge?.configuredModelId ?? "—"}`);
  lines.push(`- dispatch time: ${nativeJudge?.dispatchedAt ?? "—"}`);
  lines.push(`- status: ${nativeJudge?.status ?? "—"}`);
  lines.push(`- merge patch contract: ${nativeJudge?.mergePatchContractPath ?? "—"}`);
  lines.push(`- applied patch summary: ${nativeJudge?.appliedPatchSummary ?? "—"}`);
  lines.push("");

  // ---- Promotion ----
  lines.push("Promotion:");
  lines.push(`- candidate workspace: ${state.mainPromotion.candidateWorkspace ?? "—"}`);
  lines.push(`- promoted at: ${state.mainPromotion.promotedAt ?? "—"}`);
  lines.push(`- status: ${state.mainPromotion.status ?? "—"}`);
  lines.push(`- source untouched before promotion: ${state.mainPromotion.sourceUntouchedBeforePromotion ?? "?"}`);
  lines.push(`- promoted paths: ${(state.mainPromotion.promotedPaths ?? []).length}`);
  lines.push(`- preserved paths: ${(state.mainPromotion.preservedPaths ?? []).length}`);
  lines.push("");

  // ---- Contract ----
  lines.push("Contract:");
  lines.push(`- judge eligible at: ${state.judge.eligibleAt ?? "—"}`);
  lines.push(`- usable panels: [${(state.judge.usablePanelIndexes ?? []).join(", ")}], excluded: [${(state.judge.excludedPanelIndexes ?? []).join(", ")}]`);
  lines.push(`- decision: ${state.judge.decision ?? "—"}`);
  lines.push(`- contract path: ${state.judge.contractPath ?? "—"}`);
  lines.push(`- applied patch items: ${(state.judge.appliedPatchItems ?? []).length}`);
  lines.push("");

  // ---- Launch verdict ----
  lines.push("Launch verdict:");
  lines.push(`- panels launched: ${state.concurrency.panelsLaunched}`);
  lines.push(`- all launch timestamps recorded: ${state.concurrency.allLaunchTimestampsRecorded ? "yes" : "no"}`);
  lines.push(`- parallel panel dispatch issued: ${state.concurrency.parallelPanelDispatchIssued ? "yes" : "no"}`);
  lines.push(`- no panel via external CLI: ${state.concurrency.noPanelViaExternalCli ? "yes" : "no"}`);
  lines.push(`- main model matched: ${state.concurrency.mainModelMatched ? "yes" : "no"}`);
  lines.push(`- main launch at: ${state.concurrency.mainLaunchAt ?? "—"}`);
  lines.push(`- panel launch at: ${formatPanelLaunchAt(state.concurrency.panelLaunchAt)}`);
  lines.push(`- **${state.concurrency.verdict}**`);
  if (state.concurrency.blockingReason) {
    lines.push(`- blocking reason: ${state.concurrency.blockingReason}`);
  }
  lines.push("");

  // ---- Native panel outcomes reconciliation (confirm_launch) ----
  const wave = state.nativeWave;
  lines.push("Native panel outcomes reconciliation:");
  const received = wave?.confirmPanelOutcomesReceived;
  lines.push(
    `- confirm_launch received panelOutcomes batch: ${
      received === undefined ? "not yet" : received > 0 ? `yes (${received} entries)` : "no (empty batch)"
    }`,
  );
  lines.push(
    `- parent wave returned: ${wave?.parentWaveReturned ? `yes (${wave.waveReturnedAt ?? "timestamp pending"})` : "no"}`,
  );
  lines.push("");

  if (state.finalVerification) {
    lines.push("Final verification:");
    lines.push(`- typecheck: ${state.finalVerification.typecheck ?? "?"}, test: ${state.finalVerification.test ?? "?"}, build: ${state.finalVerification.build ?? "?"}`);
    lines.push("");
  }

  if (state.conflicts.length) {
    lines.push("Source conflicts:");
    for (const c of state.conflicts) lines.push(`- ${c.detail}`);
    lines.push("");
  }

  if (state.abortReason) {
    lines.push(`Abort reason: ${state.abortReason}`);
  }
  return lines.join("\n");
}

function formatPanelLaunchAt(panelLaunchAt?: Partial<Record<1 | 2 | 3, string>>): string {
  if (!panelLaunchAt) return "—";
  const parts: string[] = [];
  for (const key of [1, 2, 3] as const) {
    const value = panelLaunchAt[key];
    parts.push(`panel ${key}=${value ?? "—"}`);
  }
  return parts.join(", ");
}

function toExternalMainTrace(worker?: WorkerRecord): ExternalMainWorkerTrace | undefined {
  if (!worker) return undefined;
  return {
    pid: worker.pid,
    requestedModelId: worker.requestedModelId,
    configuredModelId: worker.configuredModelId,
    observedProviderId: worker.observedProviderId,
    observedModelId: worker.observedModelId,
    workspace: worker.workspacePath,
    localCanonicalTaskPath: worker.taskArtifactPath,
    workspaceContractValidated: worker.workspaceContractValidated,
    status: worker.status,
    stdoutPath: worker.stdoutPath,
    stderrPath: worker.stderrPath,
    launchRequestedAt: worker.launchRequestedAt,
    spawnedAt: worker.spawnedAt,
    endedAt: worker.endedAt,
    failureReason: worker.statusTransitions.at(-1)?.reason,
  };
}

function buildNativePanelTrace(state: SupervisorState) {
  return [1, 2, 3].map((index) => {
    const worker = state.workers[WORKER_ID.panel(index)];
    return {
      panelNumber: index as 1 | 2 | 3,
      sessionId: worker?.sessionId,
      agentId: worker?.agentId ?? WORKER_ID.panel(index),
      configuredModelId: worker?.configuredModelId ?? worker?.modelId ?? "—",
      candidateWorkspace: worker?.workspacePath ?? "—",
      dispatchRequestedAt: worker?.dispatchRequestedAt,
      dispatchedAt: worker?.dispatchedAt,
      terminalAt: worker?.terminalAt ?? worker?.endedAt,
      status: worker?.status ?? "queued",
      resultArtifactPath: worker?.resultArtifactPath ?? "—",
      runtimeEvidence: worker?.runtimeEvidence,
    };
  });
}

function toNativeJudgeTrace(worker?: WorkerRecord, contractPath?: string) {
  if (!worker) return undefined;
  return {
    sessionId: worker.sessionId,
    agentId: worker.agentId ?? WORKER_ID.judge,
    configuredModelId: worker.configuredModelId ?? worker.modelId,
    dispatchRequestedAt: worker.dispatchRequestedAt,
    dispatchedAt: worker.dispatchedAt,
    terminalAt: worker.terminalAt ?? worker.endedAt,
    status: worker.status,
    mergePatchContractPath: contractPath ?? worker.result?.contractPath,
    appliedPatchSummary: undefined,
  };
}

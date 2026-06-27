import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { diffAgainstBaseline, loadBaselineManifest } from "./candidateWorkspace.js";
import { panelReceiptPaths, readPanelReceipt, validatePanelReceipt } from "./panelReceipt.js";
import { supervisorRunDir } from "./supervisorState.js";
import {
  WORKER_ID,
  type SupervisorState,
  type WorkerRecord,
} from "./supervisorTypes.js";

const PANEL_COUNT = 3;

/**
 * Path roots/files that are NEVER meaningful source mutation. A receipt, a panel
 * output artifact, a run-artifact directory, generated output, logs, or a temp
 * file must never be counted as a candidate workspace source change. This is the
 * mutation rule the supervisor uses to decide a panel "visibly did real work" —
 * a receipt file by itself can never satisfy it.
 */
const NON_MEANINGFUL_PREFIXES = [
  ".git/",
  ".fusion-panel-output/",
  ".fusion-worker/",
  ".opencode/",
  "node_modules/",
  "logs/",
  "dist/",
  "build/",
  "coverage/",
  "out/",
  ".cache/",
  ".turbo/",
  ".next/",
];

const NON_MEANINGFUL_EXACT = new Set([
  ".fusion-panel-output",
  ".fusion-worker",
  "logs",
  ".DS_Store",
]);

/** True only for a real source/test/config file change (never receipts/artifacts/logs/temp). */
export function isMeaningfulSourceRelPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return false;
  if (NON_MEANINGFUL_EXACT.has(normalized)) return false;
  if (NON_MEANINGFUL_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    return false;
  }
  const base = normalized.split("/").pop() ?? normalized;
  if (base === ".DS_Store") return false;
  if (base.endsWith(".tmp") || base.endsWith(".swp") || base.endsWith("~")) return false;
  return true;
}

export type PanelBaselineComparison = {
  meaningfulSourceMutation: boolean;
  created: string[];
  modified: string[];
  deleted: string[];
  renamed: string[];
};

export type PanelEvidenceReconciledStatus =
  | "usable"
  | "usable_degraded"
  | "awaiting"
  | "completed_no_output"
  | "evidence_rejected"
  | "failed";

/** Plugin-owned evidence report written for each panel, independent of parent transport. */
export type PanelEvidenceReport = {
  runId: string;
  panelId: string;
  candidateWorkspace: string;
  workspaceIdentityValid: boolean;
  canonicalTaskHash: string;
  baselineComparison: PanelBaselineComparison;
  nativeEvidence: {
    sessionId: string | null;
    taskId: string | null;
    taskResultSummaryPresent: boolean;
    parentOutcomeReceived: boolean;
  };
  panelReceipt: {
    path: string | null;
    status: "valid" | "invalid" | "missing";
  };
  reconciledStatus: PanelEvidenceReconciledStatus;
  acceptedEvidence: string[];
  rejectedEvidence: string[];
  harvestedAt: string;
};

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function panelBaselineManifestPath(state: SupervisorState, logicalPanelIndex: number): string {
  return path.join(state.stagingDir, `panel-${logicalPanelIndex}-manifest.json`);
}

/**
 * Compute the snapshot-relative comparison for one panel's REGISTERED candidate
 * workspace, counting only meaningful source/test/config changes. The baseline is
 * the panel's own immutable post-materialization manifest (snapshot-relative).
 */
export async function computePanelBaselineComparison(
  state: SupervisorState,
  worker: WorkerRecord,
): Promise<PanelBaselineComparison> {
  const baselinePath = panelBaselineManifestPath(state, worker.logicalPanelIndex as number);
  const baseline = await loadBaselineManifest(baselinePath);
  if (!baseline) {
    return { meaningfulSourceMutation: false, created: [], modified: [], deleted: [], renamed: [] };
  }
  const diff = await diffAgainstBaseline(worker.workspacePath, baseline);
  const created = diff.addedFiles.filter(isMeaningfulSourceRelPath).sort();
  const modified = diff.changedFiles.filter(isMeaningfulSourceRelPath).sort();
  const deleted = diff.removedFiles.filter(isMeaningfulSourceRelPath).sort();
  return {
    meaningfulSourceMutation: created.length + modified.length + deleted.length > 0,
    created,
    modified,
    deleted,
    renamed: [],
  };
}

/** Meaningful (receipt-excluding) candidate mutation predicate used during reconciliation. */
export async function detectMeaningfulPanelCandidateMutation(
  state: SupervisorState,
  worker: WorkerRecord,
): Promise<boolean> {
  const comparison = await computePanelBaselineComparison(state, worker);
  return comparison.meaningfulSourceMutation;
}

function deriveReportStatus(
  state: SupervisorState,
  worker: WorkerRecord,
  comparison: PanelBaselineComparison,
  receiptStatus: "valid" | "invalid" | "missing",
): { reconciledStatus: PanelEvidenceReconciledStatus; accepted: string[]; rejected: string[] } {
  const ev = worker.runtimeEvidence;
  const accepted: string[] = [];
  const rejected: string[] = [];
  const waveReturned = Boolean(state.nativeWave?.parentWaveReturned);

  accepted.push("registered_candidate_workspace");
  if (comparison.meaningfulSourceMutation) accepted.push("snapshot_relative_source_mutation");
  const hasSession = Boolean(worker.sessionId || ev?.sessionId);
  if (hasSession) accepted.push("native_session_id");
  if (ev?.taskId) accepted.push("native_task_id");
  if (receiptStatus === "valid") accepted.push("valid_panel_receipt");
  const parentTaskOutcome = Boolean(ev?.parentOutcomeProvided && ev?.taskCompletionEvidence);
  if (parentTaskOutcome) accepted.push("parent_task_outcome");

  if (ev?.contractMismatchErrors?.length) rejected.push("spoofed_panel_outcome");
  if (receiptStatus === "invalid") rejected.push("invalid_panel_receipt");

  if (rejected.length > 0) {
    return { reconciledStatus: "evidence_rejected", accepted, rejected };
  }
  if (worker.status === "failed") {
    return { reconciledStatus: "failed", accepted, rejected };
  }
  if (comparison.meaningfulSourceMutation && (hasSession || receiptStatus === "valid" || parentTaskOutcome)) {
    return { reconciledStatus: "usable", accepted, rejected };
  }
  if (comparison.meaningfulSourceMutation) {
    return { reconciledStatus: "usable_degraded", accepted, rejected };
  }
  if (!waveReturned) {
    return { reconciledStatus: "awaiting", accepted, rejected };
  }
  return { reconciledStatus: "completed_no_output", accepted, rejected };
}

/**
 * Build the plugin-owned evidence report for one panel purely from on-disk
 * artifacts and the reconciled worker record. Never fabricates a session ID or
 * Task result.
 */
export async function buildPanelEvidenceReport(
  state: SupervisorState,
  worker: WorkerRecord,
  now: () => number,
): Promise<PanelEvidenceReport> {
  const candidateWorkspace = worker.workspacePath;
  const comparison = await computePanelBaselineComparison(state, worker);
  const baseline = await loadBaselineManifest(panelBaselineManifestPath(state, worker.logicalPanelIndex as number));
  const workspaceIdentityValid = Boolean(baseline) && (await isDirectory(candidateWorkspace));

  const receiptPath = panelReceiptPaths(candidateWorkspace).receiptPath;
  const receiptRaw = await readPanelReceipt(receiptPath);
  const receiptValidation = validatePanelReceipt(receiptRaw, {
    runId: state.runId,
    panelId: worker.agentId ?? worker.workerId,
    candidateWorkspace,
    canonicalTaskHash: state.taskArtifactHash,
  });
  const receiptStatus: "valid" | "invalid" | "missing" = !receiptRaw
    ? "missing"
    : receiptValidation.valid
      ? "valid"
      : "invalid";

  const ev = worker.runtimeEvidence;
  const { reconciledStatus, accepted, rejected } = deriveReportStatus(state, worker, comparison, receiptStatus);

  return {
    runId: state.runId,
    panelId: worker.agentId ?? worker.workerId,
    candidateWorkspace,
    workspaceIdentityValid,
    canonicalTaskHash: state.taskArtifactHash,
    baselineComparison: comparison,
    nativeEvidence: {
      sessionId: worker.sessionId ?? ev?.sessionId ?? null,
      taskId: ev?.taskId ?? null,
      taskResultSummaryPresent: Boolean(ev?.taskCompletionSummary),
      parentOutcomeReceived: Boolean(ev?.parentOutcomeProvided),
    },
    panelReceipt: {
      path: receiptRaw ? receiptPath : null,
      status: receiptStatus,
    },
    reconciledStatus,
    acceptedEvidence: accepted,
    rejectedEvidence: rejected,
    harvestedAt: new Date(now()).toISOString(),
  };
}

export type HarvestPanelEvidenceResult = {
  runId: string;
  reportDir: string;
  reports: PanelEvidenceReport[];
};

/**
 * Deterministic, plugin-owned automatic evidence harvest. Inspects all three
 * pre-registered panel candidate workspaces against their immutable
 * snapshot-relative baselines and writes one evidence report per panel to
 * `<runDir>/panel-evidence/panel-N.json`. This runs automatically in collect,
 * and never depends on the parent serializing Task metadata. It never mutates
 * worker classification — it only reports.
 */
export async function harvestPanelEvidence(
  state: SupervisorState,
  cwd: string,
  traceDir: string | undefined,
  now: () => number = Date.now,
): Promise<HarvestPanelEvidenceResult> {
  const runDir = supervisorRunDir(cwd, state.runId, traceDir);
  const reportDir = path.join(runDir, "panel-evidence");
  await mkdir(reportDir, { recursive: true });
  const reports: PanelEvidenceReport[] = [];
  for (let index = 1; index <= PANEL_COUNT; index += 1) {
    const worker = state.workers[WORKER_ID.panel(index)];
    if (!worker) continue;
    const report = await buildPanelEvidenceReport(state, worker, now);
    reports.push(report);
    await writeFile(
      path.join(reportDir, `panel-${index}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }
  return { runId: state.runId, reportDir, reports };
}

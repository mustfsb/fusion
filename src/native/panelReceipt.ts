import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { diffAgainstBaseline, loadBaselineManifest } from "./candidateWorkspace.js";
import { PANEL_OUTPUT_DIR_NAME } from "./speculativeBuild.js";

export const PANEL_RECEIPT_FILE = "receipt.json";
export const PANEL_RESULT_FILE = "result.json";
export const PANEL_VERIFICATION_FILE = "verification.json";

/** Deterministic receipt a native panel writes inside its candidate workspace. */
export type FusionPanelReceipt = {
  runId: string;
  panelId: string;
  agentId: string;
  canonicalTaskHash: string;
  candidateWorkspace: string;
  status: "completed" | "failed";
  completedAt: string;
  summary?: string;
};

export type PanelReceiptValidation = {
  valid: boolean;
  errors: string[];
  receipt?: FusionPanelReceipt;
};

export function panelReceiptPaths(workspacePath: string): {
  outputDir: string;
  receiptPath: string;
  resultPath: string;
  verificationPath: string;
} {
  const outputDir = path.join(workspacePath, PANEL_OUTPUT_DIR_NAME);
  return {
    outputDir,
    receiptPath: path.join(outputDir, PANEL_RECEIPT_FILE),
    resultPath: path.join(outputDir, PANEL_RESULT_FILE),
    verificationPath: path.join(outputDir, PANEL_VERIFICATION_FILE),
  };
}

export async function readPanelReceipt(filePath: string): Promise<FusionPanelReceipt | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as FusionPanelReceipt;
  } catch {
    return undefined;
  }
}

export function validatePanelReceipt(
  receipt: FusionPanelReceipt | undefined,
  expected: {
    runId: string;
    panelId: string;
    candidateWorkspace: string;
    canonicalTaskHash: string;
  },
): PanelReceiptValidation {
  if (!receipt) {
    return { valid: false, errors: ["receipt missing"] };
  }
  const errors: string[] = [];
  if (receipt.runId !== expected.runId) {
    errors.push(`runId mismatch: expected ${expected.runId}, got ${receipt.runId}`);
  }
  if (receipt.panelId !== expected.panelId) {
    errors.push(`panelId mismatch: expected ${expected.panelId}, got ${receipt.panelId}`);
  }
  if (path.resolve(receipt.candidateWorkspace) !== path.resolve(expected.candidateWorkspace)) {
    errors.push(
      `candidateWorkspace mismatch: expected ${expected.candidateWorkspace}, got ${receipt.candidateWorkspace}`,
    );
  }
  if (receipt.canonicalTaskHash !== expected.canonicalTaskHash) {
    errors.push(
      `canonicalTaskHash mismatch: expected ${expected.canonicalTaskHash}, got ${receipt.canonicalTaskHash}`,
    );
  }
  if (receipt.status !== "completed" && receipt.status !== "failed") {
    errors.push(`invalid status: ${String(receipt.status)}`);
  }
  if (!receipt.completedAt) {
    errors.push("completedAt missing");
  }
  return { valid: errors.length === 0, errors, receipt };
}

/** True when the candidate workspace differs from its baseline manifest. */
export async function detectPanelCandidateMutation(
  candidateWorkspace: string,
  baselineManifestPath: string,
): Promise<boolean> {
  const baseline = await loadBaselineManifest(baselineManifestPath);
  if (!baseline) return false;
  const diff = await diffAgainstBaseline(candidateWorkspace, baseline);
  return [...diff.changedFiles, ...diff.addedFiles, ...diff.removedFiles].length > 0;
}

/** True when any non-receipt candidate-local output artifact exists. */
export async function detectPanelOutputArtifacts(candidateWorkspace: string): Promise<boolean> {
  const paths = panelReceiptPaths(candidateWorkspace);
  const candidates = [paths.receiptPath, paths.resultPath, paths.verificationPath];
  for (const candidatePath of candidates) {
    try {
      const info = await stat(candidatePath);
      if (info.size > 0) return true;
    } catch {
      // missing artifact is normal until the panel writes one
    }
  }
  return false;
}

import { describe, expect, test } from "vitest";
import { panelReceiptPaths, validatePanelReceipt } from "../src/native/panelReceipt.js";

describe("panel receipt validation", () => {
  const expected = {
    runId: "fusion-20260627-120000-abc123",
    panelId: "fusion-panel-1",
    candidateWorkspace: "/tmp/candidate-1",
    canonicalTaskHash: "hash-abc",
  };

  test("accepts a matching receipt", () => {
    const result = validatePanelReceipt(
      {
        runId: expected.runId,
        panelId: expected.panelId,
        agentId: expected.panelId,
        canonicalTaskHash: expected.canonicalTaskHash,
        candidateWorkspace: expected.candidateWorkspace,
        status: "completed",
        completedAt: new Date().toISOString(),
        summary: "done",
      },
      expected,
    );
    expect(result.valid).toBe(true);
  });

  test("rejects spoofed run/panel/hash values", () => {
    const result = validatePanelReceipt(
      {
        runId: "other-run",
        panelId: "fusion-panel-99",
        agentId: "fusion-panel-99",
        canonicalTaskHash: "wrong-hash",
        candidateWorkspace: "/tmp/other",
        status: "completed",
        completedAt: new Date().toISOString(),
      },
      expected,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("runId"))).toBe(true);
    expect(result.errors.some((e) => e.includes("panelId"))).toBe(true);
    expect(result.errors.some((e) => e.includes("canonicalTaskHash"))).toBe(true);
  });

  test("panelReceiptPaths resolves deterministic candidate-local paths", () => {
    const paths = panelReceiptPaths("/tmp/candidate-1");
    expect(paths.receiptPath).toContain(".fusion-panel-output/receipt.json");
    expect(paths.resultPath).toContain(".fusion-panel-output/result.json");
    expect(paths.verificationPath).toContain(".fusion-panel-output/verification.json");
  });
});

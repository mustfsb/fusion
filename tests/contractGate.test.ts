import { describe, expect, test } from "vitest";
import { extractContractGate, renderContractGate, summarizeContractGate } from "../src/council/contractGate.js";
import { specTrapTask } from "./fixtures/tasks.js";

describe("Contract Gate extraction", () => {
  test("explicit Export items become package-root export requirements", () => {
    const gate = extractContractGate([
      "Required public API",
      "",
      "Export:",
      "* `createStore(options?)`",
      "* `claim(key, fingerprint)`",
      "* `complete(key, token, response)`",
    ].join("\n"));

    expect(gate.packageRootExports).toEqual(["createStore", "claim", "complete"]);
    expect(gate.literalPublicSurface[0]).toContain("Required package-root exports");
  });

  test("non-empty string requirements add trim-based normalization guidance and probes", () => {
    const gate = extractContractGate([
      "### `claim(key, fingerprint, options?)`",
      "* `key` and `fingerprint` must be non-empty strings.",
      "* Invalid values throw `InvalidKeyError`.",
    ].join("\n"));

    expect(gate.behavioralBoundaries.some((item) => item.includes("whitespace-only"))).toBe(true);
    expect(gate.externalConsumerProbes).toContain("Whitespace-only inputs fail when the task requires non-empty strings.");
  });

  test("explicit thrown errors are preserved even without a separate export list", () => {
    const gate = extractContractGate(specTrapTask);

    expect(gate.requiredTypesAndErrors).toContain("LimitExceededError");
  });

  test("ambiguous timestamp range yields a compatibility recommendation without inventing literal field names", () => {
    const gate = extractContractGate([
      "Export:",
      "* `getAuditLog(filter?)`",
      "",
      "`getAuditLog(filter?)` must support filtering by:",
      "* type",
      "* key",
      "* timestamp range",
    ].join("\n"));

    expect(gate.consumerCompatibility[0]).toContain("fromTimestamp");
    expect(gate.requiredOptionAndFieldNames).not.toContain("fromTimestamp");
    expect(gate.requiredOptionAndFieldNames).not.toContain("from");
  });

  test("render and trace summary stay compact and structured", () => {
    const gate = extractContractGate(specTrapTask);
    const rendered = renderContractGate(gate);
    const summary = summarizeContractGate(gate);

    expect(rendered).toContain("## Contract Gate");
    expect(rendered).toContain("### A. Literal Public Surface");
    expect(summary.publicExportsRequired).toContain("consumeLimit");
    expect(summary.literalRequirementsDetected).toBeGreaterThan(0);
  });
});

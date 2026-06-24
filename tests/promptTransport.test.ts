import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildJudgePrompt, buildPanelPrompt } from "../src/council/prompts.js";
import {
  FUSION_FULL_PROMPT_UNAVAILABLE_PREFIX,
  INLINE_PROMPT_LINE_LIMIT,
  buildMandatoryReadProtocol,
  buildTransportBrief,
  parseFullPromptUnavailable,
  physicalLineCount,
  preparePromptTransport,
  sha256Hex,
} from "../src/council/promptTransport.js";
import { nativeAdvance, nativeCollect, nativeFinalize, nativeFinalizeAudit, nativePrepare, nativePrepareAudit } from "../src/native/nativeCouncil.js";
import { hashSharedPanelPrompt, loadRunState } from "../src/native/runState.js";
import { completeCandidate } from "./fixtures/candidates.js";

function makeLines(count: number, prefix = "requirement"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} line ${index + 1}: must satisfy acceptance criterion ${index + 1}`).join("\n");
}

let tmpCwd: string;

async function prepareMaterializedCandidateBuild(task: string) {
  const prepare = await nativePrepare(
    {
      task,
      mode: "build_prompt",
      panelMode: "candidate_build",
      command: "fusion-build",
      trace: { saveRunArtifacts: true },
    },
    { cwd: tmpCwd },
  );
  await nativeAdvance({ runId: prepare.runId }, { cwd: tmpCwd });
  const state = await loadRunState(tmpCwd, prepare.runId);
  return {
    ...prepare,
    sharedPanelPrompt: state.sharedPanelPrompt,
    sharedPanelPromptHash: state.sharedPanelPromptHash,
    sharedPanelPromptPath: state.sharedPanelPromptPath,
    panelTransportPrompt: state.panelTransportPrompt,
    panelPromptTransport: state.panelPromptTransport,
    panelAgents: state.panelAgents,
  };
}

beforeEach(async () => {
  tmpCwd = await mkdtemp(path.join(tmpdir(), "fusion-transport-"));
});

afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true });
});

describe("physical line count", () => {
  test("empty prompt is zero lines", () => {
    expect(physicalLineCount("")).toBe(0);
    expect(physicalLineCount("   \n  \n")).toBe(0);
  });

  test("50 lines uses inline threshold boundary", () => {
    expect(physicalLineCount(makeLines(50))).toBe(50);
  });

  test("51 lines exceeds inline threshold", () => {
    expect(physicalLineCount(makeLines(51))).toBe(51);
  });

  test("CRLF, LF, and trailing newline count consistently", () => {
    const lf = makeLines(5);
    const crlf = makeLines(5).replace(/\n/g, "\r\n");
    expect(physicalLineCount(lf)).toBe(5);
    expect(physicalLineCount(crlf)).toBe(5);
    expect(physicalLineCount(`${lf}\n\n`)).toBe(5);
    expect(physicalLineCount(`${crlf}\r\n\r\n`)).toBe(5);
  });

  test("matches the spec formula exactly", () => {
    const text = "line1\nline2\nline3";
    const expected = text.trimEnd() === "" ? 0 : text.trimEnd().split(/\r\n|\r|\n/).length;
    expect(physicalLineCount(text)).toBe(expected);
    expect(physicalLineCount("line1\r\nline2\r\nline3")).toBe(3);
  });
});

describe("INLINE_PROMPT_LINE_LIMIT is 50", () => {
  test("exported constant equals 50", () => {
    expect(INLINE_PROMPT_LINE_LIMIT).toBe(50);
  });
});

describe("preparePromptTransport line threshold", () => {
  test("50-line canonical prompt uses inline_full", async () => {
    const canonical = makeLines(50);
    const artifactDir = path.join(tmpCwd, "run-inline");
    const prepared = await preparePromptTransport({
      kind: "panel",
      canonicalPrompt: canonical,
      artifactDir,
      writeArtifacts: true,
    });
    expect(prepared.mode).toBe("inline_full");
    expect(prepared.metadata.mode).toBe("inline_full");
    expect(prepared.inlineTransportPrompt).toBe(canonical);
    expect(prepared.metadata.canonicalSha256).toBe(prepared.metadata.inlineSha256);
    expect(prepared.metadata.fullArtifactPath).toBeUndefined();
    expect(prepared.metadata.canonicalLineCount).toBe(50);
    expect(prepared.metadata.inlineLineCount).toBe(50);
  });

  test("51-line canonical prompt uses brief_plus_file and writes artifacts", async () => {
    const canonical = makeLines(51);
    const artifactDir = path.join(tmpCwd, "run-brief");
    const prepared = await preparePromptTransport({
      kind: "panel",
      canonicalPrompt: canonical,
      artifactDir,
      briefContext: { kind: "panel", panelMode: "candidate_build" },
      writeArtifacts: true,
    });
    expect(prepared.mode).toBe("brief_plus_file");
    expect(prepared.metadata.canonicalLineCount).toBe(51);
    expect(prepared.metadata.inlineLineCount).toBeLessThanOrEqual(INLINE_PROMPT_LINE_LIMIT);
    expect(prepared.metadata.fullArtifactPath).toBe(path.resolve(artifactDir, "shared-panel-prompt.full.md"));
    expect(prepared.metadata.briefArtifactPath).toBe(path.resolve(artifactDir, "shared-panel-prompt.brief.md"));
    expect(prepared.metadata.canonicalSha256).toBe(sha256Hex(canonical));
    expect(prepared.metadata.inlineSha256).not.toBe(prepared.metadata.canonicalSha256);

    const fullArtifact = await readFile(prepared.metadata.fullArtifactPath!, "utf8");
    expect(fullArtifact).toBe(canonical);
    const briefArtifact = await readFile(prepared.metadata.briefArtifactPath!, "utf8");
    expect(physicalLineCount(briefArtifact)).toBeLessThanOrEqual(INLINE_PROMPT_LINE_LIMIT);
    expect(prepared.inlineTransportPrompt).toBe(briefArtifact);
  });

  test("full artifact preserves canonical content byte-for-byte", async () => {
    const canonical = makeLines(120, "preserve");
    const artifactDir = path.join(tmpCwd, "run-preserve");
    const prepared = await preparePromptTransport({
      kind: "judge",
      canonicalPrompt: canonical,
      artifactDir,
      briefContext: { kind: "judge" },
      writeArtifacts: true,
    });
    const fullArtifact = await readFile(prepared.metadata.fullArtifactPath!, "utf8");
    expect(fullArtifact).toBe(canonical);
    expect(Buffer.from(fullArtifact, "utf8")).toEqual(Buffer.from(canonical, "utf8"));
  });

  test("audit kind uses same threshold behavior and artifact names", async () => {
    const canonical = makeLines(80, "audit");
    const artifactDir = path.join(tmpCwd, "run-audit");
    const prepared = await preparePromptTransport({
      kind: "audit",
      canonicalPrompt: canonical,
      artifactDir,
      briefContext: { kind: "audit" },
      writeArtifacts: true,
    });
    expect(prepared.mode).toBe("brief_plus_file");
    expect(prepared.metadata.fullArtifactPath).toBe(path.resolve(artifactDir, "post-build-audit-context.full.md"));
    expect(prepared.metadata.briefArtifactPath).toBe(path.resolve(artifactDir, "post-build-audit-context.brief.md"));
    expect(prepared.metadata.inlineLineCount).toBeLessThanOrEqual(INLINE_PROMPT_LINE_LIMIT);
  });
});

describe("panel transport brief content", () => {
  test("brief contains absolute path, hash, line count, EOF instruction, and unavailable marker", () => {
    const canonical = makeLines(80, "panel task");
    const fullPath = path.resolve(tmpCwd, "shared-panel-prompt.full.md");
    const brief = buildTransportBrief(canonical, fullPath, { kind: "panel", panelMode: "advisory" });
    expect(brief).toContain("MANDATORY BEFORE YOU BEGIN");
    expect(brief).toContain(fullPath);
    expect(brief).toContain(`Full context SHA-256: ${sha256Hex(canonical)}`);
    expect(brief).toContain(`Full context physical line count: ${physicalLineCount(canonical)}`);
    expect(brief).toContain("You MUST use your file-reading tool to read the entire file");
    expect(brief).toContain("continue reading until EOF");
    expect(brief).toContain("Reading only the first chunk is not sufficient");
    expect(brief).toContain(FUSION_FULL_PROMPT_UNAVAILABLE_PREFIX);
    expect(physicalLineCount(brief)).toBeLessThanOrEqual(INLINE_PROMPT_LINE_LIMIT);
  });

  test("brief does not include generated Contract Gate identifier dumps", () => {
    const canonical = [
      "Build a store with `Export add` and `Export remove`.",
      "## Contract Gate",
      "- Required package-root exports: add, remove, audit, Date.now, clock, true.",
      "",
      "## Public Surface Matrix",
      "- add | export | inputs (a,b) | returns sum | consumer test",
      "",
      ...Array.from({ length: 60 }, (_, i) => `requirement ${i}: must satisfy ${i}`),
    ].join("\n");
    const fullPath = path.resolve(tmpCwd, "shared-panel-prompt.full.md");
    const brief = buildTransportBrief(canonical, fullPath, { kind: "panel", panelMode: "candidate_build" });
    expect(physicalLineCount(brief)).toBeLessThanOrEqual(INLINE_PROMPT_LINE_LIMIT);
    expect(brief).not.toContain("Required package-root exports: add, remove, audit, Date.now, clock, true");
    expect(brief).not.toContain("add | export | inputs (a,b) | returns sum");
    expect(brief).not.toContain("Date.now");
    expect(brief).not.toContain("clock");
    expect(brief).not.toContain("audit, Date.now");
  });

  test("brief does not include raw panel outputs or requirement lists", () => {
    const canonical = [
      "## Task",
      "Build something.",
      "",
      "## Panel candidate proposals:",
      ...Array.from({ length: 60 }, (_, i) => `- panel output line ${i} with detail ${i}`),
      "",
      ...Array.from({ length: 40 }, (_, i) => `requirement ${i}: must export symbol${i}`),
    ].join("\n");
    const fullPath = path.resolve(tmpCwd, "judge-context.full.md");
    const brief = buildTransportBrief(canonical, fullPath, { kind: "judge", panelMode: "candidate_build" });
    expect(physicalLineCount(brief)).toBeLessThanOrEqual(INLINE_PROMPT_LINE_LIMIT);
    expect(brief).not.toContain("panel output line 30");
    expect(brief).not.toContain("must export symbol30");
  });

  test("mandatory read protocol uses absolute path only", () => {
    const fullPath = path.resolve("/workspace/run/shared-panel-prompt.full.md");
    const protocol = buildMandatoryReadProtocol(fullPath, "abc123", 301);
    expect(protocol).toContain(fullPath);
    expect(protocol).not.toMatch(/^shared-panel-prompt\.full\.md/m);
    expect(protocol).toContain("abc123");
    expect(protocol).toContain("301");
    expect(protocol).toContain("FUSION_FULL_PROMPT_UNAVAILABLE:");
  });
});

describe("panel brief byte-identical and hash semantics", () => {
  test("panel briefs remain byte-identical across calls with same canonical prompt", () => {
    const canonical = makeLines(80, "identical");
    const fullPath = path.resolve(tmpCwd, "shared-panel-prompt.full.md");
    const brief1 = buildTransportBrief(canonical, fullPath, { kind: "panel", panelMode: "candidate_build" });
    const brief2 = buildTransportBrief(canonical, fullPath, { kind: "panel", panelMode: "candidate_build" });
    expect(brief1).toBe(brief2);
  });

  test("canonical shared hash remains unchanged in compressed mode", async () => {
    const canonical = makeLines(80, "shared hash");
    const artifactDir = path.join(tmpCwd, "run-hash");
    const prepared = await preparePromptTransport({
      kind: "panel",
      canonicalPrompt: canonical,
      artifactDir,
      briefContext: { kind: "panel", panelMode: "candidate_build" },
      writeArtifacts: true,
    });
    expect(prepared.metadata.mode).toBe("brief_plus_file");
    expect(prepared.metadata.canonicalSha256).toBe(hashSharedPanelPrompt(canonical));
    expect(prepared.metadata.canonicalSha256).not.toBe(prepared.metadata.inlineSha256);
  });

  test("separate inline hash is recorded and differs from canonical hash", async () => {
    const canonical = makeLines(60, "inline hash");
    const artifactDir = path.join(tmpCwd, "run-inline-hash");
    const prepared = await preparePromptTransport({
      kind: "panel",
      canonicalPrompt: canonical,
      artifactDir,
      briefContext: { kind: "panel", panelMode: "advisory" },
      writeArtifacts: true,
    });
    expect(prepared.metadata.inlineSha256).toBe(sha256Hex(prepared.inlineTransportPrompt));
    expect(prepared.metadata.inlineSha256).not.toBe(prepared.metadata.canonicalSha256);
  });
});

describe("native panel transport integration", () => {
  test("short default panel task preserves inline_full behavior", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        command: "fusion-build",
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    expect(prepare.panelPromptTransport.mode).toBe("inline_full");
    expect(prepare.panelTransportPrompt).toBe(prepare.sharedPanelPrompt);
    expect(prepare.sharedPanelPromptHash).toBe(hashSharedPanelPrompt(prepare.sharedPanelPrompt));
    expect(prepare.panelAgents.every((agent) => agent.promptHash === prepare.sharedPanelPromptHash)).toBe(true);
  });

  test("candidate_build panel task exceeds 50-line threshold and uses brief_plus_file", async () => {
    const prepare = await prepareMaterializedCandidateBuild("Build add(a,b)");
    expect(prepare.panelPromptTransport.mode).toBe("brief_plus_file");
    expect(prepare.panelTransportPrompt).not.toBe(prepare.sharedPanelPrompt);
    expect(physicalLineCount(prepare.panelTransportPrompt)).toBeLessThanOrEqual(INLINE_PROMPT_LINE_LIMIT);
    expect(prepare.sharedPanelPromptHash).toBe(hashSharedPanelPrompt(prepare.sharedPanelPrompt));
    expect(prepare.panelPromptTransport.canonicalSha256).toBe(prepare.sharedPanelPromptHash);
    expect(prepare.panelPromptTransport.inlineSha256).toBe(sha256Hex(prepare.panelTransportPrompt));

    const fullArtifact = await readFile(prepare.panelPromptTransport.fullArtifactPath!, "utf8");
    expect(fullArtifact).toBe(prepare.sharedPanelPrompt);

    const panelPrompts = prepare.panelAgents.map(() => prepare.panelTransportPrompt);
    expect(new Set(panelPrompts).size).toBe(1);
    expect(prepare.panelTransportPrompt).toContain(prepare.panelPromptTransport.fullArtifactPath!);
    expect(prepare.panelTransportPrompt).toContain("MANDATORY BEFORE YOU BEGIN");
  });

  test("51-line panel task creates full artifact and identical transport prompts for all panels", async () => {
    const longTask = makeLines(51, "User task line");
    const prepare = await prepareMaterializedCandidateBuild(longTask);

    expect(prepare.panelPromptTransport.mode).toBe("brief_plus_file");
    expect(prepare.panelTransportPrompt).not.toBe(prepare.sharedPanelPrompt);
    expect(physicalLineCount(prepare.panelTransportPrompt)).toBeLessThanOrEqual(INLINE_PROMPT_LINE_LIMIT);
    expect(prepare.sharedPanelPromptHash).toBe(hashSharedPanelPrompt(prepare.sharedPanelPrompt));
    expect(prepare.panelPromptTransport.canonicalSha256).toBe(prepare.sharedPanelPromptHash);
    expect(prepare.panelPromptTransport.inlineSha256).toBe(sha256Hex(prepare.panelTransportPrompt));

    const fullArtifact = await readFile(prepare.panelPromptTransport.fullArtifactPath!, "utf8");
    expect(fullArtifact).toBe(prepare.sharedPanelPrompt);

    const panelPrompts = prepare.panelAgents.map(() => prepare.panelTransportPrompt);
    expect(new Set(panelPrompts).size).toBe(1);
    expect(prepare.panelTransportPrompt).toContain(prepare.panelPromptTransport.fullArtifactPath!);
    expect(prepare.panelTransportPrompt).toContain("MANDATORY BEFORE YOU BEGIN");
  });
});

describe("judge and audit transport", () => {
  test("long judge context writes full and brief artifacts with mandatory read instructions", async () => {
    const context = { summary: "No context.", files: [], omitted: [] };
    const panel = Array.from({ length: 3 }, (_, index) => ({
      modelId: `panel-${index + 1}`,
      provider: "test",
      success: true,
      content: makeLines(80, `panel ${index + 1} output`),
      latencyMs: 1,
    }));
    const judgeContext = buildJudgePrompt({
      task: makeLines(60, "task"),
      mode: "build_prompt",
      context,
      panel,
      panelMode: "candidate_build",
    });
    expect(physicalLineCount(judgeContext)).toBeGreaterThan(INLINE_PROMPT_LINE_LIMIT);

    const artifactDir = path.join(tmpCwd, "judge-run");
    const prepared = await preparePromptTransport({
      kind: "judge",
      canonicalPrompt: judgeContext,
      artifactDir,
      briefContext: { kind: "judge", panelMode: "candidate_build" },
      writeArtifacts: true,
    });
    expect(prepared.mode).toBe("brief_plus_file");
    const fullArtifact = await readFile(prepared.metadata.fullArtifactPath!, "utf8");
    expect(fullArtifact).toBe(judgeContext);
    expect(fullArtifact).toContain("Panel candidate proposals:");
    expect(prepared.inlineTransportPrompt).toContain("MANDATORY BEFORE YOU BEGIN");
    expect(prepared.inlineTransportPrompt).toContain(prepared.metadata.fullArtifactPath!);
    expect(prepared.inlineTransportPrompt).not.toContain(panel[0].content!.split("\n")[0]);
  });

  test("native collect returns judgeTransportPrompt when judge context exceeds threshold", async () => {
    const prepare = await nativePrepare(
      {
        task: makeLines(80, "Build requirement"),
        mode: "plan",
        panelMode: "advisory",
        command: "fusion-no-build",
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );

    const longPanelOutput = makeLines(90, "advisory section");
    const collect = await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: longPanelOutput },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: longPanelOutput },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: longPanelOutput },
        ],
      },
      { cwd: tmpCwd },
    );

    expect(collect.shouldProceed).toBe(true);
    expect(physicalLineCount(collect.judgePrompt)).toBeGreaterThan(INLINE_PROMPT_LINE_LIMIT);
    expect(collect.judgePromptTransport?.mode).toBe("brief_plus_file");
    expect(collect.judgeTransportPrompt).not.toBe(collect.judgePrompt);
    expect(collect.judgeTransportPrompt).toContain(collect.judgePromptTransport?.fullArtifactPath ?? "missing");
    expect(collect.judgePrompt).toContain(longPanelOutput.split("\n")[0]);
  });

  test("default-mode judge context above 50 lines uses brief_plus_file", async () => {
    const prepare = await nativePrepare(
      {
        task: "Add add(a,b)",
        mode: "plan",
        command: "fusion-no-build",
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    const collect = await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: "advice A" },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: "advice B" },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: "advice C" },
        ],
      },
      { cwd: tmpCwd },
    );
    expect(physicalLineCount(collect.judgePrompt)).toBeGreaterThan(INLINE_PROMPT_LINE_LIMIT);
    expect(collect.judgePromptTransport?.mode).toBe("brief_plus_file");
    expect(collect.judgeTransportPrompt).not.toBe(collect.judgePrompt);
  });
});

describe("FUSION_FULL_PROMPT_UNAVAILABLE handling", () => {
  test("parseFullPromptUnavailable extracts absolute path", () => {
    const marker = `${FUSION_FULL_PROMPT_UNAVAILABLE_PREFIX} /abs/path/shared-panel-prompt.full.md`;
    const parsed = parseFullPromptUnavailable(marker);
    expect(parsed.unavailable).toBe(true);
    if (parsed.unavailable) {
      expect(parsed.path).toBe("/abs/path/shared-panel-prompt.full.md");
    }
  });

  test("panel unavailable marker records validation failure with path", async () => {
    const prepare = await prepareMaterializedCandidateBuild("Build add(a,b)");
    const unavailablePath = prepare.panelPromptTransport.fullArtifactPath ?? "/tmp/shared-panel-prompt.full.md";
    const collect = await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: `${FUSION_FULL_PROMPT_UNAVAILABLE_PREFIX} ${unavailablePath}` },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: completeCandidate },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate },
        ],
      },
      { cwd: tmpCwd },
    );
    const panel1 = collect.panelStatus.find((entry) => entry.agentName === "fusion-panel-1");
    expect(panel1?.success).toBe(false);
    expect(panel1?.errorType).toBe("validation");
    expect(panel1?.error).toContain(unavailablePath);
    expect(collect.quorum.usable).toBe(2);
  });

  test("judge unavailable marker fails finalize honestly", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "plan",
        panelMode: "advisory",
        command: "fusion-no-build",
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: "advice A" },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: "advice B" },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: "advice C" },
        ],
      },
      { cwd: tmpCwd },
    );
    const finalize = await nativeFinalize(
      {
        runId: prepare.runId,
        judgeOutput: `${FUSION_FULL_PROMPT_UNAVAILABLE_PREFIX} /abs/judge-context.full.md`,
      },
      { cwd: tmpCwd },
    );
    expect(finalize.success).toBe(false);
    expect(finalize.error).toContain("/abs/judge-context.full.md");
    expect(finalize.trace.judge.success).toBe(false);
  });

  test("audit unavailable marker records degraded audit honestly", async () => {
    const prepare = await nativePrepare(
      {
        task: "Build add(a,b)",
        mode: "build_prompt",
        panelMode: "candidate_build",
        command: "fusion-build",
        trace: { saveRunArtifacts: true },
      },
      { cwd: tmpCwd },
    );
    await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: completeCandidate },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate },
        ],
      },
      { cwd: tmpCwd },
    );
    await nativeFinalize(
      {
        runId: prepare.runId,
        judgeOutput: JSON.stringify({
          summary: "ok",
          finalRecommendation: "Proceed.",
          requirementChecklist: ["export add"],
          finalBuildGuidance: "Final build contract",
          requiredTests: ["package-entry import test"],
          finalOutput: "## Final Build Contract\nContract",
        }),
      },
      { cwd: tmpCwd },
    );
    const auditPrepare = await nativePrepareAudit({ runId: prepare.runId }, { cwd: tmpCwd });
    const auditFinalize = await nativeFinalizeAudit(
      {
        runId: prepare.runId,
        auditOutput: `${FUSION_FULL_PROMPT_UNAVAILABLE_PREFIX} /abs/post-build-audit-context.full.md`,
      },
      { cwd: tmpCwd },
    );
    expect(auditFinalize.success).toBe(false);
    expect(auditFinalize.status).toBe("FIX_REQUIRED");
    expect(auditFinalize.trace.correctnessCoverageGate?.degradedReason).toContain("unavailable");
    expect(auditFinalize.findings[0]?.observed).toContain("/abs/post-build-audit-context.full.md");
  });
});

describe("trace metadata regression", () => {
  test("finalize trace includes panel prompt transport metadata for long panel prompts", async () => {
    const prepare = await prepareMaterializedCandidateBuild(makeLines(51, "Long build task"));
    await nativeCollect(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: "opencode-go/kimi-k2.7-code", content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: "opencode-go/qwen3.7-max", content: completeCandidate },
          { agentName: "fusion-panel-3", modelId: "opencode-go/minimax-m3", content: completeCandidate },
        ],
      },
      { cwd: tmpCwd },
    );
    const finalize = await nativeFinalize(
      {
        runId: prepare.runId,
        judgeOutput: JSON.stringify({
          summary: "ok",
          finalRecommendation: "Proceed.",
          requirementChecklist: ["export add"],
          finalBuildGuidance: "Final build contract",
          requiredTests: ["probe"],
          finalOutput: "## Spec Compliance Verdict\nok",
        }),
      },
      { cwd: tmpCwd },
    );
    expect(finalize.trace.panelPromptTransport?.mode).toBe("brief_plus_file");
    expect(finalize.trace.sharedPanelPromptHash).toBe(prepare.sharedPanelPromptHash);
    expect(finalize.traceSummary).toContain("brief_plus_file");
    expect(finalize.traceSummary).toContain(prepare.sharedPanelPromptHash);
  });
});

describe("buildPanelPrompt baseline", () => {
  test("default panel prompt remains under 50-line threshold for small tasks", () => {
    const prompt = buildPanelPrompt({
      task: "Build add(a,b)",
      mode: "build_prompt",
      context: { summary: "No context.", files: [], omitted: [] },
    });
    expect(physicalLineCount(prompt)).toBeLessThanOrEqual(INLINE_PROMPT_LINE_LIMIT);
  });

  test("candidate_build panel prompt exceeds 50-line threshold and triggers file transport", () => {
    const prompt = buildPanelPrompt({
      task: "Build add(a,b)",
      mode: "build_prompt",
      context: { summary: "No context.", files: [], omitted: [] },
      panelMode: "candidate_build",
    });
    expect(physicalLineCount(prompt)).toBeGreaterThan(INLINE_PROMPT_LINE_LIMIT);
  });
});

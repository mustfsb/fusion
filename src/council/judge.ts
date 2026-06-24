import type { ContextBundle, ContractAuditResult, CouncilComparison, CouncilMode, CouncilResult, FusionCouncilConfig, FusionModelSpec, FusionTraceQuorum, ModelRunner, PanelMode, PanelResponse, RequirementDecisionMatrix } from "../types.js";
import { getReasoningEffortApplication } from "../modelSpec.js";
import { extractJsonObject } from "../utils/json.js";
import { buildJudgePrompt } from "./prompts.js";
import { contractAuditResultSchema, judgeResultSchema } from "./schema.js";
import { panelSessionTitle } from "../trace/runTrace.js";
import type { z } from "zod";

export function parseJudgeResponse(mode: CouncilMode, rawText: string): Omit<CouncilResult, "panel"> {
  try {
    const parsed = judgeResultSchema.parse(extractJsonObject(rawText));
    const requirementDecisionMatrix = normalizeRequirementDecisionMatrix(parsed.requirementDecisionMatrix);
    const councilComparison = normalizeCouncilComparison(parsed.councilComparison);
    return {
      mode,
      decision: parsed.decision,
      summary: parsed.summary,
      consensus: parsed.consensus,
      contradictions: parsed.contradictions,
      uniqueInsights: parsed.uniqueInsights,
      risks: parsed.risks,
      missingConsiderations: parsed.missingConsiderations,
      finalRecommendation: parsed.finalRecommendation,
      requirementChecklist: parsed.requirementChecklist,
      safeCompatibilityAdditions: parsed.safeCompatibilityAdditions,
      optionalNiceties: parsed.optionalNiceties,
      publicSurfaceMatrix: parsed.publicSurfaceMatrix,
      requiredExternalConsumerProbes: parsed.requiredExternalConsumerProbes,
      requiredHiddenSemanticProbes: parsed.requiredHiddenSemanticProbes,
      implementationPriorities: parsed.implementationPriorities,
      packageEntryChecklist: parsed.packageEntryChecklist,
      buildReadyConsumerTestPlan: parsed.buildReadyConsumerTestPlan,
      rejectedRiskyIdeas: parsed.rejectedRiskyIdeas,
      requirementDecisionMatrix,
      councilComparison,
      finalBuildGuidance: parsed.finalBuildGuidance,
      mustNotBreakConstraints: parsed.mustNotBreakConstraints,
      requiredTests: parsed.requiredTests,
      panelAssessments: parsed.panelAssessments,
      implementationPlan: parsed.implementationPlan,
      testPlan: parsed.testPlan,
      recommendedBuildPrompt: parsed.recommendedBuildPrompt,
      knownTraps: parsed.knownTraps,
      finalComplianceChecklist: parsed.finalComplianceChecklist,
      finalOutput: parsed.finalOutput,
    };
  } catch {
    return {
      mode,
      decision: "needs_more_info",
      summary: "Judge returned non-JSON output.",
      consensus: [],
      contradictions: [],
      uniqueInsights: [],
      risks: [],
      missingConsiderations: ["Judge response could not be parsed as strict JSON."],
      finalRecommendation: "Review the raw judge output manually.",
      requirementChecklist: [],
      safeCompatibilityAdditions: [],
      optionalNiceties: [],
      publicSurfaceMatrix: [],
      requiredExternalConsumerProbes: [],
      requiredHiddenSemanticProbes: [],
      implementationPriorities: [],
      packageEntryChecklist: [],
      buildReadyConsumerTestPlan: [],
      rejectedRiskyIdeas: [],
      requirementDecisionMatrix: { entries: [], mandatoryCount: 0, safeCompatibilityCount: 0, optionalCount: 0, rejectedCount: 0 },
      councilComparison: undefined,
      finalBuildGuidance: "Review the raw judge output manually before implementing the original task.",
      mustNotBreakConstraints: ["Do not implement unverified judge output without checking the original user task."],
      requiredTests: [],
      panelAssessments: [],
      implementationPlan: [],
      testPlan: [],
      recommendedBuildPrompt: "",
      knownTraps: [],
      finalComplianceChecklist: [],
      finalOutput: rawText,
    };
  }
}

type ParsedMatrixEntry = z.infer<typeof import("./schema.js").requirementDecisionMatrixEntrySchemaExport>;

function normalizeRequirementDecisionMatrix(entries: ParsedMatrixEntry[]): RequirementDecisionMatrix {
  const list = entries ?? [];
  return {
    entries: list.map((entry) => ({
      requirement: entry.requirement,
      chosenBehavior: entry.chosenBehavior,
      whyCorrect: entry.whyCorrect,
      evidenceSource: entry.evidenceSource,
      requiredTest: entry.requiredTest,
      riskIfOmitted: entry.riskIfOmitted,
      classification: entry.classification,
    })),
    mandatoryCount: list.filter((entry) => entry.classification === "mandatory_literal_requirement").length,
    safeCompatibilityCount: list.filter((entry) => entry.classification === "safe_compatibility_addition").length,
    optionalCount: list.filter((entry) => entry.classification === "optional_enhancement").length,
    rejectedCount: list.filter((entry) => entry.classification === "rejected_scope_expansion").length,
  };
}

type ParsedCouncilComparison = NonNullable<z.infer<typeof import("./schema.js").councilComparisonSummarySchemaExport>>;

function normalizeCouncilComparison(parsed: ParsedCouncilComparison | undefined): CouncilComparison | undefined {
  if (!parsed) return undefined;
  return {
    commonGround: parsed.commonGround.map((entry) => ({
      topic: entry.topic,
      supportedBy: entry.supportedBy,
      confidence: entry.confidence,
      rationale: entry.rationale,
      taskRequirement: undefined,
    })),
    keyDifferences: parsed.keyDifferences.map((entry) => ({
      topic: entry.topic,
      panelPositions: [],
      resolutionRule: entry.resolutionRule,
      requiredDecision: entry.requiredDecision,
      taskRequirement: undefined,
    })),
    uniqueAdditions: parsed.uniqueAdditions.map((entry) => ({
      idea: entry.idea,
      proposedBy: 0,
      classification: entry.classification,
      recommendation: entry.recommendation,
      reason: "",
    })),
    partialCoverage: parsed.partialCoverage.map((entry) => ({
      requirement: entry.requirement,
      coveredBy: [],
      requiredFollowUp: entry.requiredFollowUp,
    })),
    blindSpots: parsed.blindSpots.map((entry) => ({
      risk: entry.risk,
      requiredTestOrAudit: entry.requiredTestOrAudit,
    })),
    unresolvedDifferences: parsed.keyDifferences.length,
    adoptedUniqueAdditions: parsed.uniqueAdditions.filter((entry) => entry.recommendation === "adopt").length,
    deferredOrRejectedUniqueAdditions: parsed.uniqueAdditions.filter((entry) => entry.recommendation !== "adopt").length,
    degraded: false,
    notes: [],
  };
}

export function parseContractAuditResponse(rawText: string): ContractAuditResult {
  try {
    const parsed = contractAuditResultSchema.parse(extractJsonObject(rawText));
    return {
      status: parsed.status,
      summary: parsed.summary,
      findings: parsed.findings,
      finalOutput: parsed.finalOutput,
    };
  } catch {
    return {
      status: "FIX_REQUIRED",
      summary: "Audit returned non-JSON output.",
      findings: [
        {
          requirement: "Return strict JSON with PASS or FIX_REQUIRED.",
          observed: "Audit output could not be parsed as strict JSON.",
          requiredFix: "Rerun the post-build audit with the required JSON contract and do not claim compliance from unparsed output.",
        },
      ],
      finalOutput: rawText,
    };
  }
}

export async function runJudge(input: {
  task: string;
  mode: CouncilMode;
  context: ContextBundle;
  panel: PanelResponse[];
  judgeModelSpec: FusionModelSpec;
  config: FusionCouncilConfig;
  modelRunner: ModelRunner;
  panelMode?: PanelMode;
  timeoutMs?: number;
  keepSession?: boolean;
  judgePrompt?: string;
  quorum?: FusionTraceQuorum;
  councilComparison?: CouncilComparison;
  councilComparisonMarkdown?: string;
}): Promise<CouncilResult & {
  judgeRawOutput?: string;
  judgeSessionId?: string;
  judgeReasoningEffort?: FusionModelSpec["reasoningEffort"];
  judgeReasoningEffortApplied?: ReturnType<typeof getReasoningEffortApplication>;
  judgeRawModelSpec?: string;
}> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? input.config.defaults.timeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let judgeSessionId: string | undefined;
  const judgeModelId = input.judgeModelSpec.modelId;
  try {
    const prompt = input.judgePrompt ?? buildJudgePrompt({
      task: input.task,
      mode: input.mode,
      context: input.context,
      panel: input.panel,
      panelMode: input.panelMode,
      quorum: input.quorum,
      councilComparison: input.councilComparison,
      councilComparisonMarkdown: input.councilComparisonMarkdown,
    });
    const raw = await input.modelRunner.generate(
      judgeModelId,
      prompt,
      {
        signal: controller.signal,
        timeoutMs,
        sessionTitle: panelSessionTitle(0, judgeModelId, "judge"),
        keepSession: input.keepSession,
        onSessionCreated: (id) => { judgeSessionId = id; },
        reasoningEffort: input.judgeModelSpec.reasoningEffort,
      },
    );
    return {
      ...parseJudgeResponse(input.mode, raw),
      panelMode: input.panelMode,
      panel: input.panel,
      judgeRawOutput: raw,
      judgeSessionId,
      judgeReasoningEffort: input.judgeModelSpec.reasoningEffort,
      judgeReasoningEffortApplied: getReasoningEffortApplication(input.judgeModelSpec),
      judgeRawModelSpec: input.judgeModelSpec.raw,
    };
  } finally {
    clearTimeout(timeout);
  }
}

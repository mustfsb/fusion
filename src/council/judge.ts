import type { ContextBundle, ContractAuditResult, CouncilMode, CouncilResult, FusionCouncilConfig, FusionModelSpec, FusionTraceQuorum, ModelRunner, PanelMode, PanelResponse } from "../types.js";
import { getReasoningEffortApplication } from "../modelSpec.js";
import { extractJsonObject } from "../utils/json.js";
import { buildJudgePrompt } from "./prompts.js";
import { contractAuditResultSchema, judgeResultSchema } from "./schema.js";
import { panelSessionTitle } from "../trace/runTrace.js";

export function parseJudgeResponse(mode: CouncilMode, rawText: string): Omit<CouncilResult, "panel"> {
  try {
    const parsed = judgeResultSchema.parse(extractJsonObject(rawText));
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

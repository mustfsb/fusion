import { z } from "zod";

export const councilModeSchema = z.enum(["plan", "review", "decision", "build_prompt", "architecture"]);

export const councilDecisionSchema = z.enum(["implement", "do_not_implement", "needs_more_info", "use_caution"]);

const requirementDecisionMatrixEntrySchema = z.object({
  requirement: z.string().default(""),
  chosenBehavior: z.string().default(""),
  whyCorrect: z.string().default(""),
  evidenceSource: z.string().default(""),
  requiredTest: z.string().default(""),
  riskIfOmitted: z.string().default(""),
  classification: z
    .enum([
      "mandatory_literal_requirement",
      "safe_compatibility_addition",
      "optional_enhancement",
      "rejected_scope_expansion",
    ])
    .default("mandatory_literal_requirement"),
});

const councilComparisonSummarySchema = z.object({
  commonGround: z
    .array(
      z.object({
        topic: z.string().default(""),
        supportedBy: z.array(z.number()).default([]),
        confidence: z.enum(["high", "medium", "low"]).default("medium"),
        rationale: z.string().default(""),
      }),
    )
    .default([]),
  keyDifferences: z
    .array(
      z.object({
        topic: z.string().default(""),
        resolutionRule: z.string().default(""),
        requiredDecision: z.string().default(""),
      }),
    )
    .default([]),
  uniqueAdditions: z
    .array(
      z.object({
        idea: z.string().default(""),
        classification: z
          .enum(["literal_requirement", "safe_compatibility", "optional_enhancement", "scope_risk"])
          .default("optional_enhancement"),
        recommendation: z.enum(["adopt", "defer", "reject"]).default("defer"),
      }),
    )
    .default([]),
  partialCoverage: z
    .array(
      z.object({
        requirement: z.string().default(""),
        requiredFollowUp: z.string().default(""),
      }),
    )
    .default([]),
  blindSpots: z
    .array(
      z.object({
        risk: z.string().default(""),
        requiredTestOrAudit: z.string().default(""),
      }),
    )
    .default([]),
});

export const judgeResultSchema = z.object({
  decision: councilDecisionSchema.optional(),
  summary: z.string().default(""),
  consensus: z.array(z.string()).default([]),
  contradictions: z.array(z.string()).default([]),
  uniqueInsights: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  missingConsiderations: z.array(z.string()).default([]),
  finalRecommendation: z.string().default(""),
  requirementChecklist: z.array(z.string()).default([]),
  safeCompatibilityAdditions: z.array(z.string()).default([]),
  optionalNiceties: z.array(z.string()).default([]),
  publicSurfaceMatrix: z.array(z.string()).default([]),
  requiredExternalConsumerProbes: z.array(z.string()).default([]),
  requiredHiddenSemanticProbes: z.array(z.string()).default([]),
  implementationPriorities: z.array(z.string()).default([]),
  packageEntryChecklist: z.array(z.string()).default([]),
  buildReadyConsumerTestPlan: z.array(z.string()).default([]),
  rejectedRiskyIdeas: z.array(z.string()).default([]),
  requirementDecisionMatrix: z.array(requirementDecisionMatrixEntrySchema).default([]),
  councilComparison: councilComparisonSummarySchema.optional(),
  finalBuildGuidance: z.string().default(""),
  mustNotBreakConstraints: z.array(z.string()).default([]),
  requiredTests: z.array(z.string()).default([]),
  panelAssessments: z.array(z.object({
    modelId: z.string().default(""),
    summary: z.string().default(""),
    strengths: z.array(z.string()).default([]),
    weaknesses: z.array(z.string()).default([]),
  })).default([]),
  implementationPlan: z.array(z.string()).default([]),
  testPlan: z.array(z.string()).default([]),
  recommendedBuildPrompt: z.string().default(""),
  knownTraps: z.array(z.string()).default([]),
  finalComplianceChecklist: z.array(z.string()).default([]),
  finalOutput: z.string().default(""),
});

export const contractAuditResultSchema = z.object({
  status: z.enum(["PASS", "FIX_REQUIRED"]).default("FIX_REQUIRED"),
  summary: z.string().default(""),
  findings: z.array(z.object({
    requirement: z.string().default(""),
    observed: z.string().default(""),
    requiredFix: z.string().default(""),
  })).default([]),
  finalOutput: z.string().default(""),
});

export const requirementDecisionMatrixEntrySchemaExport = requirementDecisionMatrixEntrySchema;
export const councilComparisonSummarySchemaExport = councilComparisonSummarySchema;

import { z } from "zod";

export const councilModeSchema = z.enum(["plan", "review", "decision", "build_prompt", "architecture"]);

export const councilDecisionSchema = z.enum(["implement", "do_not_implement", "needs_more_info", "use_caution"]);

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
  rejectedRiskyIdeas: z.array(z.string()).default([]),
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

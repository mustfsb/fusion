import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { loadFusionConfig } from "./config.js";
import { formatCouncilResultMarkdown, formatLatestTraceSummary, runCouncil } from "./council/runCouncil.js";
import {
  SAVED_MODEL_CONFIG_PATH,
  formatSavedModelConfigMarkdown,
  formatUpdatedModelConfigMarkdown,
  getDefaultJudgeModelSpec,
  getDefaultPanelModelSpecs,
  loadSavedModelConfig,
  parseModelArgs,
  resetSavedModelConfig,
  resolveModels,
  saveSavedModelConfig,
} from "./modelConfig.js";
import { createOpenCodeModelRunner } from "./runners/opencodeModelRunner.js";
import { loadLatestRunTrace } from "./trace/runTrace.js";
import type { FusionTraceOptions } from "./types.js";

const outputFormatSchema = tool.schema.enum(["markdown", "json"]);
const pluginModeSchema = tool.schema.enum(["plan", "review", "decision", "build_prompt", "architecture"]);
const modelSourceSchema = tool.schema.enum(["auto", "opencode", "direct"]);
const panelModeSchema = tool.schema.enum(["advisory", "candidate_build"]);
const modelConfigActionSchema = tool.schema.enum(["show", "set", "reset"]);

type PluginSettings = FusionTraceOptions;

function resolvePluginSettings(options?: PluginSettings): Required<Pick<FusionTraceOptions, "saveRunArtifacts" | "keepPanelSessions" | "verboseTrace">> & FusionTraceOptions {
  return {
    saveRunArtifacts: options?.saveRunArtifacts ?? true,
    keepPanelSessions: options?.keepPanelSessions ?? false,
    verboseTrace: options?.verboseTrace ?? false,
    traceDir: options?.traceDir,
    command: options?.command,
  };
}

const fusionCouncilPlugin: Plugin = async ({ client }, options?: PluginSettings) => {
  const pluginSettings = resolvePluginSettings(options);
  return {
    tool: {
      fusion_council: tool({
        description: "Run a provider-agnostic multi-model council for planning, review, decisions, build prompts, or architecture analysis. Does not modify files.",
        args: {
          task: tool.schema.string().describe("The task, question, review request, or decision to analyze."),
          mode: pluginModeSchema.describe("Council mode."),
          panelMode: panelModeSchema.optional().describe("Panel prompt mode: 'candidate_build' (panels produce competing candidate implementations) or 'advisory' (panels advise without implementing)."),
          files: tool.schema.array(tool.schema.string()).optional().describe("Optional project files to include as context."),
          includeDiff: tool.schema.boolean().optional().describe("Include current git diff."),
          panelModels: tool.schema.array(tool.schema.string()).optional().describe("Override panel model IDs. If omitted, uses saved /fusion-model config or built-in defaults."),
          judgeModel: tool.schema.string().optional().describe("Override judge model ID. If omitted, uses saved /fusion-model config or built-in defaults."),
          requireAllPanels: tool.schema.boolean().optional().describe("Fail before judging unless every requested panel model succeeds."),
          minSuccessfulPanels: tool.schema.number().optional().describe("Minimum usable panel outputs required before judging (default 2). Takes precedence over requireAllPanels."),
          allowDegradedJudge: tool.schema.boolean().optional().describe("Allow judge to run in degraded mode when quorum is met but not all panels succeeded (default true)."),
          promptVerbosity: tool.schema.enum(["compact", "standard", "detailed"]).optional().describe("Panel prompt verbosity. candidate_build defaults to compact."),
          panelTimeoutMs: tool.schema.number().optional().describe("Timeout in milliseconds for each panel model attempt."),
          judgeTimeoutMs: tool.schema.number().optional().describe("Timeout in milliseconds for the judge model call."),
          panelMaxAttempts: tool.schema.number().optional().describe("Maximum attempts per panel model. Default 1 for candidate_build."),
          repairMaxAttempts: tool.schema.number().optional().describe("Maximum repair attempts for near-valid candidate output (default 1)."),
          repairTimeoutMs: tool.schema.number().optional().describe("Timeout in milliseconds for candidate repair calls (default 7 min)."),
          outputFormat: outputFormatSchema.optional().describe("Return markdown by default or raw JSON."),
          modelSource: modelSourceSchema.optional().describe("auto uses OpenCode-native model routing inside the plugin; direct uses fusion-council.config.jsonc provider mappings."),
          saveRunArtifacts: tool.schema.boolean().optional().describe("Write trace artifacts under .opencode/fusion-runs/<runId>/ (default true)."),
          keepPanelSessions: tool.schema.boolean().optional().describe("Keep OpenCode panel/judge sessions visible instead of deleting them after each call (default false)."),
          traceDir: tool.schema.string().optional().describe("Override trace artifact root directory."),
          command: tool.schema.string().optional().describe("Command name for trace metadata, e.g. fusion-build or fusion-no-build."),
        },
        async execute(args, context) {
          const config = await loadFusionConfig(process.env.FUSION_COUNCIL_CONFIG, context.directory);
          const opencodeRunner = createOpenCodeModelRunner({ client, directory: context.directory });
          const resolved = await resolveModels({
            panelModels: args.panelModels,
            judgeModel: args.judgeModel,
          });
          const trace: FusionTraceOptions = {
            saveRunArtifacts: args.saveRunArtifacts ?? pluginSettings.saveRunArtifacts,
            keepPanelSessions: args.keepPanelSessions ?? pluginSettings.keepPanelSessions,
            traceDir: args.traceDir ?? pluginSettings.traceDir,
            verboseTrace: pluginSettings.verboseTrace,
            command: args.command ?? pluginSettings.command,
          };
          const result = await runCouncil(
            {
              task: args.task,
              mode: args.mode,
              panelMode: args.panelMode,
              files: args.files,
              includeDiff: args.includeDiff,
              panelModelSpecs: resolved.panelModels,
              judgeModelSpec: resolved.judgeModel,
              requireAllPanels: args.requireAllPanels,
              minSuccessfulPanels: args.minSuccessfulPanels,
              allowDegradedJudge: args.allowDegradedJudge,
              promptVerbosity: args.promptVerbosity,
              panelTimeoutMs: args.panelTimeoutMs,
              judgeTimeoutMs: args.judgeTimeoutMs,
              panelMaxAttempts: args.panelMaxAttempts,
              repairMaxAttempts: args.repairMaxAttempts,
              repairTimeoutMs: args.repairTimeoutMs,
              modelSource: args.modelSource,
              trace,
            },
            { config, cwd: context.directory, opencodeRunner, modelSource: "auto", trace },
          );

          return args.outputFormat === "json"
            ? JSON.stringify(result, null, 2)
            : formatCouncilResultMarkdown(result);
        },
      }),

      fusion_trace: tool({
        description: "Show the latest Fusion Council run trace summary and artifact locations.",
        args: {
          traceDir: tool.schema.string().optional().describe("Override trace artifact root directory."),
        },
        async execute(args, context) {
          const trace = await loadLatestRunTrace(context.directory, args.traceDir ?? pluginSettings.traceDir);
          if (!trace) {
            return "No Fusion run trace found yet. Run `/fusion-build` or `/fusion-no-build` first.";
          }
          return formatLatestTraceSummary(trace);
        },
      }),

      fusion_model_config: tool({
        description: "Read, update, or reset the global Fusion Council model configuration (panel models and judge model) stored at ~/.config/opencode/fusion-council-models.json.",
        args: {
          action: modelConfigActionSchema.describe("show: display current config; set: save new models; reset: restore defaults"),
          models: tool.schema.string().optional().describe(
            "For 'set': comma-separated list of exactly 4 model IDs (3 panel + 1 judge), each in provider/model format. Example: 'opencode-go/kimi-k2.7-code, opencode-go/qwen3.7-max, opencode-go/minimax-m3, openai/gpt-5.5'",
          ),
        },
        async execute(args) {
          if (args.action === "show") {
            const saved = await loadSavedModelConfig();
            if (saved) {
              return formatSavedModelConfigMarkdown(saved, "Custom (saved)");
            }
            return [
              "## Fusion Council Model Config",
              "**Source:** Default (no custom config saved)",
              `**Config path:** ${SAVED_MODEL_CONFIG_PATH}`,
              "",
              "**Panel models (default):**",
              ...getDefaultPanelModelSpecs().map((spec, index) => `- ${index + 1}. ${spec.modelId}`),
              "",
              `**Judge model (default):** ${getDefaultJudgeModelSpec().modelId}`,
              "",
              "To customize:",
              "`/fusion-model provider/model1, provider/model2, provider/model3, provider/judge`",
              "`/fusion-model provider/model1/effort, provider/model2, provider/model3, provider/judge/high`",
              "To reset to defaults: `/fusion-model reset`",
            ].join("\n");
          }

          if (args.action === "reset") {
            await resetSavedModelConfig();
            return [
              "## Fusion Council Model Config Reset",
              "Custom config deleted. Defaults restored.",
              "",
              "**Panel models (default):**",
              ...getDefaultPanelModelSpecs().map((spec) => `- ${spec.modelId}`),
              "",
              `**Judge model (default):** ${getDefaultJudgeModelSpec().modelId}`,
            ].join("\n");
          }

          if (args.action === "set") {
            if (!args.models) {
              throw new Error(
                "'models' argument is required for action 'set'. Provide 4 comma-separated model specs.",
              );
            }
            const { panelModels, judgeModel } = parseModelArgs(args.models);
            await saveSavedModelConfig({ panelModels, judgeModel });
            return formatUpdatedModelConfigMarkdown({ panelModels, judgeModel });
          }

          throw new Error(`Unknown action: ${String(args.action)}`);
        },
      }),
    },
  };
};

export default fusionCouncilPlugin;

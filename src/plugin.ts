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
import {
  defaultAgentDir,
  formatAgentSyncMarkdown,
  listFusionAgentFiles,
  syncDefaultNativeAgents,
  syncNativeAgents,
} from "./native/agentSync.js";
import { nativeCollect, nativeFinalize, nativeFinalizeAudit, nativePrepare, nativePrepareAudit } from "./native/nativeCouncil.js";
import type { FusionTraceOptions, NativePanelResult } from "./types.js";

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

      fusion_native: tool({
        description:
          "Native-subagent Fusion Council orchestration. Drives panels and the judge as real OpenCode Task subagents (fusion-panel-1/2/3, fusion-judge) instead of hidden SDK sessions. Stages: prepare, collect, finalize, audit_prepare, audit_finalize. Does not call panel/judge models itself.",
        args: {
          stage: tool.schema.enum(["prepare", "collect", "finalize", "audit_prepare", "audit_finalize"]).describe("Orchestration stage to execute."),
          task: tool.schema.string().optional().describe("Original user task text (required for prepare)."),
          mode: pluginModeSchema.optional().describe("Council mode (required for prepare)."),
          panelMode: panelModeSchema.optional().describe("advisory | candidate_build (required for prepare)."),
          files: tool.schema.array(tool.schema.string()).optional().describe("Project files to include as context (prepare)."),
          includeDiff: tool.schema.boolean().optional().describe("Include current git diff (prepare)."),
          promptVerbosity: tool.schema.enum(["compact", "standard", "detailed"]).optional().describe("Panel prompt verbosity (prepare)."),
          command: tool.schema.string().optional().describe("Command name for trace metadata, e.g. fusion-build or fusion-no-build (prepare)."),
          panelModels: tool.schema.array(tool.schema.string()).optional().describe("Override panel model IDs (prepare). Defaults to saved /fusion-model config."),
          judgeModel: tool.schema.string().optional().describe("Override judge model ID (prepare). Defaults to saved /fusion-model config."),
          requireAllPanels: tool.schema.boolean().optional().describe("Fail before judging unless every panel succeeds (prepare)."),
          minSuccessfulPanels: tool.schema.number().optional().describe("Minimum usable panels before judging (prepare, default 2)."),
          allowDegradedJudge: tool.schema.boolean().optional().describe("Allow judge in degraded quorum mode (prepare, default true)."),
          runId: tool.schema.string().optional().describe("Fusion run id returned by prepare (required for collect and finalize)."),
          panelResults: tool.schema
            .array(
              tool.schema.object({
                agentName: tool.schema.string(),
                modelId: tool.schema.string(),
                content: tool.schema.string().optional(),
                error: tool.schema.string().optional(),
                errorType: tool.schema.string().optional(),
                taskId: tool.schema.string().optional(),
                sessionId: tool.schema.string().optional(),
              }),
            )
            .optional()
            .describe("Native panel subagent results (collect). Pass one entry per panel returned by the Task tool."),
          judgeOutput: tool.schema.string().optional().describe("Native judge subagent output text (finalize)."),
          judgeError: tool.schema.string().optional().describe("Native judge subagent error message (finalize)."),
          judgeTaskId: tool.schema.string().optional().describe("Task id returned by the judge Task call (finalize)."),
          judgeSessionId: tool.schema.string().optional().describe("OpenCode session id of the judge child session (finalize)."),
          auditOutput: tool.schema.string().optional().describe("Native post-build audit output text (audit_finalize)."),
          auditError: tool.schema.string().optional().describe("Native post-build audit error message (audit_finalize)."),
          auditTaskId: tool.schema.string().optional().describe("Task id returned by the audit Task call (audit_finalize)."),
          auditSessionId: tool.schema.string().optional().describe("OpenCode session id of the audit child session (audit_finalize)."),
          traceDir: tool.schema.string().optional().describe("Override trace artifact root directory."),
          saveRunArtifacts: tool.schema.boolean().optional().describe("Write trace artifacts (default true)."),
          keepPanelSessions: tool.schema.boolean().optional().describe("Keep native child sessions visible (default true in native mode)."),
        },
        async execute(args, context) {
          const cwd = context.directory;
          const traceDir = args.traceDir ?? pluginSettings.traceDir;

          if (args.stage === "prepare") {
            if (!args.task || !args.mode) {
              throw new Error("fusion_native prepare requires 'task' and 'mode'.");
            }
            const result = await nativePrepare(
              {
                task: args.task,
                mode: args.mode,
                panelMode: args.panelMode,
                files: args.files,
                includeDiff: args.includeDiff,
                promptVerbosity: args.promptVerbosity,
                command: args.command,
                panelModels: args.panelModels,
                judgeModel: args.judgeModel,
                requireAllPanels: args.requireAllPanels,
                minSuccessfulPanels: args.minSuccessfulPanels,
                allowDegradedJudge: args.allowDegradedJudge,
                trace: {
                  saveRunArtifacts: args.saveRunArtifacts ?? pluginSettings.saveRunArtifacts,
                  keepPanelSessions: args.keepPanelSessions ?? true,
                  traceDir,
                  command: args.command,
                },
              },
              { cwd, config: await loadFusionConfig(process.env.FUSION_COUNCIL_CONFIG, cwd), traceDir },
            );
            return JSON.stringify(result, null, 2);
          }

          if (args.stage === "collect") {
            if (!args.runId || !args.panelResults) {
              throw new Error("fusion_native collect requires 'runId' and 'panelResults'.");
            }
            const result = await nativeCollect(
              {
                runId: args.runId,
                panelResults: args.panelResults.map((entry) => ({
                  ...entry,
                  errorType: entry.errorType as NativePanelResult["errorType"],
                })),
              },
              { cwd, traceDir },
            );
            return JSON.stringify(result, null, 2);
          }

          if (args.stage === "finalize") {
            if (!args.runId) {
              throw new Error("fusion_native finalize requires 'runId'.");
            }
            const result = await nativeFinalize(
              {
                runId: args.runId,
                judgeOutput: args.judgeOutput,
                judgeError: args.judgeError,
                judgeTaskId: args.judgeTaskId,
                judgeSessionId: args.judgeSessionId,
              },
              { cwd, traceDir },
            );
            return JSON.stringify(result, null, 2);
          }

          if (args.stage === "audit_prepare") {
            if (!args.runId) {
              throw new Error("fusion_native audit_prepare requires 'runId'.");
            }
            const result = await nativePrepareAudit({ runId: args.runId }, { cwd, traceDir });
            return JSON.stringify(result, null, 2);
          }

          if (args.stage === "audit_finalize") {
            if (!args.runId) {
              throw new Error("fusion_native audit_finalize requires 'runId'.");
            }
            const result = await nativeFinalizeAudit(
              {
                runId: args.runId,
                auditOutput: args.auditOutput,
                auditError: args.auditError,
                auditTaskId: args.auditTaskId,
                auditSessionId: args.auditSessionId,
              },
              { cwd, traceDir },
            );
            return JSON.stringify(result, null, 2);
          }

          throw new Error(`Unknown fusion_native stage: ${String(args.stage)}`);
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
            const agentDir = defaultAgentDir();
            const presentAgents = await listFusionAgentFiles(agentDir);
            const agentLine = presentAgents.length
              ? `**Native subagent files present in:** ${agentDir} (${presentAgents.join(", ")})`
              : `**Native subagent files:** none found in ${agentDir}. Run \`/fusion-model set ...\` or \`npm run install:opencode-agents\` to generate them.`;
            if (saved) {
              return [
                formatSavedModelConfigMarkdown(saved, "Custom (saved)"),
                "",
                agentLine,
              ].join("\n");
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
              agentLine,
              "",
              "To customize:",
              "`/fusion-model provider/model1, provider/model2, provider/model3, provider/judge`",
              "`/fusion-model provider/model1/effort, provider/model2, provider/model3, provider/judge/high`",
              "To reset to defaults: `/fusion-model reset`",
            ].join("\n");
          }

          if (args.action === "reset") {
            await resetSavedModelConfig();
            const sync = await syncDefaultNativeAgents();
            return [
              "## Fusion Council Model Config Reset",
              "Custom config deleted. Defaults restored.",
              "",
              "**Panel models (default):**",
              ...getDefaultPanelModelSpecs().map((spec) => `- ${spec.modelId}`),
              "",
              `**Judge model (default):** ${getDefaultJudgeModelSpec().modelId}`,
              "",
              formatAgentSyncMarkdown(sync),
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
            const sync = await syncNativeAgents({ panelModels, judgeModel });
            return [
              formatUpdatedModelConfigMarkdown({ panelModels, judgeModel }),
              "",
              formatAgentSyncMarkdown(sync),
            ].join("\n");
          }

          throw new Error(`Unknown action: ${String(args.action)}`);
        },
      }),
    },
  };
};

export default fusionCouncilPlugin;

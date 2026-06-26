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
import {
  nativeAdvance,
  nativeCollect,
  nativeFinalize,
  nativeFinalizeAudit,
  nativePrepare,
  nativePrepareAudit,
  nativeRecordMainBaseline,
} from "./native/nativeCouncil.js";
import { nativeResume } from "./native/fusionResume.js";
import {
  launchRealParallelBuild,
  loadLatestSupervisorTrace,
  reportSupervisorStatus,
} from "./native/supervisorLaunch.js";
import { superviseRun } from "./native/fusionSupervisor.js";
import { renderSupervisorTrace } from "./native/supervisorTrace.js";
import { assertValidFusionRunId } from "./native/runLocator.js";
import type { FusionTraceOptions, NativePanelResult } from "./types.js";

const outputFormatSchema = tool.schema.enum(["markdown", "json"]);
const pluginModeSchema = tool.schema.enum(["plan", "review", "decision", "build_prompt", "architecture"]);
const modelSourceSchema = tool.schema.enum(["auto", "opencode", "direct"]);
const panelModeSchema = tool.schema.enum(["advisory", "candidate_build"]);
const buildStrategySchema = tool.schema.enum(["speculative_parallel_build"]);
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
          const traceDir = args.traceDir ?? pluginSettings.traceDir;

          // Prefer a hybrid_external_main_native_panels supervisor trace.
          const supervisor = await loadLatestSupervisorTrace(context.directory, traceDir);
          if (supervisor) {
            if (supervisor.kind === "supervisor") {
              return renderSupervisorTrace(supervisor.state);
            }
            return `Fusion supervisor run ${supervisor.runId} initialization failed: ${supervisor.error}`;
          }

          const trace = await loadLatestRunTrace(context.directory, traceDir);
          if (!trace) {
            return "No Fusion run trace found yet. Run `/fusion-build` or `/fusion-no-build` first.";
          }
          return formatLatestTraceSummary(trace);
        },
      }),

      fusion_native: tool({
        description:
          "Native-subagent Fusion Council orchestration. Drives panels and the judge as real OpenCode Task subagents (fusion-panel-1/2/3, fusion-judge) instead of hidden SDK sessions. Stages: prepare, advance, collect, record_main_baseline, finalize, audit_prepare, audit_finalize, resume. Does not call panel/judge models itself.",
        args: {
          stage: tool.schema.enum(["prepare", "advance", "collect", "record_main_baseline", "finalize", "audit_prepare", "audit_finalize", "resume"]).describe("Orchestration stage to execute."),
          task: tool.schema.string().optional().describe("Original user task text (required for prepare)."),
          mode: pluginModeSchema.optional().describe("Council mode (required for prepare)."),
          panelMode: panelModeSchema.optional().describe("advisory | candidate_build (required for prepare)."),
          buildStrategy: buildStrategySchema.optional().describe("Internal build strategy for /fusion-build. speculative_parallel_build prepares isolated candidate workspaces and a Merge Patch Contract judge flow."),
          files: tool.schema.array(tool.schema.string()).optional().describe("Project files to include as context (prepare)."),
          includeDiff: tool.schema.boolean().optional().describe("Include current git diff (prepare)."),
          promptVerbosity: tool.schema.enum(["compact", "standard", "detailed"]).optional().describe("Panel prompt verbosity (prepare)."),
          command: tool.schema.string().optional().describe("Command name for trace metadata, e.g. fusion-build or fusion-no-build (prepare)."),
          panelModels: tool.schema.array(tool.schema.string()).optional().describe("Override panel model IDs (prepare). Defaults to saved /fusion-model config."),
          judgeModel: tool.schema.string().optional().describe("Override judge model ID (prepare). Defaults to saved /fusion-model config."),
          requireAllPanels: tool.schema.boolean().optional().describe("Fail before judging unless every panel succeeds (prepare)."),
          minSuccessfulPanels: tool.schema.number().optional().describe("Minimum usable panels before judging (prepare, default 2)."),
          allowDegradedJudge: tool.schema.boolean().optional().describe("Allow judge in degraded quorum mode (prepare, default true)."),
          parallelExecutionSupported: tool.schema.boolean().optional().describe("Whether the orchestrator/runtime verified true non-blocking native subagent overlap support. If false for speculative_parallel_build, /fusion-build should abort before implementation."),
          runId: tool.schema.string().optional().describe("Fusion run id. Returned by prepare and required for collect/finalize. May be supplied to prepare to pin a deterministic run id (used by integration tests)."),
          mainBaselineStartedAt: tool.schema.string().optional().describe("ISO timestamp authorizing the main baseline to begin in the real workspace (advance). Authorization, not work."),
          mainBaselineFirstWorkAt: tool.schema.string().optional().describe("ISO timestamp of the first real parent/main workspace operation that changes or intentionally inspects implementation state (advance). Must reflect actual work, never a fabricated marker."),
          panelDispatches: tool.schema
            .array(
              tool.schema.object({
                logicalPanelIndex: tool.schema.number(),
                startReason: tool.schema.enum(["initial_immediate", "scheduled_delay", "recovery_rerun", "cascade_activity", "start_gate_timeout", "retry"]),
                startedAt: tool.schema.string().optional(),
                taskId: tool.schema.string().optional(),
                sessionId: tool.schema.string().optional(),
              }),
            )
            .optional()
            .describe("Panel dispatch events observed by the visible orchestrator (advance)."),
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
            .describe("Native panel subagent results (advance or collect). Pass one entry per panel returned by the Task tool."),
          panelObservations: tool.schema
            .array(
              tool.schema.object({
                logicalPanelIndex: tool.schema.number(),
                source: tool.schema.enum([
                  "assistant_output",
                  "reasoning_output",
                  "tool_call_start",
                  "tool_call_complete",
                  "tool_result",
                  "session_status",
                  "candidate_file_mutation",
                  "candidate_output_write",
                  "terminal_result",
                ]),
                observedAt: tool.schema.string().optional(),
              }),
            )
            .optional()
            .describe("Credible panel activity observations when the runtime exposes them (advance)."),
          judgeDispatched: tool.schema
            .object({
              startedAt: tool.schema.string().optional(),
              taskId: tool.schema.string().optional(),
              sessionId: tool.schema.string().optional(),
            })
            .optional()
            .describe("Judge dispatch event recorded immediately after the visible fusion-judge Task is started (advance)."),
          panelAttempts: tool.schema
            .array(
              tool.schema.object({
                logicalPanelIndex: tool.schema.number(),
                attempt: tool.schema.number(),
                nativeSessionId: tool.schema.string().optional(),
                model: tool.schema.string(),
                startedAt: tool.schema.string(),
                firstActivityAt: tool.schema.string().optional(),
                lastActivityAt: tool.schema.string().optional(),
                endedAt: tool.schema.string().optional(),
                status: tool.schema.enum(["queued", "waiting_for_previous_output", "waiting_for_activity", "running", "healthy", "suspected_stalled", "stalled", "cancelled", "retrying", "succeeded", "partial", "failed"]),
                startReason: tool.schema.enum(["initial_immediate", "scheduled_delay", "recovery_rerun", "cascade_activity", "start_gate_timeout", "retry"]),
                stallReason: tool.schema.enum(["inactivity_timeout", "task_timeout", "task_error", "cancelled_by_orchestrator"]).optional(),
              }),
            )
            .optional()
            .describe("Native panel attempt trace (collect). Records staggered cascade start reasons, same-slot retries, and liveness watchdog outcomes. Group retries under the original logical panel index (1-3); never create fusion-panel-4."),
          mainBaseline: tool.schema
            .object({
              startedAt: tool.schema.string().optional(),
              completedAt: tool.schema.string().optional(),
              status: tool.schema.enum(["queued", "running", "passed", "failed", "blocked"]),
              workspacePath: tool.schema.string(),
              changedFiles: tool.schema.array(tool.schema.string()),
              manifestPath: tool.schema.string().optional(),
              patchPath: tool.schema.string().optional(),
              verification: tool.schema
                .object({
                  typecheck: tool.schema.enum(["pass", "fail", "not_run"]).optional(),
                  test: tool.schema.enum(["pass", "fail", "not_run"]).optional(),
                  build: tool.schema.enum(["pass", "fail", "not_run"]).optional(),
                  commandsRun: tool.schema.array(tool.schema.string()).optional(),
                  notes: tool.schema.array(tool.schema.string()).optional(),
                })
                .optional(),
            })
            .optional()
            .describe("Main agent baseline trace for speculative_parallel_build. Record after the real-workspace baseline reaches a terminal state and before dispatching the judge."),
          judgeOutput: tool.schema.string().optional().describe("Native judge subagent output text (finalize)."),
          judgeError: tool.schema.string().optional().describe("Native judge subagent error message (finalize)."),
          judgeTaskId: tool.schema.string().optional().describe("Task id returned by the judge Task call (finalize)."),
          judgeSessionId: tool.schema.string().optional().describe("OpenCode session id of the judge child session (finalize)."),
          auditOutput: tool.schema.string().optional().describe("Native post-build audit output text (audit_finalize)."),
          auditError: tool.schema.string().optional().describe("Native post-build audit error message (audit_finalize)."),
          auditTaskId: tool.schema.string().optional().describe("Task id returned by the audit Task call (audit_finalize)."),
          auditSessionId: tool.schema.string().optional().describe("OpenCode session id of the audit child session (audit_finalize)."),
          appliedPatchItems: tool.schema
            .array(
              tool.schema.object({
                severity: tool.schema.enum(["BLOCKER", "MUST_FIX", "SAFE_ADDITION"]),
                title: tool.schema.string(),
                status: tool.schema.enum(["applied", "skipped", "failed"]),
              }),
            )
            .optional()
            .describe("Applied patch items from the Merge Patch Contract. Pass to audit_finalize after the main agent patches the real workspace."),
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
                runId: args.runId,
                panelMode: args.panelMode,
                buildStrategy: args.buildStrategy,
                files: args.files,
                includeDiff: args.includeDiff,
                promptVerbosity: args.promptVerbosity,
                command: args.command,
                panelModels: args.panelModels,
                judgeModel: args.judgeModel,
                requireAllPanels: args.requireAllPanels,
                minSuccessfulPanels: args.minSuccessfulPanels,
                allowDegradedJudge: args.allowDegradedJudge,
                parallelExecutionSupported: args.parallelExecutionSupported,
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

          if (args.stage === "advance") {
            assertValidFusionRunId(args.runId ?? "");
            const runId = args.runId!;
            const result = await nativeAdvance(
              {
                runId,
                mainBaselineStartedAt: args.mainBaselineStartedAt,
                mainBaselineFirstWorkAt: args.mainBaselineFirstWorkAt,
                panelDispatches: args.panelDispatches as import("./types.js").NativePanelDispatchEvent[] | undefined,
                panelResults: args.panelResults?.map((entry) => ({
                  ...entry,
                  errorType: entry.errorType as NativePanelResult["errorType"],
                })),
                panelObservations: args.panelObservations as import("./types.js").NativePanelObservation[] | undefined,
                judgeDispatched: args.judgeDispatched as import("./types.js").NativeJudgeDispatchEvent | undefined,
              },
              { cwd, traceDir },
            );
            return JSON.stringify(result, null, 2);
          }

          if (args.stage === "collect") {
            assertValidFusionRunId(args.runId ?? "");
            const runId = args.runId!;
            const result = await nativeCollect(
              {
                runId,
                panelResults: args.panelResults?.map((entry) => ({
                  ...entry,
                  errorType: entry.errorType as NativePanelResult["errorType"],
                })),
                panelAttempts: args.panelAttempts as import("./types.js").PanelAttemptTrace[] | undefined,
                mainBaseline: args.mainBaseline as import("./types.js").MainBaselineTrace | undefined,
              },
              { cwd, traceDir },
            );
            return JSON.stringify(result, null, 2);
          }

          if (args.stage === "record_main_baseline") {
            assertValidFusionRunId(args.runId ?? "");
            const runId = args.runId!;
            if (!args.mainBaseline) {
              throw new Error("fusion_native record_main_baseline requires 'mainBaseline'.");
            }
            const result = await nativeRecordMainBaseline(
              {
                runId,
                mainBaseline: args.mainBaseline as import("./types.js").MainBaselineTrace,
              },
              { cwd, traceDir },
            );
            return JSON.stringify(result, null, 2);
          }

          if (args.stage === "finalize") {
            assertValidFusionRunId(args.runId ?? "");
            const runId = args.runId!;
            const result = await nativeFinalize(
              {
                runId,
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
            assertValidFusionRunId(args.runId ?? "");
            const runId = args.runId!;
            const result = await nativePrepareAudit({ runId }, { cwd, traceDir });
            return JSON.stringify(result, null, 2);
          }

          if (args.stage === "audit_finalize") {
            assertValidFusionRunId(args.runId ?? "");
            const runId = args.runId!;
            const result = await nativeFinalizeAudit(
              {
                runId,
                auditOutput: args.auditOutput,
                auditError: args.auditError,
                auditTaskId: args.auditTaskId,
                auditSessionId: args.auditSessionId,
                appliedPatchItems: args.appliedPatchItems as import("./types.js").AppliedPatchItem[] | undefined,
              },
              { cwd, traceDir },
            );
            return JSON.stringify(result, null, 2);
          }

          if (args.stage === "resume") {
            const result = await nativeResume(
              {
                trace: {
                  saveRunArtifacts: args.saveRunArtifacts ?? pluginSettings.saveRunArtifacts,
                  keepPanelSessions: args.keepPanelSessions ?? true,
                  traceDir,
                  command: "fusion-resume",
                },
                runId: args.runId,
                panelModels: args.panelModels,
                judgeModel: args.judgeModel,
                requireAllPanels: args.requireAllPanels,
                minSuccessfulPanels: args.minSuccessfulPanels,
                allowDegradedJudge: args.allowDegradedJudge,
              },
              { cwd, traceDir },
            );
            return JSON.stringify(result, null, 2);
          }

          throw new Error(`Unknown fusion_native stage: ${String(args.stage)}`);
        },
      }),

      fusion_supervisor: tool({
        description:
          "Default /fusion-build engine: hybrid_external_main_native_panels. Launches a detached Node supervisor that spawns ONE external OpenCode CLI main builder in an isolated main candidate workspace and dispatches THREE visible native panel subagents concurrently, promotes the main candidate into the real source workspace on success, then dispatches a visible native judge that writes a Merge Patch Contract and applies targeted fixes itself to the real source workspace. Stages: launch (minimal bootstrap + detached supervisor), status (live worker/concurrency report), resume (reattach + continue without rerunning completed workers). Uses child_process.spawn of the installed opencode CLI for the main builder; never calls model APIs or hidden SDK runners.",
        args: {
          stage: tool.schema.enum(["launch", "status", "resume"]).describe("Supervisor stage."),
          task: tool.schema.string().optional().describe("Original user task text (required for launch)."),
          runId: tool.schema.string().optional().describe("Fusion run id (required for status/resume)."),
          panelModels: tool.schema.array(tool.schema.string()).optional().describe("Override panel model IDs (launch). Defaults to saved /fusion-model config."),
          judgeModel: tool.schema.string().optional().describe("Override judge model ID (launch)."),
          mainModel: tool.schema.string().optional().describe("Override main builder/patch worker model ID (launch). Defaults to FUSION_MAIN_MODEL env or panel model 1."),
          sourceWorkspace: tool.schema.string().optional().describe("Absolute path of the real source workspace owned by the main builder (launch). Defaults to the project directory."),
          command: tool.schema.string().optional().describe("Command name for trace metadata (launch)."),
          inline: tool.schema.boolean().optional().describe("Run the supervisor in-process instead of detached (testing/restricted environments)."),
          traceDir: tool.schema.string().optional().describe("Override trace artifact root directory."),
        },
        async execute(args, context) {
          const cwd = context.directory;
          const traceDir = args.traceDir ?? pluginSettings.traceDir;
          if (args.stage === "launch") {
            if (!args.task) throw new Error("fusion_supervisor launch requires 'task'.");
            const result = await launchRealParallelBuild({
              task: args.task,
              cwd,
              traceDir,
              command: args.command ?? "fusion-build",
              sourceWorkspace: args.sourceWorkspace,
              panelModels: args.panelModels,
              judgeModel: args.judgeModel,
              mainModel: args.mainModel,
              inline: args.inline,
            });
            return JSON.stringify(result, null, 2);
          }
          if (args.stage === "status") {
            assertValidFusionRunId(args.runId ?? "");
            return JSON.stringify(await reportSupervisorStatus(args.runId!, cwd, traceDir), null, 2);
          }
          if (args.stage === "resume") {
            assertValidFusionRunId(args.runId ?? "");
            const state = await superviseRun(args.runId!, { cwd, traceDir });
            return JSON.stringify({ runId: state.runId, phase: state.phase, concurrency: state.concurrency }, null, 2);
          }
          throw new Error(`Unknown fusion_supervisor stage: ${String(args.stage)}`);
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

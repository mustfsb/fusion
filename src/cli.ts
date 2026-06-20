#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { loadFusionConfig } from "./config.js";
import { formatCouncilResultMarkdown, runCouncil } from "./council/runCouncil.js";
import type { CouncilMode, PanelMode } from "./types.js";

const modeAliases: Record<string, CouncilMode> = {
  plan: "plan",
  review: "review",
  decision: "decision",
  "build-prompt": "build_prompt",
  build_prompt: "build_prompt",
  architecture: "architecture",
};

const panelModeAliases: Record<string, PanelMode> = {
  advisory: "advisory",
  candidate_build: "candidate_build",
  "candidate-build": "candidate_build",
};

const program = new Command()
  .name("fusion-council")
  .description("Run a provider-agnostic multi-model council for planning, review, decisions, prompts, and architecture.")
  .argument("[mode]", "plan | review | decision | build-prompt | architecture")
  .argument("[task...]", "task text")
  .option("--mode <mode>", "mode override")
  .option("--task <task>", "task text override")
  .option("--file <path...>", "selected files to include")
  .option("--diff", "include git diff")
  .option("--panel <model...>", "panel model ids")
  .option("--judge <model>", "judge model id")
  .option("--panel-mode <mode>", "advisory | candidate_build")
  .option("--require-all-panels", "fail before judging unless every requested panel model succeeds")
  .option("--min-successful-panels <count>", "minimum usable panels before judging (default 2)", parseInteger)
  .option("--allow-degraded-judge", "allow judge in degraded quorum mode (default true)")
  .option("--no-allow-degraded-judge", "disallow degraded judge mode")
  .option("--prompt-verbosity <level>", "compact | standard | detailed")
  .option("--panel-timeout-ms <ms>", "timeout in milliseconds for each panel model attempt", parseInteger)
  .option("--judge-timeout-ms <ms>", "timeout in milliseconds for the judge model call", parseInteger)
  .option("--panel-max-attempts <count>", "maximum attempts per panel model", parseInteger)
  .option("--repair-max-attempts <count>", "maximum repair attempts for near-valid candidate output", parseInteger)
  .option("--repair-timeout-ms <ms>", "timeout in milliseconds for candidate repair calls", parseInteger)
  .option("--model-source <source>", "auto | direct (opencode is only available inside the OpenCode plugin)", "auto")
  .option("--config <path>", "config path")
  .option("--json", "print JSON result")
  .option("--no-context", "disable automatic context collection")
  .action(async (modeArg: string | undefined, taskParts: string[], opts) => {
    const modeText = opts.mode ?? modeArg ?? "plan";
    const mode = modeAliases[modeText];
    if (!mode) throw new Error(`Unsupported mode '${modeText}'.`);
    const task = opts.task ?? taskParts.join(" ");
    const panelMode = opts.panelMode ? panelModeAliases[opts.panelMode] : undefined;
    if (!task.trim() && mode !== "review") throw new Error("Task is required.");
    if (opts.panelMode && !panelMode) throw new Error(`Unsupported panel mode '${opts.panelMode}'.`);

    const config = await loadFusionConfig(opts.config);
    const result = await runCouncil({
      task: task || "Review the provided context.",
      mode,
      panelMode,
      files: opts.file,
      includeDiff: Boolean(opts.diff),
      panelModels: opts.panel,
      judgeModel: opts.judge,
      requireAllPanels: Boolean(opts.requireAllPanels),
      minSuccessfulPanels: opts.minSuccessfulPanels,
      allowDegradedJudge: opts.allowDegradedJudge === false ? false : opts.allowDegradedJudge === true ? true : undefined,
      promptVerbosity: opts.promptVerbosity,
      panelTimeoutMs: opts.panelTimeoutMs,
      judgeTimeoutMs: opts.judgeTimeoutMs,
      panelMaxAttempts: opts.panelMaxAttempts,
      repairMaxAttempts: opts.repairMaxAttempts,
      repairTimeoutMs: opts.repairTimeoutMs,
      modelSource: opts.modelSource,
    }, { config, noContext: opts.context === false, modelSource: opts.modelSource });

    process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatCouncilResultMarkdown(result)}\n`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, got '${value}'.`);
  return parsed;
}

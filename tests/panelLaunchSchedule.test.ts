import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  PanelScheduler,
  buildPanelLaunchSchedule,
  PANEL_1_LAUNCH_DELAY_MS,
  PANEL_2_LAUNCH_DELAY_MS,
  PANEL_3_LAUNCH_DELAY_MS,
} from "../src/native/panelScheduler.js";
import { nativeAdvance, nativePrepare } from "../src/native/nativeCouncil.js";
import { loadRunState, writeRunState } from "../src/native/runState.js";
import { completeCandidate, conciseCompletedCandidate } from "./fixtures/candidates.js";

const PANEL_MODELS = ["provider-a/model-1", "provider-b/model-2", "provider-c/model-3"];

const PASS_SCRIPTS = {
  typecheck: "node -e \"process.exit(0)\"",
  test: "node -e \"process.exit(0)\"",
  build: "node -e \"process.exit(0)\"",
};

describe("absolute panel launch schedule (unit)", () => {
  test("default delays are 0 / 60s / 120s from the original launch clock", () => {
    expect(PANEL_1_LAUNCH_DELAY_MS).toBe(0);
    expect(PANEL_2_LAUNCH_DELAY_MS).toBe(60_000);
    expect(PANEL_3_LAUNCH_DELAY_MS).toBe(120_000);
  });

  test("buildPanelLaunchSchedule derives planned dispatch from a single anchor", () => {
    const anchor = 1_000_000;
    const schedule = buildPanelLaunchSchedule(anchor);
    expect(schedule.map((s) => s.panelIndex)).toEqual([1, 2, 3]);
    expect(schedule[0].plannedDispatchAt).toBe(anchor);
    expect(schedule[1].plannedDispatchAt).toBe(anchor + 60_000);
    expect(schedule[2].plannedDispatchAt).toBe(anchor + 120_000);
    expect(schedule[0].launchReason).toBe("initial_immediate");
    expect(schedule[1].launchReason).toBe("scheduled_delay");
    expect(schedule[2].launchReason).toBe("scheduled_delay");
    expect(schedule.every((s) => s.dispatchAt === null && s.scheduleSkewMs === null)).toBe(true);
  });

  test("panel 2 is due at anchor+60s regardless of panel 1 activity", () => {
    const anchor = 1_000;
    let now = anchor;
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => now });
    scheduler.setLaunchSchedule(buildPanelLaunchSchedule(anchor));
    // Panel 1 due immediately.
    expect(scheduler.nextScheduledAction()).toMatchObject({ type: "start_panel", panelIndex: 1 });
    scheduler.recordAttemptStart(1, "cascade_activity");
    // Panel 1 never produces activity. Before +60s, no new launch is due.
    now = anchor + 30_000;
    expect(scheduler.nextScheduledAction().type).toBe("wait");
    // At +60s panel 2 launches even though panel 1 is silent.
    now = anchor + 60_000;
    expect(scheduler.nextScheduledAction()).toMatchObject({ type: "start_panel", panelIndex: 2 });
  });

  test("panel 3 launches at anchor+120s even if panel 2 is silent/stalled", () => {
    let now = 0;
    const anchor = 1_000;
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => now });
    scheduler.setLaunchSchedule(buildPanelLaunchSchedule(anchor));
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = anchor + 60_000;
    scheduler.recordAttemptStart(2, "start_gate_timeout");
    now = anchor + 90_000;
    scheduler.markSuspectedStalled(2);
    // Panel 2 suspected stalled, no output — panel 3 still waits for its clock.
    expect(scheduler.nextScheduledAction().type).toBe("wait");
    now = anchor + 120_000;
    expect(scheduler.nextScheduledAction()).toMatchObject({ type: "start_panel", panelIndex: 3 });
  });

  test("same-slot retry fires immediately and does not create panel 4 or shift the schedule", () => {
    let now = 0;
    const anchor = 1_000;
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => now });
    const schedule = buildPanelLaunchSchedule(anchor);
    scheduler.setLaunchSchedule(schedule);
    scheduler.recordAttemptStart(2, "start_gate_timeout");
    now = anchor + 65_000;
    scheduler.recordAttemptEnd(2, "stalled", "task_timeout");
    // Retry is immediate, same slot, independent of the absolute schedule.
    const action = scheduler.nextScheduledAction();
    expect(action).toMatchObject({ type: "start_panel", panelIndex: 2, reason: "recovery_rerun" });
    scheduler.recordAttemptStart(2, "recovery_rerun");
    // Original panel 2/3 planned dispatch times are untouched.
    expect(schedule[1].plannedDispatchAt).toBe(anchor + 60_000);
    expect(schedule[2].plannedDispatchAt).toBe(anchor + 120_000);
    // No logical slot beyond 3 is ever produced.
    const slots = new Set(scheduler.getAttempts().map((a) => a.logicalPanelIndex));
    expect([...slots].every((s) => s <= 3)).toBe(true);
  });
});

describe("absolute panel launch schedule (advance route)", () => {
  let sourceWorkspace: string;
  let cacheRoot: string;
  const previousCacheRoot = process.env.FUSION_SPECULATIVE_CACHE_ROOT;

  beforeEach(async () => {
    sourceWorkspace = await mkdtemp(path.join(tmpdir(), "launch-sched-"));
    cacheRoot = await mkdtemp(path.join(tmpdir(), "fusion-cache-"));
    process.env.FUSION_SPECULATIVE_CACHE_ROOT = cacheRoot;
    await mkdir(path.join(sourceWorkspace, "src"), { recursive: true });
    await writeFile(path.join(sourceWorkspace, "package.json"), JSON.stringify({ name: "sched", scripts: PASS_SCRIPTS }), "utf8");
    await writeFile(path.join(sourceWorkspace, "src", "index.ts"), "export const value = 1;\n", "utf8");
  });

  afterEach(async () => {
    if (previousCacheRoot === undefined) delete process.env.FUSION_SPECULATIVE_CACHE_ROOT;
    else process.env.FUSION_SPECULATIVE_CACHE_ROOT = previousCacheRoot;
    await Promise.all([
      rm(sourceWorkspace, { recursive: true, force: true }),
      rm(cacheRoot, { recursive: true, force: true }),
    ]);
  });

  async function prepareRun(task: string) {
    return nativePrepare(
      {
        task,
        mode: "build_prompt",
        panelMode: "candidate_build",
        buildStrategy: "speculative_parallel_build",
        command: "fusion-build",
        minSuccessfulPanels: 2,
      },
      { cwd: sourceWorkspace },
    );
  }

  async function mutateCandidateWorkspace(runId: string, panelIndex: number, value: string) {
    const state = await loadRunState(sourceWorkspace, runId);
    const workspace = state.speculative?.candidateWorkspaces.find((entry) => entry.logicalPanelIndex === panelIndex);
    if (!workspace) throw new Error(`missing candidate workspace for panel ${panelIndex}`);
    await writeFile(path.join(workspace.workspacePath, "src", "index.ts"), `export const value = ${JSON.stringify(value)};\n`, "utf8");
  }

  test("main authorization and first-work markers are distinct and run-launch is traced", async () => {
    const prepare = await prepareRun("Distinct markers.");
    const afterPrepare = await loadRunState(sourceWorkspace, prepare.runId);
    expect(afterPrepare.speculative?.runLaunchRequestedAt).toBeTruthy();

    const authorizedAt = new Date().toISOString();
    await nativeAdvance({ runId: prepare.runId, mainBaselineStartedAt: authorizedAt }, { cwd: sourceWorkspace });
    const firstWorkAt = new Date(Date.now() + 5).toISOString();
    await nativeAdvance({ runId: prepare.runId, mainBaselineFirstWorkAt: firstWorkAt }, { cwd: sourceWorkspace });

    const state = await loadRunState(sourceWorkspace, prepare.runId);
    expect(state.speculative?.mainBaseline?.startAuthorizedAt).toBe(authorizedAt);
    expect(state.speculative?.mainBaseline?.firstWorkAt).toBe(firstWorkAt);
  });

  test("MAIN_BASELINE_SERIALIZED_BEHIND_PANELS is emitted when first work follows a panel terminal", async () => {
    const prepare = await prepareRun("Serialized detection.");
    // Authorize + stage, dispatch panels (creating attempts), then mark them
    // terminal so the panels produce real terminal endedAt timestamps.
    await nativeAdvance({ runId: prepare.runId, mainBaselineStartedAt: new Date().toISOString() }, { cwd: sourceWorkspace });
    await nativeAdvance({ runId: prepare.runId }, { cwd: sourceWorkspace });
    await nativeAdvance(
      {
        runId: prepare.runId,
        panelDispatches: [
          { logicalPanelIndex: 1, startReason: "initial_immediate", startedAt: new Date().toISOString() },
          { logicalPanelIndex: 2, startReason: "scheduled_delay", startedAt: new Date().toISOString() },
        ],
      },
      { cwd: sourceWorkspace },
    );
    await nativeAdvance(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: prepare.panelAgents[0].modelId, content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: prepare.panelAgents[1].modelId, content: completeCandidate },
        ],
      },
      { cwd: sourceWorkspace },
    );

    // First real main work happens AFTER the panels already finished — a hard
    // orchestration violation that must be surfaced, not hidden.
    const lateFirstWork = new Date(Date.now() + 60_000).toISOString();
    await nativeAdvance({ runId: prepare.runId, mainBaselineFirstWorkAt: lateFirstWork }, { cwd: sourceWorkspace });

    const state = await loadRunState(sourceWorkspace, prepare.runId);
    expect(state.speculative?.orchestrationViolations).toContain("MAIN_BASELINE_SERIALIZED_BEHIND_PANELS");
  });

  test("no serialization violation when main first work precedes panel terminals", async () => {
    const prepare = await prepareRun("No violation control.");
    const earlyFirstWork = new Date().toISOString();
    await nativeAdvance({ runId: prepare.runId, mainBaselineStartedAt: earlyFirstWork }, { cwd: sourceWorkspace });
    await nativeAdvance({ runId: prepare.runId, mainBaselineFirstWorkAt: earlyFirstWork }, { cwd: sourceWorkspace });
    await nativeAdvance({ runId: prepare.runId }, { cwd: sourceWorkspace });
    // Panels finish well after main first work.
    await new Promise((r) => setTimeout(r, 5));
    await nativeAdvance(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: prepare.panelAgents[0].modelId, content: completeCandidate },
          { agentName: "fusion-panel-2", modelId: prepare.panelAgents[1].modelId, content: completeCandidate },
        ],
      },
      { cwd: sourceWorkspace },
    );

    const state = await loadRunState(sourceWorkspace, prepare.runId);
    expect(state.speculative?.orchestrationViolations ?? []).not.toContain("MAIN_BASELINE_SERIALIZED_BEHIND_PANELS");
  });

  test("incremental judge manifest is written before the main baseline is terminal and inlines no source trees", async () => {
    const prepare = await prepareRun("Incremental judge manifest.");
    await nativeAdvance({ runId: prepare.runId }, { cwd: sourceWorkspace });
    await mutateCandidateWorkspace(prepare.runId, 1, "manifest-candidate");
    // One panel reaches a usable terminal state while main is still running.
    await nativeAdvance(
      {
        runId: prepare.runId,
        panelResults: [
          { agentName: "fusion-panel-1", modelId: prepare.panelAgents[0].modelId, content: conciseCompletedCandidate },
        ],
      },
      { cwd: sourceWorkspace },
    );

    const state = await loadRunState(sourceWorkspace, prepare.runId);
    // Main baseline is not terminal yet.
    expect(state.speculative?.mainBaseline?.status === "passed").toBe(false);
    const manifestPath = state.speculative?.judgeManifestPath;
    expect(manifestPath).toBeTruthy();

    const manifest = JSON.parse(await readFile(manifestPath!, "utf8"));
    expect(Array.isArray(manifest.panels)).toBe(true);
    expect(manifest.panels).toHaveLength(3);
    const panel1 = manifest.panels.find((p: { logicalPanelIndex: number }) => p.logicalPanelIndex === 1);
    expect(panel1.classification).toBe("usable");
    expect(typeof panel1.candidatePath).toBe("string");
    // Navigational evidence only: the full candidate proposal body is not inlined.
    expect(JSON.stringify(manifest)).not.toContain("Implementation Proposal");
  });
});

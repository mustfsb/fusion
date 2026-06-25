import type { FusionModelSpec, PanelLaunchReason, PanelLaunchSchedule } from "../types.js";

export const PANEL_START_GATE_TIMEOUT_MS = 60_000;
export const PANEL_INACTIVITY_TIMEOUT_MS = 90_000;
export const MAX_PANEL_ATTEMPTS = 2;
export const PANEL_COUNT = 3;
export const PANEL_START_GATE_FALLBACK_TIMEOUT_MS = 45_000;
export const PANEL_SUSPECTED_STALL_TIMEOUT_MS = 30_000;

/**
 * Absolute fixed-delay launch schedule. Panel 2 and Panel 3 timing derive only
 * from the original launch clock anchor, never from previous-panel activity,
 * output, success, failure, or completion. This replaces the legacy
 * activity-gated cascade for the purpose of *launching* panels. Activity/stall
 * detection still runs for tracing and same-slot retry, but it does not gate
 * the original Panel 2/3 launches.
 */
export const PANEL_1_LAUNCH_DELAY_MS = 0;
export const PANEL_2_LAUNCH_DELAY_MS = 60_000;
export const PANEL_3_LAUNCH_DELAY_MS = 120_000;
export const PANEL_LAUNCH_DELAYS_MS: readonly number[] = [
  PANEL_1_LAUNCH_DELAY_MS,
  PANEL_2_LAUNCH_DELAY_MS,
  PANEL_3_LAUNCH_DELAY_MS,
];

/**
 * Build the persisted absolute launch schedule from a single launch-clock
 * anchor. Each `plannedDispatchAt = anchor + fixedDelay`. Monotonic and
 * deterministic — no model reasoning required to compute the next due action.
 */
export function buildPanelLaunchSchedule(anchorMs: number): PanelLaunchSchedule[] {
  return PANEL_LAUNCH_DELAYS_MS.map((delay, index) => ({
    panelIndex: (index + 1) as 1 | 2 | 3,
    plannedDispatchAt: anchorMs + delay,
    dispatchRequestedAt: null,
    dispatchAt: null,
    launchReason: (index === 0 ? "initial_immediate" : "scheduled_delay") as PanelLaunchReason,
    scheduleSkewMs: null,
  }));
}

export type PanelAttemptStatus =
  | "queued"
  | "waiting_for_previous_output"
  | "waiting_for_activity"
  | "running"
  | "healthy"
  | "suspected_stalled"
  | "stalled"
  | "cancelled"
  | "retrying"
  | "succeeded"
  | "partial"
  | "failed";

export type PanelStartReason =
  | "initial_immediate"
  | "scheduled_delay"
  | "recovery_rerun"
  | "cascade_activity"
  | "start_gate_timeout"
  | "retry";

export type PanelStallReason =
  | "inactivity_timeout"
  | "task_timeout"
  | "task_error"
  | "cancelled_by_orchestrator";

export type PanelCredibleActivitySource =
  | "assistant_output"
  | "reasoning_output"
  | "tool_call_start"
  | "tool_call_complete"
  | "tool_result"
  | "session_status"
  | "candidate_file_mutation"
  | "candidate_output_write"
  | "terminal_result";

export type PanelActivityKind =
  | "session_created"
  | "assistant_text_delta"
  | "reasoning_delta"
  | "tool_call_start"
  | "tool_call_complete"
  | "tool_result"
  | "stream_event"
  | "polling_tick";

export type PanelLivenessCapability = {
  streamActivityExposed: boolean;
  tokenLevelLiveness: boolean;
  startGateFallback: boolean;
  taskTimeoutSupported: boolean;
  pendingToolActivityInspectable: boolean;
};

export type PanelAttemptTrace = {
  logicalPanelIndex: number;
  attempt: number;
  nativeSessionId?: string;
  model: string;
  startedAt: string;
  workspacePreparedAt?: string;
  dispatchAt?: string;
  fallbackGateAt?: string;
  firstActivityAt?: string;
  firstActivitySource?: PanelCredibleActivitySource;
  lastActivityAt?: string;
  lastActivitySource?: PanelCredibleActivitySource;
  suspectedStalledAt?: string;
  cancellationRequestedAt?: string;
  cancelledAt?: string;
  retryScheduledAt?: string;
  retryStartedAt?: string;
  endedAt?: string;
  status: PanelAttemptStatus;
  startReason: PanelStartReason;
  stallReason?: PanelStallReason;
  excludedAt?: string;
  excludedReason?: string;
};

export type PanelExecutionPlan = {
  panelCount: number;
  startGateTimeoutMs: number;
  inactivityTimeoutMs: number;
  maxAttemptsPerPanel: number;
  staggered: boolean;
  capability: PanelLivenessCapability;
  stages: PanelExecutionStage[];
};

export type PanelExecutionStage = {
  panelIndex: number;
  agentName: string;
  modelId: string;
  startsAfter: "immediately" | "launch_clock" | "previous_first_activity" | "previous_start_gate_timeout";
  startGateTimeoutMs: number;
};

export type PanelSchedulerAction =
  | { type: "start_panel"; panelIndex: number; attempt: number; reason: PanelStartReason }
  | { type: "cancel_panel"; panelIndex: number; attempt: number; reason: PanelStallReason }
  | { type: "wait"; deadlineMs: number; reason: "start_gate" | "inactivity" | "all_running" }
  | { type: "done" };

export const PANEL_LIVENESS_CAPABILITY: PanelLivenessCapability = {
  streamActivityExposed: false,
  tokenLevelLiveness: false,
  startGateFallback: true,
  taskTimeoutSupported: true,
  pendingToolActivityInspectable: false,
};

export function isActivityMeaningful(kind: PanelActivityKind): boolean {
  return kind !== "session_created" && kind !== "polling_tick";
}

export type PanelSchedulerOptions = {
  now?: () => number;
  startGateTimeoutMs?: number;
  startGateFallbackTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  maxAttempts?: number;
  capability?: PanelLivenessCapability;
};

export function buildPanelExecutionPlan(
  panelAgents: Array<{ panelIndex: number; agentName: string; modelId: string }>,
  panelModelSpecs: FusionModelSpec[],
  options?: {
    startGateTimeoutMs?: number;
    inactivityTimeoutMs?: number;
    maxAttempts?: number;
    capability?: PanelLivenessCapability;
  },
): PanelExecutionPlan {
  const startGateTimeoutMs = options?.startGateTimeoutMs ?? PANEL_START_GATE_TIMEOUT_MS;
  const inactivityTimeoutMs = options?.inactivityTimeoutMs ?? PANEL_INACTIVITY_TIMEOUT_MS;
  const maxAttempts = options?.maxAttempts ?? MAX_PANEL_ATTEMPTS;
  const capability = options?.capability ?? PANEL_LIVENESS_CAPABILITY;
  const stages: PanelExecutionStage[] = panelAgents.map((agent, index) => ({
    panelIndex: agent.panelIndex,
    agentName: agent.agentName,
    modelId: agent.modelId,
    startsAfter: index === 0 ? "immediately" : "launch_clock",
    startGateTimeoutMs,
  }));
  return {
    panelCount: panelAgents.length,
    startGateTimeoutMs,
    inactivityTimeoutMs,
    maxAttemptsPerPanel: maxAttempts,
    staggered: true,
    capability,
    stages,
  };
}

export class PanelScheduler {
  private readonly attempts: PanelAttemptTrace[] = [];
  private readonly activityBySlot: Map<number, { first: number; last: number; pendingTool: boolean }> = new Map();
  private readonly options: Required<PanelSchedulerOptions>;
  private readonly panelModels: string[];
  private launchSchedule: PanelLaunchSchedule[] | undefined;

  constructor(panelModels: string[], options?: PanelSchedulerOptions) {
    this.panelModels = panelModels.slice(0, PANEL_COUNT);
    this.options = {
      now: options?.now ?? Date.now,
      startGateTimeoutMs: options?.startGateTimeoutMs ?? PANEL_START_GATE_TIMEOUT_MS,
      startGateFallbackTimeoutMs: options?.startGateFallbackTimeoutMs ?? PANEL_START_GATE_FALLBACK_TIMEOUT_MS,
      inactivityTimeoutMs: options?.inactivityTimeoutMs ?? PANEL_INACTIVITY_TIMEOUT_MS,
      maxAttempts: options?.maxAttempts ?? MAX_PANEL_ATTEMPTS,
      capability: options?.capability ?? PANEL_LIVENESS_CAPABILITY,
    };
  }

  getCapability(): PanelLivenessCapability {
    return { ...this.options.capability };
  }

  /** Install the persisted absolute launch schedule that drives launch timing. */
  setLaunchSchedule(schedule: PanelLaunchSchedule[] | undefined): void {
    this.launchSchedule = schedule ? schedule.map((entry) => ({ ...entry })) : undefined;
  }

  private plannedDispatchAt(panelIndex: number): number | undefined {
    const entry = this.launchSchedule?.find((s) => s.panelIndex === panelIndex);
    return entry?.plannedDispatchAt;
  }

  /**
   * Schedule-driven next action. Original Panel 2/3 launches are gated only by
   * the absolute `plannedDispatchAt` clock — never by previous-panel activity,
   * output, success, failure, retry, or timeout. Same-slot retries fire
   * immediately and do not alter the original launch schedule. Stall/cancel
   * detection still runs for tracing. Falls back to the legacy activity cascade
   * only when no launch schedule has been installed.
   */
  nextScheduledAction(): PanelSchedulerAction {
    if (!this.launchSchedule) return this.nextAction();
    const now = this.options.now();
    for (let i = 1; i <= PANEL_COUNT; i += 1) {
      if (this.shouldMarkSuspectedStalled(i)) this.markSuspectedStalled(i);
    }
    for (let i = 1; i <= PANEL_COUNT; i += 1) {
      const cancel = this.shouldCancelForInactivity(i);
      if (cancel.cancel) {
        const attempt = this.currentAttempt(i);
        return { type: "cancel_panel", panelIndex: i, attempt: attempt?.attempt ?? 1, reason: cancel.reason ?? "inactivity_timeout" };
      }
    }
    // Same-slot retries first — immediate, independent of the launch schedule.
    for (let i = 1; i <= PANEL_COUNT; i += 1) {
      const current = this.currentAttempt(i);
      if (current && (current.status === "stalled" || current.status === "cancelled") && current.attempt < this.options.maxAttempts) {
        return { type: "start_panel", panelIndex: i, attempt: current.attempt + 1, reason: "recovery_rerun" };
      }
    }
    // Fresh launches: a slot that has never been dispatched launches the moment
    // its absolute plannedDispatchAt is due, regardless of any other panel.
    for (let i = 1; i <= PANEL_COUNT; i += 1) {
      if (this.currentAttempt(i)) continue;
      const due = this.plannedDispatchAt(i) ?? now;
      if (now >= due) {
        return { type: "start_panel", panelIndex: i, attempt: 1, reason: i === 1 ? "initial_immediate" : "scheduled_delay" };
      }
    }
    if (this.isTerminal()) return { type: "done" };
    // Wait until the next not-yet-launched slot becomes due, or a liveness
    // deadline for an active slot when token-level telemetry is exposed.
    const deadlines: number[] = [];
    for (let i = 1; i <= PANEL_COUNT; i += 1) {
      if (!this.currentAttempt(i)) {
        const due = this.plannedDispatchAt(i);
        if (due !== undefined && due > now) deadlines.push(due);
        continue;
      }
      const attempt = this.currentAttempt(i);
      if (attempt && this.options.capability.tokenLevelLiveness
        && ["waiting_for_activity", "running", "healthy", "suspected_stalled", "retrying"].includes(attempt.status)) {
        const activity = this.activityBySlot.get(i);
        const lastTs = activity?.last ?? new Date(attempt.startedAt).getTime();
        deadlines.push(lastTs + this.options.inactivityTimeoutMs);
      }
    }
    if (deadlines.length === 0) {
      return { type: "wait", deadlineMs: now + 15_000, reason: "all_running" };
    }
    return { type: "wait", deadlineMs: Math.min(...deadlines), reason: "all_running" };
  }

  getAttempts(): PanelAttemptTrace[] {
    return this.attempts.map((a) => ({ ...a }));
  }

  loadAttempts(attempts: PanelAttemptTrace[]): void {
    this.attempts.splice(0, this.attempts.length, ...attempts.map((attempt) => ({ ...attempt })));
    this.activityBySlot.clear();
    for (const attempt of this.attempts) {
      const first = attempt.firstActivityAt ? Date.parse(attempt.firstActivityAt) : NaN;
      const last = attempt.lastActivityAt ? Date.parse(attempt.lastActivityAt) : NaN;
      if (Number.isFinite(first) || Number.isFinite(last)) {
        this.activityBySlot.set(attempt.logicalPanelIndex, {
          first: Number.isFinite(first) ? first : Number.isFinite(last) ? last : new Date(attempt.startedAt).getTime(),
          last: Number.isFinite(last) ? last : Number.isFinite(first) ? first : new Date(attempt.startedAt).getTime(),
          pendingTool: false,
        });
      }
    }
  }

  currentAttempt(panelIndex: number): PanelAttemptTrace | undefined {
    const matches = this.attempts.filter((a) => a.logicalPanelIndex === panelIndex);
    if (matches.length === 0) return undefined;
    return matches[matches.length - 1];
  }

  hasSlotFinished(panelIndex: number): boolean {
    const attempt = this.currentAttempt(panelIndex);
    if (!attempt) return false;
    return attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "cancelled";
  }

  isSlotExhausted(panelIndex: number): boolean {
    const attempt = this.currentAttempt(panelIndex);
    if (!attempt) return false;
    if (attempt.status === "succeeded") return true;
    if (attempt.status === "failed") return true;
    if ((attempt.status === "stalled" || attempt.status === "cancelled") && attempt.attempt >= this.options.maxAttempts) return true;
    return false;
  }

  isTerminal(): boolean {
    for (let i = 1; i <= PANEL_COUNT; i += 1) {
      if (!this.isSlotExhausted(i)) return false;
    }
    return true;
  }

  recordAttemptStart(panelIndex: number, reason: PanelStartReason, sessionId?: string): PanelAttemptTrace {
    const previous = this.currentAttempt(panelIndex);
    const attemptNumber = previous ? previous.attempt + 1 : 1;
    const ts = new Date(this.options.now()).toISOString();
    const trace: PanelAttemptTrace = {
      logicalPanelIndex: panelIndex,
      attempt: attemptNumber,
      nativeSessionId: sessionId,
      model: this.panelModels[panelIndex - 1] ?? this.panelModels[0] ?? "",
      startedAt: ts,
      dispatchAt: ts,
      fallbackGateAt: new Date(this.options.now() + this.options.startGateFallbackTimeoutMs).toISOString(),
      status: "waiting_for_activity",
      startReason: reason,
    };
    this.attempts.push(trace);
    return { ...trace };
  }

  markWorkspacePrepared(panelIndex: number, preparedAt?: string): void {
    const attempt = this.currentAttempt(panelIndex);
    if (!attempt) return;
    attempt.workspacePreparedAt = preparedAt ?? new Date(this.options.now()).toISOString();
  }

  recordActivity(panelIndex: number, kind: PanelActivityKind): void {
    if (!isActivityMeaningful(kind)) return;
    if (!this.options.capability.streamActivityExposed) return;
    const now = this.options.now();
    const existing = this.activityBySlot.get(panelIndex);
    if (existing) {
      existing.last = now;
      if (kind === "tool_call_start") existing.pendingTool = true;
      if (kind === "tool_call_complete" || kind === "tool_result") existing.pendingTool = false;
    } else {
      this.activityBySlot.set(panelIndex, { first: now, last: now, pendingTool: kind === "tool_call_start" });
    }
    const attempt = this.currentAttempt(panelIndex);
    if (attempt && (attempt.status === "running" || attempt.status === "waiting_for_activity" || attempt.status === "suspected_stalled")) {
      const ts = new Date(now).toISOString();
      if (!attempt.firstActivityAt) attempt.firstActivityAt = ts;
      attempt.lastActivityAt = ts;
      attempt.firstActivitySource ??= mapActivityKindToSource(kind);
      attempt.lastActivitySource = mapActivityKindToSource(kind);
      attempt.status = "healthy";
    }
  }

  recordCredibleActivity(
    panelIndex: number,
    source: PanelCredibleActivitySource,
    observedAt = new Date(this.options.now()).toISOString(),
  ): void {
    const attempt = this.currentAttempt(panelIndex);
    if (!attempt) return;
    const observedMs = Date.parse(observedAt);
    const existing = this.activityBySlot.get(panelIndex);
    if (existing && Number.isFinite(observedMs)) {
      existing.last = observedMs;
      if (!attempt.firstActivityAt) existing.first = observedMs;
    } else if (Number.isFinite(observedMs)) {
      this.activityBySlot.set(panelIndex, { first: observedMs, last: observedMs, pendingTool: false });
    }
    if (!attempt.firstActivityAt) {
      attempt.firstActivityAt = observedAt;
      attempt.firstActivitySource = source;
    }
    attempt.lastActivityAt = observedAt;
    attempt.lastActivitySource = source;
    attempt.status = attempt.status === "retrying" ? "retrying" : "healthy";
  }

  markSuspectedStalled(panelIndex: number, observedAt = new Date(this.options.now()).toISOString()): void {
    const attempt = this.currentAttempt(panelIndex);
    if (!attempt || attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "cancelled") return;
    attempt.suspectedStalledAt ??= observedAt;
    if (attempt.status === "waiting_for_activity" || attempt.status === "running" || attempt.status === "healthy") {
      attempt.status = "suspected_stalled";
    }
  }

  recordAttemptEnd(panelIndex: number, status: PanelAttemptStatus, stallReason?: PanelStallReason): void {
    const attempt = this.currentAttempt(panelIndex);
    if (!attempt || (attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "cancelled" || attempt.status === "partial")) return;
    attempt.endedAt = new Date(this.options.now()).toISOString();
    attempt.status = status;
    if (stallReason) attempt.stallReason = stallReason;
    if (status === "cancelled") {
      attempt.cancelledAt = attempt.endedAt;
    }
  }

  shouldStartPanel(panelIndex: number): { start: boolean; reason: PanelStartReason } {
    if (panelIndex < 1 || panelIndex > PANEL_COUNT) return { start: false, reason: "cascade_activity" };
    const current = this.currentAttempt(panelIndex);
    if (current && (current.status === "waiting_for_activity" || current.status === "running" || current.status === "healthy" || current.status === "suspected_stalled" || current.status === "retrying")) {
      return { start: false, reason: "cascade_activity" };
    }
    if (current && (current.status === "stalled" || current.status === "cancelled")) {
      if (current.attempt < this.options.maxAttempts) return { start: true, reason: "retry" };
      return { start: false, reason: "cascade_activity" };
    }
    if (current && (current.status === "succeeded" || current.status === "failed")) {
      return { start: false, reason: "cascade_activity" };
    }
    if (panelIndex === 1) return { start: true, reason: "cascade_activity" };
    const prevIndex = panelIndex - 1;
    const prev = this.currentAttempt(prevIndex);
    if (!prev) return { start: false, reason: "cascade_activity" };
    if (prev.firstActivityAt) {
      return { start: true, reason: "cascade_activity" };
    }
    const prevActivity = this.activityBySlot.get(prevIndex);
    if (prevActivity && this.options.capability.streamActivityExposed) {
      return { start: true, reason: "cascade_activity" };
    }
    if (prev.status === "succeeded" || prev.status === "failed" || prev.status === "cancelled") {
      return { start: true, reason: "cascade_activity" };
    }
    const prevStartMs = new Date(prev.startedAt).getTime();
    const elapsed = this.options.now() - prevStartMs;
    if (elapsed >= this.options.startGateFallbackTimeoutMs) {
      return { start: true, reason: "start_gate_timeout" };
    }
    return { start: false, reason: "cascade_activity" };
  }

  shouldMarkSuspectedStalled(panelIndex: number): boolean {
    const attempt = this.currentAttempt(panelIndex);
    if (!attempt || attempt.endedAt) return false;
    if (attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "cancelled" || attempt.status === "stalled" || attempt.status === "partial") {
      return false;
    }
    const start = new Date(attempt.startedAt).getTime();
    const reference = attempt.lastActivityAt ? Date.parse(attempt.lastActivityAt) : start;
    return this.options.now() - reference >= PANEL_SUSPECTED_STALL_TIMEOUT_MS;
  }

  shouldCancelForInactivity(panelIndex: number): { cancel: boolean; reason?: PanelStallReason } {
    if (!this.options.capability.streamActivityExposed || !this.options.capability.tokenLevelLiveness) {
      return { cancel: false };
    }
    const attempt = this.currentAttempt(panelIndex);
    if (!attempt || !["waiting_for_activity", "running", "healthy", "suspected_stalled", "retrying"].includes(attempt.status)) {
      return { cancel: false };
    }
    const activity = this.activityBySlot.get(panelIndex);
    const lastTs = activity?.last ?? new Date(attempt.startedAt).getTime();
    const elapsed = this.options.now() - lastTs;
    if (elapsed <= this.options.inactivityTimeoutMs) return { cancel: false };
    if (activity?.pendingTool && this.options.capability.pendingToolActivityInspectable) {
      return { cancel: false };
    }
    return { cancel: true, reason: "inactivity_timeout" };
  }

  nextAction(): PanelSchedulerAction {
    for (let i = 1; i <= PANEL_COUNT; i += 1) {
      if (this.shouldMarkSuspectedStalled(i)) {
        this.markSuspectedStalled(i);
      }
    }
    for (let i = 1; i <= PANEL_COUNT; i += 1) {
      const cancel = this.shouldCancelForInactivity(i);
      if (cancel.cancel) {
        const attempt = this.currentAttempt(i);
        return { type: "cancel_panel", panelIndex: i, attempt: attempt?.attempt ?? 1, reason: cancel.reason ?? "inactivity_timeout" };
      }
    }
    for (let i = 1; i <= PANEL_COUNT; i += 1) {
      const start = this.shouldStartPanel(i);
      if (start.start) {
        const current = this.currentAttempt(i);
        const attemptNum = current ? current.attempt + 1 : 1;
        return { type: "start_panel", panelIndex: i, attempt: attemptNum, reason: start.reason };
      }
    }
    if (this.isTerminal()) return { type: "done" };
    const deadlines: number[] = [];
    for (let i = 1; i <= PANEL_COUNT; i += 1) {
      const attempt = this.currentAttempt(i);
      if (attempt && (attempt.status === "waiting_for_activity" || attempt.status === "running" || attempt.status === "healthy" || attempt.status === "suspected_stalled" || attempt.status === "retrying")) {
        if (this.options.capability.tokenLevelLiveness) {
          const activity = this.activityBySlot.get(i);
          const lastTs = activity?.last ?? new Date(attempt.startedAt).getTime();
          deadlines.push(lastTs + this.options.inactivityTimeoutMs);
        }
      }
      if (i < PANEL_COUNT) {
        const prev = this.currentAttempt(i);
        if (prev && !prev.endedAt && !prev.firstActivityAt) {
          deadlines.push(new Date(prev.startedAt).getTime() + this.options.startGateFallbackTimeoutMs);
        }
      }
    }
    if (deadlines.length === 0) return { type: "done" };
    const nearest = Math.min(...deadlines);
    return { type: "wait", deadlineMs: nearest, reason: "all_running" };
  }

  hasLivenessTelemetry(): boolean {
    return this.options.capability.streamActivityExposed && this.options.capability.tokenLevelLiveness;
  }
}

export function formatPanelLivenessCapabilityMarkdown(capability: PanelLivenessCapability): string {
  return [
    "- streamActivityExposed: " + (capability.streamActivityExposed ? "yes" : "no"),
    "- tokenLevelLiveness: " + (capability.tokenLevelLiveness ? "yes" : "no"),
    "- startGateFallback: " + (capability.startGateFallback ? "yes" : "no"),
    "- taskTimeoutSupported: " + (capability.taskTimeoutSupported ? "yes" : "no"),
    "- pendingToolActivityInspectable: " + (capability.pendingToolActivityInspectable ? "yes" : "no"),
  ].join("\n");
}

function mapActivityKindToSource(kind: PanelActivityKind): PanelCredibleActivitySource {
  switch (kind) {
    case "assistant_text_delta":
      return "assistant_output";
    case "reasoning_delta":
      return "reasoning_output";
    case "tool_call_start":
      return "tool_call_start";
    case "tool_call_complete":
      return "tool_call_complete";
    case "tool_result":
      return "tool_result";
    default:
      return "session_status";
  }
}

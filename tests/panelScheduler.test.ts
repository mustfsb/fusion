import { describe, expect, test } from "vitest";
import {
  MAX_PANEL_ATTEMPTS,
  PANEL_INACTIVITY_TIMEOUT_MS,
  PANEL_LIVENESS_CAPABILITY,
  PANEL_START_GATE_TIMEOUT_MS,
  PanelScheduler,
  buildPanelExecutionPlan,
  isActivityMeaningful,
  type PanelActivityKind,
  type PanelLivenessCapability,
} from "../src/native/panelScheduler.js";

const PANEL_MODELS = ["provider-a/model-1", "provider-b/model-2", "provider-c/model-3"];

function makeCapability(overrides: Partial<PanelLivenessCapability> = {}): PanelLivenessCapability {
  return { ...PANEL_LIVENESS_CAPABILITY, ...overrides };
}

describe("panel scheduler constants", () => {
  test("start-gate timeout is 60 seconds", () => {
    expect(PANEL_START_GATE_TIMEOUT_MS).toBe(60_000);
  });

  test("inactivity timeout is 90 seconds", () => {
    expect(PANEL_INACTIVITY_TIMEOUT_MS).toBe(90_000);
  });

  test("max panel attempts is 2 (one original plus one retry)", () => {
    expect(MAX_PANEL_ATTEMPTS).toBe(2);
  });

  test("default capability honestly reports no stream activity exposed", () => {
    expect(PANEL_LIVENESS_CAPABILITY.streamActivityExposed).toBe(false);
    expect(PANEL_LIVENESS_CAPABILITY.tokenLevelLiveness).toBe(false);
    expect(PANEL_LIVENESS_CAPABILITY.startGateFallback).toBe(true);
    expect(PANEL_LIVENESS_CAPABILITY.taskTimeoutSupported).toBe(true);
    expect(PANEL_LIVENESS_CAPABILITY.pendingToolActivityInspectable).toBe(false);
  });
});

describe("isActivityMeaningful", () => {
  test("session_created is not meaningful", () => {
    expect(isActivityMeaningful("session_created")).toBe(false);
  });

  test("polling_tick is not meaningful", () => {
    expect(isActivityMeaningful("polling_tick")).toBe(false);
  });

  test("assistant_text_delta is meaningful", () => {
    expect(isActivityMeaningful("assistant_text_delta")).toBe(true);
  });

  test("tool_call_start is meaningful", () => {
    expect(isActivityMeaningful("tool_call_start")).toBe(true);
  });

  test("tool_result is meaningful", () => {
    expect(isActivityMeaningful("tool_result")).toBe(true);
  });
});

describe("buildPanelExecutionPlan", () => {
  test("panel 1 starts immediately, panels 2 and 3 start after previous first activity", () => {
    const plan = buildPanelExecutionPlan(
      [
        { panelIndex: 1, agentName: "fusion-panel-1", modelId: "provider-a/model-1" },
        { panelIndex: 2, agentName: "fusion-panel-2", modelId: "provider-b/model-2" },
        { panelIndex: 3, agentName: "fusion-panel-3", modelId: "provider-c/model-3" },
      ],
      [
        { modelId: "provider-a/model-1", raw: "provider-a/model-1" },
        { modelId: "provider-b/model-2", raw: "provider-b/model-2" },
        { modelId: "provider-c/model-3", raw: "provider-c/model-3" },
      ],
    );
    expect(plan.staggered).toBe(true);
    expect(plan.startGateTimeoutMs).toBe(PANEL_START_GATE_TIMEOUT_MS);
    expect(plan.inactivityTimeoutMs).toBe(PANEL_INACTIVITY_TIMEOUT_MS);
    expect(plan.maxAttemptsPerPanel).toBe(MAX_PANEL_ATTEMPTS);
    expect(plan.stages[0].startsAfter).toBe("immediately");
    expect(plan.stages[1].startsAfter).toBe("previous_first_activity");
    expect(plan.stages[2].startsAfter).toBe("previous_first_activity");
    expect(plan.capability).toEqual(PANEL_LIVENESS_CAPABILITY);
  });
});

describe("cascade scheduling", () => {
  test("panel 1 starts first", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    const start = scheduler.shouldStartPanel(1);
    expect(start.start).toBe(true);
    expect(start.reason).toBe("cascade_activity");
  });

  test("panel 2 does not start before panel 1 has produced activity or start-gate timeout", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, {
      now: () => 0,
      capability: makeCapability({ streamActivityExposed: true, tokenLevelLiveness: true }),
    });
    scheduler.recordAttemptStart(1, "cascade_activity");
    const start = scheduler.shouldStartPanel(2);
    expect(start.start).toBe(false);
  });

  test("panel 2 starts after panel 1 first observable activity when stream activity is exposed", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, {
      now: () => now,
      capability: makeCapability({ streamActivityExposed: true, tokenLevelLiveness: true }),
    });
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = 5_000;
    scheduler.recordActivity(1, "assistant_text_delta");
    const start = scheduler.shouldStartPanel(2);
    expect(start.start).toBe(true);
    expect(start.reason).toBe("cascade_activity");
  });

  test("panel 2 starts after 60-second gate timeout when panel 1 stays silent (no stream activity exposed)", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => now });
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = 30_000;
    expect(scheduler.shouldStartPanel(2).start).toBe(false);
    now = 60_000;
    const start = scheduler.shouldStartPanel(2);
    expect(start.start).toBe(true);
    expect(start.reason).toBe("start_gate_timeout");
  });

  test("panel 3 remains staggered and does not start simultaneously with panel 2", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => now });
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = 60_000;
    expect(scheduler.shouldStartPanel(2).start).toBe(true);
    // Panel 2 hasn't actually been recorded as started yet
    expect(scheduler.shouldStartPanel(3).start).toBe(false);
    // Now record panel 2 start
    scheduler.recordAttemptStart(2, "start_gate_timeout");
    // Panel 3 still waits for panel 2 activity or its own 60s gate
    expect(scheduler.shouldStartPanel(3).start).toBe(false);
    now = 120_000;
    const start3 = scheduler.shouldStartPanel(3);
    expect(start3.start).toBe(true);
    expect(start3.reason).toBe("start_gate_timeout");
  });

  test("terminal failure of panel 1 does not permanently block subsequent slots", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    scheduler.recordAttemptStart(1, "cascade_activity");
    // First attempt stalls (retryable)
    scheduler.recordAttemptEnd(1, "stalled", "task_timeout");
    const retry = scheduler.shouldStartPanel(1);
    expect(retry.start).toBe(true);
    expect(retry.reason).toBe("retry");
    scheduler.recordAttemptStart(1, "retry");
    // Retry fails permanently — panel 1 is now exhausted
    scheduler.recordAttemptEnd(1, "failed", "task_error");
    // Panel 2 should start despite panel 1 being terminally failed
    const start2 = scheduler.shouldStartPanel(2);
    expect(start2.start).toBe(true);
    expect(start2.reason).toBe("cascade_activity");
  });

  test("panel 2 starts immediately when panel 1 finishes before 60s", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => now });
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = 10_000;
    scheduler.recordAttemptEnd(1, "succeeded");
    const start = scheduler.shouldStartPanel(2);
    expect(start.start).toBe(true);
    expect(start.reason).toBe("cascade_activity");
  });
});

describe("liveness and retry", () => {
  test("meaningful activity resets the 90-second timer when stream activity is exposed", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, {
      now: () => now,
      capability: makeCapability({ streamActivityExposed: true, tokenLevelLiveness: true }),
    });
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = 80_000;
    scheduler.recordActivity(1, "assistant_text_delta");
    now = 90_000;
    // 10s since last activity — should NOT cancel
    expect(scheduler.shouldCancelForInactivity(1).cancel).toBe(false);
    now = 170_000;
    // 90s since last activity — at boundary, should NOT cancel
    expect(scheduler.shouldCancelForInactivity(1).cancel).toBe(false);
    now = 170_001;
    // 90.001s since last activity — just over boundary, should cancel
    const cancel = scheduler.shouldCancelForInactivity(1);
    expect(cancel.cancel).toBe(true);
    expect(cancel.reason).toBe("inactivity_timeout");
  });

  test("polling alone does not reset the timer", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, {
      now: () => now,
      capability: makeCapability({ streamActivityExposed: true, tokenLevelLiveness: true }),
    });
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = 50_000;
    scheduler.recordActivity(1, "polling_tick");
    now = 50_000 + PANEL_INACTIVITY_TIMEOUT_MS + 1_000;
    const cancel = scheduler.shouldCancelForInactivity(1);
    expect(cancel.cancel).toBe(true);
    expect(cancel.reason).toBe("inactivity_timeout");
  });

  test("a stalled panel is cancelled and retried exactly once", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    scheduler.recordAttemptStart(1, "cascade_activity");
    scheduler.recordAttemptEnd(1, "stalled", "task_timeout");
    expect(scheduler.currentAttempt(1)?.status).toBe("stalled");
    expect(scheduler.currentAttempt(1)?.attempt).toBe(1);
    const retry = scheduler.shouldStartPanel(1);
    expect(retry.start).toBe(true);
    expect(retry.reason).toBe("retry");
    scheduler.recordAttemptStart(1, "retry");
    expect(scheduler.currentAttempt(1)?.attempt).toBe(2);
    scheduler.recordAttemptEnd(1, "succeeded");
    expect(scheduler.currentAttempt(1)?.status).toBe("succeeded");
    // No more retries after attempt 2 succeeded
    const again = scheduler.shouldStartPanel(1);
    expect(again.start).toBe(false);
  });

  test("retry stays attached to the same logical panel index", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    scheduler.recordAttemptStart(2, "start_gate_timeout");
    scheduler.recordAttemptEnd(2, "stalled", "task_timeout");
    scheduler.recordAttemptStart(2, "retry");
    const attempts = scheduler.getAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.logicalPanelIndex === 2)).toBe(true);
    expect(attempts[0].attempt).toBe(1);
    expect(attempts[1].attempt).toBe(2);
    expect(attempts[1].startReason).toBe("retry");
  });

  test("no fusion-panel-4 logical slot is created", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    expect(scheduler.shouldStartPanel(4).start).toBe(false);
    expect(scheduler.shouldStartPanel(0).start).toBe(false);
    expect(scheduler.shouldStartPanel(5).start).toBe(false);
  });

  test("exhausted retries produce a clear failed-panel state", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    scheduler.recordAttemptStart(1, "cascade_activity");
    scheduler.recordAttemptEnd(1, "stalled", "task_timeout");
    scheduler.recordAttemptStart(1, "retry");
    scheduler.recordAttemptEnd(1, "failed", "task_error");
    expect(scheduler.isSlotExhausted(1)).toBe(true);
    const start = scheduler.shouldStartPanel(1);
    expect(start.start).toBe(false);
    const attempt = scheduler.currentAttempt(1);
    expect(attempt?.status).toBe("failed");
    expect(attempt?.stallReason).toBe("task_error");
    expect(attempt?.attempt).toBe(MAX_PANEL_ATTEMPTS);
  });

  test("pending tool activity prevents premature cancellation when telemetry supports it", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, {
      now: () => now,
      capability: makeCapability({
        streamActivityExposed: true,
        tokenLevelLiveness: true,
        pendingToolActivityInspectable: true,
      }),
    });
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = 80_000;
    scheduler.recordActivity(1, "tool_call_start");
    now = 80_000 + PANEL_INACTIVITY_TIMEOUT_MS + 5_000;
    // Pending tool call — should NOT cancel even though inactivity exceeded
    expect(scheduler.shouldCancelForInactivity(1).cancel).toBe(false);
    // Tool completes — now inactivity timer applies
    scheduler.recordActivity(1, "tool_call_complete");
    now = 80_000 + PANEL_INACTIVITY_TIMEOUT_MS + 5_000 + PANEL_INACTIVITY_TIMEOUT_MS + 1_000;
    const cancel = scheduler.shouldCancelForInactivity(1);
    expect(cancel.cancel).toBe(true);
    expect(cancel.reason).toBe("inactivity_timeout");
  });

  test("unavailable telemetry disables token-level watchdog behavior honestly", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    scheduler.recordAttemptStart(1, "cascade_activity");
    // No stream activity exposed — should never cancel for inactivity
    expect(scheduler.shouldCancelForInactivity(1).cancel).toBe(false);
    expect(scheduler.hasLivenessTelemetry()).toBe(false);
    const cap = scheduler.getCapability();
    expect(cap.streamActivityExposed).toBe(false);
    expect(cap.tokenLevelLiveness).toBe(false);
  });

  test("recordActivity is a no-op when stream activity is not exposed", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => now });
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = 50_000;
    scheduler.recordActivity(1, "assistant_text_delta");
    const attempt = scheduler.currentAttempt(1);
    expect(attempt?.firstActivityAt).toBeUndefined();
    expect(attempt?.lastActivityAt).toBeUndefined();
  });
});

describe("nextAction", () => {
  test("returns start_panel for panel 1 when nothing has started", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    const action = scheduler.nextAction();
    expect(action.type).toBe("start_panel");
    if (action.type === "start_panel") {
      expect(action.panelIndex).toBe(1);
      expect(action.attempt).toBe(1);
      expect(action.reason).toBe("cascade_activity");
    }
  });

  test("returns done when all slots are exhausted", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    for (let i = 1; i <= 3; i += 1) {
      scheduler.recordAttemptStart(i, i === 1 ? "cascade_activity" : "start_gate_timeout");
      scheduler.recordAttemptEnd(i, "succeeded");
    }
    expect(scheduler.nextAction().type).toBe("done");
  });

  test("returns wait when all panels are running and no start-gate deadline has passed", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => now });
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = 10_000;
    const action = scheduler.nextAction();
    expect(action.type).toBe("wait");
  });
});

describe("retry and cascade integration", () => {
  test("panel 1 stalls before first activity — retry resets cascade for panel 2", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => now });
    scheduler.recordAttemptStart(1, "cascade_activity");
    // Panel 1 attempt 1 stalls (e.g., task timeout)
    scheduler.recordAttemptEnd(1, "stalled", "task_timeout");
    // Retry panel 1
    const retry = scheduler.shouldStartPanel(1);
    expect(retry.start).toBe(true);
    expect(retry.reason).toBe("retry");
    scheduler.recordAttemptStart(1, "retry");
    // Panel 2 should wait for panel 1 attempt 2 activity or 60s gate
    expect(scheduler.shouldStartPanel(2).start).toBe(false);
    now = 60_000;
    const start2 = scheduler.shouldStartPanel(2);
    expect(start2.start).toBe(true);
    expect(start2.reason).toBe("start_gate_timeout");
  });

  test("panel 2 stalls after panel 3 has started — panel 3 continues normally", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => now });
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = 60_000;
    scheduler.recordAttemptStart(2, "start_gate_timeout");
    now = 120_000;
    scheduler.recordAttemptStart(3, "start_gate_timeout");
    // Panel 2 stalls
    scheduler.recordAttemptEnd(2, "stalled", "task_timeout");
    // Panel 2 retry stays attached to logical panel 2
    const retry = scheduler.shouldStartPanel(2);
    expect(retry.start).toBe(true);
    expect(retry.reason).toBe("retry");
    scheduler.recordAttemptStart(2, "retry");
    // Panel 3 is still running — no extra logical panel added
    const attempts = scheduler.getAttempts();
    const slots = new Set(attempts.map((a) => a.logicalPanelIndex));
    expect(slots).toEqual(new Set([1, 2, 3]));
    expect(slots.has(4)).toBe(false);
  });

  test("panel terminal failure does not block later slots forever", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    scheduler.recordAttemptStart(1, "cascade_activity");
    scheduler.recordAttemptEnd(1, "failed", "task_error");
    scheduler.recordAttemptStart(1, "retry");
    scheduler.recordAttemptEnd(1, "failed", "task_error");
    // Panel 1 is exhausted — panel 2 should be able to start
    const start2 = scheduler.shouldStartPanel(2);
    expect(start2.start).toBe(true);
    // Panel 3 should also eventually start
    scheduler.recordAttemptStart(2, "cascade_activity");
    scheduler.recordAttemptEnd(2, "succeeded");
    const start3 = scheduler.shouldStartPanel(3);
    expect(start3.start).toBe(true);
  });

  test("no more than three logical panels exist in the trace", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    scheduler.recordAttemptStart(1, "cascade_activity");
    scheduler.recordAttemptEnd(1, "stalled", "task_timeout");
    scheduler.recordAttemptStart(1, "retry");
    scheduler.recordAttemptEnd(1, "stalled", "task_timeout");
    scheduler.recordAttemptStart(2, "cascade_activity");
    scheduler.recordAttemptEnd(2, "stalled", "task_timeout");
    scheduler.recordAttemptStart(2, "retry");
    scheduler.recordAttemptEnd(2, "succeeded");
    scheduler.recordAttemptStart(3, "cascade_activity");
    scheduler.recordAttemptEnd(3, "succeeded");
    const attempts = scheduler.getAttempts();
    const slots = new Set(attempts.map((a) => a.logicalPanelIndex));
    expect(slots).toEqual(new Set([1, 2, 3]));
    expect(attempts).toHaveLength(5);
    // Panel 1 has 2 attempts, panel 2 has 2 attempts, panel 3 has 1 attempt
    const bySlot = new Map<number, number>();
    for (const a of attempts) bySlot.set(a.logicalPanelIndex, (bySlot.get(a.logicalPanelIndex) ?? 0) + 1);
    expect(bySlot.get(1)).toBe(2);
    expect(bySlot.get(2)).toBe(2);
    expect(bySlot.get(3)).toBe(1);
  });
});

describe("attempt trace shape", () => {
  test("attempt trace records logical panel, attempt number, model, start reason, and status", () => {
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => 0 });
    scheduler.recordAttemptStart(1, "cascade_activity", "session-1");
    const attempt = scheduler.currentAttempt(1);
    expect(attempt).toMatchObject({
      logicalPanelIndex: 1,
      attempt: 1,
      nativeSessionId: "session-1",
      model: "provider-a/model-1",
      status: "waiting_for_activity",
      startReason: "cascade_activity",
    });
    expect(attempt?.startedAt).toBeTruthy();
  });

  test("attempt trace records stall reason and ended timestamp", () => {
    let now = 0;
    const scheduler = new PanelScheduler(PANEL_MODELS, { now: () => now });
    scheduler.recordAttemptStart(1, "cascade_activity");
    now = 5_000;
    scheduler.recordAttemptEnd(1, "stalled", "task_timeout");
    const attempt = scheduler.currentAttempt(1);
    expect(attempt?.status).toBe("stalled");
    expect(attempt?.stallReason).toBe("task_timeout");
    expect(attempt?.endedAt).toBeTruthy();
  });
});

describe("activity kinds", () => {
  test.each<[PanelActivityKind, boolean]>([
    ["session_created", false],
    ["polling_tick", false],
    ["assistant_text_delta", true],
    ["reasoning_delta", true],
    ["tool_call_start", true],
    ["tool_call_complete", true],
    ["tool_result", true],
    ["stream_event", true],
  ])("isActivityMeaningful(%s) === %s", (kind, meaningful) => {
    expect(isActivityMeaningful(kind)).toBe(meaningful);
  });
});

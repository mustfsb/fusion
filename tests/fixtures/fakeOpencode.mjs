#!/usr/bin/env node
/**
 * Fake OpenCode executable for supervisor integration tests.
 *
 * It simulates a real worker process WITHOUT any model/provider/HTTP call:
 *   - independent process lifetime (configurable sleep);
 *   - stdout activity;
 *   - candidate source changes inside its own workspace;
 *   - machine-readable result + status artifact writes;
 *   - verification outcome;
 *   - timeout / hang (never writes a result, waits to be killed);
 *   - process failure (non-zero exit);
 *   - judge merge-patch-contract output;
 *   - patch worker output.
 *
 * Behavior is looked up by worker id from the JSON file at FUSION_FAKE_BEHAVIOR.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const env = process.env;
const workerId = env.FUSION_WORKER_ID ?? "unknown";
const role = env.FUSION_WORKER_ROLE ?? "unknown";
const workspace = env.FUSION_WORKSPACE ?? process.cwd();
const resultPath = env.FUSION_RESULT_ARTIFACT;
const statusPath = env.FUSION_STATUS_ARTIFACT;
const taskPath = env.FUSION_TASK_ARTIFACT;
const verificationPath = env.FUSION_VERIFICATION_ARTIFACT;

let behavior = {};
try {
  const all = JSON.parse(readFileSync(env.FUSION_FAKE_BEHAVIOR, "utf8"));
  behavior = all[workerId] ?? all.default ?? {};
} catch {
  behavior = {};
}

const sleepMs = behavior.sleepMs ?? 50;
const outcome = behavior.outcome ?? "complete"; // complete | fail | hang
const verification = behavior.verification ?? { typecheck: "pass", test: "pass", build: "pass" };

process.stdout.write(`[fake-opencode] ${workerId} role=${role} starting in ${workspace}\n`);
const observedModel =
  behavior.observedModel ??
  process.env.FUSION_REQUESTED_MODEL ??
  process.env.FUSION_MAIN_MODEL ??
  "unknown/unknown";
process.stdout.write(`[fake-opencode] ${workerId} observedModel=${observedModel}\n`);

if (behavior.requireLocalCanonicalTask) {
  const taskText = readFileSync(taskPath, "utf8");
  if (!taskPath.startsWith(path.join(workspace, ".fusion-worker")) || !taskText.includes("# Fusion Canonical Task")) {
    process.stderr.write(`[fake-opencode] ${workerId} could not read local canonical task\n`);
    process.exit(2);
  }
}

// Simulate candidate source changes inside the worker's own workspace.
if (behavior.changedFile) {
  const target = path.join(workspace, behavior.changedFile);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, behavior.changedFileContent ?? `// ${workerId} change\nexport const x = 1;\n`, "utf8");
  process.stdout.write(`[fake-opencode] ${workerId} wrote ${behavior.changedFile}\n`);
}

// Optionally write a merge patch contract (judge).
let contractPath;
if (behavior.writeContract) {
  contractPath = path.join(path.dirname(resultPath), "merge-patch-contract.full.md");
  writeFileSync(contractPath, `# Merge Patch Contract\n\nDecision: ${behavior.decision ?? "NO_PATCH_REQUIRED"}\n`, "utf8");
}

function finish() {
  process.stdout.write(`[fake-opencode] ${workerId} finishing outcome=${outcome}\n`);
  if (outcome === "hang") {
    // Never write a result; wait to be killed by the supervisor hard timeout.
    setInterval(() => {}, 1 << 30);
    return;
  }
  const status = outcome === "fail" ? "failed" : "completed";
  const result = {
    workerId,
    role,
    runId: env.FUSION_RUN_ID,
    workspacePath: workspace,
    taskHash: env.FUSION_TASK_HASH,
    status,
    changedFiles: behavior.changedFile ? [behavior.changedFile] : [],
    verification,
    errorSummary: outcome === "fail" ? "fake failure" : undefined,
    completedAt: new Date().toISOString(),
    mergePatchDecision: role === "judge" ? behavior.decision ?? "NO_PATCH_REQUIRED" : undefined,
    contractPath,
  };
  if (verificationPath) {
    mkdirSync(path.dirname(verificationPath), { recursive: true });
    writeFileSync(verificationPath, JSON.stringify(verification, null, 2), "utf8");
  }
  if (resultPath && !behavior.noResult) {
    mkdirSync(path.dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
  }
  if (statusPath) {
    writeFileSync(statusPath, JSON.stringify({ status, at: result.completedAt }, null, 2), "utf8");
  }
  process.exit(outcome === "fail" ? 1 : 0);
}

setTimeout(finish, sleepMs);

import { spawn, type SpawnOptions } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { WorkerRole } from "./supervisorTypes.js";

/**
 * Worker command transport.
 *
 * The supervisor never calls a model API or a hidden SDK runner. It launches
 * the real OpenCode executable as an independent child process via
 * `child_process.spawn`. This abstraction lets tests inject a fake OpenCode
 * executable while production uses the installed `opencode` CLI.
 */

export type WorkerProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export interface SpawnedWorkerHandle {
  readonly pid: number | undefined;
  /** Resolves when the child process exits. Never rejects. */
  readonly exited: Promise<WorkerProcessExit>;
  /** Safely terminate only this worker process. */
  kill(signal?: NodeJS.Signals): void;
}

export type WorkerSpawnSpec = {
  workerId: string;
  role: WorkerRole;
  /** Resolved provider/model id, passed through verbatim. */
  modelId: string;
  /** Optional provider-specific reasoning variant (e.g. high/max). */
  variant?: string;
  /** OpenCode agent name to run under, when applicable. */
  agent?: string;
  /** Absolute workspace the worker runs in. */
  workspacePath: string;
  /** Explicit, human-visible session title. */
  sessionTitle: string;
  /** Worker instruction message (also persisted as an artifact). */
  promptText: string;
  /** Deterministic env exposing artifact paths to the worker. */
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
};

export interface WorkerRunner {
  readonly transport: string;
  spawn(spec: WorkerSpawnSpec): Promise<SpawnedWorkerHandle>;
}

export type OpenCodeProcessWorkerRunnerOptions = {
  /**
   * Absolute path or PATH-resolvable name of the OpenCode executable. Tests
   * inject a fake executable here. Defaults to `FUSION_OPENCODE_BIN` env or
   * `opencode`.
   */
  opencodeBin?: string;
  /** Extra args appended after the resolved opencode args (advanced/testing). */
  extraArgs?: string[];
  /**
   * Override the args builder. Default targets the verified `opencode run`
   * interface. Tests may override to adapt to a fake binary contract.
   */
  buildArgs?: (spec: WorkerSpawnSpec) => string[];
};

/**
 * Default OpenCode CLI args for a non-interactive worker, verified against the
 * installed `opencode run` interface:
 *
 *   opencode run --model <provider/model> --dir <workspace>
 *     --title <session title> [--agent <agent>] [--variant <effort>]
 *     --print-logs <prompt message>
 *
 * The prompt message instructs the worker (a real OpenCode agent) to write its
 * machine-readable result/status artifacts to the paths exposed via env.
 */
export function buildOpenCodeRunArgs(spec: WorkerSpawnSpec): string[] {
  const testEntry = process.env.FUSION_OPENCODE_TEST_ENTRY;
  if (testEntry) {
    return [testEntry];
  }
  const args = [
    "run",
    "--model",
    spec.modelId,
    "--dir",
    spec.workspacePath,
    "--title",
    spec.sessionTitle,
  ];
  if (spec.agent) {
    args.push("--agent", spec.agent);
  }
  if (spec.variant) {
    args.push("--variant", spec.variant);
  }
  args.push("--print-logs", spec.promptText);
  return args;
}

export function resolveOpenCodeBin(explicit?: string): string {
  return explicit ?? process.env.FUSION_OPENCODE_BIN ?? "opencode";
}

/**
 * Production worker runner: launches the installed OpenCode CLI as a real,
 * independent child process. stdout/stderr are streamed to per-worker files so
 * the supervisor can use byte growth as liveness evidence.
 */
export function createOpenCodeProcessWorkerRunner(
  options: OpenCodeProcessWorkerRunnerOptions = {},
): WorkerRunner {
  const bin = resolveOpenCodeBin(options.opencodeBin);
  const buildArgs = options.buildArgs ?? buildOpenCodeRunArgs;
  return {
    transport: "opencode-cli-process",
    async spawn(spec) {
      await mkdir(path.dirname(spec.stdoutPath), { recursive: true });
      await mkdir(path.dirname(spec.stderrPath), { recursive: true });
      const outFd = openSync(spec.stdoutPath, "a");
      const errFd = openSync(spec.stderrPath, "a");
      const args = [...buildArgs(spec), ...(options.extraArgs ?? [])];
      const spawnOptions: SpawnOptions = {
        cwd: spec.workspacePath,
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", outFd, errFd],
      };
      const child = spawn(bin, args, spawnOptions);
      const exited = new Promise<WorkerProcessExit>((resolve) => {
        let settled = false;
        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          try {
            closeSync(outFd);
          } catch {
            /* ignore */
          }
          try {
            closeSync(errFd);
          } catch {
            /* ignore */
          }
          resolve({ code, signal });
        };
        child.on("exit", (code, signal) => finish(code, signal));
        child.on("error", () => finish(null, null));
      });
      return {
        get pid() {
          return child.pid;
        },
        exited,
        kill(signal: NodeJS.Signals = "SIGTERM") {
          // Terminate ONLY this worker process, never its siblings or the
          // supervisor's own process group.
          try {
            child.kill(signal);
          } catch {
            /* already gone */
          }
        },
      };
    },
  };
}

/** True when a PID is still alive (signal 0 probe). */
export function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH => not alive; EPERM => alive but not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

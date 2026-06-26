import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive } from "./workerRunner.js";
import { loadSupervisorState, writeSupervisorState } from "./supervisorState.js";
import type { SupervisorState } from "./supervisorTypes.js";

export const SUPERVISOR_READY_FILENAME = "supervisor-ready.json";
export const SUPERVISOR_STARTUP_TIMEOUT_MS = 5000;
export const SUPERVISOR_STARTUP_POLL_MS = 100;

export type SupervisorReadyReceipt = {
  runId: string;
  supervisorPid: number;
  nodeExecutable: string;
  entrypointPath: string;
  workingDirectory: string;
  sourceWorkspace: string;
  readyAt: string;
  runDir: string;
};

export type SupervisorLaunchPaths = {
  runId: string;
  runDir: string;
  sourceWorkspace: string;
  workingDirectory: string;
  entrypointPath: string;
  traceDir?: string;
};

export class SupervisorStartupError extends Error {
  constructor(
    message: string,
    readonly details: {
      runId?: string;
      supervisorPid?: number;
      supervisorLogPath?: string;
      entrypointPath?: string;
      workingDirectory?: string;
    } = {},
  ) {
    super(message);
    this.name = "SupervisorStartupError";
  }
}

async function assertDirectory(label: string, dirPath: string): Promise<void> {
  const resolved = path.resolve(dirPath);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new SupervisorStartupError(`${label} does not exist: ${resolved}`);
  }
  if (!info.isDirectory()) {
    throw new SupervisorStartupError(`${label} is not a directory: ${resolved}`);
  }
}

async function assertFile(label: string, filePath: string): Promise<void> {
  const resolved = path.resolve(filePath);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new SupervisorStartupError(`${label} does not exist: ${resolved}`);
  }
  if (!info.isFile()) {
    throw new SupervisorStartupError(`${label} is not a file: ${resolved}`);
  }
}

export function supervisorMainEntry(): string {
  const siblingJs = fileURLToPath(new URL("./supervisorMain.js", import.meta.url));
  if (existsSync(siblingJs)) return siblingJs;
  const distJs = path.resolve(process.cwd(), "dist/native/supervisorMain.js");
  if (existsSync(distJs)) return distJs;
  const siblingTs = fileURLToPath(new URL("./supervisorMain.ts", import.meta.url));
  if (existsSync(siblingTs)) return siblingTs;
  return siblingJs;
}

export function resolveSupervisorWorkingDirectory(sourceWorkspace: string, explicit?: string): string {
  return path.resolve(explicit ?? sourceWorkspace);
}

function isRejectedSupervisorExecutable(executable: string): boolean {
  const base = path.basename(executable).toLowerCase();
  return base === "opencode" || base.startsWith("opencode");
}

/**
 * Confirm an executable is Node.js (never OpenCode CLI or worker binaries).
 */
export function probeNodeRuntimeVersion(executable: string): string | undefined {
  if (!executable || isRejectedSupervisorExecutable(executable)) {
    return undefined;
  }
  try {
    const result = spawnSync(executable, ["-p", "process.versions.node"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.status !== 0) {
      return undefined;
    }
    const version = (result.stdout ?? "").trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      return undefined;
    }
    return version;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a Node.js runtime for the detached supervisor. Never returns OpenCode
 * CLI, `FUSION_OPENCODE_BIN`, or worker-runner executables.
 */
export async function resolveSupervisorNodeExecutable(
  options?: { candidates?: string[] },
): Promise<string> {
  const defaultCandidates = [
    process.env.FUSION_NODE_BIN,
    process.execPath,
    "node",
  ].filter((value): value is string => Boolean(value));
  const candidates = options?.candidates ?? defaultCandidates;

  for (const candidate of candidates) {
    const version = probeNodeRuntimeVersion(candidate);
    if (version) {
      return candidate;
    }
  }

  throw new SupervisorStartupError(
    "No valid Node.js runtime found for detached supervisor launch.",
  );
}

/** Detect OpenCode CLI help/usage output in supervisor logs before readiness. */
export function supervisorLogIndicatesOpenCodeHelp(logText: string): boolean {
  const text = logText.trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (lower.includes("usage:") && lower.includes("opencode")) return true;
  if (lower.includes("available commands") && lower.includes("opencode")) return true;
  if (/^opencode\b/mi.test(text) && lower.includes("usage")) return true;
  if (lower.includes("opencode") && lower.includes("run") && lower.includes("agent")) return true;
  return false;
}

/**
 * Parse detached supervisor CLI args. `process.argv[1]` is always the script
 * path and must never be treated as a workspace directory.
 */
export function parseSupervisorMainArgs(argv: string[]): Omit<SupervisorLaunchPaths, "entrypointPath"> {
  const positional: string[] = [];
  let runId: string | undefined;
  let runDir: string | undefined;
  let sourceWorkspace: string | undefined;
  let workingDirectory: string | undefined;
  let traceDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--run-id") {
      runId = argv[++index];
      continue;
    }
    if (token === "--run-dir") {
      runDir = argv[++index];
      continue;
    }
    if (token === "--source-workspace") {
      sourceWorkspace = argv[++index];
      continue;
    }
    if (token === "--working-directory") {
      workingDirectory = argv[++index];
      continue;
    }
    if (token === "--trace-dir") {
      traceDir = argv[++index];
      continue;
    }
    if (token.startsWith("-")) {
      throw new SupervisorStartupError(`Unknown supervisor argument: ${token}`);
    }
    positional.push(token);
  }

  runId =
    runId ??
    process.env.FUSION_SUPERVISOR_RUN_ID ??
    positional[0];
  runDir = runDir ?? process.env.FUSION_SUPERVISOR_RUN_DIR;
  sourceWorkspace = sourceWorkspace ?? process.env.FUSION_SUPERVISOR_SOURCE_WORKSPACE;
  workingDirectory =
    workingDirectory ??
    process.env.FUSION_SUPERVISOR_WORKING_DIRECTORY ??
    process.env.FUSION_SUPERVISOR_CWD;
  traceDir = traceDir ?? process.env.FUSION_SUPERVISOR_TRACE_DIR ?? undefined;

  if (!runId) {
    throw new SupervisorStartupError("Supervisor run id is required (--run-id or FUSION_SUPERVISOR_RUN_ID).");
  }
  if (!runDir) {
    throw new SupervisorStartupError("Supervisor run directory is required (--run-dir).");
  }
  if (!sourceWorkspace) {
    throw new SupervisorStartupError("Source workspace is required (--source-workspace).");
  }
  if (!workingDirectory) {
    throw new SupervisorStartupError("Working directory is required (--working-directory).");
  }

  return {
    runId,
    runDir: path.resolve(runDir),
    sourceWorkspace: path.resolve(sourceWorkspace),
    workingDirectory: path.resolve(workingDirectory),
    traceDir: traceDir || undefined,
  };
}

export async function validateSupervisorLaunchPaths(
  launch: SupervisorLaunchPaths,
  options?: { validateEntrypoint?: boolean },
): Promise<void> {
  if (options?.validateEntrypoint ?? true) {
    await assertFile("Supervisor entrypoint", launch.entrypointPath);
  }
  await assertDirectory("Supervisor working directory", launch.workingDirectory);
  await assertDirectory("Source workspace", launch.sourceWorkspace);
  await assertDirectory("Run directory", launch.runDir);

  const entryBase = path.basename(launch.entrypointPath);
  for (const label of ["Working directory", "Source workspace", "Run directory"] as const) {
    const value =
      label === "Working directory"
        ? launch.workingDirectory
        : label === "Source workspace"
          ? launch.sourceWorkspace
          : launch.runDir;
    if (path.resolve(value) === path.resolve(launch.entrypointPath)) {
      throw new SupervisorStartupError(`${label} must not be the supervisor entrypoint file (${entryBase}).`);
    }
  }
}

export async function confirmSupervisorReady(
  launch: SupervisorLaunchPaths,
  options?: { validateEntrypoint?: boolean },
): Promise<{ state: SupervisorState; receipt: SupervisorReadyReceipt }> {
  await validateSupervisorLaunchPaths(launch, options);

  const state = await loadSupervisorState(launch.workingDirectory, launch.runId, launch.traceDir);
  if (!state) {
    throw new SupervisorStartupError(`No supervisor state for run ${launch.runId}.`);
  }
  if (state.phase !== "bootstrapping") {
    throw new SupervisorStartupError(
      `Supervisor expected phase bootstrapping but found ${state.phase}.`,
    );
  }

  const readyAt = new Date().toISOString();
  const nodeExecutable =
    process.env.FUSION_SUPERVISOR_NODE_EXECUTABLE ??
    (await resolveSupervisorNodeExecutable());
  state.phase = "running";
  state.supervisorPid = process.pid;
  state.updatedAt = readyAt;
  await writeSupervisorState(state, launch.workingDirectory, launch.traceDir);

  const receipt: SupervisorReadyReceipt = {
    runId: launch.runId,
    supervisorPid: process.pid,
    nodeExecutable,
    entrypointPath: launch.entrypointPath,
    workingDirectory: launch.workingDirectory,
    sourceWorkspace: launch.sourceWorkspace,
    readyAt,
    runDir: launch.runDir,
  };
  const readyPath = path.join(launch.runDir, SUPERVISOR_READY_FILENAME);
  const tmp = `${readyPath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await writeFile(readyPath, await readFile(tmp, "utf8"), "utf8");
  return { state, receipt };
}

export type WaitForSupervisorReadyOptions = {
  timeoutMs?: number;
  supervisorPid?: number;
  supervisorLogPath?: string;
  child?: ChildProcess;
  exitCode?: number | null;
};

export async function waitForSupervisorReady(
  runDir: string,
  options: WaitForSupervisorReadyOptions = {},
): Promise<SupervisorReadyReceipt> {
  const timeoutMs = options.timeoutMs ?? SUPERVISOR_STARTUP_TIMEOUT_MS;
  const readyPath = path.join(runDir, SUPERVISOR_READY_FILENAME);
  const supervisorLogPath = options.supervisorLogPath ?? path.join(runDir, "logs", "supervisor.log");
  const deadline = Date.now() + timeoutMs;
  let observedExitCode: number | null | undefined = options.exitCode;
  let childExited = options.exitCode !== undefined;

  if (options.child) {
    options.child.on("exit", (code) => {
      childExited = true;
      observedExitCode = code;
    });
  }

  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(readyPath, "utf8")) as SupervisorReadyReceipt;
    } catch {
      // keep polling
    }

    const logTail = await readSupervisorLogTail(supervisorLogPath);
    if (logTail && supervisorLogIndicatesOpenCodeHelp(logTail)) {
      throw new SupervisorStartupError(
        "Supervisor log contains OpenCode CLI help output before readiness.",
        { supervisorLogPath },
      );
    }

    const pid = options.supervisorPid ?? options.child?.pid;
    if (childExited) {
      throw new SupervisorStartupError(
        `Supervisor exited before ready with code ${observedExitCode ?? "null"}.`,
        { supervisorLogPath },
      );
    }
    if (pid !== undefined && !isPidAlive(pid)) {
      throw new SupervisorStartupError("Supervisor exited before ready.", { supervisorLogPath });
    }

    await new Promise((resolve) => setTimeout(resolve, SUPERVISOR_STARTUP_POLL_MS));
  }
  throw new SupervisorStartupError(`Supervisor ready handshake timed out after ${timeoutMs}ms.`, {
    supervisorLogPath,
  });
}

export async function readSupervisorLogTail(logPath: string, maxLines = 100): Promise<string | undefined> {
  try {
    const text = await readFile(logPath, "utf8");
    const lines = text.split(/\r?\n/);
    return lines.length > maxLines ? lines.slice(-maxLines).join("\n") : text;
  } catch {
    return undefined;
  }
}

export function formatSupervisorStartupFailure(error: unknown, context: {
  runId: string;
  supervisorPid?: number;
  nodeExecutable?: string;
  supervisorLogPath: string;
  entrypointPath: string;
  workingDirectory: string;
  exitCode?: number | null;
  logTail?: string;
}): string {
  const startupMessage =
    error instanceof SupervisorStartupError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  const parts = [
    "FUSION_SUPERVISOR_STARTUP_FAILED",
    `runId=${context.runId}`,
    `pid=${context.supervisorPid ?? "unknown"}`,
    `nodeExecutable=${context.nodeExecutable ?? "unknown"}`,
    `entrypoint=${context.entrypointPath}`,
    `workingDirectory=${context.workingDirectory}`,
    `supervisorLog=${context.supervisorLogPath}`,
  ];
  if (context.exitCode !== undefined) {
    parts.push(`exitCode=${context.exitCode ?? "null"}`);
  }
  parts.push(`failure=${startupMessage}`);
  if (context.logTail?.trim()) {
    parts.push(`logTail=${context.logTail.trim()}`);
  }
  return parts.join(": ");
}

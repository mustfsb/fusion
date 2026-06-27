import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Durable, workspace-independent registry of Fusion supervisor runs. The trace
 * tool must be able to locate a known run regardless of the current working
 * directory or active agent directory, so the registry lives at a stable path
 * (the OpenCode config dir by default), not under any single run's trace root.
 *
 * This is the resolver `/fusion-trace` falls back to when the cwd-relative
 * latest-run pointer is absent or points at a different workspace.
 */

const REGISTRY_FILENAME = "fusion-run-registry.json";
const MAX_REGISTRY_ENTRIES = 100;

export type FusionRunRegistryEntry = {
  runId: string;
  runDir: string;
  cwd: string;
  traceDir?: string;
  sourceWorkspace: string;
  phase: string;
  strategy: string;
  updatedAt: string;
};

export type FusionRunRegistry = {
  version: 1;
  runs: FusionRunRegistryEntry[];
};

export function fusionRunRegistryPath(): string {
  const explicit = process.env.FUSION_RUN_REGISTRY_PATH;
  if (explicit) return path.resolve(explicit);
  const dir =
    process.env.FUSION_RUN_REGISTRY_DIR ??
    process.env.FUSION_OPENCODE_CONFIG_DIR ??
    path.join(homedir(), ".config", "opencode");
  return path.join(path.resolve(dir), REGISTRY_FILENAME);
}

export async function loadRunRegistry(): Promise<FusionRunRegistry> {
  try {
    const text = await readFile(fusionRunRegistryPath(), "utf8");
    const parsed = JSON.parse(text) as Partial<FusionRunRegistry>;
    if (parsed && Array.isArray(parsed.runs)) {
      return { version: 1, runs: parsed.runs };
    }
  } catch {
    // missing/corrupt registry — start fresh
  }
  return { version: 1, runs: [] };
}

/**
 * Insert or update a run entry. The most recently updated run sorts first.
 * Best-effort and atomic (temp + rename); a registry write failure must never
 * abort an otherwise valid run.
 */
export async function upsertRunRegistry(entry: FusionRunRegistryEntry): Promise<void> {
  try {
    const registry = await loadRunRegistry();
    const filtered = registry.runs.filter((run) => run.runId !== entry.runId);
    filtered.unshift(entry);
    registry.runs = filtered.slice(0, MAX_REGISTRY_ENTRIES);
    const filePath = fusionRunRegistryPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
  } catch {
    // never throw from the registry
  }
}

export async function resolveRunFromRegistry(runId: string): Promise<FusionRunRegistryEntry | undefined> {
  const registry = await loadRunRegistry();
  return registry.runs.find((run) => run.runId === runId);
}

export async function latestRunFromRegistry(): Promise<FusionRunRegistryEntry | undefined> {
  const registry = await loadRunRegistry();
  return registry.runs[0];
}

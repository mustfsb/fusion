import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

const BUILD_TIMEOUT_MS = 180_000;
const OLD_EVIDENCE_ERROR = "only 0/3 native panel dispatches have runtime evidence";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const distPluginPath = path.join(projectRoot, "dist", "plugin.js");
const distSupervisorPath = path.join(projectRoot, "dist", "native", "fusionSupervisor.js");

beforeAll(() => {
  let needsBuild = true;
  try {
    const existing = execFileSync("node", ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(distSupervisorPath)}, 'utf8'))`], {
      encoding: "utf8",
    });
    needsBuild = !existing.includes("LAUNCH_CONFIRMED") || existing.includes(OLD_EVIDENCE_ERROR);
  } catch {
    needsBuild = true;
  }
  if (needsBuild) {
    execFileSync(process.execPath, [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(projectRoot, "tsconfig.json")], {
      cwd: projectRoot,
      timeout: BUILD_TIMEOUT_MS,
      stdio: "inherit",
    });
  }
}, BUILD_TIMEOUT_MS);

describe("built dist plugin descriptor", () => {
  test("dist/plugin.js exposes confirm_launch + collect lifecycle", async () => {
    const built = await readFile(distPluginPath, "utf8");
    expect(built).toContain("panelOutcomes");
    expect(built).toContain("confirm_launch");
    expect(built).toContain("collect");
  });

  test("built supervisor never emits the old 0/3 evidence gate from confirm_launch", async () => {
    const built = await readFile(distSupervisorPath, "utf8");
    expect(built).toContain("LAUNCH_CONFIRMED");
    expect(built).not.toContain(OLD_EVIDENCE_ERROR);
  });
});

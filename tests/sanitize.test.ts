import { describe, expect, test } from "vitest";
import { isDeniedPath, sanitizeText } from "../src/context/sanitize.js";

describe("sanitizeText", () => {
  test("redacts common secret assignments and bearer tokens", () => {
    const input = [
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      "normal=value",
    ].join("\n");

    const result = sanitizeText(input);

    expect(result).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(result).toContain("Authorization: Bearer [REDACTED]");
    expect(result).toContain("normal=value");
    expect(result).not.toContain("sk-proj-");
  });
});

describe("isDeniedPath", () => {
  test("denies secret, dependency, build, key, and database paths", () => {
    expect(isDeniedPath(".env")).toBe(true);
    expect(isDeniedPath("apps/web/.env.local")).toBe(true);
    expect(isDeniedPath("node_modules/pkg/index.js")).toBe(true);
    expect(isDeniedPath(".git/config")).toBe(true);
    expect(isDeniedPath("dist/index.js")).toBe(true);
    expect(isDeniedPath("private.pem")).toBe(true);
    expect(isDeniedPath("data/app.sqlite")).toBe(true);
  });

  test("allows ordinary source and metadata files", () => {
    expect(isDeniedPath("src/index.ts")).toBe(false);
    expect(isDeniedPath("README.md")).toBe(false);
    expect(isDeniedPath("package.json")).toBe(false);
  });
});

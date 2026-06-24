/**
 * Unresolved-placeholder guard for speculative panel dispatch.
 *
 * A panel must NEVER receive an unresolved candidate-workspace placeholder. The
 * reported failure was a visible panel receiving the literal
 * `<CANDIDATE_WORKSPACE_PLACEHOLDER>` because the shared task prompt baked an
 * unresolved template token. This module hard-aborts before any panel dispatch
 * when such a token survives into an active runtime artifact.
 */

/**
 * Canonical unresolved-placeholder pattern: an all-uppercase `<TOKEN>` made of
 * `[A-Z]` followed by `[A-Z0-9_]*`. Lowercase or spaced descriptors (e.g.
 * `<absolute path>`) and mixed-case generics (e.g. `<HTMLElement>`) do NOT
 * match, so real user/code content embedded in the shared task is not flagged.
 */
export const UNRESOLVED_PLACEHOLDER_PATTERN = /<[A-Z][A-Z0-9_]*>/g;

/**
 * Fusion template placeholder tokens that must never reach an active runtime
 * artifact. Used for the shared canonical task scan (which legitimately embeds
 * arbitrary user/code content) so only OUR template tokens trip the guard.
 */
export const FORBIDDEN_PANEL_PLACEHOLDERS = [
  "CANDIDATE_WORKSPACE_PLACEHOLDER",
  "PANEL_WORKSPACE",
  "PANEL_INDEX",
  "REPORT_PATH_PLACEHOLDER",
  "PATCH_PATH_PLACEHOLDER",
  "MODEL_ID_PLACEHOLDER",
  "SOURCE_WORKSPACE_PLACEHOLDER",
  "NOTES_PATH_PLACEHOLDER",
  "REPORT_PATH",
  "PATCH_PATH",
] as const;

export type PlaceholderSource = { label: string; text: string };

/** Return all distinct generic unresolved-placeholder tokens in `text`. */
export function findUnresolvedPlaceholders(text: string): string[] {
  const matches = text.match(UNRESOLVED_PLACEHOLDER_PATTERN) ?? [];
  return [...new Set(matches)];
}

/** Return any forbidden Fusion template placeholder tokens present in `text`. */
export function findForbiddenPanelPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const token of FORBIDDEN_PANEL_PLACEHOLDERS) {
    if (text.includes(`<${token}>`)) found.add(`<${token}>`);
  }
  return [...found];
}

/**
 * Assert that none of the provided sources contain an unresolved placeholder.
 *
 * - `mode: "generic"` (default): the full uppercase-bracket pattern. Use for
 *   fully Fusion-generated artifacts (per-panel execution context, inline
 *   dispatch prompt) that must be 100% path-resolved.
 * - `mode: "forbidden_tokens"`: only OUR template tokens. Use for artifacts
 *   that embed arbitrary user/code content (the shared canonical task,
 *   installed agent templates).
 *
 * Throws before panel dispatch, naming the offending source and exact token(s).
 */
export function assertNoUnresolvedPlaceholders(
  sources: PlaceholderSource[],
  options?: { mode?: "generic" | "forbidden_tokens" },
): void {
  const mode = options?.mode ?? "generic";
  const violations: { label: string; placeholders: string[] }[] = [];
  for (const source of sources) {
    const placeholders =
      mode === "generic"
        ? findUnresolvedPlaceholders(source.text)
        : findForbiddenPanelPlaceholders(source.text);
    if (placeholders.length > 0) {
      violations.push({ label: source.label, placeholders });
    }
  }
  if (violations.length > 0) {
    throw new Error(
      [
        "Fusion speculative panel dispatch aborted: unresolved placeholder(s) detected.",
        "A panel must never receive an unresolved candidate-workspace placeholder.",
        "Advisory-mode fallback is NOT permitted; resolve the binding and re-run.",
        ...violations.map((v) => `- ${v.label}: ${v.placeholders.join(", ")}`),
      ].join("\n"),
    );
  }
}

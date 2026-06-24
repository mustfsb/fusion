import type {
  ContractGate,
  CouncilComparison,
  CouncilComparisonBlindSpot,
  CouncilComparisonCommonGround,
  CouncilComparisonKeyDifference,
  CouncilComparisonPartialCoverage,
  CouncilComparisonUniqueAddition,
  CouncilComparisonUniqueAdditionClassification,
  PanelResponse,
} from "../types.js";

export type BuildCouncilComparisonInput = {
  task: string;
  contractGate: ContractGate;
  panel: PanelResponse[];
  quorumDegraded: boolean;
};

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
const BULLET_RE = /^\s*(?:[*-]|\d+\.)\s+(.*)$/;
const BACKTICK_RE = /`([^`]+)`/g;

type PanelSectionBlurb = {
  contractGate: string[];
  publicSurface: string[];
  probes: string[];
  hiddenProbes: string[];
  safeCompat: string[];
  scopeRisks: string[];
  selfAudit: string[];
  keyDecisions: string[];
  commonRequirements: string[];
};

const EMPTY_BLURB = (): PanelSectionBlurb => ({
  contractGate: [],
  publicSurface: [],
  probes: [],
  hiddenProbes: [],
  safeCompat: [],
  scopeRisks: [],
  selfAudit: [],
  keyDecisions: [],
  commonRequirements: [],
});

const SECTION_PATTERNS: Array<[keyof PanelSectionBlurb, RegExp]> = [
  ["contractGate", /^contract\s*gate/i],
  ["publicSurface", /public\s*surface\s*matrix/i],
  ["probes", /external\s*consumer\s*probe/i],
  ["hiddenProbes", /hidden\s*semantic\s*probe/i],
  ["safeCompat", /safe\s*compatibility|compatibility\s*additions?|safe\s*aliases?/i],
  ["scopeRisks", /scope\s*risks?\s*\/\s*avoid|scope\s*risks?|avoid/i],
  ["selfAudit", /self[- ]?audit\s*risks?|self[- ]?review/i],
  ["keyDecisions", /key\s*decision\s*points?|key\s*decisions?|decision\s*points?/i],
  ["commonRequirements", /common\s*requirements?\s*and\s*non[- ]?negotiables?|common\s*requirements?|non[- ]?negotiables?/i],
];

function extractBackticks(line: string): string[] {
  return [...line.matchAll(BACKTICK_RE)].map((m) => m[1]).filter(Boolean);
}

function normalizeBullet(line: string): string {
  return line.replace(/^\s*(?:[*-]|\d+\.)\s+/, "").replace(/\s+/g, " ").trim();
}

function symbolKey(text: string): string {
  const ticks = extractBackticks(text);
  if (ticks.length > 0) return ticks.map((t) => t.toLowerCase()).sort().join("|");
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!cleaned) return "";
  const stop = new Set([
    "the", "a", "an", "and", "or", "to", "of", "for", "with", "is", "are", "be", "by",
    "in", "on", "at", "as", "from", "that", "this", "must", "should", "will", "when",
    "if", "do", "not", "via", "use", "using", "into", "your", "you", "its", "it",
  ]);
  const tokens = cleaned.split(" ").filter((token) => token.length > 2 && !stop.has(token));
  return tokens.slice(0, 4).join(" ");
}

function parsePanelSections(content: string | undefined): PanelSectionBlurb {
  const blurb = EMPTY_BLURB();
  if (!content) return blurb;
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let current: keyof PanelSectionBlurb | null = null;
  for (const rawLine of lines) {
    const headingMatch = rawLine.match(HEADING_RE);
    if (headingMatch) {
      const heading = headingMatch[1].replace(/^[\s\d.\-]+/, "").trim();
      const matched = SECTION_PATTERNS.find(([, pattern]) => pattern.test(heading));
      current = matched ? matched[0] : null;
      continue;
    }
    if (!current) continue;
    const bulletMatch = rawLine.match(BULLET_RE);
    if (!bulletMatch) continue;
    const text = normalizeBullet(bulletMatch[1]);
    if (!text) continue;
    blurb[current].push(text);
  }
  return blurb;
}

function panelSections(content: string | undefined): PanelSectionBlurb {
  return parsePanelSections(content);
}

function dedupeTopics(items: { topic: string }[]): { topic: string }[] {
  const seen = new Set<string>();
  const result: { topic: string }[] = [];
  for (const item of items) {
    const key = item.topic.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function clusterByTopic(texts: Array<{ text: string; panelIndex: number }>): Array<{ topic: string; panelIndices: number[] }>{
  const buckets: Array<{ topic: string; panelIndices: number[]; key: string }> = [];
  for (const entry of texts) {
    const key = symbolKey(entry.text);
    if (!key) continue;
    const existing = buckets.find((bucket) => bucket.key === key);
    if (existing) {
      if (!existing.panelIndices.includes(entry.panelIndex)) {
        existing.panelIndices.push(entry.panelIndex);
      }
      continue;
    }
    buckets.push({ topic: entry.text, panelIndices: [entry.panelIndex], key });
  }
  return buckets.map((bucket) => ({ topic: bucket.topic, panelIndices: bucket.panelIndices }));
}

function literalRequirementMatches(contractGate: ContractGate): string[] {
  return [
    ...contractGate.packageRootExports.map((symbol) => `export \`${symbol}\` from package root`),
    ...contractGate.requiredInstanceMethods.map((symbol) => `instance method \`${symbol}\``),
    ...contractGate.requiredTypesAndErrors.map((symbol) => `typed error/type \`${symbol}\``),
    ...contractGate.requiredOptionAndFieldNames.map((name) => `option/property \`${name}\``),
    ...contractGate.returnAndThrowContracts,
    ...contractGate.behavioralBoundaries,
  ];
}

function literalCoverage(
  contractGate: ContractGate,
  panelBlurbs: PanelSectionBlurb[],
): Array<{ requirement: string; coveredBy: number[]; surface: string }>{
  const requirements = literalRequirementMatches(contractGate);
  const allSurface = panelBlurbs.flatMap((blurb) => [
    ...blurb.contractGate,
    ...blurb.publicSurface,
    ...blurb.probes,
    ...blurb.hiddenProbes,
    ...blurb.commonRequirements,
    ...blurb.selfAudit,
  ]);
  const result: Array<{ requirement: string; coveredBy: number[]; surface: string }> = [];
  for (const requirement of requirements) {
    const reqKey = symbolKey(requirement);
    if (!reqKey) continue;
    const coveredBy: number[] = [];
    let surface = "";
    panelBlurbs.forEach((blurb, index) => {
      const panelSurface = [...blurb.contractGate, ...blurb.publicSurface, ...blurb.commonRequirements, ...blurb.selfAudit];
      const hit = panelSurface.find((line) => symbolKey(line) === reqKey || line.toLowerCase().includes(reqKey.split(" ")[0] ?? ""));
      if (hit) {
        coveredBy.push(index + 1);
        if (!surface) surface = hit;
      }
    });
    if (coveredBy.length === 0) {
      const looseHit = allSurface.find((line) => {
        const lineKey = symbolKey(line);
        if (!lineKey) return false;
        const sharedTokens = lineKey.split(" ").filter((token) => reqKey.split(" ").includes(token));
        return sharedTokens.length >= Math.min(2, reqKey.split(" ").length);
      });
      if (looseHit) {
        const loosePanelIndex = panelBlurbs.findIndex((blurb) =>
          [...blurb.contractGate, ...blurb.publicSurface, ...blurb.commonRequirements].some((line) => line === looseHit),
        );
        if (loosePanelIndex >= 0) {
          coveredBy.push(loosePanelIndex + 1);
          surface = looseHit;
        }
      }
    }
    result.push({ requirement, coveredBy, surface });
  }
  return result;
}

function classifyUniqueAddition(idea: string, contractGate: ContractGate): CouncilComparisonUniqueAdditionClassification {
  const lower = idea.toLowerCase();
  const literalTokens = [
    ...contractGate.packageRootExports,
    ...contractGate.requiredInstanceMethods,
    ...contractGate.requiredTypesAndErrors,
    ...contractGate.requiredOptionAndFieldNames,
  ].map((token) => token.toLowerCase());
  if (literalTokens.some((token) => lower.includes(token))) return "literal_requirement";
  if (/alias|backwards[- ]?compat|backward compat|also accept|both .* and|fromtimestamp|totimestamp|from\/to|safe compat/i.test(idea)) {
    return "safe_compatibility";
  }
  if (/helper|extra|convenience|optional|nice[- ]?to[- ]?have|enhancement|extra feature/i.test(idea)) {
    return "optional_enhancement";
  }
  if (/refactor|broad|rewrite|architect|new module|extra dependency|extra file|scope creep|over-engineer/i.test(idea)) {
    return "scope_risk";
  }
  return "optional_enhancement";
}

function recommendationFor(classification: CouncilComparisonUniqueAdditionClassification): "adopt" | "defer" | "reject" {
  switch (classification) {
    case "literal_requirement":
      return "adopt";
    case "safe_compatibility":
      return "adopt";
    case "optional_enhancement":
      return "defer";
    case "scope_risk":
      return "reject";
  }
}

export function buildCouncilComparison(input: BuildCouncilComparisonInput): CouncilComparison {
  const usablePanels = input.panel.filter((panel) => panel.success && panel.content);
  const blurbs = input.panel.map((panel) => panelSections(panel.content));
  const usableIndices = input.panel
    .map((panel, index) => ({ panel, index: index + 1 }))
    .filter((entry) => entry.panel.success && Boolean(entry.panel.content))
    .map((entry) => entry.index);

  const commonGroundRaw: CouncilComparisonCommonGround[] = [];
  for (const blurbKey of ["contractGate", "publicSurface", "probes", "hiddenProbes", "commonRequirements"] as Array<keyof PanelSectionBlurb>) {
    const pool: Array<{ text: string; panelIndex: number }> = [];
    blurbs.forEach((blurb, index) => {
      if (!usableIndices.includes(index + 1)) return;
      for (const line of blurb[blurbKey]) pool.push({ text: line, panelIndex: index + 1 });
    });
    const clusters = clusterByTopic(pool).filter((cluster) => cluster.panelIndices.length >= 2);
    for (const cluster of clusters) {
      const matchingRequirement = literalRequirementMatches(input.contractGate).find((req) => {
        const reqKey = symbolKey(req);
        const topicKey = symbolKey(cluster.topic);
        if (!reqKey || !topicKey) return false;
        return reqKey === topicKey || reqKey.split(" ").some((token) => topicKey.split(" ").includes(token));
      });
      commonGroundRaw.push({
        topic: cluster.topic,
        taskRequirement: matchingRequirement,
        supportedBy: cluster.panelIndices.slice().sort((a, b) => a - b),
        confidence: cluster.panelIndices.length >= 3 ? "high" : cluster.panelIndices.length === 2 ? "medium" : "low",
        rationale: `Supported by ${cluster.panelIndices.length} usable panel${cluster.panelIndices.length === 1 ? "" : "s"}${matchingRequirement ? "; matches literal task requirement" : ""}.`,
      });
    }
  }

  const keyDifferencesRaw: CouncilComparisonKeyDifference[] = [];
  for (const blurbKey of ["keyDecisions", "publicSurface", "hiddenProbes", "selfAudit", "scopeRisks"] as Array<keyof PanelSectionBlurb>) {
    const pool: Array<{ text: string; panelIndex: number }> = [];
    blurbs.forEach((blurb, index) => {
      if (!usableIndices.includes(index + 1)) return;
      for (const line of blurb[blurbKey]) pool.push({ text: line, panelIndex: index + 1 });
    });
    const clusters = clusterByTopic(pool);
    for (const cluster of clusters) {
      if (cluster.panelIndices.length >= usableIndices.length) continue;
      if (cluster.panelIndices.length <= 1 && blurbKey !== "keyDecisions") continue;
      const positions = cluster.panelIndices.map((panelIndex) => ({
        panelIndex,
        position: blurbs[panelIndex - 1][blurbKey].find((line) => symbolKey(line) === symbolKey(cluster.topic)) ?? cluster.topic,
      }));
      const matchingRequirement = literalRequirementMatches(input.contractGate).find((req) => {
        const reqKey = symbolKey(req);
        const topicKey = symbolKey(cluster.topic);
        if (!reqKey || !topicKey) return false;
        return reqKey === topicKey || reqKey.split(" ").some((token) => topicKey.split(" ").includes(token));
      });
      keyDifferencesRaw.push({
        topic: cluster.topic,
        taskRequirement: matchingRequirement,
        panelPositions: positions,
        resolutionRule: matchingRequirement
          ? "Resolve using explicit original task wording first; do not adopt weaker panel majority."
          : "Pick the lowest-risk, consumer-friendly, testable behavior; label it as a compatibility decision and require test coverage.",
        requiredDecision: matchingRequirement
          ? `Adopt the position consistent with: ${matchingRequirement}.`
          : "Judge must pick a single behavior and require a hidden test that distinguishes it from plausible alternatives.",
      });
    }
  }

  const seenTopics = new Set<string>();
  const commonGround = dedupeTopics(commonGroundRaw).map((entry) => ({
    ...entry,
    supportedBy: (commonGroundRaw.find((raw) => raw.topic === entry.topic)?.supportedBy ?? []).slice().sort((a, b) => a - b),
    confidence: commonGroundRaw.find((raw) => raw.topic === entry.topic)?.confidence ?? "low",
    rationale: commonGroundRaw.find((raw) => raw.topic === entry.topic)?.rationale ?? "",
  })) as CouncilComparisonCommonGround[];
  for (const entry of commonGround) seenTopics.add(entry.topic.toLowerCase());

  const keyDifferences = dedupeTopics(keyDifferencesRaw).map((entry) => ({
    ...entry,
    panelPositions: keyDifferencesRaw.find((raw) => raw.topic === entry.topic)?.panelPositions ?? [],
    resolutionRule: keyDifferencesRaw.find((raw) => raw.topic === entry.topic)?.resolutionRule ?? "Resolve using explicit original task wording first.",
    requiredDecision: keyDifferencesRaw.find((raw) => raw.topic === entry.topic)?.requiredDecision ?? "Judge must decide and require a hidden test.",
  })) as CouncilComparisonKeyDifference[];

  const uniqueAdditionsRaw: CouncilComparisonUniqueAddition[] = [];
  blurbs.forEach((blurb, index) => {
    if (!usableIndices.includes(index + 1)) return;
    const pool = [...blurb.safeCompat, ...blurb.scopeRisks, ...blurb.hiddenProbes];
    for (const text of pool) {
      const topicKey = symbolKey(text);
      if (!topicKey) continue;
      const otherHits = blurbs.some((other, otherIndex) => otherIndex !== index && usableIndices.includes(otherIndex + 1) && [...other.safeCompat, ...other.scopeRisks, ...other.hiddenProbes].some((line) => symbolKey(line) === topicKey));
      if (otherHits) continue;
      const classification = classifyUniqueAddition(text, input.contractGate);
      uniqueAdditionsRaw.push({
        idea: text,
        proposedBy: index + 1,
        classification,
        recommendation: recommendationFor(classification),
        reason: classification === "literal_requirement"
          ? "Maps to an explicit task requirement; adopt."
          : classification === "safe_compatibility"
            ? "Cheap, non-breaking compatibility enhancement; adopt unless it conflicts with literal wording."
            : classification === "scope_risk"
              ? "Increases scope or risk without improving literal compliance; defer or reject."
              : "Useful optional addition; defer unless it directly reduces a correctness risk.",
      });
    }
  });
  const uniqueAdditions = uniqueAdditionsRaw.filter((entry, _index, arr) =>
    arr.findIndex((other) => other.idea.toLowerCase() === entry.idea.toLowerCase()) === arr.indexOf(entry),
  );

  const coverage = literalCoverage(input.contractGate, blurbs);
  const partialCoverage: CouncilComparisonPartialCoverage[] = coverage
    .filter((entry) => entry.coveredBy.length > 0 && entry.coveredBy.length < usableIndices.length)
    .map((entry) => ({
      requirement: entry.requirement,
      coveredBy: entry.coveredBy,
      requiredFollowUp: `Require an explicit hidden test and implementation check for: ${entry.requirement}.`,
    }));
  const blindSpots: CouncilComparisonBlindSpot[] = coverage
    .filter((entry) => entry.coveredBy.length === 0)
    .map((entry) => ({
      risk: `Literal requirement not surfaced by any usable panel: ${entry.requirement}.`,
      requiredTestOrAudit: `Mandatory hidden test + post-build audit check for: ${entry.requirement}.`,
    }));

  if (input.contractGate.packageRootExports.length > 0) {
    const rootExportCovered = coverage.some((entry) => /export .* from package root/.test(entry.requirement) && entry.coveredBy.length > 0);
    if (!rootExportCovered) {
      blindSpots.push({
        risk: "Package-root exports required by the task but no panel surfaced them as a literal export obligation.",
        requiredTestOrAudit: "Mandatory package-entry import/export test for every required root export.",
      });
    }
  }

  if (input.contractGate.requiredTypesAndErrors.length > 0) {
    const errorCovered = coverage.some((entry) => /typed error\/type/.test(entry.requirement) && entry.coveredBy.length > 0);
    if (!errorCovered) {
      blindSpots.push({
        risk: "Typed errors required by the task but no panel surfaced them as a throw-contract obligation.",
        requiredTestOrAudit: "Mandatory typed-error throw-contract test for every required error class.",
      });
    }
  }

  const notes: string[] = [];
  if (usableIndices.length < input.panel.length) {
    notes.push(`Comparison built from ${usableIndices.length}/${input.panel.length} usable panels; failed panels were excluded.`);
  }
  if (usableIndices.length < 2) {
    notes.push("Fewer than two usable panels; comparison is best-effort and the judge must rely on the Contract Gate and original task.");
  }

  const unresolvedDifferences = keyDifferences.length;
  const adoptedUniqueAdditions = uniqueAdditions.filter((entry) => entry.recommendation === "adopt").length;
  const deferredOrRejectedUniqueAdditions = uniqueAdditions.filter((entry) => entry.recommendation !== "adopt").length;

  return {
    commonGround,
    keyDifferences,
    uniqueAdditions,
    partialCoverage,
    blindSpots,
    unresolvedDifferences,
    adoptedUniqueAdditions,
    deferredOrRejectedUniqueAdditions,
    degraded: input.quorumDegraded || usableIndices.length < 2,
    notes,
  };
}

export function renderCouncilComparisonMarkdown(comparison: CouncilComparison): string {
  const lines: string[] = [];
  lines.push("# Council Comparison Dossier", "");
  lines.push("## Common Ground");
  if (comparison.commonGround.length === 0) {
    lines.push("- None explicit.");
  } else {
    for (const entry of comparison.commonGround) {
      lines.push(`- ${entry.topic} (panels ${entry.supportedBy.join(", ")}; confidence=${entry.confidence}${entry.taskRequirement ? `; task-linked: ${entry.taskRequirement}` : ""})`);
    }
  }
  lines.push("", "## Key Differences");
  if (comparison.keyDifferences.length === 0) {
    lines.push("- None detected.");
  } else {
    for (const entry of comparison.keyDifferences) {
      lines.push(`- ${entry.topic}${entry.taskRequirement ? ` — task-linked: ${entry.taskRequirement}` : ""}`);
      for (const position of entry.panelPositions) {
        lines.push(`  - Panel ${position.panelIndex}: ${position.position}`);
      }
      lines.push(`  - Resolution rule: ${entry.resolutionRule}`);
      lines.push(`  - Required decision: ${entry.requiredDecision}`);
    }
  }
  lines.push("", "## Unique Additions");
  if (comparison.uniqueAdditions.length === 0) {
    lines.push("- None.");
  } else {
    for (const entry of comparison.uniqueAdditions) {
      lines.push(`- ${entry.idea} (panel ${entry.proposedBy}; classification=${entry.classification}; recommendation=${entry.recommendation})`);
      lines.push(`  - ${entry.reason}`);
    }
  }
  lines.push("", "## Partial Coverage");
  if (comparison.partialCoverage.length === 0) {
    lines.push("- None.");
  } else {
    for (const entry of comparison.partialCoverage) {
      lines.push(`- ${entry.requirement} (covered by panels ${entry.coveredBy.join(", ")})`);
      lines.push(`  - Follow-up: ${entry.requiredFollowUp}`);
    }
  }
  lines.push("", "## Blind Spots");
  if (comparison.blindSpots.length === 0) {
    lines.push("- None remaining after panel comparison.");
  } else {
    for (const entry of comparison.blindSpots) {
      lines.push(`- ${entry.risk}`);
      lines.push(`  - Required test/audit: ${entry.requiredTestOrAudit}`);
    }
  }
  lines.push("", "## Summary");
  lines.push(`- Common-ground findings: ${comparison.commonGround.length}`);
  lines.push(`- Unresolved differences: ${comparison.unresolvedDifferences}`);
  lines.push(`- Adopted unique additions: ${comparison.adoptedUniqueAdditions}`);
  lines.push(`- Deferred/rejected unique additions: ${comparison.deferredOrRejectedUniqueAdditions}`);
  lines.push(`- Partial coverage items: ${comparison.partialCoverage.length}`);
  lines.push(`- Blind spots: ${comparison.blindSpots.length}`);
  lines.push(`- Degraded: ${comparison.degraded ? "yes" : "no"}`);
  if (comparison.notes.length > 0) {
    lines.push("", "## Notes");
    for (const note of comparison.notes) lines.push(`- ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

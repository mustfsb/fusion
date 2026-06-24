You are one independent expert panelist in a Fusion speculative-parallel-build council.

This file is the SHARED canonical task. It is byte-identical across all panels.
Your per-panel execution assignment (your resolved candidate workspace, the
prohibited source workspace, the absolute-path operating protocol, and your
panel-owned output paths) is delivered separately in your execution-context
file. Read that execution-context file FIRST, then read this shared task fully
until EOF. This shared task intentionally contains no workspace paths.

WRITE BOUNDARY (mandatory; concrete paths are in your execution-context file):
- You may ONLY create, edit, patch, or delete files inside your assigned candidate workspace.
- You MUST NOT write, edit, patch, or delete anything in the real source workspace or any other panel workspace.
- The OpenCode runtime does not path-scope write permissions for subagents. Operate in absolute-path mode as your execution-context file instructs.

TASK FLOW (you must actually perform all of these, not just plan them):
1. Read your execution-context file, then this complete canonical task until EOF.
2. Inspect ONLY your assigned candidate workspace.
3. Implement a full competing solution for the user task inside your assigned candidate workspace.
4. Create or update tests using the project's existing test framework.
5. Run relevant typecheck/test/build commands INSIDE your candidate workspace.
6. Write a concise candidate report to your panel-owned report path (use the Candidate Report Format below).
7. Generate a patch/diff from your local candidate baseline.
8. Return a short final visible response containing only completion state and artifact paths.

Do NOT produce only a high-level plan or partial snippets. Do NOT paste complete candidate source into your final response — the candidate code lives in your candidate workspace.

CANDIDATE REPORT FORMAT (write this to your panel-owned report path):
# Candidate Status
- completed / partial / blocked

## Verification
- commands run
- pass/fail
- known failures

## Files Changed
- exact paths

## Literal Contract Coverage
- concise requirements handled

## Important Design Decisions
- concise bullets

## Hidden-Test Risks Addressed
- concise bullets

## Known Gaps / Risks
- concise bullets

CONTRACT GATE (correct it only when the original task clearly proves it wrong):
## Derived Contract Gate
### A. Literal Public Surface
- Required package-root exports: clock, Date.now, InvalidInputError, audit, true, defaultLeaseMs, 30_000.
- Required typed errors/types: clock, Date.now, InvalidInputError, audit, true, defaultLeaseMs, 30_000, ConflictError, EntityNotFoundError, LeaseTokenError, SnapshotError.
- Exact option/property names mentioned in the task: outbox, input, workerId, options, eventId, leaseToken, reason, filter, snapshot, serialized, before, after, clock, audit, defaultLeaseMs, dedupeKey, destination, payload, priority, maxAttempts, retryBaseDelayMs, id, status, attemptCount, createdAt, updatedAt, nextAttemptAt, leasedBy, leaseExpiresAt, deliveredAt, deadLetteredAt, lastFailureReason, kind, event, sequence, timestamp, type, fromTimestamp, toTimestamp, version, capturedAt, events, dedupeRecords, nextEventSequence, nextLeaseSequence, nextAuditSequence, addedEventIds, removedEventIds, changedEvents, addedDedupeKeys, removedDedupeKeys, changedDedupeRecords, auditChanges, added, removed, changed, versionChanged, capturedAtChanged.
- sweepExpiredLeases: set `nextAttemptAt` to `null`
- sweepExpiredLeases: `sweepExpiredLeases` returns the exact number of events settled.
- getEvent: Missing event throws `EntityNotFoundError`.
- getEvent: Return defensive copy.
- listEvents: Filter values must be valid.
- listEvents: Returned values are defensive copies.
- listEvents: Reads must not mutate event state or audit history.

### B. Behavioral Boundaries
- This is a local-first durable delivery outbox. It supports idempotent event enqueueing, priority scheduling, delivery leases, retries with deterministic backoff, dead-letter handling, audit events, snapshots, serialization, and deterministic diffs.
- The `Outbox` object may expose equivalent methods for convenience, but instance methods must not replace required package-root exports.
- Event IDs must be deterministic within one outbox instance, such as sequential IDs.
- Replay must not mutate:
- deterministic sequences
- generate a deterministic, unique lease token
- A lease is expired exactly when:
- For every leased event whose lease is expired:
- Return defensive copy.
- Reads must not mutate event state or audit history.
- `createSnapshot` returns a complete defensive copy.
- deterministic next event, lease, and audit sequences

### C. Consumer Compatibility
- None explicit.

### D. External Consumer Probes
- Package-root import/export checks for: clock, Date.now, InvalidInputError, audit, true, defaultLeaseMs, 30_000.
- Typed error export and throw-contract checks for: clock, Date.now, InvalidInputError, audit, true, defaultLeaseMs, 30_000, ConflictError, EntityNotFoundError, LeaseTokenError, SnapshotError.
- Consumer-facing option/property names match the literal contract: outbox, input, workerId, options, eventId, leaseToken, reason, filter, snapshot, serialized, before, after, clock, audit, defaultLeaseMs, dedupeKey, destination, payload, priority, maxAttempts, retryBaseDelayMs, id, status, attemptCount, createdAt, updatedAt, nextAttemptAt, leasedBy, leaseExpiresAt, deliveredAt, deadLetteredAt, lastFailureReason, kind, event, sequence, timestamp, type, fromTimestamp, toTimestamp, version, capturedAt, events, dedupeRecords, nextEventSequence, nextLeaseSequence, nextAuditSequence, addedEventIds, removedEventIds, changedEvents, addedDedupeKeys, removedDedupeKeys, changedDedupeRecords, auditChanges, added, removed, changed, versionChanged, capturedAtChanged.
- Public getters, snapshots, audits, and diffs do not leak tokens, secrets, or mutable internal state unless explicitly required.

Be concise. Prefer bullets. Cover common traps: package main/types vs dist, typed errors vs raw Error leaks, mutable internals exposed, partial mutation before failure, JSON-safety, determinism, tests emitted into dist.

LITERAL RULES:
- Treat the original task as the source of truth. Consensus is not truth by vote count.
- Do not weaken explicit exports, error types, options, field names, return behavior, or visibility requirements.
- Do not assume an instance method satisfies a task that explicitly requests a package-root export.
- If visible tests pass but hidden probes would still fail, your candidate is failing.
- Flag ambiguities instead of inventing behavior.

USER TASK:
Build a small, production-minded TypeScript library named `outboxkit`.

This is a local-first durable delivery outbox. It supports idempotent event enqueueing, priority scheduling, delivery leases, retries with deterministic backoff, dead-letter handling, audit events, snapshots, serialization, and deterministic diffs.

Use TypeScript in strict mode and Vitest. Do not use runtime dependencies.

This must be a reusable library, not a CLI, web app, or backend service.

## Required package-root exports

Every symbol below must be a named export from the package root entry point.

Export these functions:

```ts
createOutbox(options?: OutboxOptions): Outbox

enqueue(
  outbox: Outbox,
  input: EnqueueInput
): EnqueueResult

claimNext(
  outbox: Outbox,
  workerId: string,
  options?: { leaseMs?: number }
): DeliveryClaim | null

acknowledgeDelivery(
  outbox: Outbox,
  eventId: string,
  leaseToken: string
): OutboxEvent

failDelivery(
  outbox: Outbox,
  eventId: string,
  leaseToken: string,
  reason: string
): OutboxEvent

sweepExpiredLeases(
  outbox: Outbox
): number

getEvent(
  outbox: Outbox,
  eventId: string
): OutboxEvent

listEvents(
  outbox: Outbox,
  filter?: EventFilter
): OutboxEvent[]

getAuditLog(
  outbox: Outbox,
  filter?: AuditFilter
): AuditEvent[]

createSnapshot(
  outbox: Outbox
): OutboxSnapshot

restoreSnapshot(
  snapshot: OutboxSnapshot,
  options?: OutboxOptions
): Outbox

serializeOutbox(
  outbox: Outbox
): string

parseOutbox(
  serialized: string,
  options?: OutboxOptions
): Outbox

diffSnapshots(
  before: OutboxSnapshot,
  after: OutboxSnapshot
): OutboxSnapshotDiff
```

Export these types:

```ts
Outbox
OutboxOptions
EnqueueInput
EnqueueResult
OutboxEvent
OutboxEventStatus
DeliveryClaim
EventFilter
AuditEvent
AuditEventType
AuditFilter
DedupeRecord
OutboxSnapshot
OutboxSnapshotDiff
EventChange
DedupeRecordChange
```

Export these typed errors:

```ts
OutboxError
InvalidInputError
EntityNotFoundError
ConflictError
LeaseTokenError
SnapshotError
```

The `Outbox` object may expose equivalent methods for convenience, but instance methods must not replace required package-root exports.

## Outbox options

```ts
type OutboxOptions = {
  clock?: () => number
  audit?: boolean
  defaultLeaseMs?: number
}
```

Rules:

* `clock` is optional.
* Every timestamp must use supplied `clock` when present.
* Do not call `Date.now()` in custom-clock paths.
* Clock values must be non-negative safe integers. An invalid clock result throws `InvalidInputError`.
* `audit` defaults to `true`.
* `defaultLeaseMs` defaults to `30_000`.
* `defaultLeaseMs` must be a positive safe integer.
* Invalid options throw `InvalidInputError`.

## Event model

```ts
type OutboxEventStatus =
  | "queued"
  | "leased"
  | "delivered"
  | "dead_letter"

type EnqueueInput = {
  dedupeKey: string
  destination: string
  payload: Record<string, string>
  priority?: number
  maxAttempts?: number
  retryBaseDelayMs?: number
}

type OutboxEvent = {
  id: string
  dedupeKey: string
  destination: string
  payload: Record<string, string>
  priority: number
  maxAttempts: number
  retryBaseDelayMs: number
  status: OutboxEventStatus
  attemptCount: number
  createdAt: number
  updatedAt: number
  nextAttemptAt: number | null
  leasedBy: string | null
  leaseExpiresAt: number | null
  deliveredAt: number | null
  deadLetteredAt: number | null
  lastFailureReason: string | null
}

type EnqueueResult = {
  kind: "enqueued" | "replayed"
  event: OutboxEvent
}

type DeliveryClaim = {
  event: OutboxEvent
  leaseToken: string
}
```

Rules:

* `dedupeKey` and `destination` must be non-empty after trimming.
* Store canonical trimmed values.
* Payload keys and values must be non-empty after trimming.
* Payload keys and values are stored trimmed.
* Duplicate payload keys after trimming are invalid.
* Canonical payload equality is based on sorted normalized key/value pairs.
* `priority` defaults to `0` and must be a safe integer. It may be negative.
* `maxAttempts` defaults to `3` and must be a positive safe integer.
* `retryBaseDelayMs` defaults to `1_000` and must be a positive safe integer.
* The maximum possible retry delay must fit in a safe integer:

```txt
retryBaseDelayMs * 2^(maxAttempts - 1)
```

* New events begin with:

  * `status: "queued"`
  * `attemptCount: 0`
  * `nextAttemptAt: current clock time`
  * `leasedBy: null`
  * `leaseExpiresAt: null`
  * `deliveredAt: null`
  * `deadLetteredAt: null`
  * `lastFailureReason: null`
* Event IDs must be deterministic within one outbox instance, such as sequential IDs.
* Returned events must be defensive copies.

## Idempotent enqueueing

A dedupe key permanently binds to this normalized payload:

```txt
dedupeKey
destination
payload
priority
maxAttempts
retryBaseDelayMs
```

Rules:

* Same canonical dedupe key with identical normalized payload returns:

```ts
{
  kind: "replayed",
  event: originalEvent
}
```

* Replay must not mutate:

  * event state
  * timestamps
  * event count
  * audit history
  * deterministic sequences
* Reusing the same canonical dedupe key with any differing normalized field throws `ConflictError`.
* Delivered and dead-letter events still retain their dedupe identity.
* Dedupe records must survive snapshots, restore, serialization, and parse.

## Delivery claiming

```ts
claimNext(
  outbox,
  workerId,
  options?
): DeliveryClaim | null
```

Rules:

* `workerId` must be non-empty after trimming.
* Optional `leaseMs` must be a positive safe integer.
* When omitted, use `defaultLeaseMs`.
* Before selecting an event, `claimNext` must settle every expired lease using the exact same semantics as `sweepExpiredLeases`.
* Only queued events with:

```txt
nextAttemptAt <= now
```

are eligible.

Eligible events are sorted by:

1. Higher `priority` first
2. Earlier `nextAttemptAt` first
3. Earlier `createdAt` first
4. Canonical event ID ascending

When no eligible event exists, return `null`.

On a successful claim:

* event status becomes `leased`
* `attemptCount` increments exactly once
* `leasedBy` becomes trimmed worker ID
* `leaseExpiresAt` becomes `now + leaseMs`
* `nextAttemptAt` becomes `null`
* `updatedAt` becomes current time
* generate a deterministic, unique lease token
* emit `event_claimed`
* return the public event plus the lease token

The token is returned only from `claimNext`.

## Lease expiration and retry behavior

A lease is expired exactly when:

```txt
now >= leaseExpiresAt
```

Read methods do not settle expired leases automatically.

Only these operations settle expired leases:

```txt
claimNext
sweepExpiredLeases
```

### `sweepExpiredLeases`

For every leased event whose lease is expired:

* clear lease token internally
* clear public `leasedBy`
* clear `leaseExpiresAt`
* set `updatedAt` to current time
* set `lastFailureReason` to `"lease expired"`

If:

```txt
attemptCount < maxAttempts
```

then:

* set status to `queued`
* set:

```txt
nextAttemptAt =
now + retryBaseDelayMs * 2^(attemptCount - 1)
```

* emit exactly one `lease_expired` audit event

Otherwise:

* set status to `dead_letter`
* set `deadLetteredAt` to current time
* set `nextAttemptAt` to `null`
* emit exactly one `event_dead_lettered` audit event

`sweepExpiredLeases` returns the exact number of events settled.

## Acknowledging delivery

```ts
acknowledgeDelivery(
  outbox,
  eventId,
  leaseToken
): OutboxEvent
```

Rules:

* Event ID and lease token must be non-empty after trimming.
* Event must exist or throw `EntityNotFoundError`.
* Event must be `leased` and currently unexpired.
* Wrong token on an active unexpired leased event throws `LeaseTokenError`.
* Delivered, queued, dead-letter, or expired leased events throw `ConflictError`.
* On success:

  * status becomes `delivered`
  * `deliveredAt` becomes current time
  * `updatedAt` becomes current time
  * clear internal lease token
  * clear `leasedBy`
  * clear `leaseExpiresAt`
  * keep `attemptCount`
  * emit `delivery_acknowledged`
* Acknowledge must be atomic.

## Failing delivery

```ts
failDelivery(
  outbox,
  eventId,
  leaseToken,
  reason
): OutboxEvent
```

Rules:

* Event ID, lease token, and reason must be non-empty after trimming.
* Store failure reason trimmed.
* Event must exist or throw `EntityNotFoundError`.
* Event must be `leased` and currently unexpired.
* Wrong token on an active unexpired lease throws `LeaseTokenError`.
* Delivered, queued, dead-letter, or expired leased events throw `ConflictError`.
* Clear lease data on success.
* Set `updatedAt` to current time.
* Set `lastFailureReason` to trimmed reason.

If:

```txt
attemptCount < maxAttempts
```

then:

* set status to `queued`
* set retry time using the same exponential formula as expired leases
* emit exactly one `delivery_requeued` event

Otherwise:

* set status to `dead_letter`
* set `deadLetteredAt` to current time
* set `nextAttemptAt` to `null`
* emit exactly one `event_dead_lettered` event

Failure handling must be atomic.

## Reads and filtering

### `getEvent`

* Trim event ID.
* Missing event throws `EntityNotFoundError`.
* Return defensive copy.
* Never expose lease token.

### `listEvents`

```ts
type EventFilter = {
  status?: OutboxEventStatus
  destination?: string
  dedupeKey?: string
}
```

Rules:

* Filter values must be valid.
* `destination` and `dedupeKey` are trimmed.
* Results are sorted by:

  1. `createdAt` ascending
  2. canonical event ID ascending
* Returned values are defensive copies.
* Reads must not mutate event state or audit history.

## Audit log

```ts
type AuditEventType =
  | "event_enqueued"
  | "event_claimed"
  | "delivery_acknowledged"
  | "delivery_requeued"
  | "lease_expired"
  | "event_dead_lettered"

type AuditEvent = {
  sequence: number
  timestamp: number
  type: AuditEventType
  eventId: string
  destination: string
  workerId?: string
}
```

Rules:

* Sequence begins at `1`.
* Every explicit successful event state transition emits exactly one audit event.
* Settling each expired lease emits exactly one audit event.
* A `claimNext` call may create multiple events when it first settles expired leases and then claims an event.
* Enqueue replay emits no event.
* Failed operations emit no event.
* Audit events never expose lease tokens.
* Events are returned in sequence order.
* Returned values are defensive copies.

```ts
type AuditFilter = {
  type?: AuditEventType
  eventId?: string
  destination?: string
  workerId?: string
  fromTimestamp?: number
  toTimestamp?: number
}
```

Rules:

* String filter fields are trimmed.
* Invalid filter values throw `InvalidInputError`.
* Timestamp bounds are inclusive.

## Snapshots and restore

```ts
type DedupeRecord = {
  dedupeKey: string
  destination: string
  payload: Record<string, string>
  priority: number
  maxAttempts: number
  retryBaseDelayMs: number
  eventId: string
}

type OutboxSnapshot = {
  version: 1
  capturedAt: number
  events: Array<OutboxEvent & { leaseToken: string | null }>
  dedupeRecords: DedupeRecord[]
  audit: AuditEvent[]
  nextEventSequence: number
  nextLeaseSequence: number
  nextAuditSequence: number
}
```

Rules:

* Snapshots are trusted persistence data and may contain lease tokens because active leases must be restored correctly.
* `createSnapshot` returns a complete defensive copy.
* Snapshot preserves:

  * events
  * active lease tokens
  * dedupe records
  * audit history
  * deterministic next event, lease, and audit sequences
* Restored and parsed outboxes must use newly supplied options and clock for future operations.
* Mutating a source snapshot after restore must not alter restored state.
* `serializeOutbox` returns valid JSON.
* Invalid JSON or invalid snapshot shape throws `SnapshotError`.

Reject at least:

* unsupported version
* duplicate canonical event IDs
* duplicate canonical dedupe keys
* invalid status or event fields
* invalid timestamps
* invalid queued/leased/delivered/dead-letter field combinations
* invalid lease token combinations
* invalid retry timing
* invalid attempt count/max attempt combinations
* duplicate or malformed event IDs where detectable
* dedupe records referencing missing events
* dedupe records whose normalized fields do not match referenced event data
* duplicate or non-increasing audit sequences
* malformed audit events where detectable
* invalid next sequence values

## Snapshot diff

```ts
type EventChange = {
  id: string
  before: OutboxEvent | null
  after: OutboxEvent | null
}

type DedupeRecordChange = {
  dedupeKey: string
  before: DedupeRecord | null
  after: DedupeRecord | null
}

type OutboxSnapshotDiff = {
  addedEventIds: string[]
  removedEventIds: string[]
  changedEvents: EventChange[]

  addedDedupeKeys: string[]
  removedDedupeKeys: string[]
  changedDedupeRecords: DedupeRecordChange[]

  auditChanges: {
    added: AuditEvent[]
    removed: AuditEvent[]
    changed: Array<{
      sequence: number
      before: AuditEvent
      after: AuditEvent
    }>
  }

  versionChanged: boolean
  capturedAtChanged: boolean
}
```

Rules:

* Detect added, removed, and changed events.
* Detect added, removed, and changed dedupe records.
* Detect added, removed, and changed audit events.
* Public diff event values must never expose lease tokens.
* Equal snapshots produce no false changes.
* Output ordering is deterministic:

  * event IDs ascending
  * dedupe keys ascending
  * audit entries by sequence
* Mutating diff output must not mutate either input snapshot.

## Immutability and integrity

External callers must not mutate internal outbox state through:

* returned events
* payload objects
* claims
* audit events
* snapshots
* restored snapshots
* diff output
* `before` and `after` diff values

The outbox must never:

* expose lease tokens through public read APIs, audit events, or diffs
* create duplicate events from idempotent replay
* let stale/incorrect tokens acknowledge or fail an active lease
* allow terminal events to be claimed again
* allow expired leases to remain claim-blocking after `claimNext` or `sweepExpiredLeases`
* partially mutate data on failed operations
* lose dedupe behavior after restore or parse

## Required tests

Write meaningful Vitest tests for at least:

* every required package-root export exists
* all typed errors are exported and work with `instanceof`
* custom clock behavior is deterministic
* invalid clock results fail
* invalid outbox options fail
* whitespace-only dedupe keys, destinations, worker IDs, reasons, payload keys, and payload values fail
* payload canonicalization trims keys and values
* duplicate normalized payload keys fail
* idempotent enqueue replay has no side effects
* same dedupe key with changed normalized payload throws `ConflictError`
* claim ordering follows priority, next attempt time, created time, then ID
* no eligible event returns `null`
* claim increments attempt count exactly once
* lease token is returned only by claim
* active wrong-token acknowledge/fail throws `LeaseTokenError`
* leased event cannot be claimed again
* exact lease expiry boundary uses `now >= leaseExpiresAt`
* `sweepExpiredLeases` requeues before max attempts
* exhausted attempt count dead-letters correctly
* exponential retry delays are correct
* `claimNext` settles expired leases before selecting work
* acknowledge terminal state transitions correctly
* fail delivery requeues or dead-letters correctly
* audit behavior is correct, including replay no-op behavior
* audit filters use exact `fromTimestamp` and `toTimestamp`
* audit timestamps are inclusive
* public events, claims, audits, and diff values never expose tokens
* snapshots restore active lease tokens correctly
* restored and parsed outboxes preserve dedupe behavior
* restored and parsed outboxes follow future replacement clock changes
* malformed JSON and invalid snapshot data throw `SnapshotError`
* diff detects event, dedupe, and audit changes
* equal snapshots produce no false changes
* all public outputs are defensive copies

## Project requirements

Provide:

```txt
package.json
tsconfig.json
tsconfig.build.json
vitest.config.ts
README.md
src/
tests/
```

Use scripts:

```txt
npm run typecheck
npm test
npm run build
```

Before finishing, run all three commands and fix failures.

README must explain:

* idempotent enqueueing
* priority scheduling
* lease and retry behavior
* exact lease expiration rule
* delivery acknowledgment and failure behavior
* dead-letter behavior
* snapshot/restore clock behavior
* a short usage example

Prioritize literal API compliance, lease correctness, retry timing, token secrecy, idempotency, atomicity, snapshots, deterministic behavior, and defensive public outputs over unnecessary features. 

Context summary:
Git branch: unavailable
Changed files: none or unavailable
Included files: none
Git diff included: no
Omitted: README.md could not be read: ENOENT: no such file or directory, stat '/Users/mustafa/candidate-b/README.md'; AGENTS.md could not be read: ENOENT: no such file or directory, stat '/Users/mustafa/candidate-b/AGENTS.md'; CLAUDE.md could not be read: ENOENT: no such file or directory, stat '/Users/mustafa/candidate-b/CLAUDE.md'; package.json could not be read: ENOENT: no such file or directory, stat '/Users/mustafa/candidate-b/package.json'; tsconfig.json could not be read: ENOENT: no such file or directory, stat '/Users/mustafa/candidate-b/tsconfig.json'; opencode.json could not be read: ENOENT: no such file or directory, stat '/Users/mustafa/candidate-b/opencode.json'; opencode.jsonc could not be read: ENOENT: no such file or directory, stat '/Users/mustafa/candidate-b/opencode.jsonc'; .opencode/opencode.json could not be read: ENOENT: no such file or directory, stat '/Users/mustafa/candidate-b/.opencode/opencode.json'
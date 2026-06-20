export const specTrapTask = [
  "Build a small TypeScript rate-limit helper.",
  "",
  "Requirements:",
  "* Export `consumeLimit(engine, request)`, `restoreSnapshot(snapshot)`, `parseEngine(json)`, and `diffSnapshots(base, target)`.",
  "* `consumeLimit` must throw `LimitExceededError` when allowance is exceeded; returning `{ allowed: false }` is incorrect for this task.",
  "* Sliding-window entries at exactly `now - windowMs` must expire.",
  "* When a deterministic `clock` is injected, restore/parse must continue from that deterministic time model after serialization.",
  "* `diffSnapshots` must preserve the documented public shape exactly.",
  "* Write tests beyond visible happy paths.",
].join("\n");

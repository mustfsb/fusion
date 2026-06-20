---
description: Run Fusion Council review
agent: plan
---
Use the `fusion_council` tool with mode `review` and `includeDiff: true`.

By default, use modelSource `auto`, panel models `opencode-go/kimi-k2.7-code`, `opencode-go/qwen3.7-max`, `opencode-go/minimax-m3`, and judge model `openai/gpt-5.5`.

Review request: $ARGUMENTS

Prioritize bugs, regressions, security risks, maintainability issues, and missing tests. Return the tool result and do not modify files.

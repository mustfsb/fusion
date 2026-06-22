---
description: Configure Fusion Council model selection and sync native subagents — show, set, or reset panel/judge models globally
---
Call the `fusion_model_config` tool based on the argument provided.

If "$ARGUMENTS" is empty or whitespace only:
- Call with `{ "action": "show" }`

If "$ARGUMENTS" trimmed equals `reset` (case-insensitive):
- Call with `{ "action": "reset" }`

Otherwise:
- Call with `{ "action": "set", "models": "$ARGUMENTS" }`

The `models` value for `set` must be exactly 4 comma-separated model specs:
- First 3 are panel models
- 4th is the judge model
- Each spec uses `provider/model` or optional `provider/model/effort`
- Allowed efforts: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`

Examples:
```
/fusion-model opencode-go/kimi-k2.7-code, opencode-go/qwen3.7-max, opencode-go/minimax-m3, openai/gpt-5.5
/fusion-model opencode-go/kimi-k2.7-code, opencode-go/minimax-m3, opencode-go/qwen3.7-max, openai/gpt-5.4/high
/fusion-model openai/gpt-5.4/medium, openai/gpt-5.4/medium, openai/gpt-5.4/medium, openai/gpt-5.4/xhigh
```

When you `set` or `reset`, the tool also regenerates the native OpenCode subagent agent files (`fusion-panel-1`, `fusion-panel-2`, `fusion-panel-3`, `fusion-judge`) into `~/.config/opencode/agent/` so `/fusion-build` and `/fusion-no-build` dispatch those exact models as native Task subagents. Judge reasoning effort is preserved as the agent `variant` when supported.

Report the tool result without modification. If the result says to restart OpenCode, tell the user to restart so the new agent definitions take effect (OpenCode loads agent files once at startup).

Model IDs are not registry-validated; confirm with `/models` if a model fails at runtime.

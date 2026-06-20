---
description: Configure Fusion Council model selection — show, set, or reset panel models and judge model globally
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

Report the tool result without modification.

Model IDs are not registry-validated; confirm with `/models` if a model fails at runtime.

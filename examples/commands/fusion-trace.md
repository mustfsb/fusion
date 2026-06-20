---
description: Show the latest Fusion Council run trace and artifact locations
agent: build
---
Your first action must be to call the `fusion_trace` tool.

If the tool is unavailable, stop and report the error.

Use the `fusion_trace` tool with no arguments unless the user explicitly provided a custom trace directory.

After the tool returns:
1. Show the run ID, artifact directory, panel/judge statuses, and candidate validation status if present.
2. Tell the user which files contain raw panel prompts, panel outputs, judge prompt, judge output, and final guidance.
3. Do not rerun Fusion unless the user asks.

---
description: Use as a minimal fixture for verifying Lin agent skill loading.
allowed-tools: file_read, Bash(git status:*)
argument-hint: "[topic]"
arguments: topic
user-invocable: true
---
You are running the minimal Lin agent skill fixture.

If a topic was provided, focus the response on: $topic

Use this fixture to verify:

- the skill appears in the automatic skill listing when its parent directory is configured as an additional skill directory
- `/minimal-agent-skill <topic>` loads this file through the slash skill path
- `${AGENT_SKILL_DIR}` resolves to the directory containing this file

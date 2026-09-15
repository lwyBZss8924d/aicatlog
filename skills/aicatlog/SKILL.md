---
name: aicatlog
description: Discover and manage registered environment, harness and Skills resources with aicatlog. Use for resource navigation, focused source retrieval, Skills installation/projection, or repository foundation setup.
---

# aicatlog

Start with `aicatlog catalog` or `aicatlog --help`. Known resource IDs can go directly
to `get` or `read`. Use `--registry <file>` for a repository or alternate profile.

Use `list` and `find` for metadata. Select one scope before `find --content`; use
`--fresh` for recent edits or current absence checks. `read` always reads the source.
Use `--schema --json` for exact inputs/outputs and `--filter-output` to narrow results.
For a declared context resource, use `context inspect <id>` to select one current
heading, then `read <id> --section <selector>`. References are inert; inspect only
the source needed for the task. Retired catalog aliases return their canonical ID
and do not create native Skill-name aliases or extra loading roots.

Source changes are prepared first. Inspect the returned plan, then use
`aicatlog apply --plan <file>` within the task's authorization. External source
owners retain their update paths. A receipt, cached index or successful process
does not grant acceptance or permission to resume an unrelated Goal.

Use `index status <scope>` to inspect a background index. `index stop <scope>` releases
the current session lease; other active sessions retain their worker.

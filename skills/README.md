# Skills

Reusable instruction files for recurring tasks in this repo. Each skill is a single markdown
file with YAML front matter that names it and describes when an AI agent should invoke it.

## Available skills

| Skill | When to use |
|---|---|
| [analyze-issue](analyze-issue.md) | Assess any issue, bug, or feature request against the current branch: fixed status, impact, compatibility, scope, and effort |
| [update-docs](update-docs.md) | Update or add a page under `docs/content/` |
| [package-extension](package-extension.md) | Build the `.vsix` via `npm run package` |

To reuse issue analysis, ask: `Use analyze-issue to assess #<number>` or
`Use analyze-issue to assess this feature request: <description>`. It produces an
evidence-based report, not an implementation, unless you explicitly request one.

## Layout

Skills live here as the canonical source. The issue-analysis skill has standard
folder-based entry points that load the workflow without duplicating its instructions:

| Harness | Entry point |
|---|---|
| GitHub Copilot | [`.github/skills/analyze-issue/SKILL.md`](../.github/skills/analyze-issue/SKILL.md) |
| Claude Code | [`.claude/skills/analyze-issue/SKILL.md`](../.claude/skills/analyze-issue/SKILL.md) |

These small loader files also work on Windows checkouts where Git symlinks are
materialized as plain text (`core.symlinks=false`). For new folder-based skills,
keep the workflow here and use a `SKILL.md` entry point with matching `name` and
`description` front matter and a relative link to the canonical file.

The existing file-based skills use legacy symlinks in harness-specific directories:

| Harness | Path | Notes |
|---|---|---|
| Claude Code | [`.claude/skills/`](../.claude/skills/) | Symlinks to files in this directory |
| GitHub Copilot / awesome-copilot | [`.github/instructions/`](../.github/instructions/) | Symlinks to files in this directory |

When adding a legacy file-based alias, create the symlinks too:

```bash
ln -s ../../skills/<skill>.md .claude/skills/<skill>.md
ln -s ../../skills/<skill>.md .github/instructions/<skill>.md
```

## Authoring

Front matter:

```yaml
---
name: kebab-case-id
description: One-line summary an agent reads to decide whether the skill applies.
when_to_use: Concrete trigger phrases or situations.
---
```

Body sections we use consistently:

- A short overview of what the skill produces or changes.
- Prerequisites, then the **Steps** as commands the agent can run.
- Troubleshooting for common failure modes.
- An **Anti-patterns** section describing what *not* to do — these prevent regressions when
  agents pattern-match from training data instead of from this repo.

Keep skills repo-specific. Generic agentic-engineering tips belong in
[`AGENTS.md`](../AGENTS.md), not here.

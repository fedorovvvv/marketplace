# Agent frontmatter — the canonical fields

An agent is a Markdown file with YAML frontmatter (the contract) and a body (the procedure). The frontmatter declares what the agent is and which tools it must not call; the body states — via a `## Model tier` section — which tier of model the work needs. Get the frontmatter wrong and the agent is silently mis-dispatched or loses its MCP access — the body cannot fix a broken contract.

## The fields

| Field | Required | Rule |
|---|:---:|---|
| `name` | yes | kebab-case, matches filename without `.md`. Dispatched as `subagent_type="pack:name"`. |
| `description` | yes | bilingual block — `EN:` + `RU:` + `Triggers:`. Shown in the dispatcher picker; drives fuzzy intent matching. |
| `color` | yes | hex `#RRGGBB` only. Named colors (`red`, `blue`) break some terminals. |
| `disallowedTools` | yes | a denylist of tool names. NOT an allowlist — see `tools-and-denylist.md`. |
| `skills` | optional | list of `<plugin>:<skill>` the agent orchestrates; helps the orchestrator pre-load skill context. |
| `maxTurns` | optional | integer cap on the agent's turn budget (typical 20-80). Prevents runaway loops. |
| `isolation` | optional | only value is `worktree` — runs the agent in an isolated git worktree (source-writer pattern). |

## Rule — no `model:` field, ever

Marketplace agents pin no model in frontmatter. `opus` / `sonnet` / `haiku` are Claude Code's own
names — OMP, OpenCode, Codex and Gemini CLI read the same file, recognise none of the three, and
fall back to their own default, which may sit far below or far above what the agent needs. Pick
the **tier** the work needs instead, and state it in a `## Model tier` body section (see
`profiles.md` and the worked example below) — that travels across runtimes; a frontmatter value
would not.

- **opus-tier** — judges trade-offs, runs reasoning cycles. Examples: `adr-architect`, `guardian`, `security-expert`.
- **sonnet-tier** — structured mechanical work: scaffolding, drafting, applying lints, running tests. Examples: `coder`, `tester`, `code-reviewer`.
- **haiku-tier** — fast classification, single-keyword scans, yes/no checks.

Defaulting high is wasteful; defaulting low is unsafe. When unsure, sonnet-tier.

## Example — a real frontmatter (agents-core `coder`)

```yaml
---
name: coder
description: |
  EN: Source-mutating implementation agent (Profile C-coder). The only agent
      allowed Write / Edit / Bash on source files. Hands off to a Profile B reviewer.
  RU: Агент-исполнитель, мутирующий исходники. Передаёт ревьюеру.
  Triggers: "implement", "write code", "build it", "реализуй", "напиши код"
color: "#00897B"
disallowedTools: mcp__forgeplan__forgeplan_new, mcp__forgeplan__forgeplan_update, ...
skills:
  - fp-cookbook
isolation: worktree    # the only writer who gets a worktree
maxTurns: 50
---
```

The `description` is parseable: the dispatcher reads `EN:`/`RU:` for the picker and `Triggers:` for fuzzy matching. A single-line description (no EN/RU/Triggers) ships, but the orchestrator cannot route to it well.

## Trap — a `model:` field at all, and named colors

Two silent-degradation traps:

1. **Any `model:` field** — even a "correct" `model: opus` binds the agent to Claude Code's vocabulary alone; every other runtime either ignores it or has no equivalent name to resolve it against. State the tier in the body's `## Model tier` section instead, never in frontmatter.
2. **`color: red`** — named colors render inconsistently across terminals; some show nothing. Always hex.

## Related

- `tools-and-denylist.md` — why `disallowedTools` is a denylist, and the `memory: project` trap
- `profiles.md` — the profile dictates the tier and the blocked set
- `examples.md` — full annotated frontmatter + body of real agents
- `../plugins/manifest.md` — where agent files sit inside a plugin

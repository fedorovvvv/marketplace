[English](README.md) | [Русский](README-RU.md)

# fpl-hsmem

> Long-term, cross-session memory for Claude Code. Wraps [Hindsight](https://github.com/vectorize-io/hindsight) with 28 MCP tools, 3 auto hooks, 10 helper skills and a curator agent — Claude remembers context across sessions, projects, and weeks.

> [!IMPORTANT]
> **3.7.0** changes how the plugin is configured and what it captures. Plugin name, server name and the 27 existing tool names are unchanged, so `mcp__plugin_fpl-hsmem_hindsight__*` keeps working; one tool (`memory_retain_batch`) is new.

What changed in 3.7.0:

- **Project-only opt-in.** Inert (no tools, hooks no-op) unless a `.hindsight.json` is found walking up from cwd. No user-wide config, no bank derived from the directory name.
- **Several banks.** `banks` allowlist + `defaultBank`; every bank-scoped tool takes an optional `bank`. Banks outside the allowlist or missing on the server are refused — nothing ever creates a bank.
- **No transcript capture by default.** The Stop / SessionEnd hooks stay but do nothing unless `autoRetain: true`. Auto-recall is opt-in too (`autoRecall: true`).
- **Hindsight 0.10.x** (verified against 0.10.2): no removed endpoints are called.
- **Batch enrichment.** `memory_retain_batch` (and `dist/enrich.mjs` for a shell) writes a reviewed file of distilled items across banks — validated, routed, secret-scanned, dry run first. The `/fpl-hsmem:enrich` skill is the procedure.

## Quick Start

```bash
# 1. Install the plugin
/plugin install fpl-hsmem@ForgePlan-marketplace

# 2. Opt the project in — the banks must already exist on the server
cat > .hindsight.json <<'JSON'
{
  "url": "http://hindsight.example.internal:8888",
  "banks": ["team", "analytics"],
  "defaultBank": "team",
  "tokenFile": ".secrets/hindsight.token"
}
JSON

# 3. Restart Claude Code here and verify
memory_get_current_bank
```

Full schema and the reasoning behind each default: [`CONFIGURATION.md`](./CONFIGURATION.md).

For a fresh setup from zero — Docker, plugin install, first bootstrap, first mental model — see [`GETTING-STARTED.md`](./GETTING-STARTED.md).

## Usage Examples

### Auto-recall in conversation

```
> What did we decide about authentication last week?

[hidden context injected by recall.js hook]
  - JWT RS256 over symmetric HS256 — security review NOTE-003
  - Refresh token rotation every 7d (Orchestra ADR-012)
  - Service-to-service auth via mTLS, not JWT

We landed on JWT RS256 with 7-day refresh token rotation, recorded in
ADR-012. Service-to-service traffic stays on mTLS — JWT only for
end-user sessions.
```

The user never sees the `<hindsight_memories>` block — but Claude does, and answers with full context.

### `/fpl-hsmem:bootstrap` — wire memory to a new project

```
> /fpl-hsmem:bootstrap

Bootstrap plan for "my-project" bank:
  • set mission         "TypeScript API for billing — focus on technical
                         decisions, data model changes, deprecations."
  • ingest 4 documents  forge/prds/PRD-001-billing.md
                        forge/rfcs/RFC-002-stripe.md
                        forge/adrs/ADR-003-currency.md
                        docs/architecture.md
  • create 2 pages      "decisions-log" — synthesizes architectural decisions
                        "tech-debt" — open items we've flagged but not fixed

Proceed? [y/n]
```

One-shot setup for a new bank — mission, existing artifacts, starter mental models.

### `/fpl-hsmem:mental-model` — guided knowledge page creation

```
> /fpl-hsmem:mental-model

Existing pages in bank "my-project":
  decisions-log    | "What architectural decisions and why?"
  tech-debt        | "What tech debt have we flagged?"

Proposed new page:
  id:           billing-edge-cases
  source_query: "What unusual billing edge cases have we discussed —
                 partial refunds, currency mismatches, dispute flows?"

Living page — Hindsight auto-rebuilds the content after every
consolidation. Content appears after a few retain cycles.

Create? [y/n]
```

Validates the source query, prevents duplicates, explains the lifecycle.

### `/fpl-hsmem:enrich` — load what the team already decided

Memory is not a document store. The skill distils a source — design records, decision ledgers,
review threads, chat threads — into short items (a decision and why, a rejected option and why, a
lesson, a pitfall, a rule) that link back to the artifact, writes them as JSONL, and dry-runs them:

```
> memory_retain_batch  file=.memory/candidates/service-x.jsonl

DRY RUN — nothing written — /…/.memory/candidates/service-x.jsonl
lines 42 · accepted 41 · refused 1

bank "team": 41 item(s) (decision 20, rejected 11, lesson 6, pitfall 4) · already on the server 0 → would be replaced · new 41

refused (1) — never sent:
  line 17 [lesson:service-x:PROB-3:retry-storm]: secret/PII scan: email in content

Apply would send 41 item(s) in 3 request(s). Show this to a human; call again with apply:true only after they approve.
```

Each line names its `bank`, or is routed by `metadata.repo` through the project's `routing` map
(CONFIGURATION.md). Writes replace by `document_id`, so a re-run is idempotent. The same pipeline
runs from a shell: `node dist/enrich.mjs <file> [--apply]`.

## What's Included

### 28 MCP tools

| Group | Tools |
|-------|-------|
| **Core memory** | `memory_retain`, `memory_retain_batch`, `memory_recall`, `memory_reflect`, `memory_status`, `memory_get_current_bank`, `memory_set_mission` |
| **Browse & correct** | `memory_list`, `memory_get`, `memory_invalidate`, `memory_reconsolidate`, `memory_operations` |
| **Mental models** (auto-refreshing pages) | `mental_model_list`, `mental_model_get`, `mental_model_create`, `mental_model_update`, `mental_model_delete`, `mental_model_refresh`, `mental_model_clear` |
| **Directives** (rules synthesis follows) | `directive_list`, `directive_create`, `directive_delete` |
| **Bank configuration** | `bank_config_get`, `bank_config_set` |
| **Documents** | `document_ingest`, `document_ingest_file`, `document_list`, `document_delete` |

The **browse & correct** group is what makes a bank correctable rather than
cumulative. `memory_recall` ranks by meaning and cannot enumerate, so it can
never hand you the id of the row that is wrong; `memory_list` can.
`memory_invalidate` retires a fact with a stated reason and keeps it readable —
reversible, unlike a rewrite. `memory_reconsolidate` rebuilds the beliefs that
rested on it, which is the step that makes "I already fixed that" true.
`memory_operations` is the only place a failed background job is visible: a
conversation that never became memory otherwise looks exactly like one that did.

**Deliberately absent, at any version:** deleting a bank, clearing all
memories, resetting the bank config, and rewriting a memory's text. The first
three annihilate; the fourth is the only irreversible single-memory mutation,
and retire-then-write reaches the same place reversibly. `document_delete`
exists because it is the only remediation for a leaked transcript — it quotes
its measured blast radius, requires a human confirmation outside the
conversation, and refuses outright in clients that cannot ask.

### 3 auto hooks

| Hook | Trigger | Behavior |
|------|---------|----------|
| `recall.mjs` | UserPromptSubmit | Semantic recall before every prompt; results injected as `additionalContext`. Optional multi-turn query composition. |
| `retain.mjs` | Stop | Saves transcript after every response. Throttling via `retainEveryNTurns` (default 10). **Compaction detection** — preserves prior long document when Claude Code compacts a session. |
| `session-end.mjs` | SessionEnd | Force-retain on close. Safety net for short sessions (< `retainEveryNTurns`). |

### 10 skills

Every skill's description is bilingual (EN + RU) with trigger phrases in both, so it fires on a
Russian request as readily as an English one, and each states the **model tier** its hardest step
needs — the tier is the requirement, `opus`/`sonnet`/`haiku` are just Claude Code's names for it.

| Skill | Purpose | Tier |
|-------|---------|:----:|
| `/fpl-hsmem:memory-setup` | Look at a project and propose the retrieval + memory layers it should have — what each answers, what it never will, and what is *not* worth it here. Proposes; never installs. | B |
| `/fpl-hsmem:status` | Quick health check + bank statistics + active mental models. | C |
| `/fpl-hsmem:bootstrap` | One-shot setup for a new bank — mission, ingest existing artifacts, create starter mental models. | B |
| `/fpl-hsmem:mental-model` | Guided mental-model creation with source-query validation. | B |
| `/fpl-hsmem:diagnose` | 6-step diagnostic (server, bank, content, hooks, config, opt-out). | C/B |
| `/fpl-hsmem:export-bank` | Markdown snapshot of a bank for backup or audit. | C |
| `/fpl-hsmem:correct-memory` | Fix a wrong fact without destroying the record — find, retire with a reason, write the correction, rebuild what rested on it, verify the job finished. Invoke deliberately; it has side effects. | B |
| `/fpl-hsmem:audit-bank` | Read-only posture audit — is masking on, what did a document cost, what silently failed. Run it on day one of a new bank. | C/B |
| `/fpl-hsmem:directives` | The rules synthesis follows. A consistently badly-shaped answer is a directive problem, not a fact problem. | B |
| `/fpl-hsmem:enrich` | Distil existing sources (design records, ledgers, review and chat threads) into short linked items, dry-run them, apply after a human approves, verify. Memory, not a document store. | B/C |

### 1 agent

| Agent | Purpose |
|-------|---------|
| `memory-curator` | Knows how this relay is meant to be used: which read tool answers which question, how to correct memory without destroying the record, and what it must never touch. Denies document deletion, extraction-rule changes and bank configuration by construction — those are operator decisions with no undo. |

### 3 activation modes

| Mode | How | Hooks? | Skills? | Best for |
|------|-----|--------|---------|----------|
| **Plugin install** | `/plugin install fpl-hsmem` | ✅ auto | ✅ auto | Default-on across all projects |
| **Setup CLI** | `node dist/setup.mjs` per project | ✅ created by CLI | ❌ | Explicit per-project control, committed `.mcp.json` |
| **Direct MCP** | Hand-wire `dist/index.mjs` in `.mcp.json` | ❌ | ❌ | One-off use, MCP tools without background machinery |

All three coexist — project-level `.mcp.json` wins over plugin-level config. **Opt-out** in any project: `touch .hindsight-disabled` or `HINDSIGHT_DISABLED=true`. See [`CONFIGURATION.md`](./CONFIGURATION.md) for details.

## Companion plugins

| Plugin | When to add |
|---|---|
| [`fpl-skills`](../fpl-skills/) | Workflow skills — `/restore`, `/briefing`, `/research`. fpl-hsmem auto-recall **complements** `/restore` for cross-session context. |
| [`forgeplan-orchestra`](../forgeplan-orchestra/) | Multi-session coordination — `/sync` artifacts to memory via `document_ingest_file`. |
| [`forgeplan-workflow`](../forgeplan-workflow/) | `/forge-cycle` Step 0 calls `mental_model_get` to seed engineering loops with synthesized context. |

## Documentation

- [`GETTING-STARTED.md`](./GETTING-STARTED.md) — 10-minute walkthrough from zero
- [`RETRIEVAL-AND-MEMORY.md`](./RETRIEVAL-AND-MEMORY.md) — which question goes to which layer: search answers *where*, recorded decisions and memory answer *why*. Anti-patterns by symptom, and why every timing in it carries its provenance
- [`USAGE.md`](./USAGE.md) — real use cases + integration with `fpl-skills` and forgeplan artifacts
- [`CONFIGURATION.md`](./CONFIGURATION.md) — full env-var reference, 3-mode setup recipes
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — diagnostic recipes for common issues
- [`CHANGELOG.md`](./CHANGELOG.md) — version history

## Credits

Built on top of [Hindsight](https://github.com/vectorize-io/hindsight) by vectorize-io. Implements the [Ruflo](https://ruflo.com/) outcome-feedback pattern (NOTE-004). Plugin scaffolding follows the [`fpl-skills`](../fpl-skills/) flagship conventions.

## License

MIT

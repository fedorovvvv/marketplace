# Configuration

> **Note.** Since 3.7.0 configuration
> is **project-only and opt-in**: one `.hindsight.json`, found by walking up from the working
> directory, is the whole of it. There is no user-wide config, no bank derived from the directory
> name, and no way for environment variables to switch the plugin on.

## The rule

| Situation | MCP server | Hooks |
|---|---|---|
| No `.hindsight.json` at or above cwd | answers the handshake, lists **no tools**; its instructions say why | no-op, no network |
| `.hindsight.json` present but invalid | same as above; the reason (e.g. `defaultBank "x" is not in banks`) is on stderr and in the instructions | no-op |
| `.hindsight-disabled` next to it, or `HINDSIGHT_DISABLED=true` | inert | no-op |
| Valid `.hindsight.json` | all 28 tools | recall only if `autoRecall: true`; retain only if `autoRetain: true` |

## `.hindsight.json`

```json
{
  "url": "http://hindsight.example.internal:8888",
  "banks": ["team", "analytics"],
  "defaultBank": "team",
  "tokenFile": ".secrets/hindsight.token",
  "autoRecall": false,
  "autoRetain": false
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | **required** | Hindsight API base URL (`http://` or `https://`). |
| `banks` | string[] | **required**, non-empty | Allowlist. The only banks any tool may touch. |
| `defaultBank` | string | **required**, must be in `banks` | Used when a tool call omits `bank`; the only bank the recall hook reads. |
| `tokenFile` | string | — | File holding the bearer token. Relative paths resolve against the directory containing `.hindsight.json`. Keep it out of git. |
| `tokenCommand` | string[] | — | argv (run without a shell, 10 s timeout) whose stdout is the token — e.g. `["security", "find-generic-password", "-s", "hindsight", "-w"]`. Used only when `tokenFile` is absent. |
| `autoRecall` | boolean | `false` | Inject recalled memories from `defaultBank` before each prompt. |
| `autoRetain` | boolean | `false` | Capture the session transcript on Stop / SessionEnd. See below. |
| `recallBudget` | `low`\|`mid`\|`high` | `mid` | Recall thoroughness. |
| `recallMaxTokens` | number | `1024` | Recall token budget. |
| `recallTypes` | string[] | `["world","experience"]` | Fact types the hook recalls. |
| `recallContextTurns` | number | `1` | Prior turns folded into the hook's query. |
| `recallMaxQueryChars` | number | `800` | Query length cap. |
| `recallRoles` | string[] | `["user","assistant"]` | Roles used when composing the query. |
| `recallPromptPreamble` | string | (built in) | Text above injected memories. |
| `retainEveryNTurns` | number | `10` | Throttle for the Stop hook (only with `autoRetain`). |
| `retainRoles` / `retainToolCalls` / `retainContext` / `retainTags` | | | Transcript formatting (only with `autoRetain`). |
| `debug` | boolean | `false` | Log to stderr. |
| `enrichMaxChars` | number | `900` | Longest `content` a batch-enrichment item may carry. See [Batch enrichment](#batch-enrichment). |
| `routing` | object | `{}` | Repository name or glob → bank, for batch-enrichment items that name no `bank`. Every target must be in `banks`. See [Batch enrichment](#batch-enrichment). |

Refused keys — the config is treated as invalid, never silently reinterpreted: `bankId` (use
`banks` + `defaultBank`), `apiKey` (never store the token in the config; use `tokenFile` /
`tokenCommand`), `bankMission`, `retainMission`, `enabled`.

### Token precedence

`HINDSIGHT_API_KEY` env → `tokenFile` → `tokenCommand` → none. `memory_status` and
`memory_get_current_bank` report *where* the token came from, never the token.

### Environment variables

Only these are read, and only for a project that is already configured:

| Variable | Effect |
|---|---|
| `HINDSIGHT_URL` | overrides `url` |
| `HINDSIGHT_API_KEY` | overrides the token |
| `HINDSIGHT_DEBUG` | turns on `debug` |
| `HINDSIGHT_DISABLED` | turns the plugin off |

`HINDSIGHT_BANK_ID`, `HINDSIGHT_AUTO_RETAIN` and the other upstream variables are ignored.

## Several banks

Every tool except `memory_get_current_bank` and `memory_retain_batch` takes an optional `bank`.
Omitted, it is `defaultBank`. A call is refused **before any bank-scoped request** when the bank is
not in `banks`, or when the server does not have it — existence is read from
`GET /v1/default/banks`, because Hindsight creates a bank implicitly on the first retain or reflect.
This plugin never creates a bank; an operator does, deliberately. There is no cross-bank search: ask
each bank separately.

## Batch enrichment

`memory_retain_batch` (MCP) and `dist/enrich.mjs` (CLI) write a JSONL file of distilled candidate
items — one short, self-contained item per line — into memory. The procedure for producing that
file is the `/fpl-hsmem:enrich` skill. Both entry points read this same `.hindsight.json`.

```json
{
  "url": "http://hindsight.example.internal:8888",
  "banks": ["team", "payments", "platform"],
  "defaultBank": "team",
  "tokenFile": ".secrets/hindsight.token",
  "enrichMaxChars": 900,
  "routing": {
    "billing-service": "payments",
    "billing-*": "payments",
    "infra-*": "platform",
    "*": "team"
  }
}
```

**Bank per item.** An item's explicit `bank` wins. Otherwise its `metadata.repo` is looked up in
`routing`: an exact key first, then the first glob (`*` any run, `?` one character) in declaration
order. No match → the line is refused; it is **never** sent to `defaultBank` by default, because a
wrong bank is a silent split of the team's memory. Add `"*": "<bank>"` if you want a catch-all.
A route to a bank outside `banks` makes the whole config invalid, so the mistake is reported where
it was made. Every resolved bank must also exist on the server; nothing is created.

**Line schema.** `kind` (`decision`|`rejected`|`lesson`|`pitfall`|`rule`|`finding`), `content`
(≤ `enrichMaxChars`), `context`, `timestamp` (ISO date or datetime — when it was decided),
`document_id` (letters, digits, `. _ ~ : -`; unique within the file), optional `tags` (strings),
`metadata` (string values), `bank`. Any other field refuses the line — it is usually a typo.

**Refused, never sent.** A line that fails validation, cannot be routed, names a disallowed or
missing bank, or carries a credential or personal-data shape (private key, bearer token, JWT,
known token prefixes, `password=`, credentials in a URL, database DSNs, long opaque tokens, email
addresses) is listed with its line number and the reason — the matched text is never echoed. The
rest of the file proceeds.

**Dry run is the default.** It reports counts per bank and kind, the refused lines, which
`document_id`s already exist on the server (apply would replace them), and samples. Apply posts
`/v1/default/banks/{bank}/memories` in batches per bank, `async: true`, each item with
`update_mode: "replace"` and `observation_scopes: "shared"`, and prints the operation ids. Re-running
the same file is idempotent: same `document_id`s, replaced in place.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/enrich.mjs" candidates.jsonl                  # dry run
node "${CLAUDE_PLUGIN_ROOT}/dist/enrich.mjs" candidates.jsonl --apply          # write
#   --max-chars N (overrides enrichMaxChars)  --batch-size N (default 20, max 100)
#   --samples N (dry-run samples per bank, default 2)  --json (machine-readable summary)
```

Exit codes: `0` every line accepted (and queued, with `--apply`); `3` some lines refused; `1`
config, file, server or batch failure; `2` usage. The MCP tool additionally requires the file to be
inside the project root (same rule as `document_ingest_file`); the CLI reads any path you give it.

## Why `autoRetain` is off by default

Before 3.7.0 the whole conversation was captured after every response. Since 3.7.0 the plugin keeps the Stop and
SessionEnd hooks registered but makes them do nothing unless `autoRetain: true`:

- memory is meant for curated facts and decisions, not a store of raw conversation;
- transcripts carry whatever was pasted into a session — credentials included — and server-side
  masking applies to future writes only;
- every captured session becomes an extraction job and a document someone has to audit.

Write deliberately with `memory_retain` (or `document_ingest` for a real document) instead. Even
with `autoRetain: true`, a retain into a bank the server does not have is skipped.

## Scaffolding

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/setup.mjs" --url http://hindsight.example.internal:8888 \
  --bank team --bank analytics --token-file .secrets/hindsight.token
```

Writes `.hindsight.json` (first `--bank` is the default) and `.claude/rules/hindsight.md`. The
plugin registers the MCP server and hooks itself; no `.mcp.json` is written.

## Hindsight server compatibility

Targets Hindsight **0.10.x** (verified against 0.10.2). Nothing calls the endpoints 0.10 removed
(`GET/PUT /banks/{id}/profile`, `POST /banks/{id}/background` → 410). The bank persona is
`reflect_mission`, set with `memory_set_mission` via `PATCH /banks/{id}/config`.
`tests/test-hindsight-010.sh` pins this.

---

## LLM providers (Hindsight server side)

`fpl-hsmem` is just an MCP client — the actual LLM for fact extraction
runs inside the Hindsight server. Provider is set when you launch the
Docker container.

| Provider | env vars |
|----------|----------|
| `claude-code` (recommended) | `HINDSIGHT_API_LLM_PROVIDER=claude-code` (no API key needed — reuses `claude auth login` credentials) |
| `openai` | `HINDSIGHT_API_LLM_PROVIDER=openai`, `HINDSIGHT_API_LLM_API_KEY=sk-...` |
| `anthropic` | `HINDSIGHT_API_LLM_PROVIDER=anthropic`, `HINDSIGHT_API_LLM_API_KEY=sk-ant-...` |
| `ollama` | `HINDSIGHT_API_LLM_PROVIDER=ollama`, `HINDSIGHT_API_LLM_BASE_URL=http://host.docker.internal:11434/v1`, `HINDSIGHT_API_LLM_MODEL=gemma3:12b` |
| `groq` | `HINDSIGHT_API_LLM_PROVIDER=groq`, `HINDSIGHT_API_LLM_API_KEY=gsk_...` |

See [Hindsight docs](https://hindsight.vectorize.io/developer/models) for
the full provider list and per-provider quirks.

---

## State files

Hooks persist runtime state under:

```
~/.hindsight/state/
├── turns.json       Per-session turn counter (used by retain throttling)
└── retention.json   Per-session message_count (used for compaction detection)
```

State files are bounded — capped at 10 000 sessions with FIFO eviction.
Safe to delete at any time; counters reset on next retain cycle.

If `CLAUDE_PLUGIN_DATA` env is set (plugin runtime), state lives there
instead — `${CLAUDE_PLUGIN_DATA}/state/`.

---

---

## Common configuration recipes

### Faster recall, less context bloat

```json
{ "autoRecall": true, "recallBudget": "low", "recallMaxTokens": 512 }
```

### Domain-tagged manual retains

Pass `tags` to `memory_retain`; with `autoRetain: true`, `retainTags` / `retainContext` tag the
captured transcript.

### Bank persona

Call `memory_set_mission` (optionally with `bank`). Extraction rules (`retain_mission`) are an
operator setting on the server and deliberately not reachable from a tool.

---

## Verification

After any config change, restart Claude Code and run `memory_get_current_bank`, then
`/fpl-hsmem:status`.

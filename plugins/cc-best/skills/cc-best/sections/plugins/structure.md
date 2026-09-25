# Plugin structure — directory layout for the four component types

## The canonical layout

A plugin is a directory under `plugins/`. The manifest is mandatory; every component directory is optional. Add only the directories you use.

```
your-plugin/
├── .claude-plugin/
│   └── plugin.json              # REQUIRED — the manifest
├── commands/                    # optional — /slash-commands
│   └── my-command.md
├── agents/                      # optional — subagents
│   └── my-agent.md
├── skills/                      # optional — knowledge bases
│   └── my-skill/
│       ├── SKILL.md             # REQUIRED per skill
│       └── sections/            # optional — agentic-RAG content
├── hooks/                       # optional — automation
│   └── hooks.json
└── README.md                    # recommended
```

## The four component types — file format each

| Component | Path | File format |
|-----------|------|-------------|
| Command | `commands/*.md` | Markdown + YAML frontmatter: `name`, `description` |
| Agent | `agents/*.md` | Markdown + YAML frontmatter: `name`, `description`, `color` (tier stated in body `## Model tier`, never `model:` in frontmatter) |
| Skill | `skills/<name>/SKILL.md` | Markdown + YAML frontmatter: `name`, `description` |
| Hook | `hooks/hooks.json` | JSON (see `../hooks/_index.md`) |

Each `.md` component starts with a `---` frontmatter fence — the validator checks `head -1` for it and WARNs if missing.

## Skills are directories, not files

A skill is a folder containing `SKILL.md`, not a bare `.md`. Skills with a body too large for one file use the agentic-RAG pattern: `SKILL.md` is a router, `sections/<topic>/_index.md` sub-routes, content files are ~30-50 lines each. This very skill (`cc-best`) is the reference shape:

```
skills/cc-best/
├── SKILL.md                     # section router
└── sections/
    ├── claude-md/
    │   ├── _index.md            # intent → file router
    │   ├── basics.md
    │   └── ...
    └── plugins/                 # ← you are here
```

Authoring guide for the RAG pattern: the `agentic-rag` plugin's own skill.

## Use `${CLAUDE_PLUGIN_ROOT}`, never hardcoded paths

Hook commands and any script reference must resolve at the user's install location, not yours.

```bash
# CORRECT — resolves wherever the plugin is installed
bash ${CLAUDE_PLUGIN_ROOT}/hooks/tdd-gate.sh

# WRONG — your machine's path; breaks for every other user
bash /Users/me/Work/.../hooks/tdd-gate.sh
```

The quality checklist makes this explicit: "No hardcoded paths (use `${CLAUDE_PLUGIN_ROOT}` for scripts)". An absolute path is the single most common reason a plugin works for the author and for nobody else.

## Related

- `manifest.md` — the `components` block that inventories these directories
- `../hooks/_index.md` — the `hooks.json` schema in detail
- `validation.md` — the per-component frontmatter and SKILL.md checks

// src/lib/version.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var __dirname = dirname(fileURLToPath(import.meta.url));
function pluginVersion() {
  const candidates = [
    join(__dirname, "..", "..", ".claude-plugin", "plugin.json"),
    // from src/lib (dev)
    join(__dirname, "..", ".claude-plugin", "plugin.json")
    // from dist (bundled)
  ];
  for (const p of candidates) {
    try {
      const v = JSON.parse(readFileSync(p, "utf-8")).version;
      if (typeof v === "string" && v) return v;
    } catch {
    }
  }
  return "unknown";
}

// src/lib/client.ts
var USER_AGENT = `hindsight-mcp/${pluginVersion()}`;
var PATH_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._~-]*$/;
var DOCUMENT_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._~:-]*$/;
function assertPathId(value, what = "id", colon = false) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${what} must be a non-empty string`);
  }
  if (value.length > 200) {
    throw new Error(`${what} is too long (${value.length} chars, max 200)`);
  }
  if (value.includes("..")) {
    throw new Error(`${what} may not contain ".." (path traversal)`);
  }
  if (!(colon ? DOCUMENT_ID_RE : PATH_ID_RE).test(value)) {
    throw new Error(
      `${what} must start with a letter, digit or underscore and contain only letters, digits, dot, underscore, tilde${colon ? ", colon" : ""} or hyphen (got ${JSON.stringify(value)})`
    );
  }
  return value;
}
function assertBankId(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("bank id must be a non-empty string");
  }
  const v = value.trim();
  if (v === "." || v === ".." || v.includes("..")) {
    throw new Error(`bank id may not be a dot segment (got ${JSON.stringify(value)})`);
  }
  if (/[/\\%]/.test(v)) {
    throw new Error(`bank id may not contain / \\ or % (got ${JSON.stringify(value)})`);
  }
  if (/[\u0000-\u001f\u007f]/.test(v)) {
    throw new Error("bank id may not contain control characters");
  }
  if (v.length > 200) {
    throw new Error(`bank id is too long (${v.length} chars, max 200)`);
  }
  return v;
}

// src/lib/tool-names.ts
var TOOL_NAMES = [
  // memory — write and read
  "memory_retain",
  "memory_retain_batch",
  "memory_recall",
  "memory_reflect",
  "memory_status",
  "memory_get_current_bank",
  "memory_set_mission",
  // memory — browse and correct
  "memory_list",
  "memory_get",
  "memory_invalidate",
  "memory_reconsolidate",
  "memory_operations",
  // mental models
  "mental_model_list",
  "mental_model_get",
  "mental_model_create",
  "mental_model_update",
  "mental_model_delete",
  "mental_model_refresh",
  "mental_model_clear",
  // directives
  "directive_list",
  "directive_create",
  "directive_delete",
  // bank configuration
  "bank_config_get",
  "bank_config_set",
  // documents
  "document_ingest",
  "document_ingest_file",
  "document_list",
  "document_delete"
];
var NAME_SET = new Set(TOOL_NAMES);
function isOwnTool(name) {
  if (!name) return false;
  if (NAME_SET.has(name)) return true;
  const suffix = name.split("__").pop() ?? "";
  return NAME_SET.has(suffix);
}

// src/lib/content.ts
var MEMORY_MARKERS = ["hindsight_memories", "relevant_memories"];
function stripMemoryTags(content) {
  let out = content;
  for (const marker of MEMORY_MARKERS) {
    out = out.replace(new RegExp(`<${marker}>[\\s\\S]*?</${marker}>`, "g"), "");
    out = out.replace(new RegExp(`</?${marker}\\b[^>]*>`, "g"), "");
  }
  return out;
}
function escapeMemoryMarkers(text) {
  let out = text;
  for (const marker of MEMORY_MARKERS) {
    out = out.replace(new RegExp(`</?${marker}\\b`, "gi"), (m) => m.replace("<", "&lt;"));
  }
  return out;
}

// src/lib/redact.ts
var RULES = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "aws-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "hindsight-key", re: /\bhsk_[A-Za-z0-9_-]{16,}\b/g },
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: "bearer", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/g },
  {
    // The catch-all: a credential-ish NAME, an assignment, and a long-enough value. The name and
    // the separator are kept so the reader can still see WHAT was redacted — a line that reads
    // `[redacted]` alone tells a debugging human nothing.
    kind: "assigned-secret",
    re: /\b(api[_-]?key|apikey|password|passwd|pwd|secret|token|access[_-]?key|private[_-]?key|client[_-]?secret)\b(\s*[:=]\s*|"\s*:\s*")(?!\s)([^\s"',;]{8,})/gi,
    keep: 1
  }
];
var MAX_SCAN = 512 * 1024;
function redact(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (text.length > MAX_SCAN) {
    return `[not redacted: ${text.length} chars exceeds the ${MAX_SCAN}-char scan limit]`;
  }
  let out = text;
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    out = out.replace(re, (...args) => {
      if (rule.keep === void 0) return `[redacted:${rule.kind}]`;
      const kept = String(args[rule.keep] ?? "");
      const sep = String(args[rule.keep + 1] ?? "=");
      return `${kept}${sep}[redacted:${rule.kind}]`;
    });
  }
  return out;
}
function redactionCount(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_SCAN) return 0;
  let n = 0;
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    n += (text.match(re) ?? []).length;
  }
  return n;
}
function secretKinds(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  if (text.length > MAX_SCAN) return ["unscannable-length"];
  const kinds = /* @__PURE__ */ new Set();
  for (const rule of RULES) {
    if (new RegExp(rule.re.source, rule.re.flags.replace("g", "")).test(text)) kinds.add(rule.kind);
  }
  return [...kinds];
}
function redactDeep(value, depth = 0) {
  if (depth > 12) return value;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

// src/lib/config.ts
import { readFileSync as readFileSync2, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname as dirname2, isAbsolute, join as join2, normalize, resolve } from "node:path";
var CONFIG_FILE = ".hindsight.json";
var TUNING_DEFAULTS = {
  autoRecall: false,
  autoRetain: false,
  recallBudget: "mid",
  recallMaxTokens: 1024,
  recallTypes: ["world", "experience"],
  recallContextTurns: 1,
  recallMaxQueryChars: 800,
  recallRoles: ["user", "assistant"],
  recallPromptPreamble: "Relevant memories from past conversations (prioritize recent when conflicting). Only use memories that are directly useful to continue this conversation; ignore the rest:",
  retainEveryNTurns: 10,
  retainOverlapTurns: 2,
  retainRoles: ["user", "assistant"],
  retainToolCalls: false,
  retainContext: "claude-code",
  retainTags: ["{session_id}"],
  debug: false,
  enrichMaxChars: 900
};
var TUNING_TYPES = {
  autoRecall: "boolean",
  autoRetain: "boolean",
  recallBudget: "string",
  recallMaxTokens: "number",
  recallTypes: "string[]",
  recallContextTurns: "number",
  recallMaxQueryChars: "number",
  recallRoles: "string[]",
  recallPromptPreamble: "string",
  retainEveryNTurns: "number",
  retainOverlapTurns: "number",
  retainRoles: "string[]",
  retainToolCalls: "boolean",
  retainContext: "string",
  retainTags: "string[]",
  debug: "boolean",
  enrichMaxChars: "number"
};
var LEGACY_KEYS = {
  bankId: "use `banks` + `defaultBank`",
  apiKey: "never put the token in the config file; use `tokenFile` or `tokenCommand`",
  bankMission: "missions are set with memory_set_mission (reflect_mission), not from config",
  retainMission: "retain_mission is an operator setting on the server, not a client config key",
  enabled: "presence of the file is the switch; delete it (or add .hindsight-disabled) to turn off"
};
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}
function findConfigFile(cwd) {
  let dir = normalize(resolve(cwd || process.cwd()));
  for (; ; ) {
    const candidate = join2(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname2(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function isDisabled(cwd = process.cwd(), configDir) {
  if (existsSync(join2(cwd, ".hindsight-disabled"))) return true;
  if (configDir && existsSync(join2(configDir, ".hindsight-disabled"))) return true;
  const env = process.env.HINDSIGHT_DISABLED ?? "";
  return ["1", "true", "yes", "on"].includes(env.toLowerCase());
}
function readToken(raw, configDir) {
  const envKey = process.env.HINDSIGHT_API_KEY;
  if (envKey) return { token: envKey.trim(), source: "env" };
  if (raw.tokenFile !== void 0) {
    if (typeof raw.tokenFile !== "string" || !raw.tokenFile) throw new Error("`tokenFile` must be a non-empty string");
    const path = isAbsolute(raw.tokenFile) ? raw.tokenFile : resolve(configDir, raw.tokenFile);
    let text;
    try {
      text = readFileSync2(path, "utf-8");
    } catch (err) {
      throw new Error(`cannot read tokenFile ${path}: ${err.code ?? err.message}`);
    }
    const token = text.trim();
    if (!token) throw new Error(`tokenFile ${path} is empty`);
    return { token, source: "tokenFile" };
  }
  if (raw.tokenCommand !== void 0) {
    if (!isStringArray(raw.tokenCommand) || raw.tokenCommand.length === 0) {
      throw new Error("`tokenCommand` must be a non-empty array of strings (argv, no shell)");
    }
    const [cmd, ...args] = raw.tokenCommand;
    let out;
    try {
      out = execFileSync(cmd, args, {
        cwd: configDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1e4
      });
    } catch (err) {
      throw new Error(`tokenCommand ${cmd} failed: ${err.message.split("\n")[0]}`);
    }
    const token = out.trim();
    if (!token) throw new Error(`tokenCommand ${cmd} printed nothing`);
    return { token, source: "tokenCommand" };
  }
  return { token: "", source: "none" };
}
function loadProjectConfig(cwd = process.cwd()) {
  const configPath = findConfigFile(cwd);
  if (!configPath) {
    return { active: false, reason: `no ${CONFIG_FILE} at or above ${resolve(cwd || process.cwd())}` };
  }
  const configDir = dirname2(configPath);
  if (isDisabled(cwd, configDir)) {
    return { active: false, reason: "disabled by .hindsight-disabled or HINDSIGHT_DISABLED", configPath };
  }
  let raw;
  try {
    const parsed = JSON.parse(readFileSync2(configPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    raw = parsed;
  } catch (err) {
    return { active: false, reason: `${configPath} is not valid JSON: ${err.message}`, configPath };
  }
  const problems = [];
  for (const [k, why] of Object.entries(LEGACY_KEYS)) {
    if (k in raw) problems.push(`\`${k}\` is not supported \u2014 ${why}`);
  }
  if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) problems.push("`url` must be an http(s) URL");
  if (!isStringArray(raw.banks) || raw.banks.length === 0) problems.push("`banks` must be a non-empty array of bank ids");
  if (typeof raw.defaultBank !== "string" || !raw.defaultBank) problems.push("`defaultBank` is required");
  else if (isStringArray(raw.banks) && !raw.banks.includes(raw.defaultBank)) {
    problems.push(`\`defaultBank\` "${raw.defaultBank}" is not in \`banks\``);
  }
  const tuning = { ...TUNING_DEFAULTS };
  for (const [key, type] of Object.entries(TUNING_TYPES)) {
    if (!(key in raw)) continue;
    const v = raw[key];
    const okType = type === "string[]" ? isStringArray(v) : typeof v === type;
    if (!okType) {
      problems.push(`\`${key}\` must be a ${type}`);
      continue;
    }
    tuning[key] = v;
  }
  if (!["low", "mid", "high"].includes(tuning.recallBudget)) problems.push("`recallBudget` must be low, mid or high");
  if (!Number.isInteger(tuning.enrichMaxChars) || tuning.enrichMaxChars < 1) {
    problems.push("`enrichMaxChars` must be a positive integer");
  }
  const routing = {};
  if (raw.routing !== void 0) {
    if (!raw.routing || typeof raw.routing !== "object" || Array.isArray(raw.routing)) {
      problems.push("`routing` must be an object mapping a repository name or glob to a bank");
    } else {
      for (const [pattern, bank] of Object.entries(raw.routing)) {
        if (!pattern || typeof bank !== "string" || !bank) {
          problems.push(`\`routing\` entry "${pattern}" must map to a bank id string`);
        } else if (isStringArray(raw.banks) && !raw.banks.includes(bank)) {
          problems.push(`\`routing\` entry "${pattern}" \u2192 "${bank}" is not in \`banks\``);
        } else {
          routing[pattern] = bank;
        }
      }
    }
  }
  let token = { token: "", source: "none" };
  if (problems.length === 0) {
    try {
      token = readToken(raw, configDir);
    } catch (err) {
      problems.push(err.message);
    }
  }
  if (problems.length > 0) {
    return { active: false, reason: `${configPath}: ${problems.join("; ")}`, configPath };
  }
  const envUrl = process.env.HINDSIGHT_URL;
  const debugEnv = (process.env.HINDSIGHT_DEBUG ?? "").toLowerCase();
  return {
    active: true,
    config: {
      ...tuning,
      debug: tuning.debug || ["1", "true", "yes", "on"].includes(debugEnv),
      url: (envUrl || raw.url).replace(/\/$/, ""),
      banks: [...new Set(raw.banks)],
      defaultBank: raw.defaultBank,
      apiKey: token.token,
      tokenSource: token.source,
      configPath,
      projectRoot: configDir,
      routing
    }
  };
}

// src/lib/enrich.ts
var ENRICH_KINDS = ["decision", "rejected", "lesson", "pitfall", "rule", "finding"];
var KINDS = new Set(ENRICH_KINDS);
var FIELDS = /* @__PURE__ */ new Set(["bank", "kind", "content", "context", "timestamp", "document_id", "tags", "metadata"]);
var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
var DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
var EXTRA_RULES = [
  // Any value at all after `password=` — redact.ts's catch-all wants 8+ characters, and a short
  // password is still a password.
  { kind: "password-assignment", re: /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i },
  // Credentials inside a URL: scheme://user:secret@host.
  { kind: "connection-string", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  // Database / broker DSNs name internal hosts even without a password.
  { kind: "connection-string", re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|clickhouse):\/\/\S+/i },
  { kind: "connection-string", re: /\bjdbc:[a-z0-9]+:\S+/i },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/ }
];
var UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
var GIT_SHA_RE = /\b[0-9a-f]{40}\b/gi;
function hasLongToken(text) {
  const cleaned = text.replace(UUID_RE, " ").replace(GIT_SHA_RE, " ");
  for (const run of cleaned.match(/[A-Za-z0-9_+/=-]{20,}/g) ?? []) {
    for (const seg of run.split(/[-_/+=]/)) {
      if (seg.length < 16) continue;
      const digits = seg.replace(/\D/g, "").length;
      const letters = seg.replace(/[^A-Za-z]/g, "").length;
      if (digits >= 2 && letters >= 2) return true;
    }
  }
  return false;
}
function scanSensitive(text) {
  const kinds = new Set(secretKinds(text));
  for (const rule of EXTRA_RULES) if (rule.re.test(text)) kinds.add(rule.kind);
  if (hasLongToken(text)) kinds.add("long-token");
  return [...kinds];
}
function routeBank(repo, routing) {
  if (Object.hasOwn(routing, repo)) return routing[repo];
  for (const [pattern, bank] of Object.entries(routing)) {
    if (!/[*?]/.test(pattern)) continue;
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    if (new RegExp(`^${source}$`).test(repo)) return bank;
  }
  return void 0;
}
function parseCandidates(text, opts) {
  const out = { lines: 0, candidates: [], refused: [] };
  const firstLineOf = /* @__PURE__ */ new Map();
  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i].trim();
    if (!raw) continue;
    out.lines++;
    const line = i + 1;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      out.refused.push({ line, reasons: ["not valid JSON"] });
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      out.refused.push({ line, reasons: ["not a JSON object"] });
      continue;
    }
    const c = obj;
    const reasons = [];
    const docId = typeof c.document_id === "string" ? c.document_id : void 0;
    const unknown = Object.keys(c).filter((k) => !FIELDS.has(k));
    if (unknown.length) reasons.push(`unknown field(s) ${unknown.join(", ")}`);
    if (typeof c.kind !== "string" || !KINDS.has(c.kind)) {
      reasons.push(`kind must be one of ${ENRICH_KINDS.join("|")} (got ${JSON.stringify(c.kind ?? null)})`);
    }
    if (typeof c.content !== "string" || !c.content.trim()) {
      reasons.push("content is required");
    } else {
      const len = [...c.content].length;
      if (len > opts.maxChars) reasons.push(`content is ${len} chars, over the ${opts.maxChars}-char cap \u2014 distil it`);
    }
    if (typeof c.context !== "string" || !c.context.trim()) reasons.push("context is required");
    if (typeof c.timestamp !== "string" || !ISO_DATE_RE.test(c.timestamp) || Number.isNaN(Date.parse(c.timestamp))) {
      reasons.push("timestamp is required as an ISO 8601 date or datetime (when it was decided)");
    }
    if (docId === void 0) {
      reasons.push("document_id is required");
    } else {
      try {
        assertPathId(docId, "document_id", true);
      } catch (err) {
        reasons.push(err.message);
      }
      const first = firstLineOf.get(docId);
      if (first !== void 0) reasons.push(`duplicate document_id (first at line ${first})`);
      else firstLineOf.set(docId, line);
    }
    const tagsOk = c.tags === void 0 || Array.isArray(c.tags) && c.tags.every((t) => typeof t === "string" && t.length > 0);
    if (!tagsOk) reasons.push("tags must be an array of non-empty strings");
    const metaOk = c.metadata === void 0 || !!c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) && Object.values(c.metadata).every((v) => typeof v === "string");
    if (!metaOk) reasons.push("metadata must be an object of string values");
    let bank;
    if (c.bank !== void 0) {
      if (typeof c.bank === "string" && c.bank) bank = c.bank;
      else reasons.push("bank, when present, must be a non-empty string");
    } else {
      const repo = metaOk ? c.metadata?.repo : void 0;
      bank = repo ? routeBank(repo, opts.routing) : void 0;
      if (!bank) {
        reasons.push(
          repo ? `no bank: the line names none and no \`routing\` entry matches repo "${repo}"` : "no bank: the line names none and has no metadata.repo to route by"
        );
      }
    }
    const fields = [
      ["content", c.content],
      ["context", c.context],
      ["document_id", c.document_id],
      ["tags", tagsOk && c.tags ? c.tags.join(" ") : ""],
      ["metadata", metaOk && c.metadata ? Object.values(c.metadata).join(" ") : ""]
    ];
    const hits = fields.flatMap(
      ([name, v]) => typeof v === "string" && v ? scanSensitive(v).map((k) => `${k} in ${name}`) : []
    );
    if (hits.length) reasons.push(`secret/PII scan: ${hits.join(", ")}`);
    if (reasons.length) {
      out.refused.push({ line, documentId: docId, reasons });
      continue;
    }
    const kind = c.kind;
    const tags = [.../* @__PURE__ */ new Set([...c.tags ?? [], `kind:${kind}`])];
    const ts = c.timestamp;
    out.candidates.push({
      line,
      bank,
      kind,
      item: {
        content: c.content,
        context: c.context,
        // Hindsight wants a datetime; a bare date means the start of that day, UTC.
        timestamp: DATE_ONLY_RE.test(ts) ? `${ts}T00:00:00Z` : ts,
        document_id: docId,
        tags,
        ...c.metadata ? { metadata: c.metadata } : {},
        update_mode: "replace",
        observation_scopes: "shared"
      }
    });
  }
  return out;
}
export {
  TOOL_NAMES,
  assertBankId,
  assertPathId,
  escapeMemoryMarkers,
  findConfigFile,
  isOwnTool,
  loadProjectConfig,
  parseCandidates,
  redact,
  redactDeep,
  redactionCount,
  routeBank,
  scanSensitive,
  secretKinds,
  stripMemoryTags
};

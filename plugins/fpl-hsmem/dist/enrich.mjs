#!/usr/bin/env node

// src/enrich.ts
import { readFileSync as readFileSync3, statSync } from "node:fs";
import { resolve as resolve2 } from "node:path";

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
var HindsightClient = class {
  url;
  apiKey;
  bankId;
  constructor(url, bankId, apiKey = "") {
    this.url = url.replace(/\/$/, "");
    this.bankId = bankId;
    this.apiKey = apiKey;
  }
  get bank() {
    return this.bankId;
  }
  headers() {
    const h = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT
    };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }
  bankPath(bankId) {
    return `/v1/default/banks/${encodeURIComponent(assertBankId(bankId ?? this.bankId))}`;
  }
  /**
   * Build a bank-scoped path from an ARRAY of segments, never a joined string. Each segment is
   * validated and encoded separately, and the assembled path is then checked to still sit under
   * the bank prefix — so a segment that somehow escapes validation still cannot re-address the
   * request at the bank base or above it.
   */
  bankUrl(segments, query, bankId) {
    const prefix = this.bankPath(bankId);
    const tail = segments.map((s, i) => encodeURIComponent(assertPathId(s, `segment ${i}`))).join("/");
    const path2 = tail ? `${prefix}/${tail}` : prefix;
    if (!path2.startsWith(`${prefix}/`) || path2.length <= prefix.length + 1) {
      throw new Error(`refusing to build a request outside ${prefix}`);
    }
    const qs = query ? "?" + Object.entries(query).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`)).join("&") : "";
    return path2 + qs;
  }
  async request(method, path2, body, timeoutMs = 15e3) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetch(`${this.url}${path2}`, {
          method,
          headers: this.headers(),
          body: body ? JSON.stringify(body) : void 0,
          signal: controller.signal,
          redirect: "error"
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/redirect/i.test(msg)) {
          throw new Error(
            `${method} ${path2} was answered with a redirect, which this client refuses to follow (a redirect can downgrade the scheme and silently drop the Authorization header)`
          );
        }
        throw err;
      }
      const text2 = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${path2}: ${text2}`);
      }
      return text2 ? JSON.parse(text2) : {};
    } finally {
      clearTimeout(timer);
    }
  }
  async health(timeoutMs = 5e3) {
    try {
      await this.request("GET", "/health", void 0, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Whether `bankId` exists on the server, without creating it.
   *
   * Hindsight creates a bank implicitly on the first bank-scoped write (and several reads), so
   * "just try it" is how orphan banks are born. This asks the bank list instead — `GET
   * /v1/default/banks?q=` is a substring filter, so the match is checked exactly here — and that
   * endpoint never creates anything.
   */
  async bankExists(bankId, timeoutMs = 1e4) {
    const res = await this.request(
      "GET",
      `/v1/default/banks?q=${encodeURIComponent(assertBankId(bankId))}&limit=1000`,
      void 0,
      timeoutMs
    );
    return (res.banks ?? []).some((b) => b.bank_id === bankId);
  }
  async retain(items, options = {}) {
    const list = Array.isArray(items) ? items : [items];
    return this.request(
      "POST",
      `${this.bankPath(options.bankId)}/memories`,
      { items: list, async: options.async ?? true },
      options.timeoutMs ?? 15e3
    );
  }
  async recall(query, options = {}) {
    const body = {
      query,
      max_tokens: options.maxTokens ?? 1024
    };
    if (options.budget) body.budget = options.budget;
    if (options.types && options.types.length > 0) body.types = options.types;
    return this.request(
      "POST",
      `${this.bankPath(options.bankId)}/memories/recall`,
      body,
      options.timeoutMs ?? 1e4
    );
  }
  /**
   * Upstream reflect measured 49-70 s; the old 30 s ceiling aborted real answers and reported them
   * as empty. The response field is `text` (ReflectResponse in the live OpenAPI), not `response`.
   */
  async reflect(query, options = {}) {
    const body = { query };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
    return this.request("POST", `${this.bankPath()}/reflect`, body, options.timeoutMs ?? 12e4);
  }
  /**
   * Exact-id document lookup. The `q` list filter matches substrings, which is not existence.
   * Document ids may carry `:` (see DOCUMENT_ID_RE), so the segment is validated here rather than
   * by `bankUrl`.
   */
  async getDocument(id) {
    try {
      return await this.request(
        "GET",
        `${this.bankPath()}/documents/${encodeURIComponent(assertPathId(id, "document id", true))}`,
        void 0,
        1e4
      );
    } catch (err) {
      if (err instanceof Error && /HTTP 404/.test(err.message)) return null;
      throw err;
    }
  }
  async stats(timeoutMs = 5e3) {
    return this.request("GET", `${this.bankPath()}/stats`, void 0, timeoutMs);
  }
  async listMentalModels(detail = "metadata") {
    return this.request("GET", `${this.bankPath()}/mental-models?detail=${detail}`);
  }
  async getMentalModel(id, detail = "content") {
    return this.request("GET", this.bankUrl(["mental-models", id], { detail }));
  }
  async createMentalModel(args) {
    return this.request("POST", `${this.bankPath()}/mental-models`, {
      id: assertPathId(args.id, "mental model id"),
      name: args.name,
      source_query: args.sourceQuery,
      max_tokens: args.maxTokens ?? 4096,
      trigger: {
        mode: "delta",
        refresh_after_consolidation: true,
        fact_types: ["observation"],
        exclude_mental_models: true
      }
    });
  }
  async updateMentalModel(id, updates) {
    const body = {};
    if (updates.name) body.name = updates.name;
    if (updates.sourceQuery) body.source_query = updates.sourceQuery;
    return this.request("PATCH", this.bankUrl(["mental-models", id]), body);
  }
  async deleteMentalModel(id) {
    return this.request("DELETE", this.bankUrl(["mental-models", id]));
  }
  /**
   * Only `reflect_mission`. `retain_mission` steers WHAT GETS EXTRACTED on every future retain, so
   * an agent able to set it can rewrite the memory rules for everything that follows — through a
   * tool that reads as cosmetic. Extraction control is an operator setting, not a tool argument.
   *
   * Hindsight 0.10: `PATCH /config {"updates":{"reflect_mission":…}}` — never the removed
   * `PUT /profile` / `POST /background`, which now answer 410.
   */
  async setMission(mission) {
    return this.request("PATCH", `${this.bankPath()}/config`, {
      updates: { reflect_mission: mission }
    });
  }
  // ---------------------------------------------------------------------------------------------
  // Browsing and correcting individual memories.
  //
  // `recall` answers "what is relevant to this question" and is what the hook calls on every
  // prompt. These answer a different question — "which stored row is the wrong one" — and that is
  // the question you must answer before you can correct anything. Without them the relay could
  // add facts and never fix one.
  // ---------------------------------------------------------------------------------------------
  /**
   * Enumerate stored memories by structured filter. `q` is a literal substring, not a search.
   *
   * Parameter names are MEASURED against the live API, not transcribed from documentation. Three
   * plausible spellings are silently ignored by the server — it answers 200 and returns the
   * unfiltered set — so a tool built on them would report "showing world facts" while showing
   * everything. Verified honoured: `type` (SINGULAR — `types` is ignored), `state`, `document_id`,
   * `q`, `tags`. Verified ignored: `types`, `fact_type`.
   */
  async listMemories(options = {}) {
    const query = {
      limit: String(options.limit ?? 10),
      offset: String(options.offset ?? 0)
    };
    if (options.q) query.q = options.q;
    if (options.type) query.type = options.type;
    if (options.state && options.state !== "all") query.state = options.state;
    if (options.documentId) query.document_id = assertPathId(options.documentId, "document_id");
    if (options.tags?.length) query.tags = options.tags;
    return this.request(
      "GET",
      this.bankUrl(["memories", "list"], query),
      void 0,
      options.timeoutMs ?? 2e4
    );
  }
  async getMemory(id) {
    return this.request("GET", this.bankUrl(["memories", id]), void 0, 15e3);
  }
  /**
   * Mark a memory invalid, or restore one.
   *
   * This is deliberately the ONLY memory mutation the relay exposes. Rewriting a memory's text is
   * irreversible upstream — it re-embeds, drops the derived observations and re-consolidates — so
   * the correction path is "retire the wrong fact, write the right one", which leaves the wrong
   * one readable and undoable. `reason` is what a future reader sees instead of a silent gap.
   */
  async invalidateMemory(id, reason, restore = false) {
    const body = restore ? { state: "valid" } : { state: "invalidated", ...reason ? { invalidation_reason: reason } : {} };
    return this.request("PATCH", this.bankUrl(["memories", id]), body, 15e3);
  }
  /**
   * Drop one memory's derived observations so consolidation rebuilds them.
   *
   * The memory itself survives. Use after invalidating a fact that a belief was built on — the
   * belief does not notice on its own, and recall keeps returning the conclusion drawn from the
   * fact you just retired.
   */
  async reconsolidateMemory(id) {
    return this.request("DELETE", this.bankUrl(["memories", id, "observations"]), void 0, 2e4);
  }
  // ---------------------------------------------------------------------------------------------
  // Asynchronous work. Retain returns before the server has finished thinking; these say whether
  // it finished, and that is the answer to "why does recall still return the old fact".
  // ---------------------------------------------------------------------------------------------
  /**
   * List async operations. The response array is `operations`, NOT `items` — this endpoint is
   * shaped differently from every other list on the API.
   *
   * `status` is the only filter the server honours (measured: `status=failed` narrowed 1085 → 6).
   * Filtering by kind is deliberately absent: `task_type`, `operation_type` and `kind` are all
   * accepted with a 200 and then ignored, so offering a kind filter would mean reporting a
   * narrowed view that was never narrowed. Callers that need it filter the returned page.
   */
  async listOperations(options = {}) {
    const query = {
      limit: String(options.limit ?? 20),
      offset: String(options.offset ?? 0)
    };
    if (options.status) query.status = options.status;
    return this.request("GET", this.bankUrl(["operations"], query), void 0, 2e4);
  }
  async getOperation(id) {
    return this.request("GET", this.bankUrl(["operations", id]), void 0, 15e3);
  }
  // ---------------------------------------------------------------------------------------------
  // Mental models: the two lifecycle operations that were missing.
  // ---------------------------------------------------------------------------------------------
  /** Force a rebuild now instead of waiting for consolidation. Returns an operation id. */
  async refreshMentalModel(id) {
    return this.request("POST", this.bankUrl(["mental-models", id, "refresh"]), {}, 2e4);
  }
  /**
   * Blank a page's content, keeping its configuration.
   *
   * Our pages are created in `delta` mode, which edits existing content rather than regenerating
   * it — so a page that has drifted keeps drifting. Clearing removes the baseline, and the next
   * refresh is a full rebuild. POST, not DELETE: DELETE on this resource removes the page itself.
   */
  async clearMentalModel(id) {
    return this.request("POST", this.bankUrl(["mental-models", id, "clear"]), {}, 2e4);
  }
  // ---------------------------------------------------------------------------------------------
  // Directives — standing instructions that govern synthesis. Without them every reflect is
  // ungoverned, which is the state this bank is in today.
  // ---------------------------------------------------------------------------------------------
  async listDirectives() {
    return this.request("GET", this.bankUrl(["directives"]), void 0, 15e3);
  }
  async createDirective(args) {
    const body = { name: args.name, content: args.content };
    if (args.priority !== void 0) body.priority = args.priority;
    if (args.isActive !== void 0) body.is_active = args.isActive;
    if (args.tags?.length) body.tags = args.tags;
    return this.request("POST", this.bankUrl(["directives"]), body, 15e3);
  }
  async deleteDirective(id) {
    return this.request("DELETE", this.bankUrl(["directives", id]), void 0, 15e3);
  }
  // ---------------------------------------------------------------------------------------------
  // Bank configuration. Hindsight 0.10 removed `GET/PUT /profile` and `POST /background` (both
  // answer 410); the mission now lives here as `reflect_mission`, next to the behavioural switches.
  // ---------------------------------------------------------------------------------------------
  async getBankConfig() {
    return this.request("GET", `${this.bankPath()}/config`, void 0, 15e3);
  }
  /**
   * Write behavioural settings. The caller decides WHICH keys are allowed — see the allowlist in
   * `index.ts`. This method deliberately does not police key names: one policy, one place, and
   * that place is the tool handler where the refusal can be explained to the caller.
   */
  async setBankConfig(updates) {
    return this.request("PATCH", `${this.bankPath()}/config`, { updates }, 15e3);
  }
  // ---------------------------------------------------------------------------------------------
  // Documents. `memory_unit_count` is the blast-radius number nothing else provides: it is how
  // many memories die with the document.
  // ---------------------------------------------------------------------------------------------
  async listDocuments(options = {}) {
    const query = {
      limit: String(options.limit ?? 10),
      offset: String(options.offset ?? 0)
    };
    if (options.q) query.q = options.q;
    return this.request("GET", this.bankUrl(["documents"], query), void 0, 2e4);
  }
  /** Irreversible. Cascades to every memory extracted from the document. */
  async deleteDocument(id) {
    return this.request("DELETE", this.bankUrl(["documents", id]), void 0, 3e4);
  }
};

// src/lib/banks.ts
var BankGate = class {
  constructor(config2) {
    this.config = config2;
  }
  config;
  /** One client per bank, created on first use. */
  clients = /* @__PURE__ */ new Map();
  /** Banks confirmed to exist on the server. Only positives are cached; a missing bank is re-asked. */
  known = /* @__PURE__ */ new Set();
  /** A client for the default bank without the existence check — for tools that never touch a bank. */
  defaultClient() {
    return this.clientFor(this.config.defaultBank);
  }
  clientFor(bank) {
    let client = this.clients.get(bank);
    if (!client) {
      client = new HindsightClient(this.config.url, bank, this.config.apiKey);
      this.clients.set(bank, client);
    }
    return client;
  }
  /**
   * Resolve `requested` (empty → `defaultBank`) to a client, or to a refusal message. May throw on
   * a network failure while checking existence; callers turn that into an explained error.
   */
  async resolve(requested) {
    const bank = requested === void 0 || requested === null || requested === "" ? this.config.defaultBank : requested;
    if (typeof bank !== "string") return "Error: bank must be a string";
    if (!this.config.banks.includes(bank)) {
      return `Refusing: bank "${bank}" is not in this project's allowlist (${this.config.banks.join(", ")}). Allowed banks are declared in ${this.config.configPath}.`;
    }
    const client = this.clientFor(bank);
    if (!this.known.has(bank)) {
      if (!await client.bankExists(bank)) {
        return `Refusing: bank "${bank}" does not exist on ${this.config.url}. This server never creates banks \u2014 an operator creates one deliberately, then this call will work.`;
      }
      this.known.add(bank);
    }
    return client;
  }
};

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
    const path2 = isAbsolute(raw.tokenFile) ? raw.tokenFile : resolve(configDir, raw.tokenFile);
    let text2;
    try {
      text2 = readFileSync2(path2, "utf-8");
    } catch (err) {
      throw new Error(`cannot read tokenFile ${path2}: ${err.code ?? err.message}`);
    }
    const token = text2.trim();
    if (!token) throw new Error(`tokenFile ${path2} is empty`);
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
function redact(text2) {
  if (typeof text2 !== "string" || text2.length === 0) return text2;
  if (text2.length > MAX_SCAN) {
    return `[not redacted: ${text2.length} chars exceeds the ${MAX_SCAN}-char scan limit]`;
  }
  let out = text2;
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
function secretKinds(text2) {
  if (typeof text2 !== "string" || text2.length === 0) return [];
  if (text2.length > MAX_SCAN) return ["unscannable-length"];
  const kinds = /* @__PURE__ */ new Set();
  for (const rule of RULES) {
    if (new RegExp(rule.re.source, rule.re.flags.replace("g", "")).test(text2)) kinds.add(rule.kind);
  }
  return [...kinds];
}

// src/lib/enrich.ts
var ENRICH_KINDS = ["decision", "rejected", "lesson", "pitfall", "rule", "finding"];
var KINDS = new Set(ENRICH_KINDS);
var FIELDS = /* @__PURE__ */ new Set(["bank", "kind", "content", "context", "timestamp", "document_id", "tags", "metadata"]);
var DEFAULT_BATCH_SIZE = 20;
var MAX_BATCH_SIZE = 100;
var LOOKUP_CONCURRENCY = 8;
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
function hasLongToken(text2) {
  const cleaned = text2.replace(UUID_RE, " ").replace(GIT_SHA_RE, " ");
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
function scanSensitive(text2) {
  const kinds = new Set(secretKinds(text2));
  for (const rule of EXTRA_RULES) if (rule.re.test(text2)) kinds.add(rule.kind);
  if (hasLongToken(text2)) kinds.add("long-token");
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
function parseCandidates(text2, opts) {
  const out = { lines: 0, candidates: [], refused: [] };
  const firstLineOf = /* @__PURE__ */ new Map();
  const rows = text2.split(/\r?\n/);
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
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
async function planEnrich(text2, opts, resolve3) {
  const parsed = parseCandidates(text2, opts);
  const byBank = /* @__PURE__ */ new Map();
  for (const c of parsed.candidates) {
    const list = byBank.get(c.bank);
    if (list) list.push(c);
    else byBank.set(c.bank, [c]);
  }
  const refused = [...parsed.refused];
  const banks = [];
  for (const [bank, candidates] of byBank) {
    const client = await resolve3(bank);
    if (typeof client === "string") {
      for (const c of candidates) refused.push({ line: c.line, documentId: c.item.document_id, reasons: [client] });
      continue;
    }
    const found = await mapLimit(candidates, LOOKUP_CONCURRENCY, (c) => client.getDocument(c.item.document_id));
    banks.push({
      bank,
      client,
      candidates,
      existing: candidates.filter((_, i) => found[i] !== null).map((c) => c.item.document_id)
    });
  }
  refused.sort((a, b) => a.line - b.line);
  return { lines: parsed.lines, refused, banks };
}
async function applyEnrichPlan(plan, batchSize2 = DEFAULT_BATCH_SIZE) {
  const size = Math.min(Math.max(Math.floor(batchSize2), 1), MAX_BATCH_SIZE);
  const results = [];
  for (const b of plan.banks) {
    const of = Math.ceil(b.candidates.length / size);
    for (let i = 0; i < of; i++) {
      const items = b.candidates.slice(i * size, (i + 1) * size).map((c) => c.item);
      const r = { bank: b.bank, batch: i + 1, of, items: items.length, operationIds: [] };
      try {
        const res = await b.client.retain(items, { async: true, timeoutMs: 6e4 });
        r.operationIds = [...res.operation_ids ?? [], ...res.operation_id ? [res.operation_id] : []];
      } catch (err) {
        r.error = redact(err.message).slice(0, 300);
      }
      results.push(r);
    }
  }
  return results;
}
function kindCounts(candidates) {
  const counts = /* @__PURE__ */ new Map();
  for (const c of candidates) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k} ${n}`).join(", ");
}
function enrichSummary(file2, plan, applied) {
  return {
    file: file2,
    mode: applied ? "apply" : "dry-run",
    lines: plan.lines,
    accepted: plan.banks.reduce((n, b) => n + b.candidates.length, 0),
    refused: plan.refused,
    banks: plan.banks.map((b) => ({
      bank: b.bank,
      items: b.candidates.length,
      kinds: Object.fromEntries(
        ENRICH_KINDS.map((k) => [k, b.candidates.filter((c) => c.kind === k).length]).filter(([, n]) => n)
      ),
      existing: b.existing
    })),
    ...applied ? { batches: applied } : {}
  };
}
function formatEnrichReport(file2, plan, applied, opts = {}) {
  const accepted = plan.banks.reduce((n, b) => n + b.candidates.length, 0);
  const size = Math.min(Math.max(Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE), 1), MAX_BATCH_SIZE);
  const out = [];
  out.push(applied ? `APPLY \u2014 ${file2}` : `DRY RUN \u2014 nothing written \u2014 ${file2}`);
  out.push(`lines ${plan.lines} \xB7 accepted ${accepted} \xB7 refused ${plan.refused.length}`);
  out.push("");
  if (plan.banks.length === 0) out.push("No item is writable.");
  for (const b of plan.banks) {
    out.push(
      `bank "${b.bank}": ${b.candidates.length} item(s) (${kindCounts(b.candidates)}) \xB7 already on the server ${b.existing.length} \u2192 ${applied ? "replaced" : "would be replaced"} \xB7 new ${b.candidates.length - b.existing.length}`
    );
  }
  if (plan.refused.length) {
    out.push("", `refused (${plan.refused.length}) \u2014 never sent:`);
    for (const r of plan.refused) {
      out.push(`  line ${r.line}${r.documentId ? ` [${r.documentId}]` : ""}: ${r.reasons.join("; ")}`);
    }
  }
  const existing = plan.banks.flatMap((b) => b.existing.map((id) => `  ${b.bank}  ${id}`));
  if (existing.length) {
    const shown = existing.slice(0, 20);
    out.push("", `already on the server (${existing.length}) \u2014 same document_id, ${applied ? "replaced" : "apply replaces them"}:`);
    out.push(...shown);
    if (existing.length > shown.length) out.push(`  \u2026 and ${existing.length - shown.length} more`);
  }
  if (applied) {
    out.push("", "batches:");
    for (const r of applied) {
      out.push(
        `  ${r.bank} ${r.batch}/${r.of}: ${r.items} item(s) \u2192 ` + (r.error ? `FAILED: ${r.error}` : r.operationIds.length ? `operation ${r.operationIds.join(", ")}` : "queued")
      );
    }
    const failed = applied.filter((r) => r.error);
    out.push(
      "",
      failed.length ? `${failed.length} batch(es) failed \u2014 fix the cause and re-run the same file; writes are idempotent by document_id.` : "Queued. Extraction is asynchronous: check memory_operations (status=failed) before calling this done, then spot-check with memory_recall."
    );
  } else {
    const samples2 = opts.samples ?? 2;
    if (samples2 > 0 && accepted) {
      out.push("", "samples:");
      for (const b of plan.banks) {
        for (const c of b.candidates.slice(0, samples2)) {
          const text2 = c.item.content.replace(/\s+/g, " ");
          out.push(`  [${b.bank}] ${c.kind} ${c.item.document_id} (${c.item.timestamp?.slice(0, 10)})`);
          out.push(`    ${redact(text2.length > 240 ? text2.slice(0, 240) + "\u2026" : text2)}`);
        }
      }
    }
    const requests = plan.banks.reduce((n, b) => n + Math.ceil(b.candidates.length / size), 0);
    out.push(
      "",
      accepted ? `Apply would send ${accepted} item(s) in ${requests} request(s). ${opts.applyHint ?? ""}`.trimEnd() : "Nothing to apply."
    );
  }
  return out.join("\n");
}

// src/enrich.ts
var MAX_FILE_BYTES = 2 * 1024 * 1024;
var USAGE = "usage: enrich.mjs <candidates.jsonl> [--apply] [--max-chars N] [--batch-size N] [--samples N] [--json]";
function fail(code, message) {
  process.stderr.write(`${message}
`);
  process.exit(code);
}
var argv = process.argv.slice(2);
var file;
var apply = false;
var json = false;
var maxChars;
var batchSize = DEFAULT_BATCH_SIZE;
var samples = 2;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const num = () => {
    const n = Number(argv[++i]);
    if (!Number.isInteger(n) || n < 0) fail(2, `${a} needs a non-negative integer
${USAGE}`);
    return n;
  };
  if (a === "--apply") apply = true;
  else if (a === "--json") json = true;
  else if (a === "--max-chars") maxChars = num();
  else if (a === "--batch-size") batchSize = num();
  else if (a === "--samples") samples = num();
  else if (a === "-h" || a === "--help") fail(0, USAGE);
  else if (a.startsWith("-")) fail(2, `unknown option ${a}
${USAGE}`);
  else if (file === void 0) file = a;
  else fail(2, `one file at a time
${USAGE}`);
}
if (!file) fail(2, USAGE);
var loaded = loadProjectConfig(process.cwd());
if (!loaded.active) fail(1, `Hindsight is not configured here: ${loaded.reason}`);
var config = loaded.config;
var path = resolve2(file);
var text;
try {
  const size = statSync(path).size;
  if (size > MAX_FILE_BYTES) fail(1, `refusing ${path}: ${size} bytes exceeds the ${MAX_FILE_BYTES}-byte cap`);
  text = readFileSync3(path, "utf-8");
} catch (err) {
  fail(1, `cannot read ${path}: ${err.code ?? err.message}`);
}
var gate = new BankGate(config);
try {
  const plan = await planEnrich(
    text,
    { maxChars: maxChars ?? config.enrichMaxChars, routing: config.routing },
    (b) => gate.resolve(b)
  );
  const applied = apply ? await applyEnrichPlan(plan, batchSize) : void 0;
  process.stdout.write(
    (json ? JSON.stringify(enrichSummary(path, plan, applied), null, 2) : formatEnrichReport(path, plan, applied, {
      samples,
      batchSize,
      applyHint: "Re-run with --apply after a human has reviewed this summary."
    })) + "\n"
  );
  if (applied?.some((r) => r.error)) process.exit(1);
  process.exit(plan.refused.length ? 3 : 0);
} catch (err) {
  fail(1, `enrich failed: ${redact(err.message).slice(0, 500)}`);
}

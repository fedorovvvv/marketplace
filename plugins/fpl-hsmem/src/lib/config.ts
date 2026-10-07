import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

/**
 * Project-only, opt-in configuration.
 *
 * WHY THIS IS STRICT. Upstream resolved a bank from five sources (built-in defaults,
 * `~/.hindsight/config.json`, `.mcp.json`, `.hindsight.json`, env) and, when none named a bank,
 * derived one from the directory name. That made the plugin active in every project on the machine
 * — including personal ones — and every new directory silently created an orphan bank on first
 * write. There is exactly one source of truth: a `.hindsight.json` found by walking up
 * from cwd. No file, no plugin: the MCP server lists no tools and every hook is a no-op.
 *
 * Schema (`.hindsight.json`):
 *   url           string    required. Hindsight API base, e.g. "http://hindsight.example:8888".
 *   banks         string[]  required, non-empty. Allowlist — the only banks any tool may touch.
 *   defaultBank   string    required, must be in `banks`. Used when a tool call omits `bank`, and
 *                           the only bank the recall hook ever reads.
 *   tokenFile     string    optional. Path to a file holding the bearer token; relative paths are
 *                           resolved against the directory containing `.hindsight.json`.
 *   tokenCommand  string[]  optional. argv (no shell) whose stdout is the token. Used only when
 *                           `tokenFile` is absent.
 *   autoRecall    boolean   optional, default false. Inject recalled memories before each prompt.
 *   autoRetain    boolean   optional, default false. Capture the session transcript on Stop /
 *                           SessionEnd. Off by default on purpose — see CONFIGURATION.md.
 *   ...tuning     optional  recallBudget, recallMaxTokens, recallTypes, recallContextTurns,
 *                           recallMaxQueryChars, recallRoles, recallPromptPreamble,
 *                           retainEveryNTurns, retainRoles, retainToolCalls, retainContext,
 *                           retainTags, debug, enrichMaxChars.
 *   routing       object    optional. Batch enrichment only (memory_retain_batch / enrich.mjs):
 *                           maps a repository name or glob (`*`, `?`) to a bank, used for a
 *                           candidate that names no `bank`. Every target must be in `banks`.
 *
 * Environment variables may override `url` (HINDSIGHT_URL) and the token (HINDSIGHT_API_KEY) of a
 * project that is ALREADY configured. They can never enable one: without the file, env is ignored.
 */
export const CONFIG_FILE = ".hindsight.json";

export interface HindsightConfig {
  url: string;
  banks: string[];
  defaultBank: string;
  apiKey: string;
  autoRecall: boolean;
  autoRetain: boolean;
  recallBudget: "low" | "mid" | "high";
  recallMaxTokens: number;
  recallTypes: string[];
  recallContextTurns: number;
  recallMaxQueryChars: number;
  recallRoles: string[];
  recallPromptPreamble: string;
  retainEveryNTurns: number;
  retainOverlapTurns: number;
  retainRoles: string[];
  retainToolCalls: boolean;
  retainContext: string;
  retainTags: string[];
  debug: boolean;
  /** Batch enrichment: the longest `content` a candidate item may carry. */
  enrichMaxChars: number;
  /**
   * Batch enrichment: repository name or glob → bank, for candidates without an explicit `bank`.
   * Declaration order is kept; an exact name beats a glob, and the first matching glob wins.
   */
  routing: Record<string, string>;
  /** Absolute path of the `.hindsight.json` that configured this project. */
  configPath: string;
  /** The directory containing it — the project root for ingest path checks. */
  projectRoot: string;
  /** Where the token came from, for memory_status. Never the token itself. */
  tokenSource: "env" | "tokenFile" | "tokenCommand" | "none";
}

export type LoadResult =
  | { active: true; config: HindsightConfig }
  | { active: false; reason: string; configPath?: string };

const TUNING_DEFAULTS = {
  autoRecall: false,
  autoRetain: false,
  recallBudget: "mid" as const,
  recallMaxTokens: 1024,
  recallTypes: ["world", "experience"],
  recallContextTurns: 1,
  recallMaxQueryChars: 800,
  recallRoles: ["user", "assistant"],
  recallPromptPreamble:
    "Relevant memories from past conversations (prioritize recent when conflicting). Only use memories that are directly useful to continue this conversation; ignore the rest:",
  retainEveryNTurns: 10,
  retainOverlapTurns: 2,
  retainRoles: ["user", "assistant"],
  retainToolCalls: false,
  retainContext: "claude-code",
  retainTags: ["{session_id}"],
  debug: false,
  enrichMaxChars: 900,
};

type Tuning = typeof TUNING_DEFAULTS;
const TUNING_TYPES: Record<keyof Tuning, "boolean" | "number" | "string" | "string[]"> = {
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
  enrichMaxChars: "number",
};

/**
 * Keys accepted before 3.7.0 that would reintroduce what was removed. Refused loudly rather than
 * ignored: a config that says `bankId: "x"` and silently gets `defaultBank` instead is the
 * split-memory bug in a new form.
 */
const LEGACY_KEYS: Record<string, string> = {
  bankId: "use `banks` + `defaultBank`",
  apiKey: "never put the token in the config file; use `tokenFile` or `tokenCommand`",
  bankMission: "missions are set with memory_set_mission (reflect_mission), not from config",
  retainMission: "retain_mission is an operator setting on the server, not a client config key",
  enabled: "presence of the file is the switch; delete it (or add .hindsight-disabled) to turn off",
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}

/** Nearest `.hindsight.json` at or above `cwd`, or null. Never consults the home directory config. */
export function findConfigFile(cwd: string): string | null {
  let dir = normalize(resolve(cwd || process.cwd()));
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Opt-out signals on top of the opt-in file:
 *   - `.hindsight-disabled` marker next to `.hindsight.json` (or in cwd)
 *   - `HINDSIGHT_DISABLED=true`
 */
export function isDisabled(cwd: string = process.cwd(), configDir?: string): boolean {
  if (existsSync(join(cwd, ".hindsight-disabled"))) return true;
  if (configDir && existsSync(join(configDir, ".hindsight-disabled"))) return true;
  const env = process.env.HINDSIGHT_DISABLED ?? "";
  return ["1", "true", "yes", "on"].includes(env.toLowerCase());
}

function readToken(raw: Record<string, unknown>, configDir: string): { token: string; source: HindsightConfig["tokenSource"] } {
  const envKey = process.env.HINDSIGHT_API_KEY;
  if (envKey) return { token: envKey.trim(), source: "env" };
  if (raw.tokenFile !== undefined) {
    if (typeof raw.tokenFile !== "string" || !raw.tokenFile) throw new Error("`tokenFile` must be a non-empty string");
    const path = isAbsolute(raw.tokenFile) ? raw.tokenFile : resolve(configDir, raw.tokenFile);
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch (err) {
      // The path is reported, never the content.
      throw new Error(`cannot read tokenFile ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    const token = text.trim();
    if (!token) throw new Error(`tokenFile ${path} is empty`);
    return { token, source: "tokenFile" };
  }
  if (raw.tokenCommand !== undefined) {
    if (!isStringArray(raw.tokenCommand) || raw.tokenCommand.length === 0) {
      throw new Error("`tokenCommand` must be a non-empty array of strings (argv, no shell)");
    }
    const [cmd, ...args] = raw.tokenCommand;
    let out: string;
    try {
      out = execFileSync(cmd, args, {
        cwd: configDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10000,
      });
    } catch (err) {
      throw new Error(`tokenCommand ${cmd} failed: ${(err as Error).message.split("\n")[0]}`);
    }
    const token = out.trim();
    if (!token) throw new Error(`tokenCommand ${cmd} printed nothing`);
    return { token, source: "tokenCommand" };
  }
  return { token: "", source: "none" };
}

/**
 * Resolve the project's configuration. Never throws: an absent or invalid config yields
 * `{ active: false, reason }`, and every caller treats that as "do nothing".
 */
export function loadProjectConfig(cwd: string = process.cwd()): LoadResult {
  const configPath = findConfigFile(cwd);
  if (!configPath) {
    return { active: false, reason: `no ${CONFIG_FILE} at or above ${resolve(cwd || process.cwd())}` };
  }
  const configDir = dirname(configPath);
  if (isDisabled(cwd, configDir)) {
    return { active: false, reason: "disabled by .hindsight-disabled or HINDSIGHT_DISABLED", configPath };
  }

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    raw = parsed as Record<string, unknown>;
  } catch (err) {
    return { active: false, reason: `${configPath} is not valid JSON: ${(err as Error).message}`, configPath };
  }

  const problems: string[] = [];
  for (const [k, why] of Object.entries(LEGACY_KEYS)) {
    if (k in raw) problems.push(`\`${k}\` is not supported — ${why}`);
  }
  if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) problems.push("`url` must be an http(s) URL");
  if (!isStringArray(raw.banks) || raw.banks.length === 0) problems.push("`banks` must be a non-empty array of bank ids");
  if (typeof raw.defaultBank !== "string" || !raw.defaultBank) problems.push("`defaultBank` is required");
  else if (isStringArray(raw.banks) && !raw.banks.includes(raw.defaultBank)) {
    problems.push(`\`defaultBank\` "${raw.defaultBank}" is not in \`banks\``);
  }
  const tuning: Tuning = { ...TUNING_DEFAULTS };
  for (const [key, type] of Object.entries(TUNING_TYPES) as [keyof Tuning, string][]) {
    if (!(key in raw)) continue;
    const v = raw[key];
    const okType = type === "string[]" ? isStringArray(v) : typeof v === type;
    if (!okType) {
      problems.push(`\`${key}\` must be a ${type}`);
      continue;
    }
    (tuning as Record<string, unknown>)[key] = v;
  }
  if (!["low", "mid", "high"].includes(tuning.recallBudget)) problems.push("`recallBudget` must be low, mid or high");
  if (!Number.isInteger(tuning.enrichMaxChars) || tuning.enrichMaxChars < 1) {
    problems.push("`enrichMaxChars` must be a positive integer");
  }

  // A route to a bank outside the allowlist is a config error, not a per-line refusal later: the
  // mistake is in this file, so this file is where it is reported.
  const routing: Record<string, string> = {};
  if (raw.routing !== undefined) {
    if (!raw.routing || typeof raw.routing !== "object" || Array.isArray(raw.routing)) {
      problems.push("`routing` must be an object mapping a repository name or glob to a bank");
    } else {
      for (const [pattern, bank] of Object.entries(raw.routing as Record<string, unknown>)) {
        if (!pattern || typeof bank !== "string" || !bank) {
          problems.push(`\`routing\` entry "${pattern}" must map to a bank id string`);
        } else if (isStringArray(raw.banks) && !raw.banks.includes(bank)) {
          problems.push(`\`routing\` entry "${pattern}" → "${bank}" is not in \`banks\``);
        } else {
          routing[pattern] = bank;
        }
      }
    }
  }

  let token = { token: "", source: "none" as HindsightConfig["tokenSource"] };
  if (problems.length === 0) {
    try {
      token = readToken(raw, configDir);
    } catch (err) {
      problems.push((err as Error).message);
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
      url: (envUrl || (raw.url as string)).replace(/\/$/, ""),
      banks: [...new Set(raw.banks as string[])],
      defaultBank: raw.defaultBank as string,
      apiKey: token.token,
      tokenSource: token.source,
      configPath,
      projectRoot: configDir,
      routing,
    },
  };
}

export function debugLog(config: Pick<HindsightConfig, "debug"> | null | undefined, ...args: unknown[]): void {
  if (config?.debug) {
    console.error("[Hindsight]", ...args);
  }
}

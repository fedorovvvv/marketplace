import { basename, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { check, finish, project, fakeHindsight, withServer, runHook, PLUGIN } from "./lib/harness.mjs";

const { loadProjectConfig } = await import(join(PLUGIN, "dist", "testable.mjs"));
const base = { url: "http://h.example:8888", banks: ["alpha", "beta"], defaultBank: "alpha" };
const savedEnv = { ...process.env };
const resetEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith("HINDSIGHT_")) delete process.env[k]; };
resetEnv();

console.log("config discovery");
{
  const bare = project(null);
  check(loadProjectConfig(bare).active === false, "no .hindsight.json → inactive");

  // A user-wide config must be ignored: it is what made the plugin active everywhere.
  mkdirSync(join(bare, ".hindsight"), { recursive: true });
  writeFileSync(join(bare, ".hindsight", "config.json"), JSON.stringify({ bankId: "x", url: "http://h" }));
  process.env.HOME = bare;
  check(loadProjectConfig(bare).active === false, "~/.hindsight/config.json is ignored");

  process.env.HINDSIGHT_URL = "http://h.example:8888";
  process.env.HINDSIGHT_API_KEY = "k";
  process.env.HINDSIGHT_BANK_ID = "alpha";
  check(loadProjectConfig(bare).active === false, "env vars alone never enable a project");
  resetEnv();

  const dir = project({ ...base, tokenFile: "secrets/t" }, { "secrets/t": "tok-123\n", "a/b/c/.keep": "" });
  const r = loadProjectConfig(join(dir, "a", "b", "c"));
  check(r.active === true, "found walking up from a subdirectory", JSON.stringify(r));
  if (r.active) {
    check(r.config.apiKey === "tok-123", "tokenFile is resolved relative to the config file");
    check(r.config.tokenSource === "tokenFile", "token source reported");
    check(r.config.autoRetain === false, "autoRetain defaults to false");
    check(r.config.autoRecall === false, "autoRecall defaults to false");
    check(r.config.defaultBank === "alpha" && r.config.banks.join() === "alpha,beta", "banks + defaultBank kept");
    check(r.config.projectRoot === dir, "project root is the config file's directory");
  }

  process.env.HINDSIGHT_URL = "http://override:1";
  process.env.HINDSIGHT_API_KEY = "env-tok";
  const o = loadProjectConfig(dir);
  check(o.active && o.config.url === "http://override:1" && o.config.apiKey === "env-tok" && o.config.tokenSource === "env", "env overrides url + token of a configured project");
  resetEnv();

  // The env token must never travel to a url the repository chose.
  process.env.HINDSIGHT_API_KEY = "env-tok";
  const k = loadProjectConfig(dir);
  check(k.active && k.config.apiKey === "tok-123" && k.config.tokenSource === "tokenFile", "HINDSIGHT_API_KEY without HINDSIGHT_URL is ignored (tokenFile wins)");
  const kNoFile = loadProjectConfig(project(base));
  check(kNoFile.active && kNoFile.config.apiKey === "" && kNoFile.config.tokenSource === "none", "HINDSIGHT_API_KEY alone is never sent to the config's url");
  resetEnv();

  const cmd = project({ ...base, tokenCommand: ["node", "-e", "process.stdout.write('from-cmd')"] });
  const refused = loadProjectConfig(cmd);
  check(!refused.active && /HINDSIGHT_ALLOW_TOKEN_COMMAND=1/.test(refused.reason), "tokenCommand is refused without the user's opt-in", refused.reason);
  process.env.HINDSIGHT_ALLOW_TOKEN_COMMAND = "1";
  const c = loadProjectConfig(cmd);
  check(c.active && c.config.apiKey === "from-cmd" && c.config.tokenSource === "tokenCommand", "tokenCommand (argv, no shell) with HINDSIGHT_ALLOW_TOKEN_COMMAND=1");
  resetEnv();
  const lazy = loadProjectConfig(cmd, { token: false });
  check(lazy.active && lazy.config.apiKey === "", "token:false validates without running tokenCommand (hooks decide first)");
}

console.log("config discovery boundaries");
{
  // Stops at the git toplevel: a config above the repository is not this repository's decision.
  const outer = project({ ...base, tokenFile: "t" }, { t: "tok", "inner/.git/HEAD": "", "inner/src/.keep": "" }, { git: false });
  check(loadProjectConfig(join(outer, "inner", "src")).active === false, "a .hindsight.json above the git toplevel is not read");
  check(loadProjectConfig(join(outer, "inner")).active === false, "…also from the toplevel itself");
  check(loadProjectConfig(outer).active === true, "the toplevel's own config is read");
  // A worktree's `.git` is a file, and it is a toplevel too.
  const wt = project({ ...base, tokenFile: "t" }, { t: "tok", "wt/.git": "gitdir: /elsewhere\n", "wt/src/.keep": "" }, { git: false });
  check(loadProjectConfig(join(wt, "wt", "src")).active === false, "a worktree (.git file) is a boundary too");

  // Never $HOME/.hindsight.json, and outside a repository the walk stops at $HOME.
  const home = mkdtempSync(join(tmpdir(), "hsmem-home-"));
  writeFileSync(join(home, ".hindsight.json"), JSON.stringify(base));
  mkdirSync(join(home, "notes", "deep"), { recursive: true });
  process.env.HOME = home;
  check(loadProjectConfig(join(home, "notes", "deep")).active === false, "$HOME/.hindsight.json never activates a directory under home");
  check(loadProjectConfig(home).active === false, "…nor home itself");
  mkdirSync(join(home, ".git"));
  check(loadProjectConfig(join(home, "notes")).active === false, "…even when home is a git toplevel (dotfiles repo)");
  mkdirSync(join(home, "proj", ".git"), { recursive: true });
  writeFileSync(join(home, "proj", ".hindsight.json"), JSON.stringify(base));
  mkdirSync(join(home, "proj", "sub"));
  check(loadProjectConfig(join(home, "proj", "sub")).active === true, "a project under home still finds its own config");
  process.env.HOME = mkdtempSync(join(tmpdir(), "hsmem-home-"));

  // Outside both a repository and home: only cwd itself.
  const loose = project(base, { "sub/.keep": "" }, { git: false });
  check(loadProjectConfig(loose).active === true, "no repository, outside home: cwd's own config is read");
  check(loadProjectConfig(join(loose, "sub")).active === false, "…but nothing above cwd");
}

console.log("tokenFile must stay inside the config's directory");
{
  const secretDir = mkdtempSync(join(tmpdir(), "hsmem-secret-"));
  writeFileSync(join(secretDir, "id_rsa"), "not-a-token-but-a-secret");
  const abs = loadProjectConfig(project({ ...base, tokenFile: join(secretDir, "id_rsa") }));
  check(!abs.active && /resolves outside/.test(abs.reason) && !abs.reason.includes("not-a-token"), "an absolute path outside is refused, content never echoed", abs.reason);
  const up = loadProjectConfig(project({ ...base, tokenFile: join("..", basename(secretDir), "id_rsa") }));
  check(!up.active && /resolves outside/.test(up.reason), "`..` out of the directory is refused", up.reason);
  const linked = project({ ...base, tokenFile: "t" });
  symlinkSync(join(secretDir, "id_rsa"), join(linked, "t"));
  const l = loadProjectConfig(linked);
  check(!l.active && /resolves outside/.test(l.reason), "a symlink pointing out is refused (realpath)", l.reason);
  const inside = project({ ...base, tokenFile: "real/t" }, { "real/t": "tok-in" });
  symlinkSync(join(inside, "real", "t"), join(inside, "alias"));
  const ok = loadProjectConfig(project({ ...base, tokenFile: join(inside, "alias") }));
  check(!ok.active, "an absolute path into ANOTHER project is outside too");
  writeFileSync(join(inside, ".hindsight.json"), JSON.stringify({ ...base, tokenFile: "alias" }));
  const viaLink = loadProjectConfig(inside);
  check(viaLink.active && viaLink.config.apiKey === "tok-in", "a symlink that stays inside is fine");
}

console.log("tool policy");
{
  const all = loadProjectConfig(project(base));
  check(all.active && all.config.enabledTools.length === 28, "no policy: every tool");
  const deny = loadProjectConfig(project({ ...base, denyTools: ["document_delete", "bank_config_set"] }));
  check(deny.active && deny.config.enabledTools.length === 26 && !deny.config.enabledTools.includes("document_delete"), "denyTools removes tools");
  const allow = loadProjectConfig(project({ ...base, allowTools: ["memory_recall", "memory_retain"], denyTools: ["memory_retain"] }));
  check(allow.active && allow.config.enabledTools.join() === "memory_recall", "allowTools narrows, denyTools wins over it");
  const typo = loadProjectConfig(project({ ...base, denyTools: ["document_delet"] }));
  check(!typo.active && /unknown tool\(s\) document_delet/.test(typo.reason), "an unknown tool name invalidates the config (a typo must not silently allow)", typo.reason);
  const shape = loadProjectConfig(project({ ...base, allowTools: "memory_recall" }));
  check(!shape.active && /`allowTools` must be an array/.test(shape.reason), "allowTools must be an array");
  // The read + curate profile documented in CONFIGURATION.md must load as written.
  const profile = [
    "memory_recall", "memory_reflect", "memory_status", "memory_get_current_bank", "memory_list", "memory_get",
    "memory_operations", "mental_model_list", "mental_model_get", "directive_list", "bank_config_get", "document_list",
    "memory_retain", "memory_retain_batch", "memory_invalidate", "memory_reconsolidate", "mental_model_refresh",
  ];
  const rc = loadProjectConfig(project({ ...base, allowTools: profile }));
  check(rc.active && rc.config.enabledTools.length === profile.length, "the documented read + curate profile loads", rc.active ? "" : rc.reason);
}

console.log("invalid configs are inert, with a reason");
for (const [label, cfg] of [
  ["defaultBank outside banks", { ...base, defaultBank: "gamma" }],
  ["missing banks", { url: base.url, defaultBank: "alpha" }],
  ["legacy bankId", { ...base, bankId: "alpha" }],
  ["token in config", { ...base, apiKey: "x" }],
  ["bad url", { ...base, url: "h.example" }],
  ["autoRetain not boolean", { ...base, autoRetain: "yes" }],
  ["unreadable tokenFile", { ...base, tokenFile: "nope" }],
]) {
  const r = loadProjectConfig(project(cfg));
  check(r.active === false && typeof r.reason === "string" && r.reason.length > 0, label, JSON.stringify(r));
}
{
  const dir = project(base, { ".hindsight-disabled": "" });
  check(loadProjectConfig(dir).active === false, ".hindsight-disabled still opts out");
}

console.log("MCP server and hooks without a config");
{
  const fake = await fakeHindsight(["alpha"]);
  const bare = project(null);
  const env = { HINDSIGHT_URL: fake.url, HINDSIGHT_API_KEY: "k", HINDSIGHT_BANK_ID: "alpha" };
  await withServer(bare, env, async ({ init, list, call }) => {
    check(Boolean(init.result?.serverInfo?.version), "still answers the handshake");
    check(/not configured/.test(init.result?.instructions ?? ""), "instructions say why it is inert");
    check((await list()).length === 0, "lists no tools");
    const r = await call("memory_recall", { query: "anything at all" });
    check(Boolean(r.error), "a direct call is refused as unknown");
  });
  for (const hook of ["recall.mjs", "retain.mjs", "session-end.mjs"]) {
    const r = await runHook(hook, { cwd: bare, prompt: "what did we decide about caching?", session_id: "s", transcript_path: "/nonexistent" }, env);
    check(r.code === 0 && r.stdout === "", `${hook} is a silent no-op`, r.stderr);
  }
  check(fake.requests.length === 0, "no request reached the server", JSON.stringify(fake.requests));
  fake.close();
}

console.log("MCP server with a config");
{
  const dir = project({ ...base, url: "http://127.0.0.1:1" });
  await withServer(dir, {}, async ({ list }) => {
    const tools = await list();
    check(tools.length === 28, "lists the full tool surface", String(tools.length));
  });
}

console.log("MCP server with a tool policy");
{
  const fake = await fakeHindsight(["alpha"]);
  const dir = project({ ...base, url: fake.url, tokenFile: "t", denyTools: ["document_delete", "bank_config_set"] }, { t: "tok" });
  await withServer(dir, {}, async ({ list, call }) => {
    const names = (await list()).map((t) => t.name);
    check(names.length === 26 && !names.includes("document_delete") && !names.includes("bank_config_set"), "denied tools are not listed", names.join());
    const before = fake.requests.length;
    const r = await call("document_delete", { document_id: "x" });
    check(Boolean(r.error) && /disabled by this project's tool policy/.test(r.error.message), "a denied tool refuses the call as a protocol error", JSON.stringify(r));
    check(fake.requests.length === before, "…without reaching the server");
    const cur = JSON.parse((await call("memory_get_current_bank")).text);
    check(Array.isArray(cur.tools) && cur.tools.length === 26, "memory_get_current_bank reports the enabled tools");
  });
  const open = project({ ...base, url: fake.url, tokenFile: "t" }, { t: "tok" });
  await withServer(open, {}, async ({ call }) => {
    check(JSON.parse((await call("memory_get_current_bank")).text).tools === "all", "no policy: tools \"all\"");
  });
  fake.close();
}

console.log("hooks decide before reading a token");
{
  const fake = await fakeHindsight(["alpha"]);
  // The token command leaves a marker in the project, so a test can see whether it ran.
  const tokenCommand = ["node", "-e", "require('fs').writeFileSync('ran', '1'); process.stdout.write('tok')"];
  const env = { HINDSIGHT_ALLOW_TOKEN_COMMAND: "1" };
  const input = (cwd) => ({ cwd, prompt: "what did we decide about caching?", session_id: "s", transcript_path: "/nonexistent" });
  const off = project({ ...base, url: fake.url, tokenCommand });
  for (const hook of ["recall.mjs", "retain.mjs", "session-end.mjs"]) await runHook(hook, input(off), env);
  check(!existsSync(join(off, "ran")), "autoRecall/autoRetain off: tokenCommand never runs");
  const on = project({ ...base, url: fake.url, tokenCommand, autoRecall: true });
  await runHook("recall.mjs", input(on), env);
  check(existsSync(join(on, "ran")), "autoRecall on: it does (the marker works)");
  fake.close();
}

Object.assign(process.env, savedEnv);
finish("project-config");

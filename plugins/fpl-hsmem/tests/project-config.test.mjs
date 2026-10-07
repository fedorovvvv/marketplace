import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
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
  check(o.active && o.config.url === "http://override:1" && o.config.apiKey === "env-tok", "env overrides url/token of a configured project");
  resetEnv();

  const cmd = project({ ...base, tokenCommand: ["node", "-e", "process.stdout.write('from-cmd')"] });
  const c = loadProjectConfig(cmd);
  check(c.active && c.config.apiKey === "from-cmd" && c.config.tokenSource === "tokenCommand", "tokenCommand (argv, no shell)");
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

Object.assign(process.env, savedEnv);
finish("project-config");

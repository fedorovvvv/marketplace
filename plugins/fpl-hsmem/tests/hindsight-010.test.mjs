import { check, finish, project, fakeHindsight, withServer } from "./lib/harness.mjs";

const fake = await fakeHindsight(["alpha"]);
const CAND = JSON.stringify({ bank: "alpha", kind: "rule", content: "c", context: "x", timestamp: "2026-01-01", document_id: "rule:x:1" });
const dir = project({ url: fake.url, banks: ["alpha"], defaultBank: "alpha", tokenFile: "t" }, { t: "tok", "doc.md": "hello", "c.jsonl": CAND });

const ARGS = {
  memory_retain: { content: "c" },
  memory_retain_batch: { file: "c.jsonl" },
  memory_recall: { query: "q q q" },
  memory_reflect: { query: "q" },
  memory_set_mission: { mission: "Answer as the team's architecture memory." },
  memory_list: { type: "world", tags: ["a", "b"] },
  memory_get: { id: "m1" },
  memory_invalidate: { id: "m1", reason: "wrong" },
  memory_reconsolidate: { id: "m1" },
  memory_operations: {},
  mental_model_get: { id: "mm" },
  mental_model_create: { id: "mm", name: "n", source_query: "s" },
  mental_model_update: { id: "mm", name: "n2" },
  mental_model_delete: { id: "mm" },
  mental_model_refresh: { id: "mm" },
  mental_model_clear: { id: "mm" },
  directive_create: { name: "d", content: "c" },
  directive_delete: { id: "d1" },
  bank_config_set: { key: "enable_reranking", value: true },
  document_ingest: { title: "t", content: "c" },
  document_ingest_file: { path: "doc.md" },
  document_list: {},
  document_delete: { id: "doc" },
};

await withServer(dir, {}, async ({ list, call }) => {
  const names = (await list()).map((t) => t.name);
  for (const n of names) await call(n, ARGS[n] ?? {});
  check(names.length === 28, "exercised every tool", String(names.length));

  const removed = fake.requests.filter((r) => /\/(profile|background)$/.test(r.path));
  check(removed.length === 0, "no tool calls a removed 0.10 endpoint (/profile, /background)", JSON.stringify(removed));
  check(!fake.requests.some((r) => r.method === "PUT" && /^\/v1\/default\/banks\/[^/]+$/.test(r.path)), "no deprecated PUT /banks/{id}");

  const mission = fake.requests.find((r) => r.method === "PATCH" && r.path === "/v1/default/banks/alpha/config" && r.body?.updates?.reflect_mission);
  check(Boolean(mission), "memory_set_mission → PATCH /config {updates:{reflect_mission}}");
  check(mission && Object.keys(mission.body).join() === "updates" && Object.keys(mission.body.updates).join() === "reflect_mission", "…and nothing else in the body", JSON.stringify(mission?.body));

  const mm = fake.requests.find((r) => r.method === "GET" && r.path === "/v1/default/banks/alpha/mental-models");
  check(mm && /detail=metadata/.test(mm.query), "mental_model_list asks for detail=metadata explicitly (0.10 default)", mm?.query);
  const mmGet = fake.requests.find((r) => r.method === "GET" && r.path === "/v1/default/banks/alpha/mental-models/mm");
  check(mmGet && /detail=content/.test(mmGet.query), "mental_model_get opts in to content (0.10 makes content opt-in)", mmGet?.query);

  const cfg = fake.requests.find((r) => r.method === "PATCH" && r.body?.updates?.enable_reranking === true);
  check(cfg && Object.keys(cfg.body).join() === "updates", "bank_config_set → PATCH /config {updates:{…}}");

  const ml = fake.requests.find((r) => r.path === "/v1/default/banks/alpha/memories/list");
  check(ml && /tags=a&tags=b/.test(ml.query) && /type=world/.test(ml.query), "memory_list sends tags as a repeated key (list[str] Query)", ml?.query);

  const existence = fake.requests.filter((r) => r.path === "/v1/default/banks");
  check(existence.length === 1 && existence[0].method === "GET" && /q=alpha/.test(existence[0].query), "bank existence read once from GET /v1/default/banks?q=", JSON.stringify(existence));
});

fake.close();
finish("hindsight-0.10");

#!/usr/bin/env node
/**
 * Batch enrichment CLI — the same pipeline as the `memory_retain_batch` tool, for a human at a
 * shell or a bot host that runs commands rather than MCP tools.
 *
 *   node dist/enrich.mjs <candidates.jsonl> [--apply] [--max-chars N] [--batch-size N]
 *                        [--samples N] [--json]
 *
 * Configuration is the project's `.hindsight.json`, found walking up from the working directory —
 * the same file, allowlist and `routing` the MCP server uses. Dry run is the default: nothing is
 * written without `--apply`.
 *
 * Exit codes: 0 — every line accepted (and, with --apply, every batch queued); 3 — some lines
 * refused (the rest were planned / written); 1 — config, file, server or batch failure; 2 — usage.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { BankGate } from "./lib/banks.js";
import { loadProjectConfig } from "./lib/config.js";
import {
  DEFAULT_BATCH_SIZE,
  applyEnrichPlan,
  enrichSummary,
  formatEnrichReport,
  planEnrich,
} from "./lib/enrich.js";
import { redact } from "./lib/redact.js";

/** Same ceiling as document_ingest_file: a candidates file is curated items, not a corpus. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const USAGE =
  "usage: enrich.mjs <candidates.jsonl> [--apply] [--max-chars N] [--batch-size N] [--samples N] [--json]";

function fail(code: number, message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
let file: string | undefined;
let apply = false;
let json = false;
let maxChars: number | undefined;
let batchSize = DEFAULT_BATCH_SIZE;
let samples = 2;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const num = () => {
    const n = Number(argv[++i]);
    if (!Number.isInteger(n) || n < 0) fail(2, `${a} needs a non-negative integer\n${USAGE}`);
    return n;
  };
  if (a === "--apply") apply = true;
  else if (a === "--json") json = true;
  else if (a === "--max-chars") maxChars = num();
  else if (a === "--batch-size") batchSize = num();
  else if (a === "--samples") samples = num();
  else if (a === "-h" || a === "--help") fail(0, USAGE);
  else if (a.startsWith("-")) fail(2, `unknown option ${a}\n${USAGE}`);
  else if (file === undefined) file = a;
  else fail(2, `one file at a time\n${USAGE}`);
}
if (!file) fail(2, USAGE);

const loaded = loadProjectConfig(process.cwd());
if (!loaded.active) fail(1, `Hindsight is not configured here: ${loaded.reason}`);
const config = loaded.config;

const path = resolve(file);
let text: string;
try {
  const size = statSync(path).size;
  if (size > MAX_FILE_BYTES) fail(1, `refusing ${path}: ${size} bytes exceeds the ${MAX_FILE_BYTES}-byte cap`);
  text = readFileSync(path, "utf-8");
} catch (err) {
  fail(1, `cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
}

const gate = new BankGate(config);
try {
  const plan = await planEnrich(text, { maxChars: maxChars ?? config.enrichMaxChars, routing: config.routing }, (b) =>
    gate.resolve(b),
  );
  const applied = apply ? await applyEnrichPlan(plan, batchSize) : undefined;
  process.stdout.write(
    (json
      ? JSON.stringify(enrichSummary(path, plan, applied), null, 2)
      : formatEnrichReport(path, plan, applied, {
          samples,
          batchSize,
          applyHint: "Re-run with --apply after a human has reviewed this summary.",
        })) + "\n",
  );
  if (applied?.some((r) => r.error)) process.exit(1);
  process.exit(plan.refused.length ? 3 : 0);
} catch (err) {
  fail(1, `enrich failed: ${redact((err as Error).message).slice(0, 500)}`);
}

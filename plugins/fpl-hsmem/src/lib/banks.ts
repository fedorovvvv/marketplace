import { HindsightClient } from "./client.js";
import type { HindsightConfig } from "./config.js";

/**
 * The one place a bank id becomes a client.
 *
 * Shared by the MCP server and the batch writer (`enrich.mjs`) so both refuse the same banks for
 * the same reasons. A bank is accepted only when it is in the project's allowlist AND already
 * exists on the server. Existence is read from the bank list, never by touching the bank:
 * Hindsight creates a bank implicitly on first use, so "try it and see" would create exactly the
 * orphan this check exists to prevent.
 */
export class BankGate {
  /** One client per bank, created on first use. */
  private readonly clients = new Map<string, HindsightClient>();
  /** Banks confirmed to exist on the server. Only positives are cached; a missing bank is re-asked. */
  private readonly known = new Set<string>();

  constructor(private readonly config: Pick<HindsightConfig, "url" | "banks" | "defaultBank" | "apiKey" | "configPath">) {}

  /** A client for the default bank without the existence check — for tools that never touch a bank. */
  defaultClient(): HindsightClient {
    return this.clientFor(this.config.defaultBank);
  }

  private clientFor(bank: string): HindsightClient {
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
  async resolve(requested: unknown): Promise<HindsightClient | string> {
    const bank = requested === undefined || requested === null || requested === "" ? this.config.defaultBank : requested;
    if (typeof bank !== "string") return "Error: bank must be a string";
    if (!this.config.banks.includes(bank)) {
      return (
        `Refusing: bank "${bank}" is not in this project's allowlist (${this.config.banks.join(", ")}). ` +
        `Allowed banks are declared in ${this.config.configPath}.`
      );
    }
    const client = this.clientFor(bank);
    if (!this.known.has(bank)) {
      if (!(await client.bankExists(bank))) {
        return (
          `Refusing: bank "${bank}" does not exist on ${this.config.url}. This server never creates ` +
          `banks — an operator creates one deliberately, then this call will work.`
        );
      }
      this.known.add(bank);
    }
    return client;
  }
}

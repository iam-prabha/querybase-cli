import { Command } from "commander";
import { loadEnv, requireUser } from "../lib/keys.js";
import { query } from "../lib/store-pool.js";

export function rateLimitCommand(program: Command): Command {
  return program
    .command("rate-limit")
    .description("Show rate limit bucket status")
    .argument("[user]", "Username (defaults to current user)")
    .option("--json", "Output as JSON")
    .action(async (username: string | undefined, opts: { json?: boolean }) => {
      loadEnv();
      const store = (await import("../lib/store.js")).storeFromEnv();
      try {
        await store.init();
        let userId: string;
        if (username) {
          const user = await store.getUserByUsername(username);
          if (!user) {
            console.error(`User "${username}" not found`);
            process.exit(1);
          }
          userId = user.id;
        } else {
          const current = await store.getCurrentUser();
          if (!current) {
            console.error("Not logged in. Run `querybase login <username>` or specify a user.");
            process.exit(1);
          }
          const user = await store.getUserByUsername(current.username);
          if (!user) {
            console.error("Session invalid. Log in again.");
            process.exit(1);
          }
          userId = user.id;
        }

        const result = await query(
          `SELECT endpoint, tokens, refilled_at FROM rate_limit_buckets WHERE user_id = $1 ORDER BY endpoint`,
          [userId]
        );

        if (opts.json) {
          console.log(JSON.stringify(result.rows, null, 2));
        } else {
          if (result.rows.length === 0) {
            console.log("No rate limit buckets found for this user.");
            return;
          }
          console.log(`Rate limit status for user ${userId}:`);
          console.log("");
          console.log(`${"Endpoint".padEnd(10)} ${"Tokens".padEnd(8)} ${"Refilled At"}`);
          console.log("─".repeat(50));
          for (const row of result.rows) {
            const refilled = new Date(row.refilled_at).toISOString().replace("T", " ").slice(0, 19);
            console.log(`${row.endpoint.padEnd(10)} ${String(row.tokens).padEnd(8)} ${refilled}`);
          }
        }
      } finally {
        await store.close();
      }
    });
}
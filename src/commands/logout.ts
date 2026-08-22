import type { Command } from "commander";
import { storeFromEnv } from "../lib/store.js";
import { loadEnv } from "../lib/keys.js";

export function logoutCommand(program: Command): Command {
  return program
    .command("logout")
    .description("End your session")
    .action(async () => {
      loadEnv();
      const store = storeFromEnv();
      try {
        await store.init();
        const current = await store.getCurrentUser();
        if (!current) {
          console.log("Not logged in.");
          return;
        }
        await store.clearCurrentUser();
        console.log(`Logged out "${current.username}".`);
      } finally {
        await store.close();
      }
    });
}

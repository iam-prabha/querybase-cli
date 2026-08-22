import type { Command } from "commander";
import { storeFromEnv } from "../lib/store.js";
import { loadEnv } from "../lib/keys.js";

export function whoamiCommand(program: Command): Command {
  return program
    .command("whoami")
    .description("Show the current logged-in user")
    .action(async () => {
      loadEnv();
      const store = storeFromEnv();
      try {
        await store.init();
        const current = await store.getCurrentUser();
        console.log(current ? current.username : "Not logged in.");
      } finally {
        await store.close();
      }
    });
}

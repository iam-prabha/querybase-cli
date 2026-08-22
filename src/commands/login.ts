import type { Command } from "commander";
import password from "@inquirer/password";
import { storeFromEnv } from "../lib/store.js";
import { loadEnv } from "../lib/keys.js";
import { newSessionToken, verifyPassword } from "../lib/auth.js";
import { META_KEYS } from "../types.js";

export function loginCommand(program: Command): Command {
  return program
    .command("login <username>")
    .description("Log in to your account")
    .action(async (username: string) => {
      loadEnv();
      const store = storeFromEnv();
      try {
        await store.init();
        const user = await store.getUserByUsername(username);
        if (!user) {
          console.error(`No account for "${username}" — run: querybase signup ${username}`);
          process.exit(1);
        }

        const entered = await password({ message: "Password:" });
        const ok = await verifyPassword(entered, user.passwordHash);
        if (!ok) {
          console.error("Incorrect password");
          process.exit(1);
        }

        await store.setMeta(META_KEYS.CURRENT_USER, user.username);
        await store.setMeta(META_KEYS.SESSION_TOKEN, newSessionToken());

        console.log(`Logged in as "${user.username}".`);
      } finally {
        await store.close();
      }
    });
}

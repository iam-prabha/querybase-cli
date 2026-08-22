import type { Command } from "commander";
import password from "@inquirer/password";
import { storeFromEnv } from "../lib/store.js";
import { loadEnv } from "../lib/keys.js";
import { hashPassword, newSessionToken } from "../lib/auth.js";
import { META_KEYS } from "../types.js";

export function signupCommand(program: Command): Command {
  return program
    .command("signup <username>")
    .description("Create a new user account and log in")
    .action(async (username: string) => {
      loadEnv();
      const store = storeFromEnv();
      try {
        await store.init();
        if (await store.getUserByUsername(username)) {
          console.error(`User "${username}" already exists`);
          process.exit(1);
        }

        const first = await password({ message: "Password:" });
        const second = await password({ message: "Confirm password:" });
        if (first !== second) {
          console.error("Passwords do not match");
          process.exit(1);
        }
        if (first.length < 8) {
          console.error("Password must be at least 8 characters");
          process.exit(1);
        }

        const passwordHash = await hashPassword(first);
        const user = await store.createUser(username, passwordHash);
        await store.setMeta(META_KEYS.CURRENT_USER, user.username);
        await store.setMeta(META_KEYS.SESSION_TOKEN, newSessionToken());

        console.log(`Account created for "${user.username}" — logged in.`);
      } finally {
        await store.close();
      }
    });
}

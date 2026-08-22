import { Command } from "commander";
import { signupCommand } from "./commands/signup.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { whoamiCommand } from "./commands/whoami.js";
import { setKeyCommand } from "./commands/set-key.js";
import { unsetKeyCommand } from "./commands/unset-key.js";
import { crawlCommand } from "./commands/crawl.js";
import { indexCommand } from "./commands/index.js";
import { askCommand } from "./commands/ask.js";
import { statusCommand } from "./commands/status.js";
import { rateLimitCommand } from "./commands/rate-limit.js";
import { rotateKeyCommand } from "./commands/rotate-key.js";
import { versionCommand } from "./commands/version.js";
import { requireUser } from "./lib/keys.js";
import { initBucket, checkRateLimit, consumeRateLimit } from "./lib/rate-limit.js";

const program = new Command();
program
  .name("querybase")
  .description("Docs site to RAG pipeline: point a sitemap scraper at any docs site, get structured JSON, chunk, embed, and chat with citations")
  .version("0.1.0");

signupCommand(program);
loginCommand(program);
logoutCommand(program);
whoamiCommand(program);
setKeyCommand(program);
unsetKeyCommand(program);
crawlCommand(program);
indexCommand(program);
askCommand(program);
statusCommand(program);
rateLimitCommand(program);
rotateKeyCommand(program);
versionCommand(program);

const RATE_LIMITED_COMMANDS: Record<string, "crawl" | "index" | "ask"> = {
  crawl: "crawl",
  index: "index",
  ask: "ask",
};

const originalParseAsync = program.parseAsync.bind(program);
program.parseAsync = async (argv: string[]) => {
  const cmdName = argv[2];
  const endpoint = RATE_LIMITED_COMMANDS[cmdName];
  if (endpoint) {
    const store = (await import("./lib/store.js")).storeFromEnv();
    try {
      await store.init();
      const user = await requireUser(store);
      await initBucket(user.id, endpoint);
      const rl = await checkRateLimit(user.id, endpoint);
      if (!rl.allowed) {
        console.error(`rate limit exceeded for ${endpoint}, retry after ${rl.retryAfter}s`);
        process.exit(1);
      }
      try {
        await originalParseAsync(argv);
        await consumeRateLimit(user.id, endpoint);
      } catch (err) {
        throw err;
      }
    } finally {
      await store.close();
    }
    return program;
  } else {
    return originalParseAsync(argv);
  }
};

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`error: ${message}`);
  process.exit(1);
});
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));

export function versionCommand(program: Command): Command {
  return program
    .command("version")
    .description("Print version information")
    .action(() => {
      console.log(`querybase ${pkg.version}`);
      console.log(`Node ${process.version}`);
      console.log(`Platform ${process.platform}/${process.arch}`);
    });
}
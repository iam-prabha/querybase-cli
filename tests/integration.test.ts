import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { discoverPageUrls } from "../src/lib/discovery.js";
import { sectionMarkdown } from "../src/lib/sectioner.js";
import { chunkText } from "../src/lib/chunk.js";
import { META_KEYS } from "../src/types.js";
import TurndownService from "turndown";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures/test-site");
const turndown = new TurndownService({ codeBlockStyle: "fenced", headingStyle: "atx" });

function createMockStore() {
  const meta = new Map<string, string>();
  return {
    init: async () => {},
    close: async () => {},
    getMeta: async (key: string) => meta.get(key) ?? null,
    setMeta: async (key: string, value: string) => { meta.set(key, value); },
    clearMeta: async (key: string) => { meta.delete(key); },
    pageCount: async () => 0,
    pendingIndexPages: async () => [],
    savePage: async () => {},
    getPage: async () => null,
    markPageIndexed: async () => {},
    resetPages: async () => {},
    resetIndexedState: async () => {},
    createUser: async () => ({ id: "test", username: "test", createdAt: new Date().toISOString() }),
    getUserByUsername: async () => null,
    getCurrentUser: async () => ({ username: "test", sessionToken: "test" }),
    clearCurrentUser: async () => {},
    userCount: async () => 1,
    setCredential: async () => {},
    getCredential: async () => "test-key",
    unsetCredential: async () => {},
    ping: async () => {},
  };
}

let server: ReturnType<typeof createServer>;
const PORT = 18473;
const BASE_URL = `http://localhost:${PORT}`;

beforeAll(() => new Promise<void>((resolve) => {
  server = createServer((req, res) => {
    let path = req.url?.replace(/^\//, "") || "sitemap.xml";
    if (path === "sitemap.xml") {
      path = "sitemap.xml";
    } else if (path.startsWith("docs/")) {
      if (!path.endsWith(".html")) path += ".html";
    } else if (!path.endsWith(".html")) {
      path = `docs/${path}.html`;
    }

    const filePath = join(FIXTURE_DIR, path);
    const fs = require("node:fs");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": path.endsWith(".xml") ? "application/xml" : "text/html" });
      res.end(data);
    });
  });
  server.listen(PORT, resolve);
}));

afterAll(() => new Promise<void>((resolve) => {
  server.close(resolve);
}));

describe("integration: sitemap discovery + sectioning pipeline", () => {
  it("discovers pages from sitemap.xml", async () => {
    const store = createMockStore();
    await store.init();
    await store.setMeta(META_KEYS.SOURCE_URL, `${BASE_URL}/sitemap.xml`);
    await store.setMeta(META_KEYS.SOURCE_TYPE, "sitemap");

    const urls = await discoverPageUrls(store);

    expect(urls).toHaveLength(3);
    expect(urls).toContain(`${BASE_URL}/docs/intro`);
    expect(urls).toContain(`${BASE_URL}/docs/guide`);
    expect(urls).toContain(`${BASE_URL}/docs/api`);

    await store.close();
  });

  it("sections HTML pages by headings (via turndown)", async () => {
    const introHtml = await fetch(`${BASE_URL}/docs/intro`).then(r => r.text());
    const markdown = turndown.turndown(introHtml);
    const sections = sectionMarkdown(markdown);

    expect(sections.length).toBeGreaterThan(0);
    const headingPaths = sections.map(s => s.headingPath);
    expect(headingPaths).toContain("Introduction to Test API");
    expect(headingPaths).toContain("Introduction to Test API > Getting Started");
    expect(headingPaths).toContain("Introduction to Test API > Basic Usage");
  });

  it("chunks sections within token budget", async () => {
    const introHtml = await fetch(`${BASE_URL}/docs/intro`).then(r => r.text());
    const markdown = turndown.turndown(introHtml);
    const sections = sectionMarkdown(markdown);

    for (const section of sections) {
      const chunks = chunkText(section.text, 50);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(100);
      }
    }
  });
});
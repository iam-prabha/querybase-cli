import { describe, expect, it } from "vitest";
import { ensureCollector, mapRowsToMarkdown, COLLECTOR_DESCRIPTION } from "../src/lib/scraper-studio.js";
import { shouldHeal } from "../src/lib/fetcher.js";
import type { Store } from "../src/lib/store.js";

const MIN = 1;

function block(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { type, ...payload };
}

describe("mapRowsToMarkdown", () => {
  it("attributes rows to urls by the top level url field and serializes blocks", () => {
    const rows = [
      {
        url: "https://example.com/a",
        extraction: {
          title: "Page A",
          blocks: [
            block("heading", { level: 2, text: "Intro" }),
            block("paragraph", { text: "Hello world" }),
            block("code", { code: "const x = 1;" }),
          ],
        },
      },
    ];
    const { markdowns, failed } = mapRowsToMarkdown(rows, ["https://example.com/a"], MIN);
    expect(failed).toEqual([]);
    expect(markdowns.get("https://example.com/a")).toBe(
      "# Page A\n\n## Intro\n\nHello world\n\n```\nconst x = 1;\n```"
    );
  });

  it("also matches rows where the url lives under input.url", () => {
    const rows = [{ input: { url: "https://example.com/b" }, extraction: { title: "B", blocks: [] } }];
    const { markdowns, failed } = mapRowsToMarkdown(rows, ["https://example.com/b"], MIN);
    expect(failed).toEqual([]);
    expect(markdowns.get("https://example.com/b")).toBe("# B");
  });

  it("counts a missing row as failed", () => {
    const { markdowns, failed } = mapRowsToMarkdown([], ["https://example.com/a"], MIN);
    expect(markdowns.has("https://example.com/a")).toBe(false);
    expect(failed).toEqual(["https://example.com/a"]);
  });

  it("counts an error row as failed", () => {
    const rows = [{ input: { url: "https://example.com/a" }, error: "collector exploded" }];
    const { markdowns, failed } = mapRowsToMarkdown(rows, ["https://example.com/a"], MIN);
    expect(markdowns.has("https://example.com/a")).toBe(false);
    expect(failed).toEqual(["https://example.com/a"]);
  });

  it("counts extraction below the minimum length as failed", () => {
    const rows = [{ url: "https://example.com/a", extraction: { title: "Tiny", blocks: [] } }];
    const { markdowns, failed } = mapRowsToMarkdown(rows, ["https://example.com/a"], 20);
    expect(markdowns.has("https://example.com/a")).toBe(false);
    expect(failed).toEqual(["https://example.com/a"]);
  });

  it("converts an html string extraction through turndown", () => {
    const rows = [{ url: "https://example.com/a", extraction: "<html><body><h1>Hi</h1></body></html>" }];
    const { markdowns } = mapRowsToMarkdown(rows, ["https://example.com/a"], MIN);
    expect(markdowns.get("https://example.com/a") ?? "").toContain("# Hi");
  });

  it("prefers the real row shape's raw_content over block reassembly", () => {
    const rows = [
      {
        title: "Concise reference",
        blocks: [block("heading", { level: 2, text: "About FastHTML" })],
        product_page_url: "https://example.com/a",
        raw_content: "# Concise reference\n\n## About FastHTML\n\nReal markdown.",
        raw_content_url: "https://example.com/a",
        input: { url: "https://example.com/a" },
      },
    ];
    const { markdowns, failed } = mapRowsToMarkdown(rows, ["https://example.com/a"], MIN);
    expect(failed).toEqual([]);
    expect(markdowns.get("https://example.com/a")).toBe(
      "# Concise reference\n\n## About FastHTML\n\nReal markdown."
    );
  });

  it("falls back to top level title and blocks when raw_content is absent", () => {
    const rows = [
      {
        title: "Page B",
        blocks: [block("paragraph", { text: "No raw content here" })],
        input: { url: "https://example.com/b" },
      },
    ];
    const { markdowns, failed } = mapRowsToMarkdown(rows, ["https://example.com/b"], MIN);
    expect(failed).toEqual([]);
    expect(markdowns.get("https://example.com/b")).toBe("# Page B\n\nNo raw content here");
  });

  it("keeps the accounting invariant: counted plus failed equals submitted", () => {
    const submitted = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];
    const rows = [
      { url: "https://example.com/a", extraction: { title: "A", blocks: [] } },
      { input: { url: "https://example.com/b" }, error: "nope" },
    ];
    const { markdowns, failed } = mapRowsToMarkdown(rows, submitted, MIN);
    expect(markdowns.size + failed.length).toBe(submitted.length);
    expect(markdowns.has("https://example.com/a")).toBe(true);
    expect(failed).toEqual(["https://example.com/b", "https://example.com/c"]);
  });
});

describe("ensureCollector", () => {
it("sends one same-origin discovered page as the generation sample url", async () => {
    const store = { getMeta: async () => null, setMeta: async () => {} } as unknown as Store;
    const calls: Array<{ path: string; body?: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = url.replace("https://api.brightdata.com", "");
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/dca/collector") {
        return new Response(JSON.stringify({ id: "c_probe" }), { status: 200 });
      }
      if (path.endsWith("/automate_template/progress")) {
        return new Response(JSON.stringify({ status: "done" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    try {
      const id = await ensureCollector("key", store, "https://example.com/docs", [
        "https://example.com/docs/a",
        "https://other.example.org/ref.md",
        "https://example.com/docs/b",
        "https://example.com/docs/c",
      ], {});
      expect(id).toBe("c_probe");
      const generation = calls.find((c) => c.path.endsWith("/automate_template"));
      expect(generation?.body).toEqual({
        description: COLLECTOR_DESCRIPTION,
        urls: ["https://example.com/docs/a"],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("shouldHeal", () => {
  it("heals when failures meet the floor, within the cap, and no transport failure", () => {
    expect(shouldHeal(3, 2, 0, 1, false)).toBe(true);
  });

  it("does not heal below the failure floor", () => {
    expect(shouldHeal(1, 2, 0, 1, false)).toBe(false);
  });

  it("does not heal past the per crawl cap", () => {
    expect(shouldHeal(3, 2, 1, 1, false)).toBe(false);
  });

  it("never heals on a transport failure", () => {
    expect(shouldHeal(50, 2, 0, 1, true)).toBe(false);
  });
});

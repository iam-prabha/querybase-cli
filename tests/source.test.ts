import { describe, expect, it } from "vitest";
import { classifySourceUrl, detectSource } from "../src/lib/source.js";

function fakeFetch(routes: Record<string, boolean>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === "string" ? input : new URL(String(input)).href;
    return { ok: routes[url] ?? false } as Response;
  }) as typeof fetch;
}

describe("classifySourceUrl", () => {
  it("classifies an explicit llms.txt url", () => {
    expect(classifySourceUrl("https://docs.anthropic.com/llms.txt")).toBe("llms-txt");
  });

  it("classifies a sitemap url", () => {
    expect(classifySourceUrl("https://docs.anthropic.com/sitemap.xml")).toBe("sitemap");
  });

  it("defaults to html for a plain docs path", () => {
    expect(classifySourceUrl("https://docs.anthropic.com/en/docs")).toBe("html");
  });
});

describe("detectSource", () => {
  it("returns llms-txt when only the origin root serves llms.txt", async () => {
    const routes = {
      "https://docs.anthropic.com/en/docs/llms.txt": false,
      "https://docs.anthropic.com/en/docs/sitemap.xml": false,
      "https://docs.anthropic.com/llms.txt": true,
    };
    const type = await detectSource("https://docs.anthropic.com/en/docs", fakeFetch(routes));
    expect(type).toBe("llms-txt");
  });

  it("returns sitemap when only the origin root serves sitemap.xml", async () => {
    const routes = {
      "https://example.com/docs/llms.txt": false,
      "https://example.com/docs/sitemap.xml": false,
      "https://example.com/llms.txt": false,
      "https://example.com/llms-full.txt": false,
      "https://example.com/sitemap.xml": true,
    };
    const type = await detectSource("https://example.com/docs", fakeFetch(routes));
    expect(type).toBe("sitemap");
  });

  it("returns llms-txt directly for an explicit llms.txt url", async () => {
    const type = await detectSource("https://example.com/llms.txt", fakeFetch({}));
    expect(type).toBe("llms-txt");
  });

  it("falls back to html when every probe fails", async () => {
    const type = await detectSource("https://example.com/docs", fakeFetch({}));
    expect(type).toBe("html");
  });
});
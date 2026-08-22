import { describe, expect, it } from "vitest";
import { chunkText } from "../src/lib/chunk.js";

describe("chunkText", () => {
  it("keeps short text in a single chunk", () => {
    expect(chunkText("Hello world.", 480)).toEqual(["Hello world."]);
  });

  it("splits long text into chunks within the token budget", () => {
    const paragraph = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(paragraph, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100 * 2.0);
    }
    expect(chunks.join(" ")).toContain("word0");
    expect(chunks.join(" ")).toContain("word499");
  });

  it("splits a single oversized paragraph across chunks without losing content", () => {
    const text = "alpha ".repeat(1200) + "omega";
    const chunks = chunkText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50 * 2.0);
    }
    const joined = chunks.join(" ");
    expect(joined).toContain("alpha");
    expect(joined).toContain("omega");
  });

  it("returns no chunks for empty or whitespace only text", () => {
    expect(chunkText("", 100)).toEqual([]);
    expect(chunkText("   \n\n  ", 100)).toEqual([]);
  });

  it("drops no content across paragraph boundaries", () => {
    const text = "one\n\n\ntwo\n\nthree";
    const chunks = chunkText(text, 100);
    expect(chunks.join(" ")).toContain("one");
    expect(chunks.join(" ")).toContain("two");
    expect(chunks.join(" ")).toContain("three");
  });
});
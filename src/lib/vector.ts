import { createHash } from "node:crypto";
import type { QdrantClient } from "@qdrant/js-client-rest";
import type { Section } from "../types.js";
import { qdrantBreaker } from "./circuit-breaker.js";
import { withRetry } from "./retry.js";

export function collectionName(sourceUrl: string): string {
  const slug = sourceUrl
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 63) || "source";
}

export function sectionPointId(section: Section): string {
  const key = `${section.pageUrl}|${section.headingPath}|${section.chunkIndex ?? 0}`;
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function withBreaker<T>(fn: () => Promise<T>): Promise<T> {
  return qdrantBreaker.execute(() => withRetry(fn));
}

export async function ensureCollection(
  client: QdrantClient,
  name: string,
  dimensions: number
): Promise<void> {
  await withBreaker(async () => {
    const { exists } = await client.collectionExists(name);
    if (!exists) {
      await client.createCollection(name, { vectors: { size: dimensions, distance: "Cosine" } });
    }
    await ensurePageUrlIndex(client, name);
  });
}

export async function rebuildCollection(
  client: QdrantClient,
  name: string,
  dimensions: number
): Promise<void> {
  await withBreaker(async () => {
    const { exists } = await client.collectionExists(name);
    if (exists) await client.deleteCollection(name);
    await client.createCollection(name, { vectors: { size: dimensions, distance: "Cosine" } });
    await ensurePageUrlIndex(client, name);
  });
}

async function ensurePageUrlIndex(client: QdrantClient, name: string): Promise<void> {
  await withBreaker(async () => {
    try {
      await client.createPayloadIndex(name, { field_name: "page_url", field_schema: "keyword" });
    } catch {
      // index already exists
    }
  });
}

export async function deletePagePoints(
  client: QdrantClient,
  name: string,
  pageUrl: string
): Promise<void> {
  await withBreaker(async () => {
    await client.delete(name, {
      wait: true,
      filter: { must: [{ key: "page_url", match: { value: pageUrl } }] },
    });
  });
}

export async function upsertSections(
  client: QdrantClient,
  name: string,
  vectors: number[][],
  sections: Section[]
): Promise<void> {
  await withBreaker(async () => {
    const points = sections.map((section, i) => ({
      id: sectionPointId(section),
      vector: vectors[i],
      payload: {
        section_id: sectionPointId(section),
        page_url: section.pageUrl,
        heading_path: section.headingPath,
        text: section.text,
      },
    }));
    const PAGE = 100;
    for (let i = 0; i < points.length; i += PAGE) {
      await client.upsert(name, { wait: true, points: points.slice(i, i + PAGE) });
    }
  });
}

export interface SearchHit {
  sectionId: string;
  pageUrl: string;
  headingPath: string;
  text: string;
  score: number;
}

export async function searchSections(
  client: QdrantClient,
  name: string,
  vector: number[],
  topK: number
): Promise<SearchHit[]> {
  return withBreaker(async () => {
    const res = await client.query(name, {
      query: vector,
      limit: topK,
      with_payload: true,
    });
    return (res.points ?? []).map((r) => ({
      sectionId: String(r.id),
      pageUrl: String(r.payload?.page_url ?? ""),
      headingPath: String(r.payload?.heading_path ?? ""),
      text: String(r.payload?.text ?? ""),
      score: r.score ?? 0,
    }));
  });
}

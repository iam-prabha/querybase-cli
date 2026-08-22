export type SourceType = "llms-txt" | "sitemap" | "html";

export interface SourceInfo {
  sourceUrl: string;
  sourceType: SourceType;
  createdAt: string;
}

export interface Page {
  url: string;
  title: string;
  markdown: string;
}

export interface PageRow extends Page {
  contentHash: string;
  lastIndexedHash: string | null;
  fetchedAt: string;
}

export interface Section {
  pageUrl: string;
  headingPath: string;
  text: string;
  chunkIndex?: number;
}

export interface Citation {
  index: number;
  url: string;
  headingPath: string;
}

export interface Account {
  id: string;
  username: string;
  createdAt: string;
}

export interface AccountRow extends Account {
  passwordHash: string;
}

// Legacy aliases for backward compatibility
export type User = Account;
export type UserRow = AccountRow;

export type CredentialProvider = "brightdata" | "qdrant" | "embed";

export const CREDENTIAL_PROVIDERS: readonly CredentialProvider[] = [
  "brightdata",
  "qdrant",
  "embed",
];

export const META_KEYS = {
  SOURCE_URL: "source_url",
  SOURCE_TYPE: "source_type",
  CREATED_AT: "created_at",
  CURRENT_USER: "current_user",
  SESSION_TOKEN: "session_token",
  NEEDS_REBUILD: "needs_rebuild",
  SCRAPER_COLLECTOR_ID: "scraper_collector_id",
} as const;

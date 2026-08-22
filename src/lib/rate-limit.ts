import { query, withTransaction } from "./store-pool.js";
import { childLogger } from "./logger.js";

const log = childLogger("rate-limit");

const REFILL_RATE = parseInt(process.env.RATE_LIMIT_REFILL_RATE || "10", 10);
const BURST = parseInt(process.env.RATE_LIMIT_BURST || "100", 10);

export type Endpoint = "crawl" | "index" | "ask";

export async function initBucket(userId: string, endpoint: Endpoint): Promise<void> {
  await query(
    `INSERT INTO rate_limit_buckets (user_id, endpoint, tokens, refilled_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT DO NOTHING`,
    [userId, endpoint, BURST]
  );
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
}

export async function checkRateLimit(userId: string, endpoint: Endpoint): Promise<RateLimitResult> {
  const result = await query(
    `SELECT tokens, refilled_at FROM rate_limit_buckets WHERE user_id = $1 AND endpoint = $2`,
    [userId, endpoint]
  );

  let tokens = result.rows[0]?.tokens ?? BURST;
  if (tokens > 0) {
    const elapsedMinutes = Math.floor((Date.now() - new Date(result.rows[0]?.refilled_at || new Date()).getTime()) / 60000);
    tokens = Math.min(BURST, tokens + elapsedMinutes * REFILL_RATE);
  }

  if (tokens <= 0) {
    const retryAfter = Math.ceil(60 / REFILL_RATE);
    return { allowed: false, remaining: 0, retryAfter };
  }
  return { allowed: true, remaining: tokens - 1 };
}

export async function consumeRateLimit(userId: string, endpoint: Endpoint): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE rate_limit_buckets
       SET tokens = LEAST($3, tokens + floor(extract(epoch from (now() - refilled_at)) / 60) * $4) - 1,
           refilled_at = now()
       WHERE user_id = $1 AND endpoint = $2`,
      [userId, endpoint, BURST, REFILL_RATE]
    );
    if (result.rowCount === 0) {
      await client.query(
        `INSERT INTO rate_limit_buckets (user_id, endpoint, tokens, refilled_at)
         VALUES ($1, $2, $3 - 1, now())`,
        [userId, endpoint, BURST]
      );
    }
  });
}

export async function getBucketStatus(userId: string, endpoint: Endpoint): Promise<{ tokens: number; refilledAt: Date } | null> {
  const result = await query(
    `SELECT tokens, refilled_at FROM rate_limit_buckets WHERE user_id = $1 AND endpoint = $2`,
    [userId, endpoint]
  );
  if (result.rows.length === 0) return null;
  return { tokens: result.rows[0].tokens, refilledAt: result.rows[0].refilled_at };
}
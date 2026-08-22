export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { retries = 3, baseDelayMs = 1000, maxDelayMs = 30_000, timeoutMs = 30_000 } = options;
  let lastError: Error;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs)
        ),
      ]);
    } catch (err) {
      lastError = err as Error;
      if (attempt < retries) {
        const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}
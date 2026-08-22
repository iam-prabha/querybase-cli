export class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly threshold = 5,
    private readonly windowMs = 30_000,
    private readonly resetTimeoutMs = 30_000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailure > this.resetTimeoutMs) {
        this.state = "half-open";
      } else {
        throw new Error("circuit breaker open");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = "open";
    }
  }

  getState() {
    return this.state;
  }
}

export const qdrantBreaker = new CircuitBreaker();
export const embeddingBreaker = new CircuitBreaker();
export const scraperStudioBreaker = new CircuitBreaker();
export const brightDataBreaker = new CircuitBreaker();
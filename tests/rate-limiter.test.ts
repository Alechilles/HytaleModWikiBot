import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../src/services/rate-limiter.js";

describe("InMemoryRateLimiter", () => {
  it("allows calls under the limit", () => {
    const limiter = new InMemoryRateLimiter();

    const first = limiter.take("key", 2, 10, "user");
    const second = limiter.take("key", 2, 10, "user");

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
  });

  it("blocks when limit is exceeded", () => {
    const limiter = new InMemoryRateLimiter();

    limiter.take("key", 1, 10, "user");
    const blocked = limiter.take("key", 1, 10, "user");

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });
});

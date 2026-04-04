import type { RateLimitDecision, RateLimitScope } from "../types/contracts.js";

interface Bucket {
  timestamps: number[];
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  public take(key: string, max: number, windowSeconds: number, scope: RateLimitScope): RateLimitDecision {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const minTimestamp = now - windowMs;

    const bucket = this.buckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((ts) => ts >= minTimestamp);

    if (bucket.timestamps.length >= max) {
      const oldest = bucket.timestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        retryAfterSec,
        scope
      };
    }

    bucket.timestamps.push(now);
    this.buckets.set(key, bucket);

    return {
      allowed: true,
      retryAfterSec: 0,
      scope
    };
  }
}

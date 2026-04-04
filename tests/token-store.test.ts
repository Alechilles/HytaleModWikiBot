import { describe, expect, it, vi } from "vitest";
import { ExpiringTokenStore } from "../src/services/token-store.js";

describe("ExpiringTokenStore", () => {
  it("returns payload before expiration and null after", () => {
    vi.useFakeTimers();
    const store = new ExpiringTokenStore<{ url: string }>(1);

    const token = store.create({ url: "https://example.com" });
    expect(store.get(token)).toEqual({ url: "https://example.com" });

    vi.advanceTimersByTime(1_500);
    expect(store.get(token)).toBeNull();
    vi.useRealTimers();
  });
});

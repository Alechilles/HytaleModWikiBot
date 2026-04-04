import { randomUUID } from "node:crypto";

export class ExpiringTokenStore<TPayload> {
  private readonly store = new Map<string, { payload: TPayload; expiresAt: number }>();

  public constructor(private readonly ttlSeconds: number) {}

  public create(payload: TPayload): string {
    const token = randomUUID().replace(/-/g, "");
    this.store.set(token, {
      payload,
      expiresAt: Date.now() + this.ttlSeconds * 1000
    });
    return token;
  }

  public get(token: string): TPayload | null {
    const entry = this.store.get(token);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(token);
      return null;
    }

    return entry.payload;
  }

  public pruneExpired(): void {
    const now = Date.now();
    for (const [token, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(token);
      }
    }
  }
}

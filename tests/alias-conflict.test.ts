import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { AliasConflictError, AliasRepository } from "../src/db/repositories/alias-repo.js";

describe("AliasRepository", () => {
  it("requires force when alias points to another mod", async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("SELECT mod_slug")) {
          return { rows: [{ mod_slug: "alecs-animal-husbandry" }] };
        }
        throw new Error("Unexpected query path");
      }
    } as unknown as Pool;

    const repo = new AliasRepository(pool);

    await expect(
      repo.setAlias({
        guildId: "1",
        alias: "ah",
        modSlug: "alecs-tamework",
        createdBy: "2",
        force: false
      })
    ).rejects.toBeInstanceOf(AliasConflictError);
  });

  it("allows overwrite when force is true", async () => {
    const calls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes("SELECT mod_slug")) {
          return { rows: [{ mod_slug: "alecs-animal-husbandry" }] };
        }
        return { rows: [], rowCount: 1 };
      }
    } as unknown as Pool;

    const repo = new AliasRepository(pool);

    const result = await repo.setAlias({
      guildId: "1",
      alias: "ah",
      modSlug: "alecs-tamework",
      createdBy: "2",
      force: true
    });

    expect(result.overwritten).toBe(true);
    expect(calls.some((sql) => sql.includes("INSERT INTO guild_settings"))).toBe(true);
  });
});

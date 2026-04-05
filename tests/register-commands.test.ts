import { describe, expect, it } from "vitest";
import { commandRegistrationRoute, parseRegisterCommandsArgs } from "../scripts/register-commands.js";

describe("register-commands argument parsing", () => {
  it("defaults to global scope when no args are provided", () => {
    expect(parseRegisterCommandsArgs([])).toEqual({ scope: "global" });
  });

  it("parses explicit global scope", () => {
    expect(parseRegisterCommandsArgs(["--scope", "global"])).toEqual({ scope: "global" });
  });

  it("parses guild scope with guild id", () => {
    expect(parseRegisterCommandsArgs(["--scope", "guild", "--guild-id", "123456789"])).toEqual({
      scope: "guild",
      guildId: "123456789"
    });
  });

  it("throws when guild scope is missing guild id", () => {
    expect(() => parseRegisterCommandsArgs(["--scope", "guild"])).toThrow(
      "--guild-id is required when --scope guild is used."
    );
  });

  it("throws when unknown arguments are provided", () => {
    expect(() => parseRegisterCommandsArgs(["--unknown"])).toThrow("Unknown argument: --unknown");
  });

  it("throws when scope value is invalid", () => {
    expect(() => parseRegisterCommandsArgs(["--scope", "team"])).toThrow(
      "Invalid --scope value: team. Use `global` or `guild`."
    );
  });
});

describe("register-commands route selection", () => {
  it("uses global application commands route", () => {
    const route = commandRegistrationRoute("111", { scope: "global" });
    expect(route).toBe("/applications/111/commands");
  });

  it("uses guild application commands route", () => {
    const route = commandRegistrationRoute("111", { scope: "guild", guildId: "222" });
    expect(route).toBe("/applications/111/guilds/222/commands");
  });
});

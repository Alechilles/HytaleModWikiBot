import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { wikiCommand } from "../src/discord/command-definitions.js";
import { wikiBotInternals } from "../src/discord/bot.js";

describe("wiki command options", () => {
  it("includes optional mention target user option", () => {
    const json = wikiCommand.toJSON();
    const atOption = json.options?.find((option) => option.name === "at");

    expect(atOption).toBeDefined();
    expect(atOption?.type).toBe(ApplicationCommandOptionType.User);
    expect(atOption?.required).toBe(false);
  });
});

describe("wiki mention response behavior", () => {
  it("forces public visibility when mention target is provided", () => {
    expect(
      wikiBotInternals.resolveWikiResponseVisibility({
        visibilityMode: "ephemeral",
        publicOption: null,
        mentionTargetId: "123"
      })
    ).toBe(true);
  });

  it("keeps existing visibility behavior when no mention target is provided", () => {
    expect(
      wikiBotInternals.resolveWikiResponseVisibility({
        visibilityMode: "ephemeral",
        publicOption: null,
        mentionTargetId: undefined
      })
    ).toBe(false);
    expect(
      wikiBotInternals.resolveWikiResponseVisibility({
        visibilityMode: "ephemeral",
        publicOption: true,
        mentionTargetId: undefined
      })
    ).toBe(true);
  });

  it("prefixes reply content with mention target", () => {
    expect(wikiBotInternals.applyWikiMentionTarget("## Result", "123")).toBe("<@123>\n## Result");
    expect(wikiBotInternals.applyWikiMentionTarget("## Result")).toBe("## Result");
  });
});

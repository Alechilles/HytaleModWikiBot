import {
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder
} from "discord.js";

export const wikiCommand = new SlashCommandBuilder()
  .setName("wiki")
  .setDescription("Look up a Hytale mod wiki page")
  .addStringOption((option) =>
    option
      .setName("query")
      .setDescription("Example: ah beast taming reference")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((option) =>
    option
      .setName("mod")
      .setDescription("Optional mod alias/slug/name")
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addBooleanOption((option) =>
    option
      .setName("public")
      .setDescription("Set true to post publicly in channel")
      .setRequired(false)
  )
  .addUserOption((option) =>
    option
      .setName("at")
      .setDescription("Optional user to mention in the response")
      .setRequired(false)
  )
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

export const wikiAliasCommand = new SlashCommandBuilder()
  .setName("wiki-alias")
  .setDescription("Manage guild wiki aliases")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set")
      .setDescription("Create or update a guild alias")
      .addStringOption((option) => option.setName("alias").setDescription("Alias key, e.g. ah").setRequired(true))
      .addStringOption((option) =>
        option
          .setName("mod")
          .setDescription("Mod alias/slug/name")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addBooleanOption((option) =>
        option
          .setName("force")
          .setDescription("Overwrite if alias already points elsewhere")
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove a guild alias")
      .addStringOption((option) => option.setName("alias").setDescription("Alias key").setRequired(true))
  )
  .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List aliases for this guild"))
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

export const wikiDefaultCommand = new SlashCommandBuilder()
  .setName("wiki-default")
  .setDescription("Manage default mods for /wiki")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add a default mod for non-prefixed /wiki searches")
      .addStringOption((option) =>
        option
          .setName("mod")
          .setDescription("Mod alias/slug/name")
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove one default mod")
      .addStringOption((option) =>
        option
          .setName("mod")
          .setDescription("Mod alias/slug/name")
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List default mods in search order"))
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set")
      .setDescription("Replace defaults with a single default mod")
      .addStringOption((option) =>
        option
          .setName("mod")
          .setDescription("Mod alias/slug/name")
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) => subcommand.setName("clear").setDescription("Clear all default mods"))
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString());

export const wikiConfigCommand = new SlashCommandBuilder()
  .setName("wiki-config")
  .setDescription("Configure guild-level wiki bot settings")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("visibility")
      .setDescription("Set default /wiki response visibility")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Default visibility")
          .setRequired(true)
          .addChoices(
            { name: "ephemeral", value: "ephemeral" },
            { name: "public", value: "public" }
          )
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("embeds")
      .setDescription("Set default link preview behavior")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Enable or disable rich link embeds")
          .setRequired(true)
          .addChoices(
            { name: "enabled", value: "enabled" },
            { name: "disabled", value: "disabled" }
          )
      )
  )
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString());

export const commandDefinitions = [
  wikiCommand.toJSON(),
  wikiAliasCommand.toJSON(),
  wikiDefaultCommand.toJSON(),
  wikiConfigCommand.toJSON()
];

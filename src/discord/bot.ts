import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { AliasConflictError, AliasRepository } from "../db/repositories/alias-repo.js";
import { GuildSettingsRepository } from "../db/repositories/guild-settings-repo.js";
import { QueryLogRepository } from "../db/repositories/query-log-repo.js";
import type { ButtonPayload, EmbedMode, VisibilityMode, WikiLookupResult } from "../types/contracts.js";
import { InMemoryRateLimiter } from "../services/rate-limiter.js";
import { ExpiringTokenStore } from "../services/token-store.js";
import { WikiAutocompleteService } from "../services/wiki-autocomplete.js";
import { WikiLookupService } from "../services/wiki-lookup.js";

interface BotDependencies {
  config: AppConfig;
  logger: Logger;
  aliasRepo: AliasRepository;
  guildSettingsRepo: GuildSettingsRepository;
  queryLogRepo: QueryLogRepository;
  lookupService: WikiLookupService;
  autocompleteService: WikiAutocompleteService;
  rateLimiter: InMemoryRateLimiter;
  buttonTokenStore: ExpiringTokenStore<ButtonPayload>;
}

interface SendableMessageParams {
  content: string;
  attachmentJson?: string;
  attachmentName?: string;
}

export class WikiBot {
  private readonly client: Client;

  public constructor(private readonly deps: BotDependencies) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds]
    });

    this.client.once("ready", () => {
      this.deps.logger.info({ user: this.client.user?.tag }, "Discord client ready");
    });

    this.client.on("interactionCreate", (interaction) => {
      void this.handleInteraction(interaction);
    });

    setInterval(() => {
      this.deps.buttonTokenStore.pruneExpired();
    }, 60_000).unref();
  }

  public async start(): Promise<void> {
    await this.client.login(this.deps.config.DISCORD_TOKEN);
  }

  public async sendMessageToChannel(params: {
    channelId: string;
    content: string;
    attachmentJson?: string;
    attachmentName?: string;
  }): Promise<void> {
    const channel = await this.client.channels.fetch(params.channelId);
    if (!channel || !channel.isSendable()) {
      throw new Error(`Channel ${params.channelId} is not a text-capable Discord channel.`);
    }

    await channel.send(this.buildSendPayload(params));
  }

  public async createCrashThread(params: {
    channelId: string;
    threadName: string;
    openerContent: string;
  }): Promise<{ threadId: string }> {
    const channel = await this.client.channels.fetch(params.channelId);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) ||
      !channel.isSendable() ||
      !("threads" in channel)
    ) {
      throw new Error(`Channel ${params.channelId} cannot create text threads.`);
    }

    const openerMessage = await channel.send({ content: params.openerContent });
    const thread = await channel.threads.create({
      name: params.threadName,
      startMessage: openerMessage.id,
      reason: "Crash telemetry fingerprint thread"
    });

    return { threadId: thread.id };
  }

  public async sendMessageToThread(params: {
    threadId: string;
    content: string;
    attachmentJson?: string;
    attachmentName?: string;
  }): Promise<void> {
    const thread = await this.client.channels.fetch(params.threadId);
    if (!thread || !thread.isThread() || !thread.isTextBased()) {
      throw new Error(`Thread ${params.threadId} is not a text thread channel.`);
    }

    if (thread.archived) {
      await thread.setArchived(false, "Crash telemetry thread reopen");
    }

    if (!thread.isSendable()) {
      throw new Error(`Thread ${params.threadId} is not sendable.`);
    }

    await thread.send(this.buildSendPayload(params));
  }

  private buildSendPayload(params: SendableMessageParams): {
    content: string;
    files?: Array<{ attachment: Buffer; name: string }>;
  } {
    const payload: {
      content: string;
      files?: Array<{ attachment: Buffer; name: string }>;
    } = {
      content: params.content
    };

    if (params.attachmentJson) {
      payload.files = [
        {
          attachment: Buffer.from(params.attachmentJson, "utf8"),
          name: params.attachmentName ?? "tamework-crash-report.json"
        }
      ];
    }

    return payload;
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isAutocomplete()) {
        await this.handleAutocomplete(interaction);
        return;
      }

      if (interaction.isButton()) {
        await this.handleButton(interaction);
        return;
      }

      if (interaction.isChatInputCommand()) {
        await this.handleChatInput(interaction);
      }
    } catch (error) {
      this.deps.logger.error({ err: error }, "Unhandled interaction error");
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Unexpected error while handling the command.",
          ephemeral: true
        });
      }
    }
  }

  private async handleAutocomplete(interaction: ChatInputCommandInteraction<"cached"> | any): Promise<void> {
    if (!interaction.guildId) {
      await interaction.respond([]);
      return;
    }

    const acLimit = this.deps.rateLimiter.take(
      `autocomplete:user:${interaction.user.id}`,
      this.deps.config.RATE_LIMIT_AUTOCOMPLETE_MAX,
      this.deps.config.RATE_LIMIT_AUTOCOMPLETE_WINDOW_SECONDS,
      "autocomplete"
    );

    if (!acLimit.allowed) {
      await interaction.respond([]);
      return;
    }

    const focused = interaction.options.getFocused(true);
    const commandName = interaction.commandName;

    if (focused.name === "mod") {
      const choices = await this.deps.autocompleteService.autocompleteMod(interaction.guildId, String(focused.value));
      await interaction.respond(choices.map((choice) => ({ name: choice.name, value: choice.value })));
      return;
    }

    if (commandName === "wiki" && focused.name === "query") {
      const explicitModInput = interaction.options.getString("mod") ?? undefined;
      const choices = await this.deps.autocompleteService.autocompleteQuery({
        guildId: interaction.guildId,
        typedQuery: String(focused.value),
        explicitModInput
      });

      await interaction.respond(choices.map((choice) => ({ name: choice.name, value: choice.value })));
      return;
    }

    await interaction.respond([]);
  }

  private async handleChatInput(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case "wiki":
        await this.handleWiki(interaction);
        return;
      case "wiki-alias":
        await this.handleWikiAlias(interaction);
        return;
      case "wiki-default":
        await this.handleWikiDefault(interaction);
        return;
      case "wiki-config":
        await this.handleWikiConfig(interaction);
        return;
      default:
        await interaction.reply({
          content: "Unknown command.",
          ephemeral: true
        });
    }
  }

  private async handleWiki(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "This bot only supports guild commands.",
        ephemeral: true
      });
      return;
    }

    const userLimit = this.deps.rateLimiter.take(
      `wiki:user:${interaction.user.id}`,
      this.deps.config.RATE_LIMIT_USER_MAX,
      this.deps.config.RATE_LIMIT_USER_WINDOW_SECONDS,
      "user"
    );

    if (!userLimit.allowed) {
      await interaction.reply({
        content: `Rate limited (${userLimit.scope}). Retry in ${userLimit.retryAfterSec}s.`,
        ephemeral: true
      });
      return;
    }

    const guildLimit = this.deps.rateLimiter.take(
      `wiki:guild:${interaction.guildId}`,
      this.deps.config.RATE_LIMIT_GUILD_MAX,
      this.deps.config.RATE_LIMIT_GUILD_WINDOW_SECONDS,
      "guild"
    );

    if (!guildLimit.allowed) {
      await interaction.reply({
        content: `Guild rate limited. Retry in ${guildLimit.retryAfterSec}s.`,
        ephemeral: true
      });
      return;
    }

    const visibilityMode = await this.deps.guildSettingsRepo.getVisibilityMode(interaction.guildId);
    const embedMode = await this.deps.guildSettingsRepo.getEmbedMode(interaction.guildId);
    const publicOption = interaction.options.getBoolean("public");
    const mentionTarget = interaction.options.getUser("at");
    const mentionTargetId = mentionTarget?.id;
    const isPublic = resolveWikiResponseVisibility({
      visibilityMode,
      publicOption,
      mentionTargetId
    });
    const suppressEmbeds = embedMode === "disabled";

    await interaction.deferReply({ ephemeral: !isPublic });

    const query = interaction.options.getString("query", true);
    const explicitModInput = interaction.options.getString("mod") ?? undefined;
    const startedAt = Date.now();

    const lookupInput =
      explicitModInput === undefined
        ? {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            query
          }
        : {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            query,
            explicitModInput
          };

    const result = await this.deps.lookupService.lookup(lookupInput);

    const response = this.buildLookupMessage(result);

    const replyOptions: {
      content: string;
      components: ActionRowBuilder<ButtonBuilder>[];
      allowedMentions?: { users: string[] };
      flags?: MessageFlags.SuppressEmbeds;
    } = {
      content: applyWikiMentionTarget(response.content, mentionTargetId),
      components: response.components
    };

    if (mentionTargetId) {
      replyOptions.allowedMentions = { users: [mentionTargetId] };
    }

    if (suppressEmbeds) {
      replyOptions.flags = MessageFlags.SuppressEmbeds;
    }

    await interaction.editReply(replyOptions);

    const resolvedPageSlug = response.resolvedUrl ? this.extractPageSlug(response.resolvedUrl) : null;

    await this.deps.queryLogRepo.insert({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      rawQuery: query,
      resolvedModSlug: result.resolvedModSlug,
      resolvedPageSlug,
      outcome: result.status,
      latencyMs: Date.now() - startedAt
    });

    this.deps.logger.info(
      {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        outcome: result.status,
        modSlug: result.resolvedModSlug,
        resolvedUrl: result.resolvedUrl
      },
      "Handled wiki query"
    );
  }

  private async handleWikiAlias(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "This command is only available in guilds.",
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "list") {
      const aliases = await this.deps.aliasRepo.listAliases(interaction.guildId);
      const lines = aliases.length
        ? aliases.map((alias) => `- \`${alias.alias}\` -> \`${alias.modSlug}\``)
        : ["No aliases configured yet."];

      await interaction.reply({
        content: lines.join("\n"),
        ephemeral: true
      });
      return;
    }

    if (!this.hasManageGuild(interaction)) {
      await interaction.reply({
        content: "You need Manage Server to modify aliases.",
        ephemeral: true
      });
      return;
    }

    if (subcommand === "set") {
      const alias = interaction.options.getString("alias", true).toLowerCase();
      const modInput = interaction.options.getString("mod", true);
      const force = interaction.options.getBoolean("force") ?? false;

      const modSlug = await this.deps.lookupService.resolveModIdentifier(interaction.guildId, modInput);
      if (!modSlug) {
        await interaction.reply({
          content: `Could not resolve mod from \`${modInput}\`.`,
          ephemeral: true
        });
        return;
      }

      try {
        const result = await this.deps.aliasRepo.setAlias({
          guildId: interaction.guildId,
          alias,
          modSlug,
          createdBy: interaction.user.id,
          force
        });

        const action = result.created ? "created" : result.overwritten ? "overwritten" : "updated";
        await interaction.reply({
          content: `Alias \`${alias}\` now points to \`${modSlug}\` (${action}).`,
          ephemeral: true
        });
      } catch (error) {
        if (error instanceof AliasConflictError) {
          await interaction.reply({
            content: `${error.message}`,
            ephemeral: true
          });
          return;
        }

        throw error;
      }

      return;
    }

    if (subcommand === "remove") {
      const alias = interaction.options.getString("alias", true).toLowerCase();
      const removed = await this.deps.aliasRepo.removeAlias(interaction.guildId, alias);
      await interaction.reply({
        content: removed ? `Removed alias \`${alias}\`.` : `Alias \`${alias}\` not found.`,
        ephemeral: true
      });
      return;
    }

    await interaction.reply({
      content: "Unsupported wiki-alias subcommand.",
      ephemeral: true
    });
  }

  private async handleWikiDefault(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "This command is only available in guilds.",
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "list") {
      const defaults = await this.deps.guildSettingsRepo.getDefaultModSlugs(interaction.guildId);
      if (defaults.length === 0) {
        await interaction.reply({
          content: "No default mods configured.",
          ephemeral: true
        });
        return;
      }

      await interaction.reply({
        content: defaults.map((mod, index) => `${index + 1}. \`${mod}\``).join("\n"),
        ephemeral: true
      });
      return;
    }

    if (!this.hasManageGuild(interaction)) {
      await interaction.reply({
        content: "You need Manage Server to modify default mod settings.",
        ephemeral: true
      });
      return;
    }

    if (subcommand === "set") {
      const modInput = interaction.options.getString("mod", true);
      const modSlug = await this.deps.lookupService.resolveModIdentifier(interaction.guildId, modInput);
      if (!modSlug) {
        await interaction.reply({
          content: `Could not resolve mod from \`${modInput}\`.`,
          ephemeral: true
        });
        return;
      }

      await this.deps.guildSettingsRepo.setDefaultModSlug(interaction.guildId, modSlug);
      await interaction.reply({
        content: `Default mods replaced with \`${modSlug}\`.`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === "add") {
      const modInput = interaction.options.getString("mod", true);
      const modSlug = await this.deps.lookupService.resolveModIdentifier(interaction.guildId, modInput);
      if (!modSlug) {
        await interaction.reply({
          content: `Could not resolve mod from \`${modInput}\`.`,
          ephemeral: true
        });
        return;
      }

      const addResult = await this.deps.guildSettingsRepo.addDefaultModSlug(interaction.guildId, modSlug);
      await interaction.reply({
        content: addResult.added
          ? `Added \`${modSlug}\` to default search mods.`
          : `\`${modSlug}\` is already in default search mods.`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === "remove") {
      const modInput = interaction.options.getString("mod", true);
      const modSlug = await this.deps.lookupService.resolveModIdentifier(interaction.guildId, modInput);
      if (!modSlug) {
        await interaction.reply({
          content: `Could not resolve mod from \`${modInput}\`.`,
          ephemeral: true
        });
        return;
      }

      const removed = await this.deps.guildSettingsRepo.removeDefaultModSlug(interaction.guildId, modSlug);
      await interaction.reply({
        content: removed
          ? `Removed \`${modSlug}\` from default search mods.`
          : `\`${modSlug}\` was not in default search mods.`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === "clear") {
      await this.deps.guildSettingsRepo.clearDefaultModSlug(interaction.guildId);
      await interaction.reply({
        content: "All default mods cleared.",
        ephemeral: true
      });
      return;
    }

    await interaction.reply({
      content: "Unsupported wiki-default subcommand.",
      ephemeral: true
    });
  }

  private async handleWikiConfig(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "This command is only available in guilds.",
        ephemeral: true
      });
      return;
    }

    if (!this.hasManageGuild(interaction)) {
      await interaction.reply({
        content: "You need Manage Server to modify config settings.",
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "visibility") {
      const mode = interaction.options.getString("mode", true) as VisibilityMode;
      await this.deps.guildSettingsRepo.setVisibilityMode(interaction.guildId, mode);
      await interaction.reply({
        content: `Default /wiki visibility set to \`${mode}\`.`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === "embeds") {
      const mode = interaction.options.getString("mode", true) as EmbedMode;
      await this.deps.guildSettingsRepo.setEmbedMode(interaction.guildId, mode);
      await interaction.reply({
        content: `Default /wiki embed mode set to \`${mode}\`.`,
        ephemeral: true
      });
      return;
    }

    {
      await interaction.reply({
        content: "Unsupported wiki-config subcommand.",
        ephemeral: true
      });
      return;
    }
  }

  private async handleButton(interaction: any): Promise<void> {
    const [action, token] = String(interaction.customId).split(":");
    if (!token) {
      await interaction.reply({
        content: "Invalid action token.",
        ephemeral: true
      });
      return;
    }

    const payload = this.deps.buttonTokenStore.get(token);

    if (!payload) {
      await interaction.reply({
        content: "That action has expired. Re-run /wiki.",
        ephemeral: true
      });
      return;
    }

    const embedMode =
      interaction.guildId != null
        ? await this.deps.guildSettingsRepo.getEmbedMode(interaction.guildId)
        : "disabled";
    const suppressEmbeds = embedMode === "disabled";
    const maybeSuppressFlags = suppressEmbeds ? MessageFlags.SuppressEmbeds : undefined;

    if (action === "copy") {
      if (!payload.url) {
        await interaction.reply({
          content: "No URL available to copy for this result.",
          ephemeral: true
        });
        return;
      }

      await interaction.reply({
        content: `\`${payload.url}\``,
        ephemeral: true,
        flags: maybeSuppressFlags
      });
      return;
    }

    if (action === "matches") {
      if (!payload.candidates.length) {
        await interaction.reply({
          content: "No alternate matches were available.",
          ephemeral: true
        });
        return;
      }

      const lines = payload.candidates.map(
        (candidate) => `### ${this.markdownLink(candidate.title, candidate.url)}`
      );

      await interaction.reply({
        content: `## Other matches:\n${lines.join("\n")}`,
        ephemeral: true,
        flags: maybeSuppressFlags
      });
      return;
    }

    await interaction.reply({
      content: "Unknown button action.",
      ephemeral: true
    });
  }

  private buildLookupMessage(result: WikiLookupResult): {
    content: string;
    components: ActionRowBuilder<ButtonBuilder>[];
    resolvedUrl: string | null;
  } {
    const lines: string[] = [];
    let url = result.resolvedUrl;

    switch (result.status) {
      case "found":
        if (url && result.resolvedTitle) {
          lines.push(`## ${this.markdownLink(result.resolvedTitle, url)}`);
        } else if (url) {
          lines.push(`## ${url}`);
        } else {
          lines.push(result.explanation);
        }
        break;
      case "did_you_mean":
        if (url && result.resolvedTitle) {
          lines.push(`## Did you mean ${this.markdownLink(result.resolvedTitle, url)}?`);
        } else if (url) {
          lines.push(`## Did you mean ${url}?`);
        } else {
          lines.push(result.explanation);
        }
        break;
      case "no_match":
        lines.push("No exact match found.");
        if (result.candidates.length) {
          lines.push(
            "## Other matches:\n" +
              result.candidates.map((candidate) => `### ${this.markdownLink(candidate.title, candidate.url)}`).join("\n")
          );
        }
        break;
      default:
        lines.push(result.explanation);
    }

    const payload: ButtonPayload = {
      url: url ?? "",
      candidates: result.candidates,
      createdAt: Date.now()
    };
    const token = this.deps.buttonTokenStore.create(payload);

    const row = new ActionRowBuilder<ButtonBuilder>();
    if (url) {
      row.addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open").setURL(url),
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Copy URL").setCustomId(`copy:${token}`)
      );
    }

    if (result.candidates.length > 0) {
      row.addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Other matches").setCustomId(`matches:${token}`)
      );
    }

    return {
      content: lines.join("\n\n"),
      components: row.components.length > 0 ? [row] : [],
      resolvedUrl: result.resolvedUrl
    };
  }

  private extractPageSlug(url: string): string | null {
    const parts = url.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    return parts[parts.length - 1] ?? null;
  }

  private hasManageGuild(interaction: ChatInputCommandInteraction): boolean {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  }

  private markdownLink(title: string, url: string): string {
    const safeTitle = title.replace(/]/g, "\\]");
    return `[${safeTitle}](${url})`;
  }
}

function resolveWikiResponseVisibility(params: {
  visibilityMode: VisibilityMode;
  publicOption: boolean | null;
  mentionTargetId: string | undefined;
}): boolean {
  if (params.mentionTargetId) {
    return true;
  }

  return params.publicOption ?? params.visibilityMode === "public";
}

function applyWikiMentionTarget(content: string, mentionTargetId?: string): string {
  if (!mentionTargetId) {
    return content;
  }

  return `<@${mentionTargetId}>\n${content}`;
}

export const wikiBotInternals = {
  resolveWikiResponseVisibility,
  applyWikiMentionTarget
};

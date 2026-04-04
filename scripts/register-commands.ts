import "dotenv/config";
import { REST, Routes } from "discord.js";
import { loadConfig } from "../src/config.js";
import { commandDefinitions } from "../src/discord/command-definitions.js";

async function main() {
  const config = loadConfig(process.env);

  if (!config.DISCORD_GUILD_ID) {
    throw new Error("DISCORD_GUILD_ID is required for register:commands");
  }

  const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);

  await rest.put(Routes.applicationGuildCommands(config.DISCORD_APPLICATION_ID, config.DISCORD_GUILD_ID), {
    body: commandDefinitions
  });

  // eslint-disable-next-line no-console
  console.log(`Registered ${commandDefinitions.length} guild commands to ${config.DISCORD_GUILD_ID}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});

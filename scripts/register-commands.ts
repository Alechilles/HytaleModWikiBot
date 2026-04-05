import "dotenv/config";
import { pathToFileURL } from "node:url";
import { REST, Routes } from "discord.js";
import { z } from "zod";
import { commandDefinitions } from "../src/discord/command-definitions.js";

type RegistrationScope = "global" | "guild";

export type RegisterCommandsArgs =
  | { scope: "global" }
  | { scope: "guild"; guildId: string };

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1)
});

export function parseRegisterCommandsArgs(argv: string[]): RegisterCommandsArgs {
  let scope: RegistrationScope = "global";
  let guildId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--scope") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --scope. Use `global` or `guild`.");
      }

      if (value !== "global" && value !== "guild") {
        throw new Error(`Invalid --scope value: ${value}. Use \`global\` or \`guild\`.`);
      }

      scope = value;
      i += 1;
      continue;
    }

    if (arg === "--guild-id") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --guild-id.");
      }

      guildId = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (scope === "guild") {
    if (!guildId) {
      throw new Error("--guild-id is required when --scope guild is used.");
    }

    return { scope, guildId };
  }

  if (guildId) {
    throw new Error("--guild-id can only be used with --scope guild.");
  }

  return { scope };
}

export function commandRegistrationRoute(applicationId: string, args: RegisterCommandsArgs): `/${string}` {
  return args.scope === "global"
    ? Routes.applicationCommands(applicationId)
    : Routes.applicationGuildCommands(applicationId, args.guildId);
}

export async function runRegisterCommands(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const config = envSchema.parse(env);
  const args = parseRegisterCommandsArgs(argv);
  const route = commandRegistrationRoute(config.DISCORD_APPLICATION_ID, args);

  const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
  await rest.put(route, { body: commandDefinitions });

  const target = args.scope === "global" ? "global scope" : `guild ${args.guildId}`;
  // eslint-disable-next-line no-console
  console.log(`Registered ${commandDefinitions.length} commands to ${target}`);
}

async function main() {
  await runRegisterCommands(process.argv.slice(2), process.env);
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}

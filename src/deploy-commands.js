const { REST, Routes } = require("discord.js");
const config = require("./config");
const commands = require("./commands");

async function main() {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const payload = commands.map((command) => command.data.toJSON());

  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: payload },
  );

  console.log(`Registered ${payload.length} slash commands for guild ${config.guildId}.`);
}

main().catch((error) => {
  console.error("Failed to deploy slash commands:", error);
  process.exitCode = 1;
});


const { Client, Collection, Events, GatewayIntentBits } = require("discord.js");
const config = require("./config");
const commands = require("./commands");
const { HistoryStore } = require("./history/history-store");
const { createDisTube } = require("./player/create-distube");
const { PlayerCardManager } = require("./player/player-card-manager");
const { PlayerService } = require("./player/player-service");
const { respond } = require("./ui/interaction");

async function main() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.commands = new Collection();
  for (const command of commands) {
    client.commands.set(command.data.name, command);
  }

  const distube = createDisTube(client, config);
  const playerCards = new PlayerCardManager(client);
  const historyStore = new HistoryStore();
  await historyStore.load();

  const services = {
    player: new PlayerService({ client, distube, playerCards, historyStore }),
  };

  services.player.bindEvents();

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) {
          return respond(interaction, "That command is not registered.");
        }

        await command.execute(interaction, services);
        return;
      }

      if (interaction.isButton()) {
        await services.player.handleButton(interaction);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        await services.player.handleSelectMenu(interaction);
      }
    } catch (error) {
      console.error("Interaction handling failed:", error);
      await respond(interaction, "Something went wrong while handling that interaction.");
    }
  });

  let isShuttingDown = false;
  const shutdown = async (signal) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    console.log(`${signal} received. Saving playback history before exit...`);

    try {
      await services.player.shutdown();
    } catch (error) {
      console.warn("Failed to save playback history during shutdown:", error);
    }

    client.destroy();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").finally(() => process.exit(0));
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").finally(() => process.exit(0));
  });

  await client.login(config.discordToken);
}

main().catch((error) => {
  console.error("Bot startup failed:", error);
  process.exitCode = 1;
});

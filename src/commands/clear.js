const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Remove every upcoming song but keep the current one playing."),
  async execute(interaction, services) {
    return services.player.clear(interaction);
  },
};


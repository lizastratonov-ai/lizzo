const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("Show songs played in this server during the last 30 days."),
  async execute(interaction, services) {
    return services.player.showHistory(interaction);
  },
};

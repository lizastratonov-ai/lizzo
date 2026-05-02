const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("player")
    .setDescription("Redisplay the shared player in this channel."),
  async execute(interaction, services) {
    return services.player.showPlayer(interaction);
  },
};

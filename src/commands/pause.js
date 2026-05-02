const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the current song."),
  async execute(interaction, services) {
    return services.player.pause(interaction);
  },
};


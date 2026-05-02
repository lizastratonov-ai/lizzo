const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song."),
  async execute(interaction, services) {
    return services.player.skip(interaction);
  },
};


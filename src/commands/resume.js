const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume a paused song."),
  async execute(interaction, services) {
    return services.player.resume(interaction);
  },
};


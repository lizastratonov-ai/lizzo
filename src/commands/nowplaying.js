const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the song that is currently playing."),
  async execute(interaction, services) {
    return services.player.showNowPlaying(interaction);
  },
};


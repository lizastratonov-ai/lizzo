const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current song and the next 10 queued tracks."),
  async execute(interaction, services) {
    return services.player.showQueue(interaction);
  },
};


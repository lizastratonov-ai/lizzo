const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Shuffle the upcoming songs."),
  async execute(interaction, services) {
    return services.player.shuffle(interaction);
  },
};


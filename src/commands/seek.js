const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Jump to a timestamp in the current song.")
    .addStringOption((option) =>
      option
        .setName("time")
        .setDescription("Examples: 1:30, 12:05, 01:02:03")
        .setRequired(true),
    ),
  async execute(interaction, services) {
    const time = interaction.options.getString("time", true);
    return services.player.seek(interaction, time);
  },
};


const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove one upcoming song from the queue.")
    .addIntegerOption((option) =>
      option
        .setName("index")
        .setDescription("The upcoming queue position, starting at 1")
        .setRequired(true)
        .setMinValue(1),
    ),
  async execute(interaction, services) {
    const index = interaction.options.getInteger("index", true);
    return services.player.remove(interaction, index);
  },
};


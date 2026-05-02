const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Disconnect the bot from voice."),
  async execute(interaction, services) {
    return services.player.leave(interaction);
  },
};


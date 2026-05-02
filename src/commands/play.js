const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Search for a song or paste a YouTube, SoundCloud, or Spotify track link.")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("A search phrase or a direct link to a song")
        .setRequired(true),
    )
    .addBooleanOption((option) =>
      option
        .setName("use_link_timestamp")
        .setDescription("For YouTube links with a saved time, keep it instead of starting at 0:00"),
    ),
  async execute(interaction, services) {
    const query = interaction.options.getString("query", true);
    const useLinkTimestamp = interaction.options.getBoolean("use_link_timestamp");
    return services.player.play(interaction, query, { useLinkTimestamp });
  },
};

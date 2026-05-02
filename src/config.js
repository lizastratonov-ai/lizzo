const dotenv = require("dotenv");

dotenv.config();

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getOptionalEnv(name) {
  const value = process.env[name];
  return value ? value.trim() : undefined;
}

module.exports = {
  discordToken: getRequiredEnv("DISCORD_TOKEN"),
  clientId: getRequiredEnv("CLIENT_ID"),
  guildId: getRequiredEnv("GUILD_ID"),
  spotifyClientId: getOptionalEnv("SPOTIFY_CLIENT_ID"),
  spotifyClientSecret: getOptionalEnv("SPOTIFY_CLIENT_SECRET"),
  spotifyTopTracksCountry: getOptionalEnv("SPOTIFY_TOP_TRACKS_COUNTRY") || "US",
  soundCloudClientId: getOptionalEnv("SOUNDCLOUD_CLIENT_ID"),
  soundCloudOauthToken: getOptionalEnv("SOUNDCLOUD_OAUTH_TOKEN"),
};


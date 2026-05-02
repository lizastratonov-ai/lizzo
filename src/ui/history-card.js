const { EmbedBuilder } = require("discord.js");
const { HISTORY_RETENTION_DAYS } = require("../history/history-store");
const { formatDateTime } = require("../utils/time");

const MAX_EMBEDS = 10;
const MAX_DESCRIPTION_LENGTH = 4000;

function truncate(text, maxLength = 120) {
  if (!text) {
    return "Unknown title";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}...`;
}

function formatRequester(userId) {
  return userId ? `<@${userId}>` : "Unknown";
}

function formatSource(source) {
  const normalized = String(source || "unknown").toLowerCase();
  const labels = {
    spotify: "Spotify",
    youtube: "YouTube",
    soundcloud: "SoundCloud",
  };

  return labels[normalized] || normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function buildHistoryLine(entry, index) {
  return `**${index}.** ${truncate(entry.title)} | queued by ${formatRequester(entry.userId)} | ${formatSource(entry.source)} | queued ${formatDateTime(entry.queuedAtMs)}`;
}

function createHistoryEmbed({ guildName, chunk, page, totalPages, shownEntries, totalEntries, isTruncated }) {
  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle(totalPages > 1 ? `Playback History (${page}/${totalPages})` : "Playback History")
    .setDescription(chunk.join("\n"))
    .setFooter({
      text: isTruncated
        ? `Showing ${shownEntries} of ${totalEntries} song(s) from the last ${HISTORY_RETENTION_DAYS} days, newest first.`
        : `Showing all ${totalEntries} song(s) from the last ${HISTORY_RETENTION_DAYS} days, newest first.`,
    });

  if (guildName) {
    embed.setAuthor({ name: guildName });
  }

  return embed;
}

function buildHistoryEmbeds(guildName, entries) {
  if (!entries.length) {
    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle("Playback History")
      .setDescription("Nothing has started playing in this server in the last 30 days.")
      .setFooter({ text: "The bot keeps playback history for 30 days and saves it across restarts." });

    if (guildName) {
      embed.setAuthor({ name: guildName });
    }

    return [embed];
  }

  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;
  let shownEntries = 0;
  let truncated = false;

  for (const [index, entry] of entries.entries()) {
    const line = buildHistoryLine(entry, index + 1);
    const separatorLength = currentChunk.length > 0 ? 1 : 0;

    if (currentChunk.length > 0 && (currentLength + separatorLength + line.length) > MAX_DESCRIPTION_LENGTH) {
      chunks.push(currentChunk);
      if (chunks.length >= MAX_EMBEDS) {
        truncated = true;
        break;
      }

      currentChunk = [];
      currentLength = 0;
    }

    currentChunk.push(line);
    currentLength += (currentChunk.length > 1 ? 1 : 0) + line.length;
    shownEntries += 1;
  }

  if (!truncated && currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks.map((chunk, chunkIndex) => createHistoryEmbed({
    guildName,
    chunk,
    page: chunkIndex + 1,
    totalPages: chunks.length,
    shownEntries,
    totalEntries: entries.length,
    isTruncated: truncated,
  }));
}

module.exports = {
  buildHistoryEmbeds,
};

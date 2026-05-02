const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");
const { formatTimestamp } = require("../utils/time");

const QUEUE_PAGE_SIZE = 5;

const BUTTON_IDS = {
  back10: "player:seek:-10",
  forward10: "player:seek:10",
  pauseResume: "player:pause-resume",
  skip: "player:skip",
  stop: "player:stop",
  loopMenu: "player:loop-menu",
  showQueue: "player:show-queue",
  backToPlayer: "queue:back-to-player",
  queuePrevPage: "queue:page:prev",
  queueNextPage: "queue:page:next",
  queueMoveUp: "queue:move:up",
  queueMoveDown: "queue:move:down",
  queueMoveTop: "queue:move:top",
  queueRemove: "queue:remove",
};

const SELECT_IDS = {
  loopMode: "player:loop-mode",
  queueSong: "queue:select-song",
};

const SOURCE_COLORS = {
  spotify: {
    active: 0x1db954,
    paused: 0x15803d,
  },
  youtube: {
    active: 0xef4444,
    paused: 0xb91c1c,
  },
  soundcloud: {
    active: 0xf97316,
    paused: 0xc2410c,
  },
  default: {
    active: 0x3b82f6,
    paused: 0x64748b,
  },
};

function truncate(text, maxLength = 60) {
  if (!text) {
    return "Unknown title";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}...`;
}

function formatSongLink(song) {
  const title = truncate(song?.name);
  return song?.url ? `[${title}](${song.url})` : title;
}

function formatSongRequester(song) {
  return song?.user ? `<@${song.user.id}>` : "Unknown";
}

function normalizeSource(source) {
  return String(source || "").toLowerCase();
}

function formatSource(source) {
  const normalized = normalizeSource(source);
  const labels = {
    youtube: "YouTube",
    soundcloud: "SoundCloud",
    spotify: "Spotify",
  };

  return labels[normalized] || (normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Unknown");
}

function getArtworkURL(song) {
  const source = normalizeSource(song?.source);

  if (source === "spotify") {
    return song?.thumbnail || null;
  }

  if (source === "youtube") {
    return song?.thumbnail || null;
  }

  if (source === "soundcloud") {
    return song?.thumbnail || null;
  }

  return song?.thumbnail || song?.stream?.song?.thumbnail || null;
}

function applyArtworkThumbnail(embed, song) {
  const artworkUrl = getArtworkURL(song);
  if (artworkUrl) {
    embed.setThumbnail(artworkUrl);
  }

  return embed;
}

function getPlayerColor(queue, song) {
  const palette = SOURCE_COLORS[normalizeSource(song?.source)] || SOURCE_COLORS.default;
  return queue.paused ? palette.paused : palette.active;
}

function getLastActionText(queue) {
  return queue?.__playerActivity?.text || "No recent queue actions yet.";
}

function getSongStartLabel(song) {
  const startTimeSeconds = Number(song?.metadata?.youtubeStartTimeSeconds);
  if (!Number.isFinite(startTimeSeconds) || startTimeSeconds <= 0) {
    return null;
  }

  return `Starts at ${formatTimestamp(startTimeSeconds)}`;
}

function getLoopState(queue, song = queue?.songs?.[0]) {
  const state = queue?.__finiteSongLoop;
  if (!state || state.songRef !== song) {
    return {
      remaining: 0,
      infinite: false,
    };
  }

  if (state.infinite) {
    return {
      remaining: 0,
      infinite: true,
    };
  }

  const remaining = Number(state.remaining);
  return {
    remaining: Number.isInteger(remaining) && remaining > 0 ? Math.min(remaining, 3) : 0,
    infinite: false,
  };
}

function getLoopModeValue(queue, song = queue?.songs?.[0]) {
  const loopState = getLoopState(queue, song);

  if (loopState.infinite) {
    return "infinite";
  }

  if (loopState.remaining >= 1 && loopState.remaining <= 3) {
    return String(loopState.remaining);
  }

  return "off";
}

function formatLoopFieldValue(queue, song = queue?.songs?.[0]) {
  const loopState = getLoopState(queue, song);

  if (loopState.infinite) {
    return "Infinite";
  }

  if (loopState.remaining > 0) {
    return `x${loopState.remaining}`;
  }

  return "Off";
}

function formatLoopButtonLabel(queue, song = queue?.songs?.[0]) {
  const loopState = getLoopState(queue, song);
  const loopIcon = "\u{1F501}";
  const infinitySymbol = "\u221E";

  if (loopState.infinite) {
    return `${loopIcon} ${infinitySymbol}`;
  }

  if (loopState.remaining > 0) {
    return `${loopIcon} x${loopState.remaining}`;
  }

  return `${loopIcon} Off`;
}

function getLoopButtonStyle(queue, song = queue?.songs?.[0]) {
  const loopState = getLoopState(queue, song);
  return loopState.infinite || loopState.remaining > 0 ? ButtonStyle.Success : ButtonStyle.Secondary;
}

function formatQueueSize(queue) {
  return `${queue.songs.length} track${queue.songs.length === 1 ? "" : "s"}`;
}

function formatCompactQueueLine(song, index) {
  return `${index}. ${formatSongLink(song)} | ${song.formattedDuration} | ${formatSongRequester(song)}`;
}

function formatDetailedQueueLine(song, index) {
  const startLabel = getSongStartLabel(song);
  return `${index}. ${formatSongLink(song)}${startLabel ? ` | ${startLabel}` : ""} | ${song.formattedDuration} | queued by ${formatSongRequester(song)}`;
}

function createPlaybackButtonRow(options = {}) {
  const {
    queue = null,
    paused = false,
    disabled = false,
    seekDisabled = false,
  } = options;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.pauseResume)
      .setLabel(paused ? "Resume" : "Pause")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.skip)
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.back10)
      .setLabel("-10s")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || seekDisabled),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.loopMenu)
      .setLabel(formatLoopButtonLabel(queue))
      .setStyle(getLoopButtonStyle(queue))
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.forward10)
      .setLabel("+10s")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || seekDisabled),
  );
}

function createUtilityRow(options = {}) {
  const { disabled = false } = options;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.stop)
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.showQueue)
      .setLabel("Show Queue")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

function buildLoopModeSelectRow(queue) {
  const currentValue = getLoopModeValue(queue);

  const select = new StringSelectMenuBuilder()
    .setCustomId(SELECT_IDS.loopMode)
    .setPlaceholder("Choose a loop mode")
    .addOptions(
      {
        label: "Off",
        value: "off",
        description: "Play the current track normally without replays.",
        default: currentValue === "off",
      },
      {
        label: "Loop once",
        value: "1",
        description: "Replay the current track 1 additional time.",
        default: currentValue === "1",
      },
      {
        label: "Loop twice",
        value: "2",
        description: "Replay the current track 2 additional times.",
        default: currentValue === "2",
      },
      {
        label: "Loop three times",
        value: "3",
        description: "Replay the current track 3 additional times.",
        default: currentValue === "3",
      },
      {
        label: "Loop infinitely",
        value: "infinite",
        description: "Keep replaying this track until you change it.",
        default: currentValue === "infinite",
      },
    );

  return new ActionRowBuilder().addComponents(select);
}

function getQueueManagerPage(queue, queuePage = 0) {
  const upcomingCount = Math.max(queue.songs.length - 1, 0);
  const totalPages = Math.max(1, Math.ceil(upcomingCount / QUEUE_PAGE_SIZE));
  const page = Math.min(Math.max(queuePage, 0), totalPages - 1);
  const pageStart = page * QUEUE_PAGE_SIZE;
  const visibleSongs = queue.songs.slice(pageStart + 1, pageStart + 1 + QUEUE_PAGE_SIZE);

  return {
    page,
    pageStart,
    totalPages,
    upcomingCount,
    visibleSongs,
  };
}

function createQueueSongSelect(queue, viewState) {
  const pageInfo = getQueueManagerPage(queue, viewState.queuePage);

  const select = new StringSelectMenuBuilder()
    .setCustomId(SELECT_IDS.queueSong)
    .setPlaceholder(pageInfo.upcomingCount > 0 ? "Choose a queued song" : "No upcoming songs")
    .setDisabled(pageInfo.upcomingCount === 0);

  if (pageInfo.upcomingCount === 0) {
    select.addOptions({
      label: "No upcoming songs",
      value: "queue:none",
      description: "Add more songs with /play to manage the queue here.",
    });
  } else {
    select.addOptions(
      pageInfo.visibleSongs.map((song, index) => {
        const absoluteIndex = pageInfo.pageStart + index + 1;
        const requestedBy = song.user?.username ? `Requested by ${song.user.username}` : "Queued track";

        return {
          label: `${absoluteIndex}. ${truncate(song.name, 90)}`,
          value: String(absoluteIndex),
          description: truncate(`${song.formattedDuration} - ${requestedBy}`, 100),
          default: absoluteIndex === viewState.selectedIndex,
        };
      }),
    );
  }

  return new ActionRowBuilder().addComponents(select);
}

function createQueueActionRow(queue, selectedIndex) {
  const lastUpcomingIndex = queue.songs.length - 1;
  const hasUpcomingSongs = lastUpcomingIndex >= 1;
  const hasSelection = hasUpcomingSongs && Number.isInteger(selectedIndex);

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.queueMoveUp)
      .setLabel("Move Up")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSelection || selectedIndex <= 1),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.queueMoveDown)
      .setLabel("Move Down")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSelection || selectedIndex >= lastUpcomingIndex),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.queueMoveTop)
      .setLabel("Move To Top")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasSelection || selectedIndex <= 1),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.queueRemove)
      .setLabel("Remove")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasSelection),
  );
}

function createQueueNavigationRow(pageInfo) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.queuePrevPage)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageInfo.upcomingCount === 0 || pageInfo.page === 0),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.queueNextPage)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageInfo.upcomingCount === 0 || pageInfo.page >= pageInfo.totalPages - 1),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.backToPlayer)
      .setLabel("Back To Player")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildNowPlayingEmbed(queue) {
  const song = queue.songs[0];
  const upcomingSongs = queue.songs.slice(1, 4);
  const hiddenCount = Math.max(queue.songs.length - 4, 0);
  const timeText = song.isLive ? "LIVE" : `${queue.formattedCurrentTime} / ${song.formattedDuration}`;
  const detailParts = [
    queue.paused ? "Paused" : "Playing",
    timeText,
  ];
  const sourceParts = [formatSource(song.source)];
  const startLabel = getSongStartLabel(song);

  if (startLabel) {
    sourceParts.push(startLabel);
  }

  const descriptionLines = [
    detailParts.join(" | "),
    sourceParts.join(" | "),
    "",
  ];

  if (upcomingSongs.length > 0) {
    descriptionLines.push("**Up Next**");

    for (const [index, upcomingSong] of upcomingSongs.entries()) {
      descriptionLines.push(formatCompactQueueLine(upcomingSong, index + 1));
    }

    if (hiddenCount > 0) {
      descriptionLines.push(`+${hiddenCount} more not shown`);
    }
  } else {
    descriptionLines.push("*Nothing else is queued.*");
  }

  descriptionLines.push("");
  descriptionLines.push(`*Last action:* ${getLastActionText(queue)}`);

  const embed = new EmbedBuilder()
    .setColor(getPlayerColor(queue, song))
    .setAuthor({ name: queue.paused ? "Player Paused" : "Now Playing" })
    .setTitle(truncate(song.name, 256))
    .setDescription(descriptionLines.join("\n"))
    .addFields(
      { name: "Requested By", value: formatSongRequester(song), inline: true },
      { name: "Queue Size", value: formatQueueSize(queue), inline: true },
      { name: "Loop", value: formatLoopFieldValue(queue, song), inline: true },
    )
    .setFooter({ text: "Use Show Queue to manage upcoming songs, or /queue for a read-only list." });

  if (song.url) {
    embed.setURL(song.url);
  }

  return applyArtworkThumbnail(embed, song);
}

function buildNowPlayingEmbeds(queue) {
  return [buildNowPlayingEmbed(queue)];
}

function buildQueueEmbed(queue) {
  const currentSong = queue.songs[0];
  const upcomingSongs = queue.songs.slice(1, 11);
  const hiddenCount = Math.max(queue.songs.length - 11, 0);
  const descriptionLines = [
    "**Current**",
    `${formatSongLink(currentSong)} | ${queue.formattedCurrentTime} / ${currentSong.formattedDuration}`,
    "",
  ];

  if (upcomingSongs.length === 0) {
    descriptionLines.push("No songs are queued after the current one.");
  } else {
    descriptionLines.push("**Up Next**");

    for (const [index, song] of upcomingSongs.entries()) {
      descriptionLines.push(formatDetailedQueueLine(song, index + 1));
    }

    if (hiddenCount > 0) {
      descriptionLines.push(`+${hiddenCount} more not shown`);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(getPlayerColor(queue, currentSong))
    .setTitle("Queue")
    .setDescription(descriptionLines.join("\n"))
    .addFields(
      { name: "Queue Size", value: formatQueueSize(queue), inline: true },
      { name: "Loop", value: formatLoopFieldValue(queue, currentSong), inline: true },
      { name: "Last Action", value: getLastActionText(queue), inline: false },
    );

  return applyArtworkThumbnail(embed, currentSong);
}

function buildQueueEmbeds(queue) {
  return [buildQueueEmbed(queue)];
}

function buildQueueManagerEmbed(queue, viewState) {
  const currentSong = queue.songs[0];
  const pageInfo = getQueueManagerPage(queue, viewState.queuePage);
  const hiddenCount = Math.max(pageInfo.upcomingCount - pageInfo.pageStart - pageInfo.visibleSongs.length, 0);

  const descriptionLines = [
    "**Current Song**",
    `${formatSongLink(currentSong)} | ${queue.formattedCurrentTime} / ${currentSong.formattedDuration}`,
    "",
    `**Upcoming Songs (Page ${pageInfo.page + 1}/${pageInfo.totalPages})**`,
  ];

  if (pageInfo.visibleSongs.length === 0) {
    descriptionLines.push("No songs are queued after the current one.");
  } else {
    for (const [index, song] of pageInfo.visibleSongs.entries()) {
      const absoluteIndex = pageInfo.pageStart + index + 1;
      const marker = absoluteIndex === viewState.selectedIndex ? "[Selected] " : "";
      descriptionLines.push(`${marker}${formatDetailedQueueLine(song, absoluteIndex)}`);
    }

    if (hiddenCount > 0) {
      descriptionLines.push(`+${hiddenCount} more not shown`);
    }
  }

  const selectedLabel =
    Number.isInteger(viewState.selectedIndex) && viewState.selectedIndex > 0
      ? `#${viewState.selectedIndex}`
      : "None";

  const embed = new EmbedBuilder()
    .setColor(getPlayerColor(queue, currentSong))
    .setTitle("Queue Manager")
    .setDescription(descriptionLines.join("\n"))
    .addFields(
      { name: "Loop", value: formatLoopFieldValue(queue, currentSong), inline: true },
      { name: "Upcoming", value: `${pageInfo.upcomingCount}`, inline: true },
      { name: "Selected", value: selectedLabel, inline: true },
      { name: "Last Action", value: getLastActionText(queue), inline: false },
    )
    .setFooter({ text: "Choose a visible song below, then move it or remove it." });

  return applyArtworkThumbnail(embed, currentSong);
}

function buildQueueManagerEmbeds(queue, viewState) {
  return [buildQueueManagerEmbed(queue, viewState)];
}

function buildIdlePlayerCard({ guildName, reason }) {
  const embed = new EmbedBuilder()
    .setColor(0x64748b)
    .setTitle(guildName ? `${guildName} Player` : "Player Idle")
    .setDescription(reason || "Nothing is playing right now. Use /play to start music.")
    .setFooter({ text: "The shared player message will update when music starts again." });

  return {
    embeds: [embed],
    components: [
      createPlaybackButtonRow({ disabled: true, seekDisabled: true }),
      createUtilityRow({ disabled: true }),
    ],
  };
}

function buildMovedPlayerCard({ channelId }) {
  const embed = new EmbedBuilder()
    .setColor(0x64748b)
    .setTitle("Player Moved")
    .setDescription(`The shared player was moved to <#${channelId}>.`)
    .setFooter({ text: "Use /player in another channel if you want to move it again." });

  return {
    embeds: [embed],
    components: [
      createPlaybackButtonRow({ disabled: true, seekDisabled: true }),
      createUtilityRow({ disabled: true }),
    ],
  };
}

function buildActivePlayerCard(queue) {
  return {
    embeds: buildNowPlayingEmbeds(queue),
    components: [
      createPlaybackButtonRow({ queue, paused: queue.paused, seekDisabled: queue.songs[0]?.isLive }),
      createUtilityRow(),
    ],
  };
}

function buildQueueManagerCard(queue, viewState) {
  const pageInfo = getQueueManagerPage(queue, viewState.queuePage);

  return {
    embeds: buildQueueManagerEmbeds(queue, viewState),
    components: [
      createQueueSongSelect(queue, viewState),
      createQueueActionRow(queue, viewState.selectedIndex),
      createQueueNavigationRow(pageInfo),
    ],
  };
}

module.exports = {
  BUTTON_IDS,
  QUEUE_PAGE_SIZE,
  SELECT_IDS,
  buildActivePlayerCard,
  buildIdlePlayerCard,
  buildLoopModeSelectRow,
  buildMovedPlayerCard,
  buildQueueManagerCard,
  buildNowPlayingEmbed,
  buildNowPlayingEmbeds,
  buildQueueEmbed,
  buildQueueEmbeds,
  formatSource,
};

const { DisTubeStream, RepeatMode } = require("distube");
const {
  BUTTON_IDS,
  SELECT_IDS,
  buildLoopModeSelectRow,
  buildNowPlayingEmbeds,
  buildQueueEmbeds,
} = require("../ui/player-card");
const { buildHistoryEmbeds } = require("../ui/history-card");
const { deferEphemeral, respond } = require("../ui/interaction");
const { formatTimestamp, parseTimestamp } = require("../utils/time");
const { extractYouTubeStartInfo } = require("../utils/youtube");

const LEGACY_LOOP_BUTTON_ID = "player:loop-cycle";
const MAX_SONG_LOOP_REPEATS = 3;
const MAX_FFMPEG_DEBUG_LINES = 25;
const PLAYER_PROGRESS_REFRESH_MS = 3000;
const SPOTIFY_RETRY_STARTUP_WINDOW_SECONDS = 3;

class PlayerService {
  constructor({ client, distube, playerCards, historyStore }) {
    this.client = client;
    this.distube = distube;
    this.playerCards = playerCards;
    this.historyStore = historyStore;
    this.ffmpegDebugBuffers = new Map();
    this.progressTickerHandles = new Map();
    this.progressTickerBusyGuilds = new Set();
  }

  bindEvents() {
    this.distube.on("playSong", (queue, song) => {
      this.#startFfmpegDebugBuffer(queue.id, song);
      song.__playStartedAtMs = Date.now();
      this.#syncFiniteSongLoop(queue, song);
      this.#recordSongInHistory(queue, song);
      this.#startProgressTicker(queue.id);
      void this.#handlePlaySong(queue);
    });
    this.distube.on("ffmpegDebug", (debugLine) => this.#recordFfmpegDebugLine(debugLine));
    this.distube.on("finishSong", (queue, song) => this.#handleSongFinish(queue, song));
    this.distube.on("addSong", (queue) => this.#renderQueueCard(queue));
    this.distube.on("addList", (queue) => this.#renderQueueCard(queue));
    this.distube.on("deleteQueue", (queue) => {
      this.#clearFfmpegDebugBuffer(queue.id);
      this.#clearFiniteSongLoop(queue);
      this.#stopProgressTicker(queue.id);
      return this.#renderIdleCard(queue, "The queue is empty. Use /play to start music again.");
    });
    this.distube.on("disconnect", (queue) => {
      this.#clearFfmpegDebugBuffer(queue.id);
      this.#clearFiniteSongLoop(queue);
      this.#stopProgressTicker(queue.id);
      return this.#renderIdleCard(queue, "Disconnected from voice. Use /play to start music again.");
    });
    this.distube.on("finish", (queue) => {
      this.#clearFfmpegDebugBuffer(queue.id);
      this.#clearFiniteSongLoop(queue);
      this.#stopProgressTicker(queue.id);
      return this.#renderIdleCard(queue, "Reached the end of the queue. Use /play to start music again.");
    });
    this.distube.on("error", (error, queue, song) => {
      const retryResult = this.#tryRecoverSpotifyPlaybackError(error, queue, song);
      const message = retryResult.didRetry
        ? null
        : retryResult.userMessage || this.#friendlyDistubeError(error);

      this.#logPlaybackError(error, queue, song, retryResult);

      if (!message) {
        return;
      }

      if (queue?.textChannel && typeof queue.textChannel.send === "function") {
        queue.textChannel
          .send(`Playback error: ${message}`)
          .catch((sendError) => console.warn("Failed to send a playback error message:", sendError));
      }
    });
  }

  async play(interaction, query, options = {}) {
    await deferEphemeral(interaction);

    try {
      const member = await this.#getMember(interaction);
      const voiceChannel = member.voice?.channel;
      if (!voiceChannel) {
        return respond(interaction, "Join a voice channel first, then use `/play`.");
      }

      const spotifyUrlProblem = this.#validateSpotifyInput(query);
      if (spotifyUrlProblem) {
        return respond(interaction, spotifyUrlProblem);
      }

      const activeVoiceChannel = this.#getActiveVoiceChannel(interaction.guildId);
      if (activeVoiceChannel && activeVoiceChannel.id !== voiceChannel.id) {
        return respond(
          interaction,
          `I am already using <#${activeVoiceChannel.id}>. Join that channel or use \`/leave\` there first.`,
        );
      }

      const existingQueue = this.distube.getQueue(interaction.guildId);
      const previousSongCount = existingQueue?.songs.length || 0;

      if (!existingQueue && activeVoiceChannel && activeVoiceChannel.id === voiceChannel.id) {
        this.distube.voices.leave(interaction.guildId);
      }

      const playRequest = extractYouTubeStartInfo(query);
      const shouldUseLinkTimestamp = options.useLinkTimestamp !== false;
      const savedStartTime = shouldUseLinkTimestamp ? playRequest.startTimeSeconds : null;
      const isSpotifyTrackLookup = this.#isSpotifyTrackLookup(query);
      const metadata = {
        queuedAtMs: Date.now(),
      };

      if (isSpotifyTrackLookup) {
        metadata.spotifyTrackLookup = true;
      }

      if (savedStartTime) {
        metadata.youtubeStartTimeSeconds = savedStartTime;
      }

      await this.distube.play(voiceChannel, playRequest.query, {
        member,
        textChannel: this.#getTextChannel(interaction),
        metadata,
      });

      const queue = this.distube.getQueue(interaction.guildId);
      const currentSongCount = queue?.songs.length || 0;
      const addedCount = Math.max(currentSongCount - previousSongCount, 0);
      const latestSong = queue ? queue.songs[queue.songs.length - 1] : null;
      const startText = savedStartTime ? ` starting at **${playRequest.startTimeLabel}**` : "";
      const ignoredTimestampText = !shouldUseLinkTimestamp && playRequest.startTimeLabel
        ? " from the beginning"
        : "";

      if (queue) {
        this.#setQueueActivity(
          queue,
          addedCount > 1
            ? `Queued ${addedCount} tracks by <@${interaction.user.id}>.`
            : latestSong?.name
              ? `Queued **${latestSong.name}** by <@${interaction.user.id}>${startText}.`
              : `Queued a track by <@${interaction.user.id}>.`,
        );
        await this.#renderQueueCard(queue);
      }

      if (addedCount > 1) {
        return respond(interaction, `Added ${addedCount} tracks to the queue.`);
      }

      if (latestSong?.name) {
        if (previousSongCount === 0) {
          return respond(interaction, `Started playing **${latestSong.name}**${startText}${ignoredTimestampText}.`);
        }

        return respond(interaction, `Added **${latestSong.name}** to the queue${startText}${ignoredTimestampText}.`);
      }

      return respond(interaction, "Queued your request.");
    } catch (error) {
      return respond(interaction, this.#friendlyDistubeError(error));
    }
  }

  async showQueue(interaction) {
    await deferEphemeral(interaction);

    const queue = await this.#getQueueForViewing(interaction);
    if (!queue?.songs.length) {
      return respond(interaction, "The queue is empty right now.");
    }

    return respond(interaction, { embeds: buildQueueEmbeds(queue) });
  }

  async showNowPlaying(interaction) {
    await deferEphemeral(interaction);

    const queue = await this.#getQueueForViewing(interaction);
    if (!queue?.songs.length) {
      return respond(interaction, "Nothing is playing right now.");
    }

    return respond(interaction, { embeds: buildNowPlayingEmbeds(queue) });
  }

  async showHistory(interaction) {
    await deferEphemeral(interaction);

    if (!interaction.inGuild()) {
      return respond(interaction, "This command only works inside a server.");
    }

    return respond(interaction, {
      embeds: buildHistoryEmbeds(interaction.guild?.name, this.#getHistoryEntries(interaction.guildId)),
    });
  }

  async shutdown() {
    await this.historyStore?.close();
  }

  async showPlayer(interaction) {
    await deferEphemeral(interaction);

    try {
      const textChannel = this.#getTextChannel(interaction);
      if (!textChannel) {
        return respond(interaction, "I can only display the player in a normal server text channel.");
      }

      const queue = this.distube.getQueue(interaction.guildId);
      if (queue?.songs.length) {
        await this.#getQueueForViewing(interaction);
        queue.textChannel = textChannel;
        this.playerCards.setPlayerMode(interaction.guildId);
        await this.playerCards.renderQueue(queue);
        return respond(interaction, "Redisplayed the shared player in this channel.");
      }

      await this.playerCards.renderIdle({
        guildId: interaction.guildId,
        textChannel,
        guildName: interaction.guild?.name,
        reason: "Nothing is playing right now. Use /play to start music.",
      });

      return respond(interaction, "Displayed the idle player in this channel.");
    } catch (error) {
      return respond(interaction, this.#friendlyDistubeError(error));
    }
  }

  async showQueueManager(interaction) {
    return this.#runQueueAction(interaction, async (queue) => {
      this.playerCards.setQueueMode(interaction.guildId, queue);
      await this.#renderQueueCard(queue);

      if (queue.songs.length > 1) {
        return "Opened the queue manager.";
      }

      return "Opened the queue manager. There are no upcoming songs yet.";
    });
  }

  async returnToPlayer(interaction) {
    return this.#runQueueAction(interaction, async (queue) => {
      this.playerCards.setPlayerMode(interaction.guildId);
      await this.#renderQueueCard(queue);
      return "Returned to the player view.";
    });
  }

  async pause(interaction) {
    return this.#runQueueAction(interaction, async (queue) => {
      await queue.pause();
      this.#stopProgressTicker(queue.id);
      await this.#renderQueueCard(queue);
      return "Paused the current song.";
    });
  }

  async resume(interaction) {
    return this.#runQueueAction(interaction, async (queue) => {
      await queue.resume();
      this.#startProgressTicker(queue.id);
      await this.#renderQueueCard(queue);
      return "Resumed playback.";
    });
  }

  async skip(interaction) {
    return this.#runQueueAction(interaction, async (queue) => {
      const skippedSong = queue.songs[0];
      this.#clearFiniteSongLoop(queue);
      const skippedTo = await queue.skip();
      this.#setQueueActivity(
        queue,
        skippedSong?.name
          ? `Skipped **${skippedSong.name}** by <@${interaction.user.id}>.`
          : `Skipped the current song by <@${interaction.user.id}>.`,
      );
      await this.#renderQueueCard(queue);
      return skippedTo?.name ? `Skipped. Up next: **${skippedTo.name}**.` : "Skipped the current song.";
    });
  }

  async stop(interaction) {
    return this.#runQueueAction(interaction, async (queue) => {
      const textChannel = queue.textChannel || this.#getTextChannel(interaction);
      const guildName = interaction.guild?.name;

      this.#clearFiniteSongLoop(queue);
      this.#stopProgressTicker(queue.id);
      await queue.stop();
      await this.playerCards.renderIdle({
        guildId: interaction.guildId,
        textChannel,
        guildName,
        reason: "Playback stopped. Use /play to start music again.",
      });

      return "Stopped playback and cleared the queue.";
    });
  }

  async leave(interaction) {
    await deferEphemeral(interaction);

    try {
      const member = await this.#getMember(interaction);
      const memberVoiceChannel = member.voice?.channel;
      if (!memberVoiceChannel) {
        return respond(interaction, "Join my voice channel first if you want to disconnect me.");
      }

      const activeVoiceChannel = this.#getActiveVoiceChannel(interaction.guildId);
      if (!activeVoiceChannel) {
        return respond(interaction, "I am not connected to a voice channel right now.");
      }

      if (activeVoiceChannel.id !== memberVoiceChannel.id) {
        return respond(
          interaction,
          `Join <#${activeVoiceChannel.id}> if you want to disconnect the bot.`,
        );
      }

      const queue = this.distube.getQueue(interaction.guildId);
      this.#clearFiniteSongLoop(queue);
      this.#stopProgressTicker(interaction.guildId);
      this.distube.voices.leave(interaction.guildId);
      await this.playerCards.renderIdle({
        guildId: interaction.guildId,
        textChannel: this.#getTextChannel(interaction),
        guildName: interaction.guild?.name,
        reason: "Disconnected from voice. Use /play to start music again.",
      });

      return respond(interaction, "Left the voice channel.");
    } catch (error) {
      return respond(interaction, this.#friendlyDistubeError(error));
    }
  }

  async seek(interaction, input) {
    return this.#runQueueAction(interaction, async (queue) => {
      const targetSeconds = parseTimestamp(input);
      if (targetSeconds === null) {
        return "Use a timestamp like `1:30`, `12:05`, or `01:02:03`.";
      }

      this.#ensureSeekable(queue, targetSeconds);
      await this.#seekTo(queue, targetSeconds);
      await this.#renderQueueCard(queue);
      return `Jumped to **${formatTimestamp(targetSeconds)}**.`;
    });
  }

  async shuffle(interaction) {
    return this.#runQueueAction(interaction, async (queue) => {
      if (queue.songs.length < 3) {
        return "Add at least two upcoming songs before shuffling the queue.";
      }

      await queue.shuffle();
      await this.#renderQueueCard(queue);
      return "Shuffled the upcoming queue.";
    });
  }

  async openSongLoopMenu(interaction) {
    await deferEphemeral(interaction);

    try {
      const { queue } = await this.#getQueueContext(interaction);
      return respond(interaction, {
        content: "Choose how the current track should loop.",
        components: [buildLoopModeSelectRow(queue)],
      });
    } catch (error) {
      return respond(interaction, this.#friendlyDistubeError(error));
    }
  }

  async remove(interaction, index) {
    return this.#runQueueAction(interaction, async (queue) => {
      const upcomingCount = Math.max(queue.songs.length - 1, 0);
      if (upcomingCount === 0) {
        return "There are no upcoming songs to remove.";
      }

      if (index < 1 || index > upcomingCount) {
        return `Pick a number between 1 and ${upcomingCount}.`;
      }

      const [removedSong] = queue.songs.splice(index, 1);
      await this.#renderQueueCard(queue);

      return removedSong?.name
        ? `Removed **${removedSong.name}** from the queue.`
        : "Removed that song from the queue.";
    });
  }

  async clear(interaction) {
    return this.#runQueueAction(interaction, async (queue) => {
      const removedCount = Math.max(queue.songs.length - 1, 0);
      if (removedCount === 0) {
        return "The queue is already clear after the current song.";
      }

      queue.songs.splice(1);
      await this.#renderQueueCard(queue);
      return `Cleared ${removedCount} upcoming track(s).`;
    });
  }

  async handleButton(interaction) {
    const { customId } = interaction;

    if (customId === BUTTON_IDS.showQueue) {
      return this.showQueueManager(interaction);
    }

    if (customId === BUTTON_IDS.backToPlayer) {
      return this.returnToPlayer(interaction);
    }

    if (customId === BUTTON_IDS.pauseResume) {
      return this.#runQueueAction(interaction, async (queue) => {
        if (queue.paused) {
          await queue.resume();
          this.#startProgressTicker(queue.id);
          await this.#renderQueueCard(queue);
          return "Resumed playback.";
        }

        await queue.pause();
        this.#stopProgressTicker(queue.id);
        await this.#renderQueueCard(queue);
        return "Paused the current song.";
      });
    }

    if (customId === BUTTON_IDS.skip) {
      return this.skip(interaction);
    }

    if (customId === BUTTON_IDS.stop) {
      return this.stop(interaction);
    }

    if (customId === BUTTON_IDS.loopMenu || customId === LEGACY_LOOP_BUTTON_ID) {
      return this.openSongLoopMenu(interaction);
    }

    if (customId === BUTTON_IDS.back10) {
      return this.#seekByOffset(interaction, -10);
    }

    if (customId === BUTTON_IDS.forward10) {
      return this.#seekByOffset(interaction, 10);
    }

    if (customId === BUTTON_IDS.queuePrevPage) {
      return this.#changeQueuePage(interaction, -1);
    }

    if (customId === BUTTON_IDS.queueNextPage) {
      return this.#changeQueuePage(interaction, 1);
    }

    if (customId === BUTTON_IDS.queueMoveUp) {
      return this.#moveSelectedSong(interaction, "up");
    }

    if (customId === BUTTON_IDS.queueMoveDown) {
      return this.#moveSelectedSong(interaction, "down");
    }

    if (customId === BUTTON_IDS.queueMoveTop) {
      return this.#moveSelectedSong(interaction, "top");
    }

    if (customId === BUTTON_IDS.queueRemove) {
      return this.#removeSelectedSong(interaction);
    }

    return respond(interaction, "That control is not supported.");
  }

  async handleSelectMenu(interaction) {
    if (interaction.customId === SELECT_IDS.loopMode) {
      return this.#handleLoopModeSelection(interaction);
    }

    await deferEphemeral(interaction);

    try {
      if (interaction.customId !== SELECT_IDS.queueSong) {
        return respond(interaction, "That control is not supported.");
      }

      const { queue } = await this.#getQueueContext(interaction);
      const selectedValue = interaction.values?.[0];
      if (!selectedValue || selectedValue === "queue:none") {
        return respond(interaction, "There are no upcoming songs to manage yet.");
      }

      const selectedIndex = Number.parseInt(selectedValue, 10);
      const upcomingCount = Math.max(queue.songs.length - 1, 0);

      if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > upcomingCount) {
        this.playerCards.setQueueMode(interaction.guildId, queue);
        await this.#renderQueueCard(queue);
        return respond(interaction, "That queued song is no longer available.");
      }

      this.playerCards.setQueueSelectedIndex(interaction.guildId, queue, selectedIndex);
      await this.#renderQueueCard(queue);

      const selectedSong = queue.songs[selectedIndex];
      if (selectedSong?.name) {
        return respond(interaction, `Selected **${selectedSong.name}**.`);
      }

      return respond(interaction, "Selected that queued song.");
    } catch (error) {
      return respond(interaction, this.#friendlyDistubeError(error));
    }
  }

  async #seekByOffset(interaction, offsetSeconds) {
    return this.#runQueueAction(interaction, async (queue) => {
      const targetSeconds = Math.floor(queue.currentTime + offsetSeconds);
      this.#ensureSeekable(queue, targetSeconds);
      await this.#seekTo(queue, targetSeconds);
      await this.#renderQueueCard(queue);
      return `Jumped to **${formatTimestamp(targetSeconds)}**.`;
    });
  }

  async #changeQueuePage(interaction, delta) {
    return this.#runQueueAction(interaction, async (queue) => {
      const state = this.playerCards.getQueueViewState(interaction.guildId, queue);
      const nextState = this.playerCards.setQueuePage(interaction.guildId, queue, state.queuePage + delta);
      await this.#renderQueueCard(queue);
      return `Showing queue page ${nextState.queuePage + 1}.`;
    });
  }

  async #moveSelectedSong(interaction, direction) {
    return this.#runQueueAction(interaction, async (queue) => {
      const selectedIndex = this.#getSelectedQueueIndex(interaction.guildId, queue);
      const selectedSong = queue.songs[selectedIndex];

      if (direction === "up") {
        if (selectedIndex <= 1) {
          return "That song is already first in the upcoming queue.";
        }

        [queue.songs[selectedIndex - 1], queue.songs[selectedIndex]] = [
          queue.songs[selectedIndex],
          queue.songs[selectedIndex - 1],
        ];
        this.playerCards.setQueueSelectedIndex(interaction.guildId, queue, selectedIndex - 1);
        await this.#renderQueueCard(queue);
        return selectedSong?.name ? `Moved **${selectedSong.name}** up.` : "Moved that song up.";
      }

      if (direction === "down") {
        if (selectedIndex >= queue.songs.length - 1) {
          return "That song is already last in the queue.";
        }

        [queue.songs[selectedIndex], queue.songs[selectedIndex + 1]] = [
          queue.songs[selectedIndex + 1],
          queue.songs[selectedIndex],
        ];
        this.playerCards.setQueueSelectedIndex(interaction.guildId, queue, selectedIndex + 1);
        await this.#renderQueueCard(queue);
        return selectedSong?.name ? `Moved **${selectedSong.name}** down.` : "Moved that song down.";
      }

      if (direction === "top") {
        if (selectedIndex <= 1) {
          return "That song is already first in the upcoming queue.";
        }

        const [song] = queue.songs.splice(selectedIndex, 1);
        queue.songs.splice(1, 0, song);
        this.playerCards.setQueueSelectedIndex(interaction.guildId, queue, 1);
        await this.#renderQueueCard(queue);
        return song?.name ? `Moved **${song.name}** to the top of the queue.` : "Moved that song to the top.";
      }

      return "That queue action is not supported.";
    });
  }

  async #removeSelectedSong(interaction) {
    return this.#runQueueAction(interaction, async (queue) => {
      const selectedIndex = this.#getSelectedQueueIndex(interaction.guildId, queue);
      const [removedSong] = queue.songs.splice(selectedIndex, 1);

      if (queue.songs.length > 1) {
        const nextSelectedIndex = Math.min(selectedIndex, queue.songs.length - 1);
        this.playerCards.setQueueSelectedIndex(interaction.guildId, queue, nextSelectedIndex);
      } else {
        this.playerCards.setQueueMode(interaction.guildId, queue);
      }

      await this.#renderQueueCard(queue);
      return removedSong?.name
        ? `Removed **${removedSong.name}** from the queue.`
        : "Removed that song from the queue.";
    });
  }

  async #runQueueAction(interaction, action) {
    await deferEphemeral(interaction);

    try {
      const context = await this.#getQueueContext(interaction);
      const result = await action(context.queue);

      if (typeof result === "string") {
        return respond(interaction, result);
      }

      return respond(interaction, "Done.");
    } catch (error) {
      return respond(interaction, this.#friendlyDistubeError(error));
    }
  }

  async #getQueueContext(interaction) {
    const member = await this.#getMember(interaction);
    const memberVoiceChannel = member.voice?.channel;
    if (!memberVoiceChannel) {
      throw new Error("Join the bot's voice channel first.");
    }

    const queue = this.distube.getQueue(interaction.guildId);
    if (!queue?.songs.length || !queue.voiceChannel) {
      throw new Error("Nothing is playing right now.");
    }

    if (queue.voiceChannel.id !== memberVoiceChannel.id) {
      throw new Error(`Join <#${queue.voiceChannel.id}> if you want to control the player.`);
    }

    return { queue, member };
  }

  #getSelectedQueueIndex(guildId, queue) {
    const state = this.playerCards.getQueueViewState(guildId, queue);
    const upcomingCount = Math.max(queue.songs.length - 1, 0);

    if (!upcomingCount || !Number.isInteger(state.selectedIndex)) {
      throw new Error("There are no upcoming songs to manage.");
    }

    if (state.selectedIndex < 1 || state.selectedIndex > upcomingCount) {
      throw new Error("That queued song is no longer available.");
    }

    return state.selectedIndex;
  }

  async #getQueueForViewing(interaction) {
    const queue = this.distube.getQueue(interaction.guildId);
    if (!queue?.songs.length || !queue.voiceChannel) {
      return queue;
    }

    const member = await this.#getMember(interaction);
    const memberVoiceChannel = member.voice?.channel;

    if (!memberVoiceChannel) {
      throw new Error("Join the bot's voice channel if you want to view the active player.");
    }

    if (memberVoiceChannel.id !== queue.voiceChannel.id) {
      throw new Error(`Join <#${queue.voiceChannel.id}> if you want to view the active player.`);
    }

    return queue;
  }

  async #getMember(interaction) {
    if (!interaction.inGuild()) {
      throw new Error("This bot only works inside a server.");
    }

    return interaction.guild.members.fetch(interaction.user.id);
  }

  #getActiveVoiceChannel(guildId) {
    const queue = this.distube.getQueue(guildId);
    if (queue?.voiceChannel) {
      return queue.voiceChannel;
    }

    const voice = this.distube.voices.get(guildId);
    return voice?.channel || null;
  }

  #getTextChannel(interaction) {
    const { channel } = interaction;

    if (channel && typeof channel.send === "function") {
      return channel;
    }

    return undefined;
  }

  #validateSpotifyInput(query) {
    const match = query.match(/(?:open\.spotify\.com\/|spotify:)(track|album|playlist|artist)/i);
    if (!match) {
      return null;
    }

    if (match[1].toLowerCase() === "track") {
      return null;
    }

    return "Version 1 only supports Spotify **track** links. Album, artist, and playlist links can come later.";
  }

  #isSpotifyTrackLookup(query) {
    return /(?:open\.spotify\.com\/track\/|spotify:track:)/i.test(query || "");
  }

  #ensureSeekable(queue, targetSeconds) {
    const song = queue.songs[0];
    if (!song || song.isLive || !song.duration) {
      throw new Error("This track cannot be seeked.");
    }

    if (targetSeconds < 0 || targetSeconds >= song.duration) {
      throw new Error(`Pick a time between 0:00 and ${song.formattedDuration}.`);
    }
  }

  #clearCurrentStreamCache(queue) {
    const song = queue.songs[0];
    if (!song) {
      return;
    }

    if (song.stream?.playFromSource) {
      delete song.stream.url;
    }

    if (song.stream?.song?.stream?.playFromSource) {
      delete song.stream.song.stream.url;
    }
  }

  #startFfmpegDebugBuffer(guildId, song = null) {
    const existing = this.ffmpegDebugBuffers.get(guildId);
    this.ffmpegDebugBuffers.set(guildId, {
      songRef: song,
      lines: existing?.lines?.slice(-10) || [],
    });
  }

  #clearFfmpegDebugBuffer(guildId) {
    this.ffmpegDebugBuffers.delete(guildId);
  }

  #recordFfmpegDebugLine(debugLine) {
    const match = /^\[([^\]]+)\]\s*(.*)$/u.exec(String(debugLine || ""));
    if (!match) {
      return;
    }

    const guildId = match[1];
    const existing = this.ffmpegDebugBuffers.get(guildId) || {
      songRef: null,
      lines: [],
    };

    existing.lines.push(String(debugLine));
    if (existing.lines.length > MAX_FFMPEG_DEBUG_LINES) {
      existing.lines.splice(0, existing.lines.length - MAX_FFMPEG_DEBUG_LINES);
    }

    this.ffmpegDebugBuffers.set(guildId, existing);
  }

  #getRecentFfmpegDebugLines(guildId) {
    return this.ffmpegDebugBuffers.get(guildId)?.lines || [];
  }

  #setQueueActivity(queue, text) {
    if (!queue) {
      return;
    }

    queue.__playerActivity = {
      text,
      updatedAt: Date.now(),
    };
  }

  #tryRecoverSpotifyPlaybackError(error, queue, song) {
    const fallbackContext = this.#getSpotifyFallbackContext(song);
    if (!this.#isRetryableSpotifyPlaybackError(error, queue, song, fallbackContext)) {
      return {
        didRetry: false,
        context: fallbackContext,
        userMessage: this.#getSpotifyFallbackFailureMessage(error, queue, song, fallbackContext),
      };
    }

    const nextIndex = fallbackContext.currentIndex + 1;
    const nextCandidate = fallbackContext.candidates[nextIndex];
    this.#applySpotifyFallbackCandidate(fallbackContext.playableSong, nextCandidate, fallbackContext.candidates);
    queue.songs.unshift(song);

    return {
      didRetry: true,
      context: {
        ...fallbackContext,
        nextCandidate,
        nextIndex,
      },
      userMessage: null,
    };
  }

  #getSpotifyFallbackContext(song) {
    const playableSong = song?.stream?.song;
    const candidates = playableSong?.stream?.spotifyFallbackCandidates;
    const currentIndex = Number.isInteger(playableSong?.stream?.spotifyFallbackCandidateIndex)
      ? playableSong.stream.spotifyFallbackCandidateIndex
      : 0;

    if (!song || song.source !== "spotify" || !playableSong?.stream?.playFromSource || !Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }

    return {
      playableSong,
      candidates,
      currentCandidate: candidates[currentIndex] || null,
      currentIndex,
      totalCandidates: candidates.length,
    };
  }

  #isRetryableSpotifyPlaybackError(error, queue, song, fallbackContext) {
    const code = error?.code || error?.errorCode;
    if (code !== "FFMPEG_EXITED") {
      return false;
    }

    if (!queue || !song || !fallbackContext) {
      return false;
    }

    if (!this.#isStartupPlaybackFailure(queue, song)) {
      return false;
    }

    return fallbackContext.currentIndex < fallbackContext.candidates.length - 1;
  }

  #isStartupPlaybackFailure(queue, song) {
    const currentTime = Number(queue?.currentTime);
    if (Number.isFinite(currentTime) && currentTime > SPOTIFY_RETRY_STARTUP_WINDOW_SECONDS) {
      return false;
    }

    const startedAtMs = Number(song?.__playStartedAtMs);
    if (Number.isFinite(startedAtMs) && (Date.now() - startedAtMs) > ((SPOTIFY_RETRY_STARTUP_WINDOW_SECONDS + 2) * 1000)) {
      return false;
    }

    return true;
  }

  #applySpotifyFallbackCandidate(playableSong, candidate, candidates) {
    if (!playableSong || !candidate) {
      return;
    }

    playableSong.id = candidate.id;
    playableSong.name = candidate.name;
    playableSong.url = candidate.url;
    playableSong.isLive = candidate.isLive;
    playableSong.thumbnail = candidate.thumbnail;
    playableSong.duration = candidate.duration;
    playableSong.uploader = {
      name: candidate.uploader?.name,
      url: candidate.uploader?.url,
    };
    playableSong.stream.url = candidate.streamUrl;
    playableSong.stream.spotifyFallbackCandidates = candidates;
    playableSong.stream.spotifyFallbackCandidateIndex = candidate.index;
    playableSong.stream.spotifyFallbackCurrentCandidate = candidate;
    playableSong.stream.spotifyFallbackStreamMeta = candidate.streamMeta;
  }

  #getSpotifyFallbackFailureMessage(error, queue, song, fallbackContext) {
    const code = error?.code || error?.errorCode;
    if (code !== "FFMPEG_EXITED" || song?.source !== "spotify" || !this.#isStartupPlaybackFailure(queue, song)) {
      return null;
    }

    if (fallbackContext?.totalCandidates) {
      return `I could not open a working YouTube match for this Spotify track after ${fallbackContext.totalCandidates} attempt${fallbackContext.totalCandidates === 1 ? "" : "s"}.`;
    }

    return "I could not open a working YouTube match for this Spotify track.";
  }

  #logPlaybackError(error, queue, song, retryResult = {}) {
    const songName = song?.name ? ` while handling "${song.name}"` : "";
    const context = retryResult.context;
    const currentCandidate = context?.currentCandidate;
    const nextCandidate = context?.nextCandidate;
    const recentDebugLines = this.#getRecentFfmpegDebugLines(queue?.id);

    if (retryResult.didRetry) {
      console.warn(
        `DisTube error${songName}: retrying Spotify fallback ${context.nextIndex + 1}/${context.totalCandidates} after FFmpeg exited.`,
        error,
      );
    } else {
      console.error(`DisTube error${songName}:`, error);
    }

    if (currentCandidate) {
      console.warn(
        `Spotify fallback candidate ${context.currentIndex + 1}/${context.totalCandidates}: ${currentCandidate.name} (${currentCandidate.url})`,
      );
    }

    if (nextCandidate) {
      console.warn(
        `Retrying with candidate ${context.nextIndex + 1}/${context.totalCandidates}: ${nextCandidate.name} (${nextCandidate.url})`,
      );
    }

    if (recentDebugLines.length > 0) {
      console.warn("Recent FFmpeg debug lines:");
      for (const line of recentDebugLines) {
        console.warn(line);
      }
    }
  }

  async #handleLoopModeSelection(interaction) {
    const selectedValue = interaction.values?.[0];

    await interaction.update({
      content: "Updating loop mode...",
      components: [],
    });

    try {
      const { queue } = await this.#getQueueContext(interaction);
      const currentSong = queue.songs[0];
      const loopMode = this.#parseSongLoopSelection(selectedValue);

      if (!loopMode) {
        return interaction.editReply({ content: "That loop mode is not supported." });
      }

      this.#setSongLoopMode(queue, currentSong, loopMode);
      await this.#renderQueueCard(queue);

      return interaction.editReply({
        content: this.#formatSongLoopConfirmation(loopMode),
      });
    } catch (error) {
      return interaction.editReply({
        content: this.#friendlyDistubeError(error),
      });
    }
  }

  #handleSongFinish(queue, song) {
    const loopState = this.#getFiniteSongLoopState(queue, song);
    if (loopState.infinite) {
      queue.repeatMode = RepeatMode.SONG;
      return;
    }

    if (loopState.remaining <= 0) {
      queue.repeatMode = RepeatMode.DISABLED;
      return;
    }

    this.#setFiniteSongLoopCount(queue, song, loopState.remaining - 1);
    queue.repeatMode = RepeatMode.SONG;
  }

  #syncFiniteSongLoop(queue, song = queue?.songs?.[0]) {
    const state = this.#getFiniteSongLoopState(queue, song);
    queue.repeatMode = state.infinite || state.remaining > 0 ? RepeatMode.SONG : RepeatMode.DISABLED;
    return state;
  }

  #getFiniteSongLoopState(queue, song = queue?.songs?.[0]) {
    if (!queue || !song) {
      return {
        songRef: null,
        remaining: 0,
        infinite: false,
      };
    }

    const existingState = queue.__finiteSongLoop;
    if (!existingState || existingState.songRef !== song) {
      queue.__finiteSongLoop = {
        songRef: song,
        remaining: 0,
        infinite: false,
      };
    }

    const normalizedRemaining = Number.isInteger(queue.__finiteSongLoop.remaining)
      ? Math.min(Math.max(queue.__finiteSongLoop.remaining, 0), MAX_SONG_LOOP_REPEATS)
      : 0;
    const normalizedInfinite = queue.__finiteSongLoop.infinite === true;

    queue.__finiteSongLoop.remaining = normalizedInfinite ? 0 : normalizedRemaining;
    queue.__finiteSongLoop.infinite = normalizedInfinite;
    return queue.__finiteSongLoop;
  }

  #setFiniteSongLoopCount(queue, song = queue?.songs?.[0], remaining = 0) {
    if (!queue || !song) {
      return 0;
    }

    queue.__finiteSongLoop = {
      songRef: song,
      remaining: Math.min(Math.max(Number(remaining) || 0, 0), MAX_SONG_LOOP_REPEATS),
      infinite: false,
    };
    queue.repeatMode = queue.__finiteSongLoop.remaining > 0 ? RepeatMode.SONG : RepeatMode.DISABLED;
    return queue.__finiteSongLoop.remaining;
  }

  #setInfiniteSongLoop(queue, song = queue?.songs?.[0], infinite = false) {
    if (!queue || !song) {
      return false;
    }

    queue.__finiteSongLoop = {
      songRef: song,
      remaining: 0,
      infinite: infinite === true,
    };
    queue.repeatMode = queue.__finiteSongLoop.infinite ? RepeatMode.SONG : RepeatMode.DISABLED;
    return queue.__finiteSongLoop.infinite;
  }

  #setSongLoopMode(queue, song = queue?.songs?.[0], mode = "off") {
    if (mode === "infinite") {
      this.#setInfiniteSongLoop(queue, song, true);
      return;
    }

    const remaining = Number.parseInt(mode, 10);
    if (Number.isInteger(remaining) && remaining > 0) {
      this.#setFiniteSongLoopCount(queue, song, remaining);
      return;
    }

    this.#clearFiniteSongLoop(queue);
  }

  #parseSongLoopSelection(selectedValue) {
    if (selectedValue === "off" || selectedValue === "infinite") {
      return selectedValue;
    }

    const remaining = Number.parseInt(selectedValue, 10);
    if (Number.isInteger(remaining) && remaining >= 1 && remaining <= MAX_SONG_LOOP_REPEATS) {
      return String(remaining);
    }

    return null;
  }

  #formatSongLoopConfirmation(mode) {
    if (mode === "off") {
      return "Song looping is off.";
    }

    if (mode === "infinite") {
      return "This track will loop until you change it.";
    }

    const remaining = Number.parseInt(mode, 10);
    return `This track will replay ${remaining} more time${remaining === 1 ? "" : "s"}.`;
  }

  #clearFiniteSongLoop(queue) {
    if (!queue) {
      return;
    }

    queue.__finiteSongLoop = {
      songRef: queue.songs?.[0] || null,
      remaining: 0,
      infinite: false,
    };
    queue.repeatMode = RepeatMode.DISABLED;
  }

  #recordSongInHistory(queue, song = queue?.songs?.[0]) {
    if (!queue?.id || !song || song.__historyRecorded) {
      return;
    }

    song.__historyRecorded = true;

    this.historyStore?.addEntry(queue.id, {
      title: song.name || "Unknown title",
      source: song.source || "unknown",
      userId: song.user?.id || null,
      queuedAtMs: this.#getSongQueuedAtMs(song),
    });
  }

  async #handlePlaySong(queue) {
    try {
      await this.#applySavedYouTubeTimestamp(queue);
    } catch (error) {
      console.warn("Failed to apply the saved YouTube timestamp:", error);
    }

    await this.#renderQueueCard(queue);
  }

  async #seekTo(queue, targetSeconds) {
    await queue._taskQueue.queuing();

    try {
      const song = queue.songs[0];
      if (!song) {
        throw new Error("Nothing is playing right now.");
      }

      const playableSong = await this.#getPlayableSongForSeek(song);
      const dtStream = new DisTubeStream(
        playableSong.stream.url,
        this.#createSeekStreamOptions(queue, targetSeconds),
      );

      dtStream.seekTime = targetSeconds;
      dtStream.on("debug", (data) => this.distube.emit("ffmpegDebug", `[${queue.id}] ${data}`));

      queue._beginTime = 0;
      await queue.voice.play(dtStream);

      if (queue.voice?.stream) {
        queue.voice.stream.seekTime = targetSeconds;
      }
    } finally {
      queue._taskQueue.resolve();
    }
  }

  async #applySavedYouTubeTimestamp(queue) {
    const song = queue.songs[0];
    const savedStartTime = this.#getSavedYouTubeStartTime(song);
    if (savedStartTime === null) {
      return;
    }

    song.metadata.youtubeStartTimeApplied = true;

    if (!song.duration || song.isLive || savedStartTime >= song.duration) {
      return;
    }

    await this.#seekTo(queue, savedStartTime);
  }

  #getSavedYouTubeStartTime(song) {
    if (!song?.metadata || typeof song.metadata !== "object" || song.metadata.youtubeStartTimeApplied) {
      return null;
    }

    const savedStartTime = Number(song.metadata.youtubeStartTimeSeconds);
    if (!Number.isFinite(savedStartTime) || savedStartTime <= 0) {
      return null;
    }

    return Math.floor(savedStartTime);
  }

  #getSongQueuedAtMs(song) {
    const queuedAtMs = Number(song?.metadata?.queuedAtMs);
    if (Number.isFinite(queuedAtMs) && queuedAtMs > 0) {
      return queuedAtMs;
    }

    return Date.now();
  }

  #getHistoryEntries(guildId) {
    return this.historyStore?.getEntries(guildId) || [];
  }

  #createSeekStreamOptions(queue, targetSeconds) {
    return {
      ffmpeg: {
        path: this.distube.options.ffmpeg.path,
        args: {
          global: { ...queue.ffmpegArgs.global },
          input: {
            ...queue.ffmpegArgs.input,
            ss: String(targetSeconds),
          },
          output: {
            ...queue.ffmpegArgs.output,
            ...queue.filters.ffmpegArgs,
          },
        },
      },
    };
  }

  async #getPlayableSongForSeek(song) {
    const cachedPlayableSong = this.#getCachedPlayableSong(song);
    if (cachedPlayableSong) {
      return cachedPlayableSong;
    }

    this.#clearCurrentStreamCache({ songs: [song] });
    await this.distube.handler.attachStreamInfo(song);

    const refreshedPlayableSong = song.stream?.playFromSource ? song : song.stream?.song;
    if (!refreshedPlayableSong?.stream?.playFromSource || !refreshedPlayableSong.stream.url) {
      throw new Error("I could not reopen the current audio stream for seeking.");
    }

    return refreshedPlayableSong;
  }

  #getCachedPlayableSong(song) {
    if (song.stream?.playFromSource && this.#hasFreshStreamURL(song.stream.url)) {
      return song;
    }

    const alternateSong = song.stream?.song;
    if (alternateSong?.stream?.playFromSource && this.#hasFreshStreamURL(alternateSong.stream.url)) {
      return alternateSong;
    }

    return null;
  }

  #hasFreshStreamURL(streamUrl) {
    if (!streamUrl) {
      return false;
    }

    try {
      const parsed = new URL(streamUrl);
      const expiresAt = parsed.searchParams.get("expire");
      if (!expiresAt) {
        return true;
      }

      const expiresAtUnix = Number.parseInt(expiresAt, 10);
      if (!Number.isFinite(expiresAtUnix)) {
        return true;
      }

      const nowUnix = Math.floor(Date.now() / 1000);
      return (expiresAtUnix - nowUnix) > 120;
    } catch {
      return true;
    }
  }

  async #renderQueueCard(queue) {
    try {
      await this.playerCards.renderQueue(queue);
    } catch (error) {
      console.warn("Failed to refresh the shared player message:", error);
    }
  }

  async #renderIdleCard(queue, reason) {
    try {
      this.#stopProgressTicker(queue.id);
      await this.playerCards.renderIdle({
        guildId: queue.id,
        textChannel: queue.textChannel,
        guildName: queue.textChannel?.guild?.name,
        reason,
      });
    } catch (error) {
      console.warn("Failed to refresh the idle player message:", error);
    }
  }

  #startProgressTicker(guildId) {
    if (this.progressTickerHandles.has(guildId)) {
      return;
    }

    const handle = setInterval(() => {
      void this.#refreshProgressCard(guildId);
    }, PLAYER_PROGRESS_REFRESH_MS);

    this.progressTickerHandles.set(guildId, handle);
  }

  #stopProgressTicker(guildId) {
    const handle = this.progressTickerHandles.get(guildId);
    if (!handle) {
      return;
    }

    clearInterval(handle);
    this.progressTickerHandles.delete(guildId);
    this.progressTickerBusyGuilds.delete(guildId);
  }

  async #refreshProgressCard(guildId) {
    if (this.progressTickerBusyGuilds.has(guildId)) {
      return;
    }

    const queue = this.distube.getQueue(guildId);
    if (!queue?.songs.length || !queue.voiceChannel) {
      this.#stopProgressTicker(guildId);
      return;
    }

    if (queue.paused) {
      return;
    }

    const viewState = this.playerCards.getQueueViewState(guildId, queue);
    if (viewState.mode !== "player") {
      return;
    }

    this.progressTickerBusyGuilds.add(guildId);

    try {
      await this.#renderQueueCard(queue);
    } finally {
      this.progressTickerBusyGuilds.delete(guildId);
    }
  }

  #friendlyDistubeError(error) {
    const code = error?.code || error?.errorCode;

    switch (code) {
      case "NO_QUEUE":
      case "NO_PLAYING_SONG":
      case "QUEUE_STOPPED":
        return "Nothing is playing right now.";
      case "PAUSED":
        return "Playback is already paused.";
      case "RESUMED":
        return "Playback is already running.";
      case "NO_UP_NEXT":
        return "There is nothing queued after the current song.";
      case "NO_RESULT":
      case "NO_VALID_SONG":
        return "I could not find anything playable for that request.";
      case "NOT_SUPPORTED_URL":
      case "CANNOT_RESOLVE_SONG":
      case "CANNOT_GET_STREAM_URL":
      case "NO_STREAM_URL":
        return "I could not turn that into a playable track.";
      case "UNPLAYABLE_FORMATS":
        return "YouTube did not offer a usable audio stream for that track.";
      case "YTDLP_ERROR":
        return "The YouTube lookup failed. Try the command again, or try a direct link.";
      case "NO_EXTRACTOR_PLUGIN":
        return "The music-source plugins are not ready. Reinstall the project dependencies and try again.";
      case "FFMPEG_NOT_INSTALLED":
        return "FFmpeg is missing, so audio playback cannot start yet.";
      case "FFMPEG_EXITED":
        return "FFmpeg could not open the audio stream for that track.";
      case "VOICE_ALREADY_CREATED":
        return "The bot is already connected in another voice channel.";
      case "VOICE_CONNECT_FAILED":
      case "VOICE_RECONNECT_FAILED":
        return "I could not connect to that voice channel.";
      case "VOICE_MISSING_PERMS":
        return "I need permission to join and speak in that voice channel.";
      case "VOICE_FULL":
        return "That voice channel is full.";
      default:
        break;
    }

    if (error instanceof Error && error.message) {
      if (error.message.includes("Failed to find any playable formats")) {
        return "YouTube did not offer a usable audio stream for that track.";
      }

      return error.message;
    }

    return "Something went wrong while handling the player command.";
  }
}

module.exports = {
  PlayerService,
};

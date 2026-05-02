const { DisTubeError, ExtractorPlugin, Playlist, Song } = require("distube");
const { getInfo, isYouTubeUrl } = require("./yt-dlp");

const MAX_SPOTIFY_FALLBACK_CANDIDATES = 3;

function getBestThumbnail(info) {
  if (info.thumbnail) {
    return info.thumbnail;
  }

  if (Array.isArray(info.thumbnails) && info.thumbnails.length > 0) {
    const bestThumbnail = info.thumbnails
      .filter((thumbnail) => thumbnail?.url)
      .sort((left, right) => {
        const leftArea = Number(left.width || 0) * Number(left.height || 0);
        const rightArea = Number(right.width || 0) * Number(right.height || 0);
        return rightArea - leftArea;
      })[0];

    return bestThumbnail?.url;
  }

  return undefined;
}

function createSongInfo(plugin, info) {
  return {
    plugin,
    source: info.extractor || "youtube",
    playFromSource: true,
    id: String(info.id),
    name: info.title || info.fulltitle,
    url: info.webpage_url || info.original_url,
    isLive: Boolean(info.is_live),
    thumbnail: getBestThumbnail(info),
    duration: info.is_live ? 0 : info.duration,
    views: info.view_count,
    likes: info.like_count,
    uploader: {
      name: info.uploader,
      url: info.uploader_url,
    },
  };
}

function isSpotifyFallbackLookup(options = {}) {
  return options?.metadata?.spotifyTrackLookup === true;
}

function createSpotifyFallbackCandidate(info, index) {
  return {
    index,
    id: String(info.id),
    name: info.title || info.fulltitle || "Unknown title",
    url: info.webpage_url || info.original_url || null,
    isLive: Boolean(info.is_live),
    thumbnail: getBestThumbnail(info),
    duration: info.is_live ? 0 : Number(info.duration || 0),
    uploader: {
      name: info.uploader || "Unknown uploader",
      url: info.uploader_url || null,
    },
    streamUrl: info.url || null,
    streamMeta: {
      formatId: info.format_id || null,
      protocol: info.protocol || null,
      ext: info.ext || null,
      audioCodec: info.acodec || null,
      hasHeaders: Boolean(info.http_headers && Object.keys(info.http_headers).length > 0),
    },
  };
}

function applySpotifyFallbackCandidate(song, candidate) {
  if (!song || !candidate) {
    return song;
  }

  song.id = candidate.id;
  song.name = candidate.name;
  song.url = candidate.url;
  song.isLive = candidate.isLive;
  song.thumbnail = candidate.thumbnail;
  song.duration = candidate.duration;
  song.uploader = {
    name: candidate.uploader?.name,
    url: candidate.uploader?.url,
  };
  song.stream.url = candidate.streamUrl;
  song.stream.spotifyFallbackCandidateIndex = candidate.index;
  song.stream.spotifyFallbackCurrentCandidate = candidate;
  song.stream.spotifyFallbackStreamMeta = candidate.streamMeta;

  return song;
}

function attachSpotifyFallbackState(song, candidates, query) {
  if (!song || !Array.isArray(candidates) || candidates.length === 0) {
    return song;
  }

  song.stream.spotifyFallbackCandidates = candidates;
  song.stream.spotifyFallbackQuery = query;
  song.stream.spotifyFallbackCandidateCount = candidates.length;

  return applySpotifyFallbackCandidate(song, candidates[0]);
}

async function buildSpotifyFallbackCandidates(query) {
  const info = await getInfo(query, { defaultSearch: `ytsearch${MAX_SPOTIFY_FALLBACK_CANDIDATES}` });
  const entries = (Array.isArray(info.entries) ? info.entries : [info])
    .filter(Boolean)
    .slice(0, MAX_SPOTIFY_FALLBACK_CANDIDATES);

  if (entries.length === 0) {
    return [];
  }

  const detailedCandidates = await Promise.allSettled(
    entries.map(async (entry, index) => {
      const url = entry.webpage_url || entry.original_url;
      if (!url) {
        return null;
      }

      const detailedInfo = await getInfo(url, { format: "ba/ba*" });
      if (Array.isArray(detailedInfo.entries) || !detailedInfo.url) {
        return null;
      }

      return createSpotifyFallbackCandidate(detailedInfo, index);
    }),
  );

  return detailedCandidates
    .filter((result) => result.status === "fulfilled" && result.value?.streamUrl)
    .map((result) => result.value);
}

class YtDlpYouTubeSong extends Song {
  constructor(plugin, info, options = {}) {
    super(createSongInfo(plugin, info), options);
  }
}

class YtDlpYouTubePlaylist extends Playlist {
  constructor(plugin, info, options = {}) {
    const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];

    super(
      {
        source: info.extractor || "youtube",
        songs: entries.map((entry) => new YtDlpYouTubeSong(plugin, entry, options)),
        id: info.id ? String(info.id) : undefined,
        name: info.title,
        url: info.webpage_url || info.original_url,
        thumbnail: getBestThumbnail(info),
      },
      options,
    );
  }
}

class YtDlpYouTubePlugin extends ExtractorPlugin {
  async validate(url) {
    return isYouTubeUrl(url);
  }

  async resolve(url, options = {}) {
    const info = await getInfo(url);

    if (Array.isArray(info.entries)) {
      const playlist = new YtDlpYouTubePlaylist(this, info, options);
      if (playlist.songs.length === 0) {
        throw new DisTubeError("YTDLP_ERROR", "The YouTube playlist is empty.");
      }

      return playlist;
    }

    return new YtDlpYouTubeSong(this, info, options);
  }

  async searchSong(query, options = {}) {
    if (isSpotifyFallbackLookup(options)) {
      const candidates = await buildSpotifyFallbackCandidates(query);
      if (candidates.length > 0) {
        const song = new YtDlpYouTubeSong(
          this,
          {
            extractor: "youtube",
            id: candidates[0].id,
            title: candidates[0].name,
            webpage_url: candidates[0].url,
            original_url: candidates[0].url,
            is_live: candidates[0].isLive,
            thumbnail: candidates[0].thumbnail,
            duration: candidates[0].duration,
            uploader: candidates[0].uploader?.name,
            uploader_url: candidates[0].uploader?.url,
          },
          options,
        );

        return attachSpotifyFallbackState(song, candidates, query);
      }
    }

    const info = await getInfo(query, { defaultSearch: "ytsearch1" });
    const firstEntry = Array.isArray(info.entries) ? info.entries.find(Boolean) : info;

    if (!firstEntry) {
      return null;
    }

    return new YtDlpYouTubeSong(this, firstEntry, options);
  }

  async getStreamURL(song) {
    if (!song.url) {
      throw new DisTubeError("YTDLP_ERROR", "Cannot get a stream URL for a song without a URL.");
    }

    const currentCandidate = song.stream?.spotifyFallbackCurrentCandidate;
    if (currentCandidate?.streamUrl) {
      return currentCandidate.streamUrl;
    }

    const info = await getInfo(song.url, { format: "ba/ba*" });
    if (Array.isArray(info.entries)) {
      throw new DisTubeError("YTDLP_ERROR", "Cannot get a stream URL for an entire playlist.");
    }

    if (!info.url) {
      throw new DisTubeError("YTDLP_ERROR", "yt-dlp did not return a playable audio URL.");
    }

    return info.url;
  }
}

module.exports = {
  YtDlpYouTubePlugin,
};

const ffmpegStatic = require("ffmpeg-static");
const { DisTube } = require("distube");
const { SoundCloudPlugin } = require("@distube/soundcloud");
const { SpotifyPlugin } = require("@distube/spotify");
const { YtDlpYouTubePlugin } = require("./yt-dlp-youtube-plugin");

function normalizeSpotifyArtworkURL(url) {
  if (typeof url !== "string" || !url) {
    return null;
  }

  return url.replace(/^https:\/\/image-cdn-[^.]+\.spotifycdn\.com\/image\//i, "https://i.scdn.co/image/");
}

function getSpotifyImageArea(image) {
  const width = Number(image?.width ?? image?.maxWidth ?? 0);
  const height = Number(image?.height ?? image?.maxHeight ?? 0);
  return width * height;
}

function getBestSpotifyArtwork(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return null;
  }

  const bestImage = images
    .filter((image) => typeof image?.url === "string" && image.url)
    .sort((left, right) => getSpotifyImageArea(right) - getSpotifyImageArea(left))[0];

  return normalizeSpotifyArtworkURL(bestImage?.url || null);
}

function applySpotifyArtwork(trackData, fallbackArtwork = null) {
  if (!trackData || typeof trackData !== "object") {
    return trackData;
  }

  const artwork =
    normalizeSpotifyArtworkURL(trackData.thumbnail) ||
    getBestSpotifyArtwork(trackData.album?.images) ||
    getBestSpotifyArtwork(trackData.visualIdentity?.image) ||
    getBestSpotifyArtwork(trackData.coverArt?.sources) ||
    normalizeSpotifyArtworkURL(fallbackArtwork);

  if (artwork) {
    trackData.thumbnail = artwork;
  }

  return trackData;
}

function patchSpotifyPluginArtwork(spotifyPlugin) {
  const originalGetData = spotifyPlugin.api.getData.bind(spotifyPlugin.api);

  spotifyPlugin.api.getData = async (url) => {
    const data = await originalGetData(url);

    if (!data || typeof data !== "object") {
      return data;
    }

    if (data.type === "track") {
      return applySpotifyArtwork(data);
    }

    const collectionArtwork =
      normalizeSpotifyArtworkURL(data.thumbnail) ||
      getBestSpotifyArtwork(data.visualIdentity?.image) ||
      getBestSpotifyArtwork(data.coverArt?.sources);

    if (collectionArtwork) {
      data.thumbnail = collectionArtwork;
    }

    if (Array.isArray(data.tracks)) {
      data.tracks = data.tracks.map((track) => applySpotifyArtwork(track, collectionArtwork));
    }

    return data;
  };

  return spotifyPlugin;
}

function createDisTube(client, config) {
  const spotifyApi =
    config.spotifyClientId && config.spotifyClientSecret
      ? {
          clientId: config.spotifyClientId,
          clientSecret: config.spotifyClientSecret,
          topTracksCountry: config.spotifyTopTracksCountry,
        }
      : undefined;

  const soundCloudOptions = {};

  if (config.soundCloudClientId) {
    soundCloudOptions.clientId = config.soundCloudClientId;
  }

  if (config.soundCloudOauthToken) {
    soundCloudOptions.oauthToken = config.soundCloudOauthToken;
  }

  const spotifyPlugin = patchSpotifyPluginArtwork(new SpotifyPlugin({ api: spotifyApi }));

  return new DisTube(client, {
    emitNewSongOnly: false,
    joinNewVoiceChannel: false,
    ffmpeg: {
      path: ffmpegStatic || "ffmpeg",
    },
    plugins: [
      spotifyPlugin,
      new YtDlpYouTubePlugin(),
      new SoundCloudPlugin(soundCloudOptions),
    ],
  });
}

module.exports = {
  createDisTube,
};

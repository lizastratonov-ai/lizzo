const { formatTimestamp, parseTimestamp } = require("./time");

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
]);

function normalizeHost(hostname) {
  return (hostname || "").toLowerCase().replace(/^(www\.|m\.|music\.)/i, "");
}

function isYouTubeHost(hostname) {
  return YOUTUBE_HOSTS.has(normalizeHost(hostname));
}

function toURL(input) {
  if (typeof input !== "string") {
    return null;
  }

  try {
    return new URL(input);
  } catch {
    if (/^(?:www\.|m\.|music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(input.trim())) {
      try {
        return new URL(`https://${input.trim()}`);
      } catch {
        return null;
      }
    }

    return null;
  }
}

function isDirectYouTubeVideoURL(url) {
  const host = normalizeHost(url.hostname);
  const pathname = url.pathname || "";

  if (host === "youtu.be") {
    return pathname.length > 1;
  }

  if ((host === "youtube.com" || host === "youtube-nocookie.com") && pathname === "/watch") {
    return url.searchParams.has("v");
  }

  return ["/shorts/", "/live/", "/embed/"].some((prefix) => pathname.startsWith(prefix));
}

function parseYouTubeTimeValue(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  const colonValue = parseTimestamp(normalized);
  if (colonValue !== null) {
    return colonValue;
  }

  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  const match = normalized.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
  if (!match || !(match[1] || match[2] || match[3])) {
    return null;
  }

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return (hours * 3600) + (minutes * 60) + seconds;
}

function parseHashTimeValue(hash) {
  const normalized = String(hash || "").replace(/^#/, "").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.includes("=")) {
    const params = new URLSearchParams(normalized);
    return parseYouTubeTimeValue(
      params.get("t") || params.get("start") || params.get("time_continue"),
    );
  }

  return parseYouTubeTimeValue(normalized);
}

function extractYouTubeStartInfo(input) {
  const url = toURL(input);
  if (!url || !isYouTubeHost(url.hostname)) {
    return {
      query: input,
      startTimeSeconds: null,
      startTimeLabel: null,
    };
  }

  const sanitizedURL = new URL(url.toString());
  const hasPlaylist = sanitizedURL.searchParams.has("list");
  const isDirectVideo = isDirectYouTubeVideoURL(sanitizedURL) && !hasPlaylist;

  const startTimeSeconds = isDirectVideo
    ? parseYouTubeTimeValue(
      sanitizedURL.searchParams.get("t")
        || sanitizedURL.searchParams.get("start")
        || sanitizedURL.searchParams.get("time_continue"),
    ) ?? parseHashTimeValue(sanitizedURL.hash)
    : null;

  sanitizedURL.searchParams.delete("t");
  sanitizedURL.searchParams.delete("start");
  sanitizedURL.searchParams.delete("time_continue");
  sanitizedURL.hash = "";

  return {
    query: sanitizedURL.toString(),
    startTimeSeconds: Number.isInteger(startTimeSeconds) && startTimeSeconds > 0 ? startTimeSeconds : null,
    startTimeLabel:
      Number.isInteger(startTimeSeconds) && startTimeSeconds > 0
        ? formatTimestamp(startTimeSeconds)
        : null,
  };
}

module.exports = {
  extractYouTubeStartInfo,
};

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DisTubeError } = require("distube");

const YOUTUBE_URL_PATTERN =
  /^(https?:\/\/)?(www\.)?(m\.)?(music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i;
const INFO_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 3 * 60 * 1000;
const STREAM_CACHE_TTL_MS = 60 * 1000;
const STREAM_EXPIRY_BUFFER_MS = 30 * 1000;
const MAX_INFO_CACHE_ENTRIES = 200;
const infoCache = new Map();

function isYouTubeUrl(value) {
  return YOUTUBE_URL_PATTERN.test(value || "");
}

function getBundledBinaryPath() {
  const entryFile = require.resolve("@distube/yt-dlp");
  const packageRoot = path.resolve(path.dirname(entryFile), "..");
  const filename = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  return path.join(packageRoot, "bin", filename);
}

function resolveYtDlpBinary() {
  const explicitPath = process.env.YTDLP_PATH?.trim();
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }

  const bundledPath = getBundledBinaryPath();
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

function buildCacheKey(input, options) {
  return JSON.stringify([
    input,
    options.defaultSearch || "",
    options.format || "",
  ]);
}

function getStreamExpiryTimeMs(info) {
  if (!info?.url) {
    return null;
  }

  try {
    const parsedUrl = new URL(info.url);
    const expiresAt = Number.parseInt(parsedUrl.searchParams.get("expire"), 10);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      return null;
    }

    return Math.max(Date.now() + 1000, (expiresAt * 1000) - STREAM_EXPIRY_BUFFER_MS);
  } catch {
    return null;
  }
}

function getCacheTtlMs(info, options) {
  if (options.format) {
    const streamExpiryTime = getStreamExpiryTimeMs(info);
    if (streamExpiryTime) {
      return Math.max(1000, streamExpiryTime - Date.now());
    }

    return STREAM_CACHE_TTL_MS;
  }

  if (options.defaultSearch) {
    return SEARCH_CACHE_TTL_MS;
  }

  return INFO_CACHE_TTL_MS;
}

function pruneInfoCache(now = Date.now()) {
  for (const [key, entry] of infoCache) {
    if (!entry.promise && entry.expiresAt <= now) {
      infoCache.delete(key);
    }
  }

  while (infoCache.size > MAX_INFO_CACHE_ENTRIES) {
    const oldestKey = infoCache.keys().next().value;
    if (!oldestKey) {
      break;
    }

    infoCache.delete(oldestKey);
  }
}

function runYtDlp(args) {
  const binaryPath = resolveYtDlpBinary();

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new DisTubeError("YTDLP_ERROR", error.message));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new DisTubeError("YTDLP_ERROR", (stderr || stdout || "yt-dlp failed").trim()));
        return;
      }

      if (!stdout.trim()) {
        reject(new DisTubeError("YTDLP_ERROR", "yt-dlp returned empty output."));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        const details = stderr.trim() || error.message;
        reject(new DisTubeError("YTDLP_ERROR", `Could not parse yt-dlp output: ${details}`));
      }
    });
  });
}

async function getInfo(input, options = {}) {
  const cacheKey = buildCacheKey(input, options);
  const now = Date.now();
  const cachedEntry = infoCache.get(cacheKey);

  if (cachedEntry?.promise) {
    return cachedEntry.promise;
  }

  if (cachedEntry?.value && cachedEntry.expiresAt > now) {
    return cachedEntry.value;
  }

  if (cachedEntry) {
    infoCache.delete(cacheKey);
  }

  pruneInfoCache(now);

  const args = [
    input,
    "--dump-single-json",
    "--no-warnings",
    "--prefer-free-formats",
    "--skip-download",
    "--simulate",
  ];

  if (options.defaultSearch) {
    args.push("--default-search", options.defaultSearch);
  }

  if (options.format) {
    args.push("--format", options.format);
  }

  const pendingLookup = runYtDlp(args)
    .then((info) => {
      const ttlMs = getCacheTtlMs(info, options);
      infoCache.delete(cacheKey);

      if (ttlMs > 0) {
        infoCache.set(cacheKey, {
          value: info,
          expiresAt: Date.now() + ttlMs,
        });
        pruneInfoCache();
      }

      return info;
    })
    .catch((error) => {
      infoCache.delete(cacheKey);
      throw error;
    });

  infoCache.set(cacheKey, {
    promise: pendingLookup,
    expiresAt: now + STREAM_CACHE_TTL_MS,
  });

  return pendingLookup;
}

module.exports = {
  getInfo,
  isYouTubeUrl,
  resolveYtDlpBinary,
};

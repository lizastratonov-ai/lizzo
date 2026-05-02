function parseTimestamp(input) {
  if (!input) {
    return null;
  }

  const normalized = input.trim();

  if (!normalized) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  const parts = normalized.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  if (parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }

  const numbers = parts.map(Number);

  if (numbers.some((value) => value < 0)) {
    return null;
  }

  if (numbers.length === 2) {
    const [minutes, seconds] = numbers;
    return (minutes * 60) + seconds;
  }

  const [hours, minutes, seconds] = numbers;
  return (hours * 3600) + (minutes * 60) + seconds;
}

function formatTimestamp(totalSeconds) {
  const wholeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  }

  return [minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatDateTime(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    ...options,
  }).format(date);
}

module.exports = {
  formatDateTime,
  formatTimestamp,
  parseTimestamp,
};

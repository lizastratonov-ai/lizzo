const fs = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const HISTORY_RETENTION_DAYS = 30;
const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const HISTORY_DB_PATH = path.resolve(__dirname, "..", "..", "data", "play-history.sqlite");
const LEGACY_HISTORY_FILE_PATH = path.resolve(__dirname, "..", "..", "data", "play-history.json");
const LEGACY_HISTORY_BACKUP_PATH = path.resolve(__dirname, "..", "..", "data", "play-history.json.migrated.bak");

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const queuedAtMs = Number(entry.queuedAtMs);
  if (!Number.isFinite(queuedAtMs) || queuedAtMs <= 0) {
    return null;
  }

  return {
    title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : "Unknown title",
    source: typeof entry.source === "string" && entry.source.trim() ? entry.source.trim() : "unknown",
    userId: entry.userId ? String(entry.userId) : null,
    queuedAtMs,
  };
}

class HistoryStore {
  constructor({
    dbPath = HISTORY_DB_PATH,
    legacyFilePath = LEGACY_HISTORY_FILE_PATH,
    legacyBackupPath = LEGACY_HISTORY_BACKUP_PATH,
    retentionMs = HISTORY_RETENTION_MS,
  } = {}) {
    this.dbPath = dbPath;
    this.legacyFilePath = legacyFilePath;
    this.legacyBackupPath = legacyBackupPath;
    this.retentionMs = retentionMs;
    this.db = null;
    this.countEntriesStmt = null;
    this.insertEntryStmt = null;
    this.selectEntriesStmt = null;
    this.deleteExpiredStmt = null;
  }

  async load() {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.#initializeSchema();
    await this.#migrateLegacyJsonIfNeeded();
    this.pruneExpiredEntries();
  }

  getEntries(guildId) {
    if (!guildId) {
      return [];
    }

    this.#ensureLoaded();
    this.pruneExpiredEntries();

    return this.selectEntriesStmt
      .all(guildId, Date.now() - this.retentionMs)
      .map(normalizeHistoryEntry)
      .filter(Boolean);
  }

  addEntry(guildId, entry) {
    if (!guildId) {
      return;
    }

    this.#ensureLoaded();

    const normalizedEntry = normalizeHistoryEntry(entry);
    if (!normalizedEntry) {
      return;
    }

    this.insertEntryStmt.run(
      guildId,
      normalizedEntry.title,
      normalizedEntry.source,
      normalizedEntry.userId,
      normalizedEntry.queuedAtMs,
    );
    this.pruneExpiredEntries();
  }

  pruneExpiredEntries(now = Date.now()) {
    this.#ensureLoaded();
    this.deleteExpiredStmt.run(now - this.retentionMs);
  }

  async flush() {
    this.#ensureLoaded();
  }

  async close() {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = null;
    this.countEntriesStmt = null;
    this.insertEntryStmt = null;
    this.selectEntriesStmt = null;
    this.deleteExpiredStmt = null;
  }

  #ensureLoaded() {
    if (!this.db) {
      throw new Error("History store is not loaded.");
    }
  }

  #initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS playback_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        user_id TEXT,
        queued_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_playback_history_guild_time
        ON playback_history (guild_id, queued_at_ms DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_playback_history_time
        ON playback_history (queued_at_ms);
    `);

    this.countEntriesStmt = this.db.prepare("SELECT COUNT(*) AS count FROM playback_history");
    this.insertEntryStmt = this.db.prepare(`
      INSERT INTO playback_history (guild_id, title, source, user_id, queued_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.selectEntriesStmt = this.db.prepare(`
      SELECT title, source, user_id AS userId, queued_at_ms AS queuedAtMs
      FROM playback_history
      WHERE guild_id = ? AND queued_at_ms >= ?
      ORDER BY queued_at_ms DESC, id DESC
    `);
    this.deleteExpiredStmt = this.db.prepare(`
      DELETE FROM playback_history
      WHERE queued_at_ms < ?
    `);
  }

  async #migrateLegacyJsonIfNeeded() {
    const row = this.countEntriesStmt.get();
    if (Number(row?.count) > 0) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.legacyFilePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }

      console.warn("Failed to read the legacy JSON history file. Skipping migration:", error);
      return;
    }

    const guilds = parsed?.guilds && typeof parsed.guilds === "object" ? parsed.guilds : {};
    const entriesToImport = [];

    for (const [guildId, entries] of Object.entries(guilds)) {
      if (!Array.isArray(entries)) {
        continue;
      }

      for (const entry of entries) {
        const normalizedEntry = normalizeHistoryEntry(entry);
        if (normalizedEntry) {
          entriesToImport.push({
            guildId,
            ...normalizedEntry,
          });
        }
      }
    }

    if (entriesToImport.length === 0) {
      return;
    }

    entriesToImport.sort((left, right) => left.queuedAtMs - right.queuedAtMs);

    this.db.exec("BEGIN");

    try {
      for (const entry of entriesToImport) {
        this.insertEntryStmt.run(
          entry.guildId,
          entry.title,
          entry.source,
          entry.userId,
          entry.queuedAtMs,
        );
      }

      this.db.exec("COMMIT");
      this.pruneExpiredEntries();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    await fs.rm(this.legacyBackupPath, { force: true });
    await fs.rename(this.legacyFilePath, this.legacyBackupPath).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

module.exports = {
  HISTORY_RETENTION_DAYS,
  HistoryStore,
};

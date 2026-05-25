import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'mrn.sqlite');
const configuredDbPath = String(process.env.MRN_DB_PATH || '').trim();
const resolvedDbPath = configuredDbPath
  ? (path.isAbsolute(configuredDbPath) ? configuredDbPath : path.resolve(__dirname, configuredDbPath))
  : DEFAULT_DB_PATH;
const activeDriver = 'sqlite';

let database = null;
let statements = null;
let writeQueue = Promise.resolve();

const debug = (message, details = '') => {
  if (process.env.DEBUG_DB === 'true') {
    console.log(`[DB] ${message}`, details ? JSON.stringify(details) : '');
  }
};

const initializeStatements = (db) => ({
  selectState: db.prepare(`
    SELECT payload
    FROM app_state
    WHERE state_key = ?
  `),
  upsertState: db.prepare(`
    INSERT INTO app_state (state_key, payload, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(state_key) DO UPDATE SET
      payload = excluded.payload,
      updated_at = CURRENT_TIMESTAMP
  `),
});

const initializeSqlite = () => {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

  database = new DatabaseSync(resolvedDbPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS app_state (
      state_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_app_state_updated_at
      ON app_state(updated_at);
  `);

  statements = initializeStatements(database);
  debug('SQLite database initialized', { path: resolvedDbPath });
  return database;
};

const ensureDatabase = () => initializeSqlite();

const cloneFallback = (value) => structuredClone(value);

const serializePayload = (value) => JSON.stringify(value ?? null);

const deserializePayload = (key, payload) => {
  try {
    return JSON.parse(payload);
  } catch (err) {
    console.error(`[DB ERROR] Failed to parse payload for "${key}"`, err?.message || err || '');
    return null;
  }
};

const saveToSqlite = (key, value) => {
  const db = ensureDatabase();
  statements ??= initializeStatements(db);
  statements.upsertState.run(key, serializePayload(value));
};

const queueWrite = (operation) => {
  writeQueue = writeQueue
    .then(operation)
    .catch((err) => {
      console.error('[DB ERROR] Database write failed', err?.message || err || '');
      throw err;
    });

  return writeQueue;
};

export const initializeDatabase = async () => {
  ensureDatabase();
};

export const getDatabaseDriver = () => activeDriver;

export const loadCollection = async (key, fallbackValue) => {
  ensureDatabase();

  try {
    const row = statements.selectState.get(key);

    if (!row) {
      const initialValue = cloneFallback(fallbackValue);
      await saveCollectionStrict(key, initialValue);
      return initialValue;
    }

    const parsedValue = deserializePayload(key, row.payload);
    if (parsedValue === null) {
      const initialValue = cloneFallback(fallbackValue);
      await saveCollectionStrict(key, initialValue);
      return initialValue;
    }

    return parsedValue;
  } catch (err) {
    console.error(`[DB ERROR] Error loading collection "${key}"`, err?.message || err || '');
    const initialValue = cloneFallback(fallbackValue);
    await saveCollectionStrict(key, initialValue);
    return initialValue;
  }
};

export const saveCollection = (key, value) =>
  queueWrite(async () => {
    saveToSqlite(key, value);
  });

export const saveCollectionStrict = async (key, value) => {
  saveToSqlite(key, value);
};

export const closeDatabase = async () => {
  if (!database) {
    return;
  }

  database.close();
  database = null;
  statements = null;
  debug('SQLite database closed', { path: resolvedDbPath });
};

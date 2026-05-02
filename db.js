import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'mrn.sqlite');

let db;

const getDatabase = () => {
  if (db) {
    return db;
  }

  const databasePath = process.env.MRN_DB_PATH || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_state (
      state_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  return db;
};

export const initializeDatabase = () => {
  getDatabase();
};

export const loadCollection = (key, fallbackValue) => {
  const database = getDatabase();
  const row = database
    .prepare('SELECT payload FROM app_state WHERE state_key = ?')
    .get(key);

  if (!row) {
    const initialValue = structuredClone(fallbackValue);
    saveCollection(key, initialValue);
    return initialValue;
  }

  try {
    return JSON.parse(row.payload);
  } catch {
    const initialValue = structuredClone(fallbackValue);
    saveCollection(key, initialValue);
    return initialValue;
  }
};

export const saveCollection = (key, value) => {
  const database = getDatabase();
  const now = new Date().toISOString();

  database.prepare(`
    INSERT INTO app_state (state_key, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now);
};


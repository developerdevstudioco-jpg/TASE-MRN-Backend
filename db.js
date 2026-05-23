import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQLITE_DB_PATH = path.join(__dirname, 'data', 'mrn.sqlite');

let activeDriver = null;
let sqliteDb = null;
let pgPool = null;
let writeQueue = Promise.resolve();

const isLocalPostgresUrl = (connectionString) =>
  /localhost|127\.0\.0\.1/i.test(connectionString);

const getPostgresSslConfig = (connectionString) => {
  const sslMode = String(process.env.POSTGRES_SSL_MODE || '').trim().toLowerCase();

  if (sslMode === 'disable') {
    return false;
  }

  if (sslMode === 'require') {
    return { rejectUnauthorized: false };
  }

  return isLocalPostgresUrl(connectionString) ? false : { rejectUnauthorized: false };
};

const ensureSqliteDriver = () => {
  if (sqliteDb) {
    activeDriver = 'sqlite';
    return;
  }

  const databasePath = process.env.MRN_DB_PATH || DEFAULT_SQLITE_DB_PATH;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  sqliteDb = new DatabaseSync(databasePath);
  sqliteDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_state (
      state_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  activeDriver = 'sqlite';
};

const ensurePostgresDriver = async () => {
  if (pgPool) {
    activeDriver = 'postgres';
    return;
  }

  const connectionString = process.env.DATABASE_URL || process.env.RENDER_POSTGRES_URL;
  if (!connectionString) {
    ensureSqliteDriver();
    return;
  }

  pgPool = new Pool({
    connectionString,
    ssl: getPostgresSslConfig(connectionString),
  });

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      state_key TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  activeDriver = 'postgres';
};

const ensureDriver = async () => {
  if (activeDriver === 'postgres' || activeDriver === 'sqlite') {
    return;
  }

  await ensurePostgresDriver();
};

const loadFromSqlite = (key) => {
  const row = sqliteDb
    .prepare('SELECT payload FROM app_state WHERE state_key = ?')
    .get(key);

  return row ? JSON.parse(row.payload) : null;
};

const saveToSqlite = (key, value) => {
  const now = new Date().toISOString();

  sqliteDb.prepare(`
    INSERT INTO app_state (state_key, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now);
};

const loadFromPostgres = async (key) => {
  const result = await pgPool.query(
    'SELECT payload FROM app_state WHERE state_key = $1',
    [key]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0].payload;
};

const saveToPostgres = async (key, value) => {
  await pgPool.query(`
    INSERT INTO app_state (state_key, payload, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT(state_key) DO UPDATE SET
      payload = EXCLUDED.payload,
      updated_at = EXCLUDED.updated_at
  `, [key, JSON.stringify(value)]);
};

const queueWrite = (operation) => {
  writeQueue = writeQueue
    .then(operation)
    .catch((error) => {
      console.error('Database write failed:', error);
      throw error;
    });

  return writeQueue;
};

export const initializeDatabase = async () => {
  await ensureDriver();
};

export const getDatabaseDriver = () => activeDriver;

export const loadCollection = async (key, fallbackValue) => {
  await ensureDriver();

  try {
    const row = activeDriver === 'postgres'
      ? await loadFromPostgres(key)
      : loadFromSqlite(key);

    if (row == null) {
      const initialValue = structuredClone(fallbackValue);
      await saveCollectionStrict(key, initialValue);
      return initialValue;
    }

    return typeof row === 'string' ? JSON.parse(row) : row;
  } catch {
    const initialValue = structuredClone(fallbackValue);
    await saveCollectionStrict(key, initialValue);
    return initialValue;
  }
};

export const saveCollection = (key, value) =>
  queueWrite(async () => {
    await ensureDriver();

    if (activeDriver === 'postgres') {
      await saveToPostgres(key, value);
      return;
    }

    saveToSqlite(key, value);
  });

export const saveCollectionStrict = async (key, value) => {
  await ensureDriver();

  if (activeDriver === 'postgres') {
    await saveToPostgres(key, value);
    return;
  }

  saveToSqlite(key, value);
};


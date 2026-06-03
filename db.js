import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'mrn.sqlite');
const configuredDbPath = String(process.env.MRN_DB_PATH || '').trim();
const resolvedDbPath = configuredDbPath
  ? (path.isAbsolute(configuredDbPath) ? configuredDbPath : path.resolve(__dirname, configuredDbPath))
  : DEFAULT_DB_PATH;

const configuredDriver = String(process.env.MRN_DB_DRIVER || 'postgres').trim().toLowerCase();
const activeDriver = ['postgres', 'postgresql', 'pg'].includes(configuredDriver)
  ? 'postgres'
  : configuredDriver === 'sqlite'
    ? 'sqlite'
    : 'postgres';

let database = null; // sqlite DatabaseSync instance
let statements = null;
let writeQueue = Promise.resolve();
let pgPool = null; // Postgres Pool when using postgres

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

const initializeSqlite = async () => {
  if (database) {
    return database;
  }

  const fs = await requireNodeFs();
  const DatabaseSync = await requireNodeSqlite();

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

const requireNodeFs = async () => import('node:fs');

const requireNodeSqlite = async () => {
  const sqliteModule = await import('node:sqlite');
  return sqliteModule.DatabaseSync;
};

const initializePostgres = async () => {
  if (pgPool) return pgPool;

  const connectionString = String(
    process.env.MRN_DATABASE_URL || process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || ''
  ).trim();

  if (!connectionString) {
    throw new Error('MRN_DATABASE_URL or DATABASE_URL must be set for PostgreSQL storage');
  }

  const { Pool } = await import('pg');

  const sslMode = String(process.env.PGSSLMODE || '').trim().toLowerCase();
  const sslDisabled = sslMode === 'disable' || process.env.PGDONTVERIFY === 'true';
  const ssl = sslDisabled ? false : { rejectUnauthorized: false };

  pgPool = new Pool({ connectionString, ssl });

  // Ensure table exists
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      state_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_app_state_updated_at
      ON app_state(updated_at);
  `);

  debug('Postgres database initialized');
  return pgPool;
};

const ensureDatabase = () => {
  if (activeDriver === 'postgres') {
    return initializePostgres();
  }

  return initializeSqlite();
};

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

const saveToSqlite = async (key, value) => {
  const db = await initializeSqlite();
  statements ??= initializeStatements(db);
  statements.upsertState.run(key, serializePayload(value));
};

const saveToPostgres = async (key, value) => {
  const pool = await initializePostgres();
  await pool.query(
    `INSERT INTO app_state (state_key, payload, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (state_key) DO UPDATE SET
       payload = EXCLUDED.payload,
       updated_at = EXCLUDED.updated_at`,
    [key, serializePayload(value)]
  );
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
  await ensureDatabase();
};

export const getDatabaseDriver = () => activeDriver;

export const loadCollection = async (key, fallbackValue) => {
  if (activeDriver === 'postgres') {
    try {
      const pool = await initializePostgres();
      const res = await pool.query('SELECT payload FROM app_state WHERE state_key = $1', [key]);
      if (!res.rows || res.rows.length === 0) {
        const initialValue = cloneFallback(fallbackValue);
        await saveCollectionStrict(key, initialValue);
        return initialValue;
      }

      const parsed = deserializePayload(key, res.rows[0].payload);
      if (parsed === null) {
        const initialValue = cloneFallback(fallbackValue);
        await saveCollectionStrict(key, initialValue);
        return initialValue;
      }

      return parsed;
    } catch (err) {
      console.error(`[DB ERROR] Error loading collection "${key}"`, err?.message || err || '');
      const initialValue = cloneFallback(fallbackValue);
      await saveCollectionStrict(key, initialValue);
      return initialValue;
    }
  }

  // sqlite path
  await ensureDatabase();

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
    if (activeDriver === 'postgres') {
      await saveToPostgres(key, value);
      return;
    }

    await saveToSqlite(key, value);
  });

export const saveCollectionStrict = async (key, value) => {
  if (activeDriver === 'postgres') {
    await saveToPostgres(key, value);
    return;
  }

  await saveToSqlite(key, value);
};

export const closeDatabase = async () => {
  if (activeDriver === 'postgres') {
    if (!pgPool) return;
    await pgPool.end();
    pgPool = null;
    debug('Postgres pool closed');
    return;
  }

  if (!database) {
    return;
  }

  database.close();
  database = null;
  statements = null;
  debug('SQLite database closed', { path: resolvedDbPath });
};

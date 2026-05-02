# TASE Digital MRN Backend

This backend provides the Express API for the MRN frontend.

## Production-focused changes

- PostgreSQL-backed persistence when `DATABASE_URL` is set
- SQLite fallback for local development when `DATABASE_URL` is not set
- Passwords stored as salted `scrypt` hashes instead of plaintext
- Config-driven admin bootstrap and JWT secret handling
- Configurable CORS allowlist
- Health endpoints at `/healthz` and `/readyz`
- Basic security headers and bounded JSON payload size

## Setup

1. Install dependencies

   ```bash
   cd backend
   npm install
   ```

2. Copy `backend/.env.example` to `.env` and fill the required values

3. Start the backend

   ```bash
   npm run dev
   ```

## Important environment variables

- `NODE_ENV`
- `PORT`
- `JWT_SECRET`
- `DATABASE_URL`
- `POSTGRES_SSL_MODE`
- `ADMIN_EMAIL`
- `ADMIN_EMPLOYEE_CODE`
- `ADMIN_PASSWORD`
- `CORS_ORIGINS`
- `MRN_DB_PATH`
- `MAIL_HOST`
- `MAIL_PORT`
- `MAIL_SECURE`
- `MAIL_USER`
- `MAIL_PASS`
- `MAIL_FROM`

## Notes

- In production, set `JWT_SECRET`, `DATABASE_URL`, `ADMIN_PASSWORD`, and `CORS_ORIGINS`.
- When `DATABASE_URL` is present, the backend persists app state in PostgreSQL.
- When `DATABASE_URL` is absent, the backend falls back to local SQLite at `backend/data/mrn.sqlite`.

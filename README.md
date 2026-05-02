# TASE Digital MRN Backend

This backend provides the Express API for the MRN frontend.

## Production-focused changes

- SQLite-backed persistence in `backend/data/mrn.sqlite`
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

- In production, set `JWT_SECRET`, `ADMIN_PASSWORD`, and `CORS_ORIGINS`.
- On first run, the SQLite database is seeded with demo data and then persisted across restarts.
- For long-term production scale, PostgreSQL is still the better target database for this app.

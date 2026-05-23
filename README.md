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

2. Ensure `backend/.env` exists and contains the required values

3. Start the backend

   ```bash
   npm run dev
   ```

## Important environment variables

- `NODE_ENV`
- `PORT`
- `JWT_SECRET`
- `DATABASE_URL`
- `RENDER_POSTGRES_URL`
- `POSTGRES_SSL_MODE`
- `ADMIN_NAME`
- `ADMIN_EMAIL`
- `ADMIN_EMPLOYEE_CODE`
- `ADMIN_PASSWORD`
- `SECONDARY_ADMIN_NAME`
- `SECONDARY_ADMIN_EMAIL`
- `SECONDARY_ADMIN_EMPLOYEE_CODE`
- `SECONDARY_ADMIN_PASSWORD`
- `CORS_ORIGINS`
- `MRN_DB_PATH`
- `TRUST_PROXY`
- `MAIL_HOST`
- `MAIL_PORT`
- `MAIL_SECURE`
- `MAIL_ENCRYPTION`
- `MAIL_USER`
- `MAIL_PASS`
- `MAIL_FROM`
- `BREVO_USE_API`
- `BREVO_API_KEY`
- `APP_FRONTEND_URL`
- `APP_BACKEND_URL`
- `PUPPETEER_EXECUTABLE_PATH`
- `CHROME_BIN`

## Notes

- In production, set `JWT_SECRET`, `DATABASE_URL`, `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_EMPLOYEE_CODE`, `ADMIN_PASSWORD`, and `CORS_ORIGINS`.
- When `DATABASE_URL` is present, the backend persists app state in PostgreSQL.
- When `DATABASE_URL` is absent, the backend falls back to local SQLite at `backend/data/mrn.sqlite`.
- The primary bootstrap admin signs in with the configured employee code or admin email. Keep those values in `backend/.env`, not in source code.
- You can optionally configure one additional bootstrap admin by setting `SECONDARY_ADMIN_EMAIL`, `SECONDARY_ADMIN_EMPLOYEE_CODE`, and `SECONDARY_ADMIN_PASSWORD`.

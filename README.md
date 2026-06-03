# TASE Digital MRN Backend

This backend provides the Express API for the MRN frontend and persists app data in PostgreSQL.

## Setup

1. Install dependencies

   ```bash
   cd backend
   npm install
   ```

2. Ensure `backend/.env` contains your runtime values

3. Start the backend

   ```bash
   npm run dev
   ```

## Key environment variables

- `NODE_ENV`
- `PORT`
- `JWT_SECRET`
- `MRN_DB_DRIVER`
- `MRN_DATABASE_URL`
- `DATABASE_URL`
- `PGSSLMODE`
- `DEBUG_DB`
- `EMAIL_LOGO_URL`
- `EMAIL_LOGO_PATH`
- `ADMIN_NAME`
- `ADMIN_EMAIL`
- `ADMIN_EMPLOYEE_CODE`
- `ADMIN_PASSWORD`
- `SECONDARY_ADMIN_NAME`
- `SECONDARY_ADMIN_EMAIL`
- `SECONDARY_ADMIN_EMPLOYEE_CODE`
- `SECONDARY_ADMIN_PASSWORD`
- `CORS_ORIGINS`
- `FRONTEND_URL`
- `BACKEND_URL`
- `MAIL_HOST`
- `MAIL_PORT`
- `MAIL_SECURE`
- `MAIL_ENCRYPTION`
- `MAIL_USER`
- `MAIL_PASS`
- `MAIL_FROM`
- `BREVO_USE_API`
- `BREVO_API_KEY`

## Notes

- PostgreSQL is the default database driver.
- Set `MRN_DATABASE_URL` to the PostgreSQL connection string. `DATABASE_URL` is also supported for hosting providers that inject it automatically.
- Set `PGSSLMODE=disable` only for local PostgreSQL servers that do not use SSL. Hosted PostgreSQL providers usually require SSL.
- The legacy SQLite fallback is available only when `MRN_DB_DRIVER=sqlite`; relative `MRN_DB_PATH` values are resolved from the `backend/` directory.
- The backend keeps a production-safe logo copy at `backend/assets/logo.png`.
- App state is stored in the PostgreSQL `app_state` table as JSON payloads keyed by collection name.
- For production email branding, set `EMAIL_LOGO_URL` to a public HTTPS image URL if you do not want the backend to serve the logo itself.
- PDF export auto-detects installed browsers such as Chrome, Brave, Chromium, and Edge across common Windows, macOS, and Linux locations.

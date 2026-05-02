# TASE Digital MRN Backend

This backend provides a simple Express REST API for the MRN frontend.

## Features

- Demo authentication with JWT
- Employee code login for users and fixed email login for the primary admin
- Role-based access control for MRN workflows
- Nodemailer welcome emails for new users
- Endpoints for MRNs, users, and auth
- SQLite-backed persistence seeded for demo use on first run

## Setup

1. Install dependencies

   ```bash
   cd backend
   npm install
   ```

2. Start the backend

   ```bash
   npm run dev
   ```

3. The backend will run on `http://localhost:4000`

## Database

- The backend now stores app data in a local SQLite database at `backend/data/mrn.sqlite`
- On first run, the database is seeded with the same demo users and MRNs that were previously kept in memory
- To use a different database file path, set `MRN_DB_PATH`

## Environment variables

- `JWT_SECRET`
- `MAIL_HOST`
- `MAIL_PORT`
- `MAIL_SECURE`
- `MAIL_USER`
- `MAIL_PASS`
- `MAIL_FROM`
- `MRN_DB_PATH`

If mail variables are configured, the backend sends a welcome email with the user's name, employee code, and temporary password when a new user is created.

## Fixed admin account

- Email: `somaskandhanmj@gmail.com`
- Password: `Kandhan28@@`

Only one admin account is allowed. The primary admin cannot be duplicated, deactivated, or removed.

## API Endpoints

- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/mrns`
- `GET /api/mrns/:id`
- `POST /api/mrns`
- `PUT /api/mrns/:id/status`
- `GET /api/users`
- `PUT /api/users/:id`

## Notes

- This setup uses SQLite because it is the fastest way to add durable local persistence without extra infrastructure.
- For production, PostgreSQL is the better long-term choice for this app because the data is relational and the workflow will benefit from stronger concurrency handling, backups, and reporting support.
- Regular users sign in with employee code and password.
"# TASE-MRN-Backend" 

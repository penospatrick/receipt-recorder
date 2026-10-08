# Receipt Recorder

A phone-friendly receipt register with individual staff sign-in, permission-managed user groups, administrator-managed accounts, configurable receipt fields, and filtered Excel exports.

## Requirements

- Node.js 22
- A Supabase project for shared, cloud-hosted storage, or a writable disk for local SQLite
- HTTPS in production so the accounting session cookie is protected

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Set `ACCOUNTING_PASSWORD` to the initial **System Admin** password and replace `SESSION_SECRET` with a unique secret of at least 32 characters. The initial admin username defaults to `admin`; set `ADMIN_USERNAME` to change it before first launch.
4. For shared cloud storage, create a Supabase project and put its **PostgreSQL connection string** in `SUPABASE_DB_URL` or `DATABASE_URL` in `.env`. Find connection details in **Supabase Dashboard → Project Settings → Database → Connect**. Use the session pooler for servers where direct database connections are unavailable. The database credential is server-only; never put it in frontend code or commit it.
5. If this is an existing local installation, stop the app and run `npm run migrate:supabase` **before starting the app with the Supabase connection configured**. The migration preserves users, password hashes, groups, receipts, and custom fields. It only imports into an empty Supabase database and rolls back if an error occurs. Keep a backup of `data/receipts.sqlite` until the migrated app has been verified.
6. Start the app with `npm start` and open `http://localhost:3000`.

When `SUPABASE_DB_URL` or `DATABASE_URL` is set to a PostgreSQL URI, the server initializes and uses Supabase PostgreSQL. Otherwise, it uses local SQLite at `data/receipts.sqlite`. A PostgreSQL URI in `SUPABASE_URL` is also supported. To make the app accessible to staff outside your computer, deploy this Node.js server to a hosting service and configure the database URI, `ACCOUNTING_PASSWORD`, `ADMIN_USERNAME`, `SESSION_SECRET`, `NODE_ENV=production`, and `PORT` as private environment variables in the host. Set a custom start command of `npm start`; hosting and the database are separate services. Share the deployed **HTTPS** address with staff. Do not deploy as a static-only site.

## Deploy to Vercel

This project can run on Vercel as an Express application backed by Supabase. Import the GitHub repository as a new Vercel project and use the repository root; Vercel detects the root `server.js` Express entry point. The `vercel.json` configuration explicitly includes the database schema and Supabase root CA in that function. No build command, output directory, or catch-all rewrite is required. Vercel serves files in `public/` from its CDN, and the Express function handles API requests.

Add these environment variables in **Project Settings → Environment Variables**:

- `SUPABASE_DB_URL`: the PostgreSQL connection string from Supabase **Project Settings → Database → Connect**. Use the Supavisor transaction pooler for serverless deployments, and keep the URI private.
- `ACCOUNTING_PASSWORD`: a strong bootstrap password. It is used only if the initial admin account does not already exist in the database.
- `ADMIN_USERNAME`: `admin`, unless using a different bootstrap username.
- `SESSION_SECRET`: a unique random string of at least 32 characters.

Set the variables for the Production environment. For Preview deployments, use a separate Supabase project/database so preview testing cannot modify production receipts. Vercel provides HTTPS; the app automatically marks authentication cookies as secure and uses one database connection per function instance. SQLite is intentionally rejected on Vercel because its filesystem is not persistent. After deployment, check `/api/health`, sign in, and verify receipt entry and Excel export.

`ACCOUNTING_PASSWORD` is only used to create the initial administrator if that username is not already in the database. Changing the Vercel variable does not change an existing account's password; update it while signed in as an administrator.

The manifest pins Vercel to Node.js 22 and explicitly approves the pinned `better-sqlite3` native install script required by the local SQLite backend.

The server connects to PostgreSQL using `pg` and validates TLS against Supabase's public root CA (`certs/supabase-root-ca-2021.crt`); certificate verification stays enabled. The Supabase database password never reaches the browser. Row Level Security is enabled on the app tables. Keep the database connection string private and only use it as a server environment variable.

Run the API and Excel-export regression tests with `npm test`.

On a phone, open the deployed HTTPS address in the browser and use its **Add to Home Screen** / **Install app** action. The app shell can load offline, but saving receipts and exporting require a connection to the server.

## Default user groups

- **System Admin:** manage users and groups, configure fields, and access all receipt actions.
- **Field Officer:** create receipts and view receipts entered by that user.
- **Accounting:** view all receipts and download Excel reports.

In **User accounts**, administrators can create, edit, disable, enable, or permanently delete accounts. Deleting an account preserves receipts already entered and retains the staff member's name in the record. In **User groups**, administrators can create groups and customize permissions for receipt creation, viewing, editing, deletion, Excel export, account management, group management, and custom fields. Keep at least one active user with both user- and group-management permissions. The application prevents changes that would remove the last system administrator.

In **Custom fields**, administrators can add text, number, date, or dropdown fields and mark them required. They appear on the receipt form and as additional Excel columns. Archiving a field keeps its existing receipt values for history and export.

Excel filters include a date range, SI/OR number, particulars, amount bounds, user group, entering user, and any active custom fields. Use **Preview matching receipts** to check the filtered set before downloading. The server applies the same filters to the workbook and enforces the signed-in user's data permissions.

## Access

The bootstrap admin account is created only on the first startup when its username does not yet exist. Changing `ACCOUNTING_PASSWORD` later does not reset an existing account; sign in as an administrator and edit the account to change its password. Sign-in sessions expire after eight hours. Set `NODE_ENV=production` when deployed over HTTPS so session cookies are marked secure. Protect the deployment with HTTPS and keep all passwords and the session secret private.

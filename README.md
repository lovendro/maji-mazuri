# Maji Mazuri HMIS

A locally hosted starter application for managing a paediatric patient register, appointments, and immunization records. The browser interface uses a Node.js API and a SQLite database; records are no longer stored in browser `localStorage`.

## Important safety and privacy notice

**This project is not approved or validated for clinical use and is not ready for real patient information.** Before considering any real records, have the software, hosting computer, backup and recovery process, staff workflows, and applicable Kenyan privacy, health-record, and security requirements reviewed by qualified professionals and your facility's responsible officers.

The starter currently has important limitations:

- The SQLite database is **not encrypted at rest**. Anyone who can access the server computer or its files may be able to read it.
- The server listens only on `127.0.0.1`; other computers and devices cannot connect. Do not expose it to a network or the internet.
- There is no multi-factor authentication, encrypted backup process, or tested disaster-recovery procedure. Password changes and administrator resets are basic workflows, not a complete account-recovery process.
- The vaccine schedule and due/overdue indicators are inherited from a demo and are **not clinical guidance**. Confirm the current Ministry of Health and facility schedule.
- The audit log is a basic application log, not a tamper-proof clinical record.
- Existing records in the old browser-based version are not migrated. The new server starts with an empty database.

Do not use this starter as a substitute for clinical judgment, an approved electronic medical record, or a compliance/security review.

## Requirements

- Node.js 22.13 or later (uses Node's built-in SQLite module)
- npm

## Run locally

1. Open a terminal in this project folder.
2. Install the dependencies:

   ```powershell
   npm install
   ```

3. Start the server:

   ```powershell
   npm start
   ```

4. Open the local URL printed by the server, normally <http://127.0.0.1:3000>.
5. On first run, copy the one-time administrator setup code from the server terminal into the setup form within 15 minutes. Create an administrator username and a unique password/passphrase of at least 12 characters. If the code expires, restart the server to generate a new one.
6. After setup, sign in. An administrator can create individual receptionist and clinician accounts under **Staff accounts**.

Stop the server with `Ctrl+C`. The application binds to the local computer only. Changing the port with `PORT` does not change this network restriction.

## Data and access

- The database is created at `.local-data/hmis.sqlite`. This directory is excluded from Git.
- Never commit the database, real patient information, passwords, setup codes, or backups.
- Passwords are stored as salted scrypt hashes. Session cookies are HTTP-only and same-site; write requests are checked for a same-origin request.
- Staff accounts have administrator, clinician, or receptionist roles. Users can change their password; administrators can reset passwords and deactivate staff accounts. Clinical record changes and administrative changes are recorded in a basic audit log.
- Administrator and clinician roles may update patient records and record immunizations. Receptionist accounts can register patients and manage appointments.
- The previous demo data saved in browser storage is intentionally not imported into the database.

## Included workflows

- First-run administrator setup and staff sign-in
- Patient registration, search, and patient record updates
- Appointment booking and status updates
- Immunization schedule view and dated administration records
- Facility dashboard with current inpatient census and today's appointments

## Development checks

```powershell
npm test
npm run check
```

Tests use a temporary database and do not write patient records into the project directory.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'mm_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const ROLES = new Set(['admin', 'clinician', 'receptionist']);
const VACCINES = [
  { id: 'bcg-opv0', name: 'BCG + OPV 0', weeks: 0 },
  { id: 'penta1-pcv1-rota1', name: 'Penta 1 · PCV 1 · Rota 1', weeks: 6 },
  { id: 'penta2-pcv2-rota2', name: 'Penta 2 · PCV 2 · Rota 2', weeks: 10 },
  { id: 'penta3-pcv3-opv3', name: 'Penta 3 · PCV 3 · OPV 3', weeks: 14 },
  { id: 'mr1', name: 'Measles-Rubella 1', weeks: 39 },
  { id: 'mr2', name: 'Measles-Rubella 2', weeks: 78 }
];
const scryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const dummySalt = Buffer.alloc(16, 0x5a);
const dummyHash = crypto.scryptSync('invalid-password', dummySalt, 64, scryptOptions);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function cleanText(value, label, maxLength, { required = true } = {}) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    throw httpError(400, `${label} is required.`);
  }
  const text = value.trim();
  if ((!text && required) || text.length > maxLength) {
    throw httpError(400, `${label} must be ${required ? 'present and ' : ''}no more than ${maxLength} characters.`);
  }
  return text;
}

function validatePatient(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Invalid patient details.');
  const name = cleanText(body.name, 'Child name', 120);
  const guardian = cleanText(body.guardian, 'Guardian name', 120);
  const phone = cleanText(body.phone, 'Guardian phone', 40);
  const allergies = cleanText(body.allergies ?? 'Unknown', 'Allergies', 500);
  if (!isDate(body.dob) || body.dob > localDateString()) throw httpError(400, 'Enter a valid date of birth that is not in the future.');
  if (!['F', 'M', 'Other', 'Unknown'].includes(body.sex)) throw httpError(400, 'Choose a valid sex value.');
  const kg = Number(body.kg);
  if (!Number.isFinite(kg) || kg < 0.3 || kg > 250) throw httpError(400, 'Weight must be between 0.3 and 250 kg.');
  const status = body.status ?? 'Outpatient';
  if (!['Outpatient', 'Admitted – Ward A', 'Admitted – Ward B'].includes(status)) throw httpError(400, 'Choose a valid care status.');
  return { name, dob: body.dob, sex: body.sex, guardian, phone, kg, allergies, status };
}

function validateUsername(value) {
  const username = cleanText(value, 'Username', 32);
  if (username.length < 3 || !/^[a-zA-Z0-9._-]+$/.test(username)) {
    throw httpError(400, 'Username must be 3–32 characters and use letters, numbers, dots, underscores or hyphens.');
  }
  return username;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 200) {
    throw httpError(400, 'Use a password or passphrase between 12 and 200 characters.');
  }
  return value;
}

async function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, scryptOptions);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

async function passwordMatches(password, savedHash) {
  const [saltHex, hashHex] = typeof savedHash === 'string' ? savedHash.split(':') : [];
  const validEncoding = /^[a-f0-9]{32}$/i.test(saltHex || '') && /^[a-f0-9]{128}$/i.test(hashHex || '');
  const salt = validEncoding ? Buffer.from(saltHex, 'hex') : dummySalt;
  const expected = validEncoding ? Buffer.from(hashHex, 'hex') : dummyHash;
  const actual = await scrypt(password, salt, 64, scryptOptions);
  return validEncoding && crypto.timingSafeEqual(actual, expected);
}

function readCookie(request, name) {
  const prefix = `${name}=`;
  for (const part of (request.headers.cookie || '').split(';')) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) return cookie.slice(prefix.length);
  }
  return '';
}

function createApp({ dbPath, setupToken = crypto.randomBytes(24).toString('base64url'), logSetupToken = false } = {}) {
  const setupExpiresAt = Date.now() + 15 * 60 * 1000;
  const resolvedDbPath = dbPath || path.join(__dirname, '.local-data', 'hmis.sqlite');
  fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
  const db = new DatabaseSync(resolvedDbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'clinician', 'receptionist')),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      dob TEXT NOT NULL,
      sex TEXT NOT NULL,
      guardian TEXT NOT NULL,
      phone TEXT NOT NULL,
      kg REAL NOT NULL,
      allergies TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      dept TEXT NOT NULL,
      doctor TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('Scheduled', 'Completed', 'Cancelled')),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vaccinations (
      id INTEGER PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      vaccine_id TEXT NOT NULL,
      administered_on TEXT NOT NULL,
      recorded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (patient_id, vaccine_id),
      CHECK (vaccine_id IN ('bcg-opv0', 'penta1-pcv1-rota1', 'penta2-pcv2-rota2', 'penta3-pcv3-opv3', 'mr1', 'mr2'))
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS patients_name ON patients(name);
    CREATE INDEX IF NOT EXISTS appointments_date ON appointments(date, time);
    CREATE INDEX IF NOT EXISTS vaccinations_patient ON vaccinations(patient_id);
    CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at);
  `);
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some(column => column.name === 'active')) {
    db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))');
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use(express.json({ limit: '16kb', strict: true }));
  app.use('/api', (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!['POST', 'PATCH', 'DELETE'].includes(request.method)) return next();
    const origin = request.get('origin');
    const host = request.get('host');
    if (!origin || !host || origin !== `http://${host}` || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      return response.status(403).json({ error: 'Request origin was not accepted.' });
    }
    next();
  });

  app.get('/', (request, response) => response.sendFile(path.join(__dirname, 'index.html')));
  app.use('/css', express.static(path.join(__dirname, 'css'), { fallthrough: false, index: false, maxAge: 0 }));
  app.use('/js', express.static(path.join(__dirname, 'js'), { fallthrough: false, index: false, maxAge: 0 }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' }
  });

  function currentUser(request, response, next) {
    const token = readCookie(request, SESSION_COOKIE);
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) {
      request.user = null;
      return next();
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = db.prepare(`
      SELECT users.id, users.username, users.role, sessions.token_hash
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1
    `).get(tokenHash, Date.now());
    request.user = session ? { id: session.id, username: session.username, role: session.role, tokenHash: session.token_hash } : null;
    if (!session) response.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    next();
  }

  app.use('/api', currentUser);
  const requireUser = (request, response, next) => {
    if (!request.user) return response.status(401).json({ error: 'Sign in to continue.' });
    next();
  };
  const requireRole = (...roles) => (request, response, next) => {
    if (!request.user) return response.status(401).json({ error: 'Sign in to continue.' });
    if (!roles.includes(request.user.role)) return response.status(403).json({ error: 'Your account does not have permission to do that.' });
    next();
  };
  const audit = (userId, action, entity, entityId = null) => {
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES (?, ?, ?, ?)').run(userId, action, entity, entityId);
  };

  app.get('/api/session', (request, response) => {
    const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    response.json({
      user: request.user ? { id: request.user.id, username: request.user.username, role: request.user.role } : null,
      setupRequired: userCount === 0
    });
  });

  app.post('/api/setup', loginLimiter, async (request, response) => {
    if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count !== 0 || !setupToken || Date.now() > setupExpiresAt) {
      return response.status(409).json({ error: 'Initial setup code expired or setup is already complete. Restart the local server if you need a new code.' });
    }
    if (typeof request.body?.token !== 'string' || !crypto.timingSafeEqual(
      crypto.createHash('sha256').update(request.body.token).digest(),
      crypto.createHash('sha256').update(setupToken).digest()
    )) {
      return response.status(403).json({ error: 'Setup code is invalid. Check the server terminal.' });
    }
    const username = validateUsername(request.body.username);
    const password = validatePassword(request.body.password);
    const hash = await passwordHash(password);
    const insert = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hash, 'admin');
    setupToken = '';
    audit(Number(insert.lastInsertRowid), 'account_created', 'user', Number(insert.lastInsertRowid));
    response.status(201).json({ created: true, username });
  });

  app.post('/api/login', loginLimiter, async (request, response) => {
    const username = cleanText(request.body?.username, 'Username', 32);
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (password.length > 200) throw httpError(400, 'Password is too long.');
    const user = db.prepare('SELECT id, username, role, password_hash, active FROM users WHERE username = ? COLLATE NOCASE').get(username);
    const matches = await passwordMatches(password, user?.password_hash);
    if (!user || !user.active || !matches) return response.status(401).json({ error: 'Username or password is incorrect.' });
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, user.id, Date.now() + SESSION_MS);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    response.append('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
    audit(user.id, 'signed_in', 'session');
    response.json({ user: { id: user.id, username: user.username, role: user.role } });
  });

  app.post('/api/logout', requireUser, (request, response) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(request.user.tokenHash);
    audit(request.user.id, 'signed_out', 'session');
    response.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    response.json({ signedOut: true });
  });

  app.post('/api/change-password', requireUser, async (request, response) => {
    const currentPassword = typeof request.body?.currentPassword === 'string' ? request.body.currentPassword : '';
    const newPassword = validatePassword(request.body?.newPassword);
    if (!await passwordMatches(currentPassword, db.prepare('SELECT password_hash FROM users WHERE id = ?').get(request.user.id)?.password_hash)) {
      throw httpError(403, 'Current password is incorrect.');
    }
    const hash = await passwordHash(newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, request.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(request.user.id, request.user.tokenHash);
    audit(request.user.id, 'password_changed', 'user', request.user.id);
    response.json({ changed: true });
  });

  app.get('/api/dashboard', requireUser, (request, response) => {
    const today = localDateString();
    const patients = db.prepare('SELECT id, dob FROM patients').all();
    const given = new Set(db.prepare('SELECT patient_id, vaccine_id FROM vaccinations').all()
      .map(row => `${row.patient_id}:${row.vaccine_id}`));
    const currentDay = new Date(`${today}T12:00:00`).getTime();
    const overdueVaccines = patients.reduce((total, patient) => {
      const age = Math.max(0, Math.floor((currentDay - new Date(`${patient.dob}T12:00:00`).getTime()) / 6048e5));
      return total + VACCINES.filter(vaccine => !given.has(`${patient.id}:${vaccine.id}`) && age >= vaccine.weeks + 4).length;
    }, 0);
    response.json({
      patients: patients.length,
      admitted: db.prepare("SELECT COUNT(*) AS count FROM patients WHERE status LIKE 'Admitted%'").get().count,
      appointmentsToday: db.prepare('SELECT COUNT(*) AS count FROM appointments WHERE date = ?').get(today).count,
      overdueVaccines,
      upcomingAppointments: db.prepare(`
        SELECT appointments.id, appointments.date, appointments.time, appointments.dept,
          appointments.doctor, appointments.status, patients.name AS patientName
        FROM appointments JOIN patients ON patients.id = appointments.patient_id
        WHERE appointments.date = ? ORDER BY appointments.time LIMIT 20
      `).all(today),
      wardCensus: db.prepare(`
        SELECT id, name, dob, sex, kg, guardian, phone, allergies, status
        FROM patients WHERE status LIKE 'Admitted%' ORDER BY name LIMIT 20
      `).all()
    });
  });

  app.get('/api/patients', requireUser, (request, response) => {
    const query = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 100) : '';
    const rows = query
      ? db.prepare(`SELECT id, name, dob, sex, guardian, phone, kg, allergies, status FROM patients
          WHERE instr(lower(name || ' ' || guardian), lower(?)) > 0 ORDER BY name LIMIT 500`).all(query)
      : db.prepare('SELECT id, name, dob, sex, guardian, phone, kg, allergies, status FROM patients ORDER BY name LIMIT 500').all();
    response.json({ patients: rows });
  });

  app.post('/api/patients', requireRole('admin', 'clinician', 'receptionist'), (request, response) => {
    const patient = validatePatient(request.body);
    const result = db.prepare(`
      INSERT INTO patients (name, dob, sex, guardian, phone, kg, allergies, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(patient.name, patient.dob, patient.sex, patient.guardian, patient.phone, patient.kg, patient.allergies, patient.status);
    const id = Number(result.lastInsertRowid);
    audit(request.user.id, 'patient_created', 'patient', id);
    response.status(201).json({ patient: { id, ...patient } });
  });

  app.patch('/api/patients/:id', requireRole('admin', 'clinician'), (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw httpError(400, 'Invalid patient ID.');
    const patient = validatePatient(request.body);
    const result = db.prepare(`
      UPDATE patients SET name = ?, dob = ?, sex = ?, guardian = ?, phone = ?, kg = ?,
        allergies = ?, status = ?, updated_at = datetime('now') WHERE id = ?
    `).run(patient.name, patient.dob, patient.sex, patient.guardian, patient.phone, patient.kg, patient.allergies, patient.status, id);
    if (!result.changes) throw httpError(404, 'Patient not found.');
    audit(request.user.id, 'patient_updated', 'patient', id);
    response.json({ patient: { id, ...patient } });
  });

  app.get('/api/appointments', requireUser, (request, response) => {
    const appointments = db.prepare(`
      SELECT appointments.id, appointments.patient_id AS pid, appointments.date, appointments.time,
        appointments.dept, appointments.doctor, appointments.status, patients.name AS patientName
      FROM appointments JOIN patients ON patients.id = appointments.patient_id
      ORDER BY appointments.date DESC, appointments.time DESC LIMIT 500
    `).all();
    response.json({ appointments });
  });

  app.post('/api/appointments', requireRole('admin', 'clinician', 'receptionist'), (request, response) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Invalid appointment details.');
    const pid = Number(body.pid);
    if (!Number.isSafeInteger(pid) || pid < 1 || !db.prepare('SELECT id FROM patients WHERE id = ?').get(pid)) {
      throw httpError(400, 'Choose a registered patient.');
    }
    if (!isDate(body.date) || body.date < localDateString()) throw httpError(400, 'Appointment date must be today or later.');
    if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) throw httpError(400, 'Enter a valid appointment time.');
    const dept = cleanText(body.dept, 'Clinic', 80);
    const doctor = cleanText(body.doctor, 'Clinician', 120);
    const result = db.prepare(`
      INSERT INTO appointments (patient_id, date, time, dept, doctor, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'Scheduled', ?)
    `).run(pid, body.date, body.time, dept, doctor, request.user.id);
    const id = Number(result.lastInsertRowid);
    audit(request.user.id, 'appointment_created', 'appointment', id);
    response.status(201).json({
      appointment: { id, pid, date: body.date, time: body.time, dept, doctor, status: 'Scheduled' }
    });
  });

  app.patch('/api/appointments/:id/status', requireRole('admin', 'clinician', 'receptionist'), (request, response) => {
    const id = Number(request.params.id);
    const status = request.body?.status;
    if (!Number.isSafeInteger(id) || id < 1) throw httpError(400, 'Invalid appointment ID.');
    if (!['Scheduled', 'Completed', 'Cancelled'].includes(status)) throw httpError(400, 'Choose a valid appointment status.');
    const result = db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, id);
    if (!result.changes) throw httpError(404, 'Appointment not found.');
    audit(request.user.id, 'appointment_status_updated', 'appointment', id);
    response.json({ id, status });
  });

  app.get('/api/immunizations', requireUser, (request, response) => {
    const patients = db.prepare(`
      SELECT patients.id, patients.name, patients.dob, vaccinations.vaccine_id AS vaccineId,
        vaccinations.administered_on AS administeredOn
      FROM patients LEFT JOIN vaccinations ON vaccinations.patient_id = patients.id
      ORDER BY patients.name
    `).all();
    response.json({ vaccines: VACCINES, patients });
  });

  app.post('/api/patients/:id/vaccinations/:vaccineId', requireRole('admin', 'clinician'), (request, response) => {
    const patientId = Number(request.params.id);
    const vaccine = VACCINES.find(item => item.id === request.params.vaccineId);
    const administeredOn = request.body?.administeredOn;
    if (!Number.isSafeInteger(patientId) || patientId < 1) throw httpError(400, 'Invalid patient ID.');
    if (!vaccine) throw httpError(400, 'Choose a vaccine in the schedule.');
    if (!db.prepare('SELECT id FROM patients WHERE id = ?').get(patientId)) throw httpError(404, 'Patient not found.');
    if (!isDate(administeredOn) || administeredOn > localDateString()) throw httpError(400, 'Enter a valid administration date that is not in the future.');
    try {
      db.prepare('INSERT INTO vaccinations (patient_id, vaccine_id, administered_on, recorded_by) VALUES (?, ?, ?, ?)')
        .run(patientId, vaccine.id, administeredOn, request.user.id);
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) {
        throw httpError(409, 'This vaccine is already recorded for this patient.');
      }
      throw error;
    }
    audit(request.user.id, 'vaccination_recorded', 'patient', patientId);
    response.status(201).json({ patientId, vaccineId: vaccine.id, administeredOn });
  });

  app.delete('/api/patients/:id/vaccinations/:vaccineId', requireRole('admin'), (request, response) => {
    const patientId = Number(request.params.id);
    const vaccine = VACCINES.find(item => item.id === request.params.vaccineId);
    if (!Number.isSafeInteger(patientId) || patientId < 1 || !vaccine) throw httpError(400, 'Invalid vaccination record.');
    const result = db.prepare('DELETE FROM vaccinations WHERE patient_id = ? AND vaccine_id = ?').run(patientId, vaccine.id);
    if (!result.changes) throw httpError(404, 'Vaccination record not found.');
    audit(request.user.id, 'vaccination_record_removed', 'patient', patientId);
    response.json({ removed: true });
  });

  app.get('/api/users', requireRole('admin'), (request, response) => {
    response.json({
      users: db.prepare('SELECT id, username, role, active, created_at AS createdAt FROM users ORDER BY username').all()
    });
  });

  app.post('/api/users', requireRole('admin'), async (request, response) => {
    const username = validateUsername(request.body?.username);
    const password = validatePassword(request.body?.password);
    const role = request.body?.role;
    if (!ROLES.has(role)) throw httpError(400, 'Choose a valid staff role.');
    const hash = await passwordHash(password);
    try {
      const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
        .run(username, hash, role);
      const id = Number(result.lastInsertRowid);
      audit(request.user.id, 'staff_account_created', 'user', id);
      response.status(201).json({ user: { id, username, role } });
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) {
        throw httpError(409, 'That username is already in use.');
      }
      throw error;
    }
  });

  app.patch('/api/users/:id/active', requireRole('admin'), (request, response) => {
    const id = Number(request.params.id);
    const active = request.body?.active;
    if (!Number.isSafeInteger(id) || id < 1 || typeof active !== 'boolean') throw httpError(400, 'Invalid staff account update.');
    const target = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(id);
    if (!target) throw httpError(404, 'Staff account not found.');
    if (id === request.user.id && !active) throw httpError(400, 'You cannot deactivate your own account.');
    if (!active && target.role === 'admin' && target.active) {
      const activeAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get().count;
      if (activeAdmins <= 1) throw httpError(400, 'The last active administrator cannot be deactivated.');
    }
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(Number(active), id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(request.user.id, active ? 'staff_account_activated' : 'staff_account_deactivated', 'user', id);
    response.json({ id, active });
  });

  app.post('/api/users/:id/password', requireRole('admin'), async (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw httpError(400, 'Invalid staff account.');
    if (id === request.user.id) throw httpError(400, 'Use the change-password form for your own account.');
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(id)) throw httpError(404, 'Staff account not found.');
    const password = validatePassword(request.body?.password);
    const hash = await passwordHash(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(request.user.id, 'staff_password_reset', 'user', id);
    response.json({ reset: true });
  });

  app.get('/api/audit', requireRole('admin'), (request, response) => {
    response.json({
      entries: db.prepare(`
        SELECT audit_log.id, users.username, audit_log.action, audit_log.entity,
          audit_log.entity_id AS entityId, audit_log.created_at AS createdAt
        FROM audit_log LEFT JOIN users ON users.id = audit_log.user_id
        ORDER BY audit_log.id DESC LIMIT 100
      `).all()
    });
  });

  app.use('/api', (request, response) => response.status(404).json({ error: 'API route not found.' }));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') return response.status(400).json({ error: 'Request body must be valid JSON.' });
    if (error.type === 'entity.too.large') return response.status(413).json({ error: 'Request body is too large.' });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) console.error('Unhandled request error:', error);
    response.status(status).json({ error: status === 500 ? 'A server error occurred.' : error.message });
  });

  if (logSetupToken && db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0) {
    console.log('\nInitial administrator setup code (one use; keep private):');
    console.log(`${setupToken}\n`);
  }
  return { app, db };
}

if (require.main === module) {
  const { app, db } = createApp({ logSetupToken: true });
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Maji Mazuri HMIS is available at http://127.0.0.1:${port}`);
    console.log('Listening on loopback only; do not expose this service to a network.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => {
      db.close();
      process.exit(0);
    }));
  }
}

module.exports = { createApp, VACCINES, isDate };

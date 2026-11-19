'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../server');

function localDateString() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

test('local HMIS setup, authentication, records, permissions and logout work end to end', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maji-mazuri-test-'));
  const dbPath = path.join(directory, 'test.sqlite');
  const { app, db } = createApp({ dbPath, setupToken: 'one-time-test-code' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const send = (route, { cookie, ...options } = {}) => fetch(`${base}${route}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.method && ['POST', 'PATCH', 'DELETE'].includes(options.method) ? { Origin: base } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers
    }
  });

  const initial = await send('/api/session');
  assert.deepEqual(await initial.json(), { user: null, setupRequired: true });
  assert.equal((await send('/api/patients')).status, 401);
  assert.equal((await send('/api/setup', {
    method: 'POST',
    headers: { Origin: 'http://example.test' },
    body: JSON.stringify({ token: 'one-time-test-code', username: 'admin', password: 'a-strong-test-password' })
  })).status, 403);

  const setup = await send('/api/setup', {
    method: 'POST',
    body: JSON.stringify({ token: 'one-time-test-code', username: 'admin', password: 'a-strong-test-password' })
  });
  assert.equal(setup.status, 201);
  assert.equal((await send('/api/setup', {
    method: 'POST',
    body: JSON.stringify({ token: 'one-time-test-code', username: 'other', password: 'another-strong-password' })
  })).status, 409);

  const login = await send('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'a-strong-test-password' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await login.json()).user.role, 'admin');
  assert.equal((await send('/api/session', { cookie })).status, 200);
  assert.equal((await send('/api/users/1/active', {
    method: 'PATCH', cookie, body: JSON.stringify({ active: false })
  })).status, 400);

  const invalidPatient = await send('/api/patients', {
    method: 'POST', cookie,
    body: JSON.stringify({ name: 'Invalid', dob: '2999-01-01', sex: 'F', guardian: 'Guardian', phone: '0700000000', kg: 5 })
  });
  assert.equal(invalidPatient.status, 400);

  const createdPatient = await send('/api/patients', {
    method: 'POST', cookie,
    body: JSON.stringify({
      name: 'Test Patient', dob: '2020-01-01', sex: 'F', guardian: 'Test Guardian',
      phone: '0700000000', kg: 12.4, allergies: 'Unknown', status: 'Admitted – Ward A'
    })
  });
  assert.equal(createdPatient.status, 201);
  const patient = (await createdPatient.json()).patient;
  assert.equal(patient.name, 'Test Patient');
  const updatedPatient = await send(`/api/patients/${patient.id}`, {
    method: 'PATCH', cookie,
    body: JSON.stringify({
      name: 'Updated Test Patient', dob: '2020-01-01', sex: 'F', guardian: 'Test Guardian',
      phone: '0700000000', kg: 12.8, allergies: 'Unknown', status: 'Admitted – Ward A'
    })
  });
  assert.equal((await updatedPatient.json()).patient.kg, 12.8);
  assert.equal((await (await send('/api/patients?q=Updated', { cookie })).json()).patients.length, 1);

  const dashboard = await (await send('/api/dashboard', { cookie })).json();
  assert.equal(dashboard.patients, 1);
  assert.equal(dashboard.admitted, 1);
  assert.ok(dashboard.overdueVaccines > 0);

  const appointment = await send('/api/appointments', {
    method: 'POST', cookie,
    body: JSON.stringify({ pid: patient.id, date: localDateString(), time: '09:30', dept: 'Paediatric OPD', doctor: 'Test Clinician' })
  });
  assert.equal(appointment.status, 201);
  const appointmentId = (await appointment.json()).appointment.id;
  const completed = await send(`/api/appointments/${appointmentId}/status`, {
    method: 'PATCH', cookie, body: JSON.stringify({ status: 'Completed' })
  });
  assert.equal((await completed.json()).status, 'Completed');

  const staff = await send('/api/users', {
    method: 'POST', cookie,
    body: JSON.stringify({ username: 'nurse.one', password: 'another-strong-password', role: 'clinician' })
  });
  assert.equal(staff.status, 201);
  const clinicianLogin = await send('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'nurse.one', password: 'another-strong-password' })
  });
  const clinicianCookie = clinicianLogin.headers.get('set-cookie').split(';')[0];
  const recordedDose = await send(`/api/patients/${patient.id}/vaccinations/bcg-opv0`, {
    method: 'POST', cookie: clinicianCookie,
    body: JSON.stringify({ administeredOn: localDateString() })
  });
  assert.equal(recordedDose.status, 201);
  assert.equal((await send(`/api/patients/${patient.id}/vaccinations/bcg-opv0`, {
    method: 'POST', cookie: clinicianCookie,
    body: JSON.stringify({ administeredOn: localDateString() })
  })).status, 409);
  assert.equal((await send('/api/users', { cookie: clinicianCookie })).status, 403);
  assert.equal((await send('/api/change-password', {
    method: 'POST', cookie: clinicianCookie,
    body: JSON.stringify({ currentPassword: 'wrong-current-password', newPassword: 'changed-strong-password' })
  })).status, 403);
  assert.equal((await send('/api/change-password', {
    method: 'POST', cookie: clinicianCookie,
    body: JSON.stringify({ currentPassword: 'another-strong-password', newPassword: 'changed-strong-password' })
  })).status, 200);
  assert.equal((await send('/api/patients', { cookie: clinicianCookie })).status, 200);
  assert.equal((await send('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'nurse.one', password: 'another-strong-password' })
  })).status, 401);

  const receptionist = await send('/api/users', {
    method: 'POST', cookie,
    body: JSON.stringify({ username: 'front.desk', password: 'third-strong-password', role: 'receptionist' })
  });
  assert.equal(receptionist.status, 201);
  const receptionistCreated = await receptionist.json();
  const receptionistLogin = await send('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'front.desk', password: 'third-strong-password' })
  });
  const oldReceptionistCookie = receptionistLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await send(`/api/patients/${patient.id}/vaccinations/mr1`, {
    method: 'POST', cookie: oldReceptionistCookie,
    body: JSON.stringify({ administeredOn: localDateString() })
  })).status, 403);
  assert.equal((await send(`/api/patients/${patient.id}`, {
    method: 'PATCH', cookie: oldReceptionistCookie,
    body: JSON.stringify({ name: 'Changed', dob: '2020-01-01', sex: 'F', guardian: 'Guardian', phone: '0700', kg: 12, allergies: 'Unknown', status: 'Outpatient' })
  })).status, 403);
  const receptionistId = receptionistCreated.user.id;
  assert.equal((await send(`/api/users/${receptionistId}/password`, {
    method: 'POST', cookie, body: JSON.stringify({ password: 'reset-strong-password' })
  })).status, 200);
  assert.equal((await send('/api/patients', { cookie: oldReceptionistCookie })).status, 401);
  assert.equal((await send('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'front.desk', password: 'third-strong-password' })
  })).status, 401);
  const resetLogin = await send('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'front.desk', password: 'reset-strong-password' })
  });
  const resetCookie = resetLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await send(`/api/users/${receptionistId}/active`, {
    method: 'PATCH', cookie, body: JSON.stringify({ active: false })
  })).status, 200);
  assert.equal((await send('/api/patients', { cookie: resetCookie })).status, 401);
  assert.equal((await send('/api/audit', { cookie })).status, 200);

  const vaccinationView = await (await send('/api/immunizations', { cookie })).json();
  assert.equal(vaccinationView.vaccines.length, 6);
  assert.equal(vaccinationView.patients.find(row => row.id === patient.id).vaccineId, 'bcg-opv0');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count >= 9, true);
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin').password_hash.includes('a-strong-test-password'), false);

  const logout = await send('/api/logout', { method: 'POST', cookie });
  assert.equal(logout.status, 200);
  assert.equal((await send('/api/patients', { cookie })).status, 401);
  assert.match((await send('/')).headers.get('content-security-policy'), /default-src 'self'/);
});

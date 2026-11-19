'use strict';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const todayISO = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const localDate = value => new Date(`${value}T12:00:00`);
const ageWeeks = dob => Math.max(0, Math.floor((Date.now() - localDate(dob).getTime()) / 6048e5));
const titles = {
  dashboard: 'Overview',
  patients: 'Patients',
  appointments: 'Appointments',
  immunizations: 'Immunizations',
  users: 'Staff accounts'
};

let currentUser = null;
let vaccineSchedule = [];
let noticeTimer;
let viewSequence = 0;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('The server returned an unreadable response.'); }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function notify(message, type = 'error') {
  const notice = $('#notice');
  notice.textContent = message;
  notice.className = `notice ${type}`;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 6500);
}

function formatDate(value, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!value) return '—';
  return localDate(value).toLocaleDateString('en-KE', options);
}

function ageLabel(dob) {
  const weeks = ageWeeks(dob);
  if (weeks < 8) return `${weeks} wks`;
  const months = Math.floor(weeks / 4.345);
  return months < 24 ? `${months} mo` : `${Math.floor(months / 12)} yrs`;
}

async function showAuth(setupRequired) {
  $('#app-shell').hidden = true;
  const screen = $('#auth-screen');
  screen.hidden = false;
  screen.innerHTML = setupRequired ? `
    <div class="auth-card">
      <p class="eyebrow">Maji Mazuri · Local setup</p>
      <h1>Create the administrator account</h1>
      <p class="auth-copy">The one-time setup code is printed in the server terminal. Create a long, unique passphrase and keep the code private.</p>
      <form id="setup-form">
        <label>One-time setup code<input name="token" autocomplete="off" required></label>
        <label>Administrator username<input name="username" minlength="3" maxlength="32" autocomplete="username" required></label>
        <label>Password / passphrase<input name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password" required></label>
        <p class="field-help">Use at least 12 characters. Do not reuse a password from another account.</p>
        <button type="submit">Create administrator</button>
      </form>
      <p id="auth-error" class="auth-error" role="alert"></p>
      <p class="safety-note">Initial setup only works before the first account is created. This starter is not approved for clinical use or real patient records.</p>
    </div>` : `
    <div class="auth-card">
      <p class="eyebrow">Maji Mazuri · Staff access</p>
      <h1>Sign in</h1>
      <p class="auth-copy">Sign in with your facility account to access the local HMIS.</p>
      <form id="login-form">
        <label>Username<input name="username" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">Sign in</button>
      </form>
      <p id="auth-error" class="auth-error" role="alert"></p>
      <p class="safety-note">Local starter system only. Do not enter real patient information until it has passed professional security, privacy, and compliance review.</p>
    </div>`;
  const form = $('#setup-form') || $('#login-form');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const errorBox = $('#auth-error');
    button.disabled = true;
    errorBox.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    try {
      if (setupRequired) {
        await api('/api/setup', { method: 'POST', body: JSON.stringify(values) });
        await loadSession();
        return;
      }
      const { user } = await api('/api/login', { method: 'POST', body: JSON.stringify(values) });
      startApp(user);
    } catch (error) {
      errorBox.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

async function loadSession() {
  try {
    const result = await api('/api/session');
    if (result.user) startApp(result.user);
    else showAuth(result.setupRequired);
  } catch (error) {
    $('#auth-screen').hidden = false;
    $('#auth-screen').innerHTML = `<div class="auth-card"><h1>HMIS server unavailable</h1><p class="auth-copy">${esc(error.message)} Start the local server with <code>npm start</code>, then reload this page.</p></div>`;
  }
}

function startApp(user) {
  currentUser = user;
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;
  $('#user-label').textContent = `${user.username} · ${user.role}`;
  document.querySelectorAll('[data-admin-only]').forEach(element => { element.hidden = user.role !== 'admin'; });
  $('#today').textContent = new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  show(location.hash.slice(1).replace(/^#/, '') || 'dashboard');
}

function statusTag(status) {
  const tone = status === 'Completed' || status.startsWith('Admitted') ? 'g' :
    status === 'Cancelled' ? 'r' : status === 'Scheduled' ? 'a' : '';
  return `<span class="tag ${tone}">${esc(status)}</span>`;
}

function patientTable(patients, actions = false) {
  if (!patients.length) return '<p class="empty">No patient records found.</p>';
  return `<table><thead><tr><th>Patient</th><th>Age</th><th>Weight</th><th>Guardian</th><th>Allergies</th><th>Care status</th>${actions ? '<th>Action</th>' : ''}</tr></thead><tbody>${patients.map(patient => `
    <tr>
      <td><b>${esc(patient.name)}</b><br><small>${esc(patient.sex)} · Born ${esc(formatDate(patient.dob))}</small></td>
      <td>${esc(ageLabel(patient.dob))}</td>
      <td>${esc(patient.kg)} kg</td>
      <td>${esc(patient.guardian)}<br><small>${esc(patient.phone)}</small></td>
      <td>${patient.allergies && !['None', 'Unknown'].includes(patient.allergies) ? `<span class="tag r">${esc(patient.allergies)}</span>` : esc(patient.allergies || 'Unknown')}</td>
      <td>${statusTag(patient.status)}</td>
      ${actions ? `<td><button class="alt compact" type="button" data-edit-patient="${patient.id}">Edit</button></td>` : ''}
    </tr>`).join('')}</tbody></table>`;
}

function appointmentTable(appointments, actions = false) {
  if (!appointments.length) return '<p class="empty">No appointments to show.</p>';
  return `<table><thead><tr><th>Date & time</th><th>Patient</th><th>Clinic</th><th>Clinician</th><th>Status</th>${actions ? '<th>Update</th>' : ''}</tr></thead><tbody>${appointments.map(item => `
    <tr>
      <td>${esc(formatDate(item.date))}<br><small>${esc(item.time)}</small></td>
      <td>${esc(item.patientName || '—')}</td><td>${esc(item.dept)}</td><td>${esc(item.doctor)}</td><td>${statusTag(item.status)}</td>
      ${actions ? `<td>${item.status === 'Scheduled' ? `<button class="alt compact" type="button" data-appt-status="${item.id}" data-status="Completed">Complete</button> <button class="danger compact" type="button" data-appt-status="${item.id}" data-status="Cancelled">Cancel</button>` : '—'}</td>` : ''}
    </tr>`).join('')}</tbody></table>`;
}

async function dashboardView() {
  const data = await api('/api/dashboard');
  return `<div class="page-intro"><p class="eyebrow">Facility operations</p><h2>Welcome, ${esc(currentUser.username)}</h2><p>Today's activity and current inpatient census.</p></div>
    <div class="safety-banner"><b>Clinical-use warning</b><span>Starter software, not validated for clinical decisions or approved for real patient records. Verify schedules and workflows with your facility.</span></div>
    <div class="stats">
      <div class="stat"><span>Registered patients</span><b>${data.patients}</b><small>Active facility register</small></div>
      <div class="stat g"><span>Currently admitted</span><b>${data.admitted}</b><small>Inpatient census</small></div>
      <div class="stat"><span>Appointments today</span><b>${data.appointmentsToday}</b><small>${esc(formatDate(todayISO(), { weekday: 'long', day: 'numeric', month: 'long' }))}</small></div>
      <div class="stat a"><span>Overdue vaccines</span><b>${data.overdueVaccines}</b><small>Based on the editable demo schedule</small></div>
    </div>
    <div class="grid2">
      <section class="panel"><div class="panel-heading"><h2>Today's appointments</h2><a href="#appointments">View all</a></div>${appointmentTable(data.upcomingAppointments)}</section>
      <section class="panel"><div class="panel-heading"><h2>Inpatient census</h2><a href="#patients">Patient register</a></div>${patientTable(data.wardCensus)}</section>
    </div>`;
}

async function patientsView() {
  const { patients } = await api('/api/patients');
  return `<div class="page-intro"><p class="eyebrow">Care register</p><h2>Patient records</h2><p>Search the local facility register or create a patient record.</p></div>
    <div class="bar"><input id="patient-search" type="search" placeholder="Search patient or guardian" aria-label="Search patients"><button id="add-patient" type="button">Register patient</button></div>
    <div class="panel table-panel" id="patient-list">${patientTable(patients, ['admin', 'clinician'].includes(currentUser.role))}</div>`;
}

async function appointmentsView() {
  const { appointments } = await api('/api/appointments');
  const ordered = appointments.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return `<div class="page-intro"><p class="eyebrow">Scheduling</p><h2>Appointments</h2><p>Book visits and track appointment completion.</p></div>
    <div class="bar"><button id="add-appointment" type="button">Book appointment</button></div>
    <div class="panel table-panel">${appointmentTable(ordered, true)}</div>`;
}

function vaccinationState(patient, vaccine) {
  if (patient.vaccineId === vaccine.id) return 'given';
  const weeks = ageWeeks(patient.dob);
  if (weeks >= vaccine.weeks + 4) return 'over';
  if (weeks >= vaccine.weeks) return 'due';
  return 'later';
}

async function immunizationsView() {
  const { vaccines, patients } = await api('/api/immunizations');
  vaccineSchedule = vaccines;
  const records = new Map();
  for (const row of patients) {
    if (!records.has(row.id)) records.set(row.id, { id: row.id, name: row.name, dob: row.dob, given: {} });
    if (row.vaccineId) records.get(row.id).given[row.vaccineId] = row.administeredOn;
  }
  const rows = [...records.values()].map(patient => `<tr>
    <td><b>${esc(patient.name)}</b><br><small>${esc(ageLabel(patient.dob))}</small></td>
    <td class="vaccine-list">${vaccines.map(vaccine => {
      const patientVaccine = { ...patient, vaccineId: patient.given[vaccine.id] ? vaccine.id : '' };
      const state = vaccinationState(patientVaccine, vaccine);
      const date = patient.given[vaccine.id];
      const label = `${vaccine.name}${date ? ` · recorded ${formatDate(date)}` : state === 'over' ? ' · overdue*' : state === 'due' ? ' · due*' : ''}`;
      if (date) {
        return `<span class="vax given" title="Recorded ${esc(formatDate(date))}">${esc(label)}</span>${currentUser.role === 'admin' ? `<button class="danger compact" type="button" data-remove-vaccine="${patient.id}" data-vaccine="${esc(vaccine.id)}" aria-label="Remove ${esc(vaccine.name)} record for ${esc(patient.name)}">Remove</button>` : ''}`;
      }
      if (!['admin', 'clinician'].includes(currentUser.role)) return `<span class="vax ${state}">${esc(label)}</span>`;
      return `<button class="vax ${state}" type="button" data-record-vaccine="${patient.id}" data-vaccine="${esc(vaccine.id)}" title="Record administration date">${esc(label)}</button>`;
    }).join('')}</td>
  </tr>`).join('');
  return `<div class="page-intro"><p class="eyebrow">Preventive care</p><h2>Immunization records</h2><p>Record an administration date or review recorded doses.</p></div>
    <div class="safety-banner warning"><b>Schedule is unverified</b><span>The displayed age schedule is inherited from the demo. Confirm the current Ministry of Health guidance and facility protocol before use.</span></div>
    <div class="panel table-panel"><p class="legend"><span>Recorded</span><span>Due by demo schedule*</span><span>Past due by demo schedule*</span></p>
      ${rows ? `<table><thead><tr><th>Patient</th><th>Schedule · *not clinical guidance</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No patient records found.</p>'}
    </div>`;
}

async function usersView() {
  const [{ users }, { entries }] = await Promise.all([api('/api/users'), api('/api/audit')]);
  return `<div class="page-intro"><p class="eyebrow">Access management</p><h2>Staff accounts</h2><p>Create individual accounts and share initial passwords securely. Staff can change their password from the sidebar.</p></div>
    <div class="panel">
      <h2>Add staff account</h2>
      <form id="add-user-form" class="user-form">
        <label>Username<input name="username" minlength="3" maxlength="32" required></label>
        <label>Temporary password<input name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password" required></label>
        <label>Role<select name="role"><option value="receptionist">Receptionist</option><option value="clinician">Clinician</option><option value="admin">Administrator</option></select></label>
        <button type="submit">Create account</button>
      </form>
    </div>
    <div class="panel table-panel"><h2>Current staff</h2><table><thead><tr><th>Username</th><th>Role</th><th>Account</th><th>Created</th><th>Actions</th></tr></thead><tbody>${users.map(user => `
      <tr>
        <td>${esc(user.username)}${user.id === currentUser.id ? ' <small>(you)</small>' : ''}</td>
        <td>${esc(user.role)}</td><td>${user.active ? '<span class="tag g">Active</span>' : '<span class="tag r">Inactive</span>'}</td>
        <td>${esc(user.createdAt)}</td>
        <td class="staff-actions">${user.id !== currentUser.id ? `<button class="alt compact" type="button" data-reset-password="${user.id}">Reset password</button>
          <button class="${user.active ? 'danger' : 'alt'} compact" type="button" data-toggle-user="${user.id}" data-active="${!user.active}">${user.active ? 'Deactivate' : 'Activate'}</button>` : '—'}</td>
      </tr>`).join('')}</tbody></table></div>
    <div class="panel table-panel"><h2>Recent audit activity</h2><p class="field-help">The latest 100 account and record events; this log is not tamper-proof.</p>
      ${entries.length ? `<table><thead><tr><th>Time (UTC)</th><th>Staff</th><th>Action</th><th>Record type / ID</th></tr></thead><tbody>${entries.map(entry => `
        <tr><td>${esc(entry.createdAt)}</td><td>${esc(entry.username || 'System')}</td><td>${esc(entry.action)}</td><td>${esc(entry.entity)}${entry.entityId ? ` #${entry.entityId}` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No audit activity yet.</p>'}
    </div>`;
}

const views = {
  dashboard: dashboardView,
  patients: patientsView,
  appointments: appointmentsView,
  immunizations: immunizationsView,
  users: usersView
};

async function show(viewName) {
  const view = views[viewName] ? viewName : 'dashboard';
  const sequence = ++viewSequence;
  if (view === 'users' && currentUser.role !== 'admin') {
    location.hash = 'dashboard';
    return;
  }
  $('#title').textContent = titles[view];
  document.querySelectorAll('#nav a[data-v]').forEach(link => link.classList.toggle('on', link.dataset.v === view));
  $('#side').classList.remove('open');
  $('#menu').setAttribute('aria-expanded', 'false');
  $('#view').setAttribute('aria-busy', 'true');
  try {
    const markup = await views[view]();
    if (sequence !== viewSequence) return;
    $('#view').innerHTML = markup;
    bind(view);
  } catch (error) {
    if (sequence !== viewSequence) return;
    notify(error.message);
    if (error.message.includes('Sign in')) {
      currentUser = null;
      await loadSession();
    } else {
      $('#view').innerHTML = `<div class="panel error-panel"><h2>Could not load this page</h2><p>${esc(error.message)}</p><button id="retry-view" type="button">Try again</button></div>`;
      $('#retry-view').onclick = () => show(view);
    }
  } finally {
    if (sequence === viewSequence) $('#view').setAttribute('aria-busy', 'false');
  }
}

function bind(view) {
  if (view === 'patients') {
    let searchSequence = 0;
    $('#add-patient').onclick = () => patientForm();
    $('#patient-search').addEventListener('input', async event => {
      const query = event.target.value.trim();
      const sequence = ++searchSequence;
      try {
        const { patients } = await api(`/api/patients?q=${encodeURIComponent(query)}`);
        if (sequence !== searchSequence || !$('#patient-list')) return;
        $('#patient-list').innerHTML = patientTable(patients, ['admin', 'clinician'].includes(currentUser.role));
        bindPatientEdit();
      } catch (error) {
        if (sequence === searchSequence) notify(error.message);
      }
    });
    bindPatientEdit();
  }
  if (view === 'appointments') {
    $('#add-appointment').onclick = () => appointmentForm();
    document.querySelectorAll('[data-appt-status]').forEach(button => {
      button.onclick = async () => {
        try {
          await api(`/api/appointments/${button.dataset.apptStatus}/status`, {
            method: 'PATCH', body: JSON.stringify({ status: button.dataset.status })
          });
          notify(`Appointment marked ${button.dataset.status.toLowerCase()}.`, 'success');
          await show(view);
        } catch (error) { notify(error.message); }
      };
    });
  }
  if (view === 'immunizations') {
    document.querySelectorAll('[data-record-vaccine]').forEach(button => {
      button.onclick = () => vaccinationForm(button.dataset.recordVaccine, button.dataset.vaccine);
    });
    document.querySelectorAll('[data-remove-vaccine]').forEach(button => {
      button.onclick = async () => {
        if (!confirm('Remove this vaccination record? This action is recorded in the audit log.')) return;
        try {
          await api(`/api/patients/${button.dataset.removeVaccine}/vaccinations/${encodeURIComponent(button.dataset.vaccine)}`, { method: 'DELETE' });
          notify('Vaccination record removed.', 'success');
          await show(view);
        } catch (error) { notify(error.message); }
      };
    });
  }
  if (view === 'users') {
    $('#add-user-form').onsubmit = async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      try {
        await api('/api/users', { method: 'POST', body: JSON.stringify(values) });
        notify('Staff account created.', 'success');
        await show(view);
      } catch (error) { notify(error.message); }
    };
    document.querySelectorAll('[data-toggle-user]').forEach(button => {
      button.onclick = async () => {
        const active = button.dataset.active === 'true';
        const action = active ? 'activate' : 'deactivate';
        if (!confirm(`${action[0].toUpperCase()}${action.slice(1)} this account?${active ? '' : ' Existing sessions will be signed out.'}`)) return;
        try {
          await api(`/api/users/${button.dataset.toggleUser}/active`, {
            method: 'PATCH', body: JSON.stringify({ active })
          });
          notify(`Staff account ${active ? 'activated' : 'deactivated'}.`, 'success');
          await show(view);
        } catch (error) { notify(error.message); }
      };
    });
    document.querySelectorAll('[data-reset-password]').forEach(button => {
      button.onclick = () => {
        dialog('Reset staff password', `
          <p class="form-intro">Share this temporary password with the staff member privately. They can change it after signing in.</p>
          <label>Temporary password<input name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password" required></label>`,
        async values => {
          await api(`/api/users/${button.dataset.resetPassword}/password`, {
            method: 'POST', body: JSON.stringify(values)
          });
          notify('Password reset. Share it securely with the account holder.', 'success');
        });
      };
    });
  }
}

function bindPatientEdit() {
  document.querySelectorAll('[data-edit-patient]').forEach(button => {
    button.onclick = async () => {
      try {
        const { patients } = await api(`/api/patients?q=${encodeURIComponent($('#patient-search').value.trim())}`);
        const patient = patients.find(item => item.id === Number(button.dataset.editPatient));
        if (patient) patientForm(patient);
      } catch (error) { notify(error.message); }
    };
  });
}

function dialog(title, fields, onSave) {
  const form = $('#form');
  form.innerHTML = `<h2>${esc(title)}</h2>${fields}<div class="acts"><button type="button" class="alt" id="cancel-dialog">Cancel</button><button type="submit" id="save-dialog">Save</button></div>`;
  $('#cancel-dialog').onclick = () => $('#dlg').close();
  form.onsubmit = async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const saveButton = $('#save-dialog');
    saveButton.disabled = true;
    try {
      await onSave(Object.fromEntries(new FormData(form)));
      $('#dlg').close();
      await show(location.hash.slice(1).replace(/^#/, '') || 'dashboard');
    } catch (error) {
      notify(error.message);
      saveButton.disabled = false;
    }
  };
  $('#dlg').showModal();
}

function patientForm(patient = null) {
  const editing = Boolean(patient);
  const canEditStatus = ['admin', 'clinician'].includes(currentUser.role);
  const fields = `
    <label>Child's full name<input name="name" maxlength="120" value="${esc(patient?.name)}" required></label>
    <div class="row"><label>Date of birth<input type="date" name="dob" max="${todayISO()}" value="${esc(patient?.dob)}" required></label>
    <label>Sex recorded<select name="sex" required>${['F', 'M', 'Other', 'Unknown'].map(value => `<option${patient?.sex === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label></div>
    <div class="row"><label>Guardian name<input name="guardian" maxlength="120" value="${esc(patient?.guardian)}" required></label>
    <label>Guardian phone<input name="phone" type="tel" maxlength="40" value="${esc(patient?.phone)}" required></label></div>
    <div class="row"><label>Weight (kg)<input name="kg" type="number" step="0.1" min="0.3" max="250" value="${esc(patient?.kg)}" required></label>
    <label>Allergies / status<input name="allergies" maxlength="500" value="${esc(patient?.allergies || 'Unknown')}" required></label></div>
    ${canEditStatus ? `<label>Care status<select name="status">${['Outpatient', 'Admitted – Ward A', 'Admitted – Ward B'].map(value => `<option${patient?.status === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label>` : `<input type="hidden" name="status" value="${esc(patient?.status || 'Outpatient')}">`}`;
  dialog(editing ? 'Update patient record' : 'Register patient', fields, async values => {
    const url = editing ? `/api/patients/${patient.id}` : '/api/patients';
    const response = await api(url, {
      method: editing ? 'PATCH' : 'POST',
      body: JSON.stringify(values)
    });
    notify(editing ? 'Patient record updated.' : `Patient ${response.patient.name} registered.`, 'success');
  });
}

async function appointmentForm() {
  try {
    const { patients } = await api('/api/patients');
    if (!patients.length) {
      notify('Register a patient before booking an appointment.');
      return;
    }
    const fields = `
      <label>Patient<select name="pid" required>${patients.map(patient => `<option value="${patient.id}">${esc(patient.name)}</option>`).join('')}</select></label>
      <div class="row"><label>Date<input type="date" name="date" min="${todayISO()}" value="${todayISO()}" required></label>
      <label>Time<input type="time" name="time" value="09:00" required></label></div>
      <div class="row"><label>Clinic<select name="dept"><option>Paediatric OPD</option><option>Immunization</option><option>Nutrition clinic</option><option>Neonatal follow-up</option></select></label>
      <label>Clinician<input name="doctor" maxlength="120" required></label></div>`;
    dialog('Book appointment', fields, async values => {
      await api('/api/appointments', { method: 'POST', body: JSON.stringify(values) });
      notify('Appointment booked.', 'success');
    });
  } catch (error) { notify(error.message); }
}

function vaccinationForm(patientId, vaccineId) {
  const vaccine = vaccineSchedule.find(item => item.id === vaccineId);
  if (!vaccine) return notify('Vaccine schedule item was not found.');
  dialog(`Record ${vaccine.name}`, `
    <p class="form-intro">Only record an administration that has been confirmed in the patient's source record.</p>
    <label>Administration date<input type="date" name="administeredOn" max="${todayISO()}" value="${todayISO()}" required></label>`,
  async values => {
    await api(`/api/patients/${patientId}/vaccinations/${encodeURIComponent(vaccineId)}`, {
      method: 'POST', body: JSON.stringify(values)
    });
    notify('Vaccination record saved.', 'success');
  });
}

$('#change-password').addEventListener('click', () => {
  dialog('Change your password', `
    <label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
    <label>New password<input name="newPassword" type="password" minlength="12" maxlength="200" autocomplete="new-password" required></label>
    <label>Confirm new password<input name="confirmPassword" type="password" minlength="12" maxlength="200" autocomplete="new-password" required></label>`,
  async values => {
    if (values.newPassword !== values.confirmPassword) throw new Error('The new passwords do not match.');
    await api('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword })
    });
    notify('Your password has been changed.', 'success');
  });
});

$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); }
  catch (error) { notify(error.message); return; }
  currentUser = null;
  await loadSession();
});

$('#menu').addEventListener('click', () => {
  const isOpen = $('#side').classList.toggle('open');
  $('#menu').setAttribute('aria-expanded', String(isOpen));
});

$('#dlg').addEventListener('click', event => {
  if (event.target === $('#dlg')) $('#dlg').close();
});

addEventListener('hashchange', () => {
  if (currentUser) show(location.hash.slice(1).replace(/^#/, '') || 'dashboard');
});

loadSession();

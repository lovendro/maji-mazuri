/* Maji Mazuri HMIS – vanilla JS. Data lives in localStorage; swap load()/save() for API calls later. */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iso = d => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const ago = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return iso(d); };
const localDate = value => new Date(`${value}T12:00:00`);
const KEY = 'majimazuri.v1', TODAY = iso(new Date());

// Kenya routine immunization schedule (age in weeks) – edit to match your facility
const VAX = [
  {n:'BCG + OPV 0', w:0}, {n:'Penta 1 · PCV 1 · Rota 1', w:6}, {n:'Penta 2 · PCV 2 · Rota 2', w:10},
  {n:'Penta 3 · PCV 3 · OPV 3', w:14}, {n:'Measles-Rubella 1', w:39}, {n:'Measles-Rubella 2', w:78}
];

function seed() {
  const P = (id,name,dob,sex,guardian,phone,kg,status,allergies,vax) => ({id,name,dob,sex,guardian,phone,kg,status,allergies,vax});
  return {
    patients: [
      P(1,'Amani Wanjiru',ago(40),'F','Grace Wanjiru','0712 345 678',4.2,'Outpatient','None',[0]),
      P(2,'Baraka Otieno',ago(130),'M','Peter Otieno','0722 111 222',6.8,'Admitted – Ward A','Penicillin',[0,1,2]),
      P(3,'Zuri Mwangi',ago(420),'F','Faith Mwangi','0733 987 654',9.5,'Outpatient','None',[0,1,2,3]),
      P(4,'Imani Hassan',ago(900),'F','Amina Hassan','0700 222 333',12.1,'Admitted – Ward B','None',[0,1,2,3,4]),
      P(5,'Jabali Kiptoo',ago(1800),'M','Joyce Kiptoo','0745 555 010',18.3,'Outpatient','Peanuts',[0,1,2,3,4,5])
    ],
    appts: [
      {id:1,pid:1,date:TODAY,time:'09:00',dept:'Paediatric OPD',doctor:'Dr. Achieng',status:'Scheduled'},
      {id:2,pid:3,date:TODAY,time:'10:30',dept:'Immunization',doctor:'Nurse Mutua',status:'Scheduled'},
      {id:3,pid:5,date:TODAY,time:'11:15',dept:'Nutrition clinic',doctor:'Dr. Njoroge',status:'Completed'}
    ]
  };
}
let S = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.patients) && Array.isArray(s.appts)) {
      s.patients = s.patients.map(p => ({...p, vax: Array.isArray(p.vax) ? p.vax : [], allergies: p.allergies || 'None'}));
      return s;
    }
  } catch (e) { console.warn('Could not restore saved HMIS data.', e); }
  return seed();
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { console.error('Could not save HMIS data.', e); alert('Changes could not be saved in this browser.'); }
}
const nextId = a => Math.max(0, ...a.map(x => x.id)) + 1;
const pat = id => S.patients.find(p => p.id === id);
const weeks = dob => {
  const born = localDate(dob).getTime();
  if (!Number.isFinite(born)) return 0;
  return Math.max(0, Math.floor((Date.now() - born) / 6048e5));
};
function age(dob) {
  const born = localDate(dob);
  if (!Number.isFinite(born.getTime())) return 'Unknown';
  const w = weeks(dob);
  if (w < 8) return w + ' wks';
  const m = Math.floor(w / 4.345);
  return m < 24 ? m + ' mo' : Math.floor(m / 12) + ' yrs';
}
function vaxState(p, i) { if (p.vax.includes(i)) return 'given'; const w = weeks(p.dob), d = VAX[i].w; return w >= d + 4 ? 'over' : w >= d ? 'due' : 'later'; }
const overdue = p => VAX.filter((_, i) => vaxState(p, i) === 'over').length;
const admitted = p => p.status.startsWith('Admitted');
const stag = s => `<span class="tag ${s === 'Completed' ? 'g' : s === 'Cancelled' ? 'r' : ''}">${esc(s)}</span>`;

const views = {
  dashboard() {
    const todays = S.appts.filter(a => a.date === TODAY);
    const od = S.patients.reduce((n, p) => n + overdue(p), 0);
    return `<div class="stats">
      <div class="stat"><b>${S.patients.length}</b><span>Registered children</span></div>
      <div class="stat g"><b>${S.patients.filter(admitted).length}</b><span>Currently admitted</span></div>
      <div class="stat"><b>${todays.length}</b><span>Appointments today</span></div>
      <div class="stat a"><b>${od}</b><span>Overdue vaccines</span></div></div>
      <div class="grid2">
      <div class="panel"><h2>Today's appointments</h2>${apptTable(todays)}</div>
      <div class="panel"><h2>Ward census</h2>${patientTable(S.patients.filter(admitted))}</div></div>`;
  },
  patients() {
    return `<div class="bar"><input id="q" type="search" placeholder="Search by child or guardian name" aria-label="Search patients"><button id="addP">Register child</button></div>
      <div class="panel" id="plist">${patientTable(S.patients)}</div>`;
  },
  appointments() {
    const list = [...S.appts].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    return `<div class="bar"><button id="addA">Book appointment</button></div><div class="panel">${apptTable(list, true)}</div>`;
  },
  immunizations() {
    const rows = S.patients.map(p => `<tr><td><b>${esc(p.name)}</b><br><small>${age(p.dob)}</small></td><td>${
      VAX.map((v, i) => { const s = vaxState(p, i); return `<button class="vax ${s}" data-p="${p.id}" data-i="${i}" title="Click to mark given / not given">${esc(v.n)}${s === 'given' ? ' ✓' : s === 'over' ? ' – overdue' : s === 'due' ? ' – due' : ''}</button>`; }).join('')
    }</td></tr>`).join('');
    return `<div class="panel"><h2>Immunization tracker</h2><p class="empty">Click a vaccine to record it as given. Green = given, amber = due now, red = more than 4 weeks late.</p><table><tr><th>Child</th><th>Schedule</th></tr>${rows}</table></div>`;
  }
};
const titles = {dashboard:'Dashboard', patients:'Young patients', appointments:'Appointments', immunizations:'Immunizations'};

function patientTable(list) {
  if (!list.length) return '<p class="empty">No children to show yet. Use Register child to add one.</p>';
  return `<table><tr><th>Name</th><th>Age</th><th>Weight</th><th>Guardian</th><th>Allergies</th><th>Status</th></tr>${list.map(p =>
    `<tr><td><b>${esc(p.name)}</b> <small>(${esc(p.sex)})</small></td><td>${age(p.dob)}</td><td>${esc(p.kg)} kg</td><td>${esc(p.guardian)}<br><small>${esc(p.phone)}</small></td><td>${p.allergies && p.allergies !== 'None' ? `<span class="tag r">${esc(p.allergies)}</span>` : '—'}</td><td><span class="tag ${admitted(p) ? 'g' : ''}">${esc(p.status)}</span></td></tr>`).join('')}</table>`;
}
function apptTable(list, actions) {
  if (!list.length) return '<p class="empty">No appointments. Use Book appointment to add one.</p>';
  return `<table><tr><th>When</th><th>Child</th><th>Clinic</th><th>Clinician</th><th>Status</th>${actions ? '<th></th>' : ''}</tr>${list.map(a =>
    `<tr><td>${esc(a.date)}<br><small>${esc(a.time)}</small></td><td>${esc(pat(a.pid)?.name || '—')}</td><td>${esc(a.dept)}</td><td>${esc(a.doctor)}</td><td>${stag(a.status)}</td>${actions ? `<td>${a.status === 'Scheduled' ? `<button class="alt" data-done="${a.id}">Mark done</button>` : ''}</td>` : ''}</tr>`).join('')}</table>`;
}

function show(v) {
  v = views[v] ? v : 'dashboard';
  $('#title').textContent = titles[v];
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.v === v));
  $('#view').innerHTML = views[v]();
  $('#side').classList.remove('open');
  bind(v);
}
function bind(v) {
  if (v === 'patients') {
    $('#addP').onclick = patientForm;
    $('#q').oninput = e => { const t = e.target.value.toLowerCase();
      $('#plist').innerHTML = patientTable(S.patients.filter(p => (p.name + p.guardian).toLowerCase().includes(t))); };
  }
  if (v === 'appointments') {
    $('#addA').onclick = apptForm;
    document.querySelectorAll('[data-done]').forEach(b => b.onclick = () => {
      const appt = S.appts.find(a => a.id == b.dataset.done);
      if (!appt) return;
      appt.status = 'Completed';
      save();
      show(v);
    });
  }
  if (v === 'immunizations') document.querySelectorAll('.vax').forEach(b => b.onclick = () => {
    const p = pat(+b.dataset.p), i = +b.dataset.i;
    if (!p || !Number.isInteger(i) || i < 0 || i >= VAX.length) return;
    p.vax = p.vax.includes(i) ? p.vax.filter(x => x !== i) : [...p.vax, i];
    save();
    show(v);
  });
}

function dialog(title, fields, onSave) {
  $('#form').innerHTML = `<h2>${title}</h2>${fields}<div class="acts"><button type="button" class="alt" id="cx">Cancel</button><button type="submit">Save</button></div>`;
  $('#cx').onclick = () => $('#dlg').close();
  $('#form').onsubmit = e => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    try {
      onSave(Object.fromEntries(new FormData(e.target)));
      $('#dlg').close();
      save();
      show(location.hash.slice(1).replace(/^#/, '') || 'dashboard');
    } catch (error) {
      alert(error.message || 'Could not save this record.');
    }
  };
  $('#dlg').showModal();
}
function patientForm() {
  dialog('Register child', `
    <label>Child's full name<input name="name" required></label>
    <div class="row"><label>Date of birth<input type="date" name="dob" max="${TODAY}" required></label>
    <label>Sex<select name="sex"><option>F</option><option>M</option></select></label></div>
    <div class="row"><label>Guardian name<input name="guardian" required></label><label>Phone<input name="phone" type="tel" required></label></div>
    <div class="row"><label>Weight (kg)<input name="kg" type="number" step="0.1" min="0.3" required></label><label>Allergies<input name="allergies" placeholder="None"></label></div>`,
    d => {
      const name = d.name.trim(), guardian = d.guardian.trim(), phone = d.phone.trim();
      if (!name || !guardian || !phone) throw new Error('Name, guardian and phone are required.');
      S.patients.push({id: nextId(S.patients), ...d, name, guardian, phone, kg: +d.kg, allergies: d.allergies.trim() || 'None', status: 'Outpatient', vax: []});
    });
}
function apptForm() {
  if (!S.patients.length) return alert('Register a child first.');
  dialog('Book appointment', `
    <label>Child<select name="pid">${S.patients.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
    <div class="row"><label>Date<input type="date" name="date" min="${TODAY}" value="${TODAY}" required></label><label>Time<input type="time" name="time" value="09:00" required></label></div>
    <div class="row"><label>Clinic<select name="dept"><option>Paediatric OPD</option><option>Immunization</option><option>Nutrition clinic</option><option>Neonatal follow-up</option></select></label>
    <label>Clinician<input name="doctor" required></label></div>`,
    d => {
      const doctor = d.doctor.trim();
      if (!doctor) throw new Error('Clinician is required.');
      S.appts.push({id: nextId(S.appts), ...d, pid: +d.pid, doctor, status: 'Scheduled'});
    });
}

$('#today').textContent = new Date().toLocaleDateString('en-KE', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
$('#menu').onclick = () => $('#side').classList.toggle('open');
$('#dlg').addEventListener('click', e => {
  if (e.target === $('#dlg')) $('#dlg').close();
});
addEventListener('hashchange', () => show(location.hash.slice(1).replace(/^#/, '') || 'dashboard'));
show(location.hash.slice(1).replace(/^#/, '') || 'dashboard');

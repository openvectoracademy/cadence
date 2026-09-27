(() => {
// ══════════════════════════════════════════════════════════════
// CLOUD SYNC LAYER (D1 via /api/state)
// ══════════════════════════════════════════════════════════════
const TOKEN = localStorage.getItem('site_token') || '';
let pushTimer = null;
let pushInFlight = false;
let pushAgain = false;

function setSyncStatus(status) {
  const pill = document.getElementById('syncPill');
  const label = document.getElementById('syncLabel');
  if (!pill || !label) return;
  pill.dataset.status = status;
  label.textContent =
    status === 'syncing' ? 'Syncing…' :
    status === 'error'   ? 'Offline'  :
    status === 'synced'  ? 'Synced'   : 'Ready';
}

function authFail() {
  localStorage.removeItem('site_token');
  localStorage.removeItem('site_user');
  location.replace('/login.html');
}

async function pushRemote() {
  if (!TOKEN) return;
  if (pushInFlight) { pushAgain = true; return; }
  pushInFlight = true;
  setSyncStatus('syncing');
  try {
    const res = await fetch('/api/state', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKEN
      },
      body: JSON.stringify({ state })
    });
    if (res.status === 401) { pushInFlight = false; return authFail(); }
    setSyncStatus(res.ok ? 'synced' : 'error');
  } catch (e) {
    setSyncStatus('error');
  }
  pushInFlight = false;
  if (pushAgain) { pushAgain = false; schedulePush(); }
}

function schedulePush() {
  if (!TOKEN) return;
  setSyncStatus('syncing');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushRemote, 800);
}

async function pullRemote() {
  if (!TOKEN) return null;
  try {
    const res = await fetch('/api/state', {
      headers: { 'Authorization': 'Bearer ' + TOKEN },
      cache: 'no-store'
    });
    if (res.status === 401) { authFail(); return null; }
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}
// ══════════════════════════════════════════════════════════════

const KEY = "focus_admission_v1";
const DEFAULT = {
  version: 3,
  progress: {},
  finals: { papers: {}, subjects: {} },
  mock: 0,
  daily: { total: 0, byDate: {}, completedByDate: {} },
  custom: { subjects: {} },
  ui: { lastEdited: null, theme: "light" },
  exams: []
};

let state = load();
let page = "dashboard";
let activeChapter = null;
let clockTimer = null;

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function merge(a, b) {
  if (!b || typeof b !== "object") return a;
  for (const k in b) {
    if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) {
      a[k] = merge(a[k] || {}, b[k]);
    } else {
      a[k] = b[k];
    }
  }
  return a;
}
function cycleCount(x) {
  return Math.min(Number(x?.recall || 0), Number(x?.qb || 0), Number(x?.exam || 0));
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    const s = merge(clone(DEFAULT), raw || {});
    Object.values(s.progress || {}).forEach(p => {
      if (p.exam === true) p.exam = 1;
      else if (typeof p.exam !== "number") p.exam = 0;
      if (typeof p.revision !== "number") p.revision = 0;
      if (typeof p.qb !== "number") p.qb = 0;
      if (typeof p.theory !== "boolean") p.theory = !!p.theory;
    });
    Object.keys(s.finals?.papers || {}).forEach(id => {
      const x = s.finals.papers[id];
      if (typeof x !== "number") s.finals.papers[id] = cycleCount(x);
    });
    Object.keys(s.finals?.subjects || {}).forEach(id => {
      const x = s.finals.subjects[id];
      if (typeof x !== "number") s.finals.subjects[id] = cycleCount(x);
    });
    if (typeof s.mock !== "number") s.mock = cycleCount(s.mock);
    s.exams = Array.isArray(s.exams) ? s.exams : [];
    s.daily = s.daily && typeof s.daily === "object" ? s.daily : { total: 0, byDate: {} };
    if (typeof s.daily.total !== "number") s.daily.total = 0;
    if (!s.daily.byDate || typeof s.daily.byDate !== "object") s.daily.byDate = {};
    if (!s.daily.completedByDate || typeof s.daily.completedByDate !== "object") s.daily.completedByDate = {};
    return s;
  } catch { return clone(DEFAULT); }
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
  schedulePush();
}

function toast(s) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = s;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 1800);
}
function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}
function enc(s) { return encodeURIComponent(s); }
function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(date, delta) {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function studyStreak() {
  let d = today(), n = 0;
  while (Number(state.daily.completedByDate[d] || 0) > 0) { n++; d = addDays(d, -1); }
  return n;
}
function recordChapterCompletion(day) {
  const d = day || today();
  state.daily.completedByDate[d] = Number(state.daily.completedByDate[d] || 0) + 1;
  save();
}
function recordDailyExam(delta) {
  const d = today();
  const old = Number(state.daily.byDate[d] || 0);
  const next = Math.max(0, old + delta);
  state.daily.byDate[d] = next;
  state.daily.total = Math.max(0, Number(state.daily.total || 0) + delta);
  if (next === 0) delete state.daily.byDate[d];
  save();
}

function syllabus() {
  const out = [];
  for (const [sn, papers] of Object.entries(window.SYLLABUS)) {
    for (const [pn, chs] of Object.entries(papers)) {
      chs.forEach((name, i) => out.push({
        subject: sn, paper: pn, name, index: i + 1, id: `${sn}|${pn}|${i}`
      }));
    }
  }
  for (const [sn, s] of Object.entries(state.custom.subjects || {})) {
    for (const [pn, p] of Object.entries(s.papers || {})) {
      for (const c of p.chapters || []) {
        out.push({ subject: sn, paper: pn, name: c.name, index: c.index, id: c.id, custom: true });
      }
    }
  }
  return out;
}
function chapter(id) { return syllabus().find(x => x.id === id); }
function prog(id) { return state.progress[id] || (state.progress[id] = { theory: false, revision: 0, qb: 0, exam: 0 }); }
function done(p) { return !!(p.theory && p.revision >= 1 && p.qb >= 1 && p.exam >= 1); }
function totals() {
  const all = syllabus();
  const complete = all.filter(c => done(prog(c.id))).length;
  return { all, complete, remaining: all.length - complete, percent: pct(complete, all.length) };
}
function markEdited(id) { state.ui.lastEdited = id; save(); }
function change(id, fn) {
  const p = prog(id);
  const wasDone = done(p);
  const beforeExam = Number(p.exam || 0);
  fn(p);
  p.revision = Math.max(0, Number(p.revision || 0));
  p.qb = Math.max(0, Number(p.qb || 0));
  p.exam = Math.max(0, Number(p.exam || 0));
  if (p.exam !== beforeExam) recordDailyExam(p.exam - beforeExam);
  if (!wasDone && done(p)) recordChapterCompletion();
  markEdited(id);
  render();
}

function iconCheck(on) { return on ? "✓" : ""; }
function backButton(target, label = "Back") {
  return `<button class="secondary back-btn" onclick="go('${target}')">← ${esc(label)}</button>`;
}
function pageHero(eyebrow, title, text, back) {
  return `<div class="hero"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></div>${back ? backButton(back.target, back.label) : ""}</div>`;
}

function nowParts() {
  const d = new Date();
  return {
    date: d.toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }),
    time: d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  };
}
function examDateValue(exam) { return new Date(exam.date).getTime(); }
function upcomingExams() {
  return state.exams
    .filter(e => Number.isFinite(examDateValue(e)) && examDateValue(e) > Date.now())
    .sort((a, b) => examDateValue(a) - examDateValue(b));
}
function nextExam() { return upcomingExams()[0] || null; }
function countdownParts(ms) {
  if (ms <= 0) return [0, 0, 0, 0];
  const s = Math.floor(ms / 1000);
  return [
    Math.floor(s / 86400),
    Math.floor(s % 86400 / 3600),
    Math.floor(s % 3600 / 60),
    s % 60
  ];
}
function formatDateShort(v) {
  const d = new Date(v);
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function timeHorizon() {
  const now = new Date(), months = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const last = new Date(now.getFullYear(), now.getMonth() + i + 1, 0);
    let daysLeft;
    if (i === 0) daysLeft = last.getDate() - now.getDate() + 1;
    else daysLeft = last.getDate();
    months.push(`<div class="horizon-item"><b>${d.toLocaleString("en-US", { month: "long", year: "numeric" })}</b><span>${daysLeft} day${daysLeft === 1 ? "" : "s"}</span></div>`);
  }
  return months.join("");
}
function refreshLive() {
  const n = nowParts();
  document.querySelectorAll("[data-live-date]").forEach(x => x.textContent = n.date);
  document.querySelectorAll("[data-live-time]").forEach(x => x.textContent = n.time);
  const ex = nextExam();
  const box = document.getElementById("nextCountdown");
  if (box) {
    if (!ex) box.innerHTML = '<div class="muted">No upcoming exam scheduled.</div>';
    else {
      const [d, h, m, s] = countdownParts(examDateValue(ex) - Date.now());
      box.querySelector("[data-exam-name]").textContent = ex.name;
      box.querySelector("[data-exam-date]").textContent = formatDateShort(ex.date);
      box.querySelector("[data-cd-days]").textContent = d;
      box.querySelector("[data-cd-hours]").textContent = h;
      box.querySelector("[data-cd-mins]").textContent = m;
      box.querySelector("[data-cd-secs]").textContent = s;
    }
  }
}
function startLive() {
  clearInterval(clockTimer);
  refreshLive();
  clockTimer = setInterval(refreshLive, 1000);
}
function addExam(name, date) {
  name = String(name || "").trim();
  if (!name || !date) return toast("Enter exam name and date/time");
  state.exams.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name, date
  });
  save();
  render();
  toast("Exam scheduled");
}
function removeExam(id) {
  state.exams = state.exams.filter(e => e.id !== id);
  save();
  render();
  toast("Exam removed");
}

function progressTimeView() {
  return `${pageHero("Progress & time", "Progress & Time", "Your study streak, daily exam activity, current time and study horizon in one place.", { target: "dashboard", label: "Dashboard" })}
  <div class="grid stats">
    ${stat("Study Streak", studyStreak(), studyStreak() === 1 ? "day" : "days")}
    ${stat("Daily Exams Today", Number(state.daily.byDate[today()] || 0), "today")}
    ${stat("Daily Exams", Number(state.daily.total || 0), "overall")}
  </div>
  <div class="time-panel card">
    <div><div class="eyebrow">Current time</div><div class="live-date" data-live-date></div><div class="live-time" data-live-time></div></div>
    <div class="horizon"><div class="eyebrow">Study horizon</div><div class="horizon-grid">${timeHorizon()}</div></div>
  </div>`;
}

function examsView() {
  const list = [...state.exams].sort((a, b) => examDateValue(a) - examDateValue(b));
  return `${pageHero("Schedule", "Upcoming Exams", "Set your own exam dates and keep a live countdown.", { target: "dashboard", label: "Dashboard" })}
  <div class="card exam-form">
    <h2>Add an exam</h2>
    <div class="exam-form-grid">
      <input id="examName" class="search" placeholder="Exam name e.g. DU A Unit">
      <input id="examDate" class="search" type="datetime-local">
      <button class="primary" onclick="addExam(document.getElementById('examName').value,document.getElementById('examDate').value)">Add exam</button>
    </div>
  </div>
  <div class="section-title"><h2>Scheduled exams</h2><span class="muted">Edit your dates anytime</span></div>
  <div class="exam-schedule">
    ${list.length
      ? list.map(e => `<div class="card schedule-row"><div><b>${esc(e.name)}</b><div class="muted">${formatDateShort(e.date)}</div></div><button class="secondary danger" onclick="removeExam('${e.id}')">Remove</button></div>`).join("")
      : '<div class="empty">No exams scheduled yet.</div>'}
  </div>`;
}

function countdownCard() {
  const ex = nextExam();
  if (!ex) {
    return `<div class="countdown-top"><div><div class="eyebrow">Next exam</div><h2>No upcoming exam</h2><div class="muted">Set your next exam date to start a live countdown.</div></div><button class="primary" onclick="go('exams')">Set an exam</button></div>`;
  }
  return `<div class="countdown-top"><div><div class="eyebrow">Next exam</div><h2 data-exam-name>${esc(ex.name)}</h2><div class="muted" data-exam-date>${formatDateShort(ex.date)}</div></div><button class="secondary" onclick="go('exams')">Manage exams</button></div>
  <div class="countdown-grid">
    <div><b data-cd-days>0</b><span>Days</span></div>
    <div><b data-cd-hours>0</b><span>Hours</span></div>
    <div><b data-cd-mins>0</b><span>Minutes</span></div>
    <div><b data-cd-secs>0</b><span>Seconds</span></div>
  </div>`;
}

function dashboard() {
  const t = totals();
  const last = state.ui.lastEdited && chapter(state.ui.lastEdited);
  const resume = last && !done(prog(last.id)) ? last : t.all.find(c => !done(prog(c.id)));
  const by = {};
  for (const c of t.all) {
    by[c.subject] ??= { all: 0, done: 0 };
    by[c.subject].all++;
    if (done(prog(c.id))) by[c.subject].done++;
  }
  const dailyToday = Number(state.daily.byDate[today()] || 0);
  return `${pageHero("Admission command center", "Dashboard", "Track chapters, daily exams and every final/mock attempt.", null)}
  <div class="grid stats">
    ${stat("Completion", t.percent + "%", "of chapters", t.percent)}
    ${stat("Chapters", t.complete + " / " + t.all.length, "completed")}
    ${stat("Daily Exams", state.daily.total, "overall")}
    ${stat("Study Streak", studyStreak(), studyStreak() === 1 ? "day" : "days")}
  </div>
  <div class="daily-alert card">
    <div><b>Daily Exam + Analysis</b><p>Every day, give at least one exam and do the error analysis. You can give multiple exams in one day.</p></div>
    <strong>${dailyToday} today</strong>
  </div>
  ${resume ? `<div class="section-title"><h2>Continue</h2><span class="muted">Pick up where you left off</span></div><div class="card resume"><div><div class="eyebrow">${esc(resume.subject)} · ${esc(resume.paper)}</div><h3>${esc(resume.name)}</h3><p>${stageSummary(resume.id)}</p></div><button class="primary" onclick="openChapter('${enc(resume.id)}')">Continue →</button></div>` : ""}
  <div class="section-title"><h2>Subject Chapter Completion</h2><span class="muted">Chapter completion by subject</span></div>
  <div class="grid subject-grid">
    ${Object.entries(by).map(([n, v]) => `<div class="card subject-card" onclick="filterSubject('${enc(n)}')"><div class="subject-name">${esc(n)}</div><div class="subject-meta">${v.done} of ${v.all} chapters complete</div><div class="progress"><i style="width:${pct(v.done, v.all)}%"></i></div><div class="bar-row"><span>${pct(v.done, v.all)}%</span><span>${v.all - v.done} left</span></div></div>`).join("")}
  </div>
  <div class="section-title"><h2>Exam counts</h2><span class="muted">Only final/mock appearances are shown here</span></div>
  <div class="exam-dashboard">
    <div class="card"><h3>Paper Final Exams</h3><div class="exam-list">${paperDashboard()}</div></div>
    <div class="card"><h3>Subject Final Exams</h3><div class="exam-list">${subjectDashboard()}</div></div>
    <div class="card"><h3>Full Mock Tests</h3><div class="mock-total">${Number(state.mock || 0)}</div><div class="muted">mock tests given</div></div>
  </div>`;
}
function stat(a, b, c, p) {
  return `<div class="card"><div class="stat-label">${a}</div><div class="stat-value">${b} <small>${c}</small></div>${p !== undefined ? `<div class="progress"><i style="width:${p}%"></i></div>` : ""}</div>`;
}
function stageSummary(id) {
  const p = prog(id);
  return `${p.theory ? "✓" : "○"} Theory · ${p.revision} revisions · ${p.qb} QB · ${p.exam} daily exams`;
}
function paperDashboard() {
  const arr = [];
  for (const [s, ps] of Object.entries(window.SYLLABUS)) {
    for (const p of Object.keys(ps)) {
      const n = Number(state.finals.papers[s + "|" + p] || 0);
      arr.push(`<div class="exam-row"><span>${esc(s)} · ${esc(p)}</span><b>${n}</b></div>`);
    }
  }
  return arr.join("");
}
function subjectDashboard() {
  return [...new Set(Object.keys(window.SYLLABUS))]
    .map(s => `<div class="exam-row"><span>${esc(s)}</span><b>${Number(state.finals.subjects[s] || 0)}</b></div>`)
    .join("");
}

function chaptersView() {
  const subjects = [...new Set(syllabus().map(c => c.subject))];
  return `${pageHero("Syllabus", "Chapters", "Track theory, revision, QB practice and the required daily exam.", { target: "dashboard", label: "Dashboard" })}
  <div class="filter-panel card">
    <div class="filter-grid">
      <input class="search" id="chapterSearch" placeholder="Search chapter…" oninput="renderChapters()">
      <select class="filter" id="subjectFilter" onchange="updatePaperFilter();renderChapters()">
        <option value="all">All subjects</option>
        ${subjects.map(s => `<option value="${enc(s)}">${esc(s)}</option>`).join("")}
      </select>
      <select class="filter" id="paperFilter" onchange="renderChapters()"><option value="all">All papers</option></select>
      <select class="filter" id="reviewFilter" onchange="renderChapters()">
        <option value="all">All chapters</option>
        <option value="untouched">Not touched</option>
        <option value="revision">Least revised</option>
        <option value="qb">Least QB practiced</option>
        <option value="exam">Least exam + analysis</option>
        <option value="in">In progress</option>
        <option value="done">Completed</option>
      </select>
    </div>
    <div class="filter-hint">Filters work together. Chapters remain grouped by subject and paper.</div>
  </div>
  <div id="chapterList"></div>`;
}

function updatePaperFilter() {
  const subject = decodeURIComponent(document.getElementById("subjectFilter")?.value || "all");
  const select = document.getElementById("paperFilter");
  if (!select) return;
  const papers = [...new Set(syllabus().filter(c => subject === "all" || c.subject === subject).map(c => c.paper))];
  const current = select.value;
  select.innerHTML = '<option value="all">All papers</option>' + papers.map(p => `<option value="${enc(p)}">${esc(p)}</option>`).join("");
  if (papers.includes(decodeURIComponent(current))) select.value = current;
}
function leastBy(arr, fn) {
  if (!arr.length) return [];
  const min = Math.min(...arr.map(fn));
  return arr.filter(x => fn(x) === min);
}
function renderChapters() {
  const host = document.getElementById("chapterList");
  if (!host) return;
  const q = (document.getElementById("chapterSearch")?.value || "").toLowerCase().trim();
  const sf = decodeURIComponent(document.getElementById("subjectFilter")?.value || "all");
  const pf = decodeURIComponent(document.getElementById("paperFilter")?.value || "all");
  const rf = document.getElementById("reviewFilter")?.value || "all";
  let all = syllabus().filter(c => {
    const p = prog(c.id);
    return (!q || (c.name + " " + c.subject + " " + c.paper).toLowerCase().includes(q))
      && (sf === "all" || c.subject === sf)
      && (pf === "all" || c.paper === pf);
  });
  if (rf === "done") all = all.filter(c => done(prog(c.id)));
  if (rf === "in") all = all.filter(c => {
    const p = prog(c.id);
    return !done(p) && (p.theory || p.revision > 0 || p.qb > 0 || p.exam > 0);
  });
  if (rf === "untouched") all = all.filter(c => {
    const p = prog(c.id);
    return !p.theory && p.revision === 0 && p.qb === 0 && p.exam === 0;
  });
  if (rf === "revision") all = leastBy(all, c => prog(c.id).revision);
  if (rf === "qb") all = leastBy(all, c => prog(c.id).qb);
  if (rf === "exam") all = leastBy(all, c => prog(c.id).exam);
  if (["revision", "qb", "exam"].includes(rf)) {
    const k = rf === "revision" ? "revision" : rf === "qb" ? "qb" : "exam";
    all.sort((a, b) => prog(a.id)[k] - prog(b.id)[k] || a.subject.localeCompare(b.subject));
  }
  if (!all.length) { host.innerHTML = '<div class="empty">No chapters match these filters.</div>'; return; }
  const groups = {};
  all.forEach(c => { const key = c.subject + "|||" + c.paper; (groups[key] ??= []).push(c); });
  host.innerHTML = Object.entries(groups).map(([key, items]) => {
    const [subject, paper] = key.split("|||");
    return `<section class="chapter-group">
      <div class="chapter-heading"><div><div class="eyebrow">${esc(subject)}</div><h2>${esc(paper)}</h2></div><span>${items.length} chapter${items.length === 1 ? "" : "s"}</span></div>
      <div class="chapter-list">
        ${items.map(c => {
          const p = prog(c.id), d = done(p);
          return `<div class="chapter ${d ? "done" : ""}" onclick="openChapter('${enc(c.id)}')">
            <div class="num">${c.index}</div>
            <div><div class="chapter-name">${esc(c.name)}</div>
              <div class="chapter-counts"><span>Revision <b>${p.revision}</b></span><span>QB <b>${p.qb}</b></span><span>Daily exam <b>${p.exam}</b></span></div>
            </div>
            <span class="status ${d ? "done" : ""}">${d ? "Completed" : "Open"}</span>
          </div>`;
        }).join("")}
      </div>
    </section>`;
  }).join("");
}

function chapterView(c) {
  if (!c) return pageHero("Chapters", "Not found", "This chapter could not be found.", { target: "chapters", label: "Chapters" });
  const p = prog(c.id);
  return `${pageHero(c.subject + " · " + c.paper, c.name, "Daily Exam + Error Analysis is the required daily study habit.", { target: "chapters", label: "Chapters" })}
  <div class="detail"><div class="stage-list">
    ${stageBool("Theory + Concept Class", "Finish the core theory/concept lesson.", p.theory, `toggle('${enc(c.id)}','theory')`)}
    ${stageCounter("Theory + Concept Revision + Active Recall", "Count each completed revision / recall session.", p.revision, `counter('${enc(c.id)}','revision',-1)`, `counter('${enc(c.id)}','revision',1)`)}
    ${stageCounter("Question Bank Solve", "Count each meaningful QB solving session.", p.qb, `counter('${enc(c.id)}','qb',-1)`, `counter('${enc(c.id)}','qb',1)`)}
    ${stageCounter("Daily Exam + Error Analysis", "This is your daily exam. Multiple exams in one day are allowed.", p.exam, `counter('${enc(c.id)}','exam',-1)`, `counter('${enc(c.id)}','exam',1)`)}
    <div class="daily-mini card"><b>${Number(state.daily.byDate[today()] || 0)} exams today</b><span> · Overall daily exams: ${state.daily.total} · Study streak: ${studyStreak()} day${studyStreak() === 1 ? "" : "s"}</span></div>
  </div></div>`;
}
function stageBool(a, b, on, fn) {
  return `<div class="stage"><div><div class="stage-title">${a}</div><div class="stage-desc">${b}</div></div><button class="check ${on ? "on" : ""}" onclick="${fn}">${iconCheck(on)}</button></div>`;
}
function stageCounter(a, b, n, minus, plus) {
  return `<div class="stage"><div><div class="stage-title">${a}</div><div class="stage-desc">${b}</div></div><div class="counter"><button type="button" onclick="${minus}">−</button><b>${n}</b><button type="button" onclick="${plus}">+</button></div></div>`;
}

function finalsView() {
  const papers = [];
  for (const [s, ps] of Object.entries(window.SYLLABUS)) {
    for (const p of Object.keys(ps)) papers.push([s, p]);
  }
  const subjects = [...new Set(papers.map(x => x[0]))];
  return `${pageHero("Final exams", "Paper & Subject Finals", "Only one counter per exam type. No syllabus completion required.", { target: "dashboard", label: "Dashboard" })}
  <div class="section-title"><h2>Paper Final Exams</h2><span class="muted">Every + click = one paper final exam</span></div>
  <div class="final-grid">${papers.map(([s, p]) => finalCard(s, p, "paper")).join("")}</div>
  <div class="section-title"><h2>Subject Final Exams</h2><span class="muted">Every + click = one subject final exam</span></div>
  <div class="final-grid">${subjects.map(s => finalCard(s, s, "subject")).join("")}</div>`;
}
function finalCard(s, n, type) {
  const id = type === "paper" ? s + "|" + n : n;
  const key = type === "paper" ? "papers" : "subjects";
  const value = Number(state.finals[key][id] || 0);
  return `<div class="card final-card">
    <h3>${esc(n)}</h3>
    <div class="sub">${type === "paper" ? esc(s) + " · Paper final" : "Subject final · both papers"}</div>
    <div class="simple-counter">
      <button type="button" onclick="finalCounter('${enc(type)}','${enc(id)}',-1)">−</button>
      <b>${value}</b>
      <button type="button" onclick="finalCounter('${enc(type)}','${enc(id)}',1)">+</button>
    </div>
    <div class="counter-caption">exam${value === 1 ? "" : "s"} given</div>
  </div>`;
}
function finalCounter(type, id, d) {
  type = decodeURIComponent(type);
  id = decodeURIComponent(id);
  const key = type === "paper" ? "papers" : "subjects";
  state.finals[key][id] = Math.max(0, Number(state.finals[key][id] || 0) + d);
  save();
  render();
}
function mockView() {
  const n = Number(state.mock || 0);
  return `${pageHero("Full test", "Mock Tests", "One simple counter. Every + click records one full mock test. Always open.", { target: "dashboard", label: "Dashboard" })}
  <div class="detail"><div class="card mock-card">
    <div class="simple-counter">
      <button type="button" onclick="mock(-1)">−</button>
      <b>${n}</b>
      <button type="button" onclick="mock(1)">+</button>
    </div>
    <h3>${n} mock test${n === 1 ? "" : "s"} given</h3>
    <p class="muted">No syllabus completion or preparation stages are required.</p>
  </div></div>`;
}
function mock(d) {
  state.mock = Math.max(0, Number(state.mock || 0) + d);
  save();
  render();
}

function settingsView() {
  return `${pageHero("Preferences & data", "Settings", "Manage backup and reset options.", { target: "dashboard", label: "Dashboard" })}
  <div class="settings card">
    <div class="setting-row"><div><h3>Export progress</h3><p>Download a JSON backup of your complete tracker.</p></div><button class="secondary" onclick="exportData()">Export</button></div>
    <div class="setting-row"><div><h3>Import progress</h3><p>Restore a previous JSON backup.</p></div><button class="secondary" onclick="document.getElementById('importFile').click()">Import</button></div>
    <div class="setting-row"><div><h3>Cloud sync</h3><p>Force a manual sync with the server right now.</p></div><button class="secondary" onclick="manualSync()">Sync now</button></div>
    <div class="setting-row"><div><h3>Sign out</h3><p>Removes your session from this device. Data stays in the cloud.</p></div><button class="secondary danger" onclick="signOut()">Sign out</button></div>
    <div class="setting-row"><div><h3>Reset all progress</h3><p>This removes all tracker data from this device and the cloud.</p></div><button class="secondary danger" onclick="resetAll()">Reset</button></div>
    <input hidden type="file" id="importFile" accept="application/json" onchange="importData(this.files[0])">
  </div>`;
}

function openChapter(id) {
  activeChapter = decodeURIComponent(id);
  page = "chapter";
  closeSidebar();
  render();
}
function filterSubject(n) {
  page = "chapters";
  activeChapter = null;
  closeSidebar();
  render();
  setTimeout(() => {
    const s = document.getElementById("subjectFilter");
    if (s) {
      s.value = encodeURIComponent(decodeURIComponent(n));
      updatePaperFilter();
      renderChapters();
    }
  }, 0);
}
function closeSidebar() {
  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("scrim")?.classList.remove("show");
  document.getElementById("menuBtn")?.setAttribute("aria-expanded", "false");
}
function go(p) {
  page = p;
  activeChapter = null;
  closeSidebar();
  document.querySelectorAll(".nav").forEach(x => x.classList.toggle("active", x.dataset.page === p));
  render();
}
function toggle(id, k) { change(decodeURIComponent(id), p => p[k] = !p[k]); }
function counter(id, k, d) { change(decodeURIComponent(id), p => p[k] = Math.max(0, Number(p[k] || 0) + d)); }

function render() {
  let h = page === "dashboard" ? dashboard()
    : page === "chapters" ? chaptersView()
    : page === "chapter" && activeChapter ? chapterView(chapter(activeChapter))
    : page === "finals" ? finalsView()
    : page === "mock" ? mockView()
    : page === "exams" ? examsView()
    : page === "progress" ? progressTimeView()
    : settingsView();
  document.getElementById("content").innerHTML = h;
  if (page === "chapters") { updatePaperFilter(); renderChapters(); }
  if (page === "dashboard" || page === "progress") startLive();
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `focus-admission-backup-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Backup exported");
}
function importData(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const x = JSON.parse(r.result);
      if (!x.progress || !x.finals) throw Error();
      state = merge(clone(DEFAULT), x);
      state.finals = state.finals || { papers: {}, subjects: {} };
      state.mock = typeof state.mock === "number" ? state.mock : cycleCount(state.mock);
      save();
      render();
      toast("Backup imported");
    } catch { toast("Invalid backup file"); }
  };
  r.readAsText(file);
}
async function manualSync() {
  toast("Syncing…");
  await pushRemote();
  const remote = await pullRemote();
  if (remote && remote.state) {
    state = merge(clone(DEFAULT), remote.state);
    localStorage.setItem(KEY, JSON.stringify(state));
    render();
    toast("Synced from cloud");
  } else {
    toast("Synced to cloud");
  }
}
function signOut() {
  if (!confirm("Sign out of this device? Your data stays in the cloud.")) return;
  localStorage.removeItem('site_token');
  localStorage.removeItem('site_user');
  location.replace('/login.html');
}
function resetAll() {
  if (confirm("Reset all progress? This cannot be undone.")) {
    state = clone(DEFAULT);
    save();
    render();
    toast("Progress reset");
  }
}
function toggleTheme() { toast("Light mode is always on"); }
function applyTheme() { document.body.classList.add("light"); }

document.querySelectorAll(".nav").forEach(b => b.onclick = () => go(b.dataset.page));
const themeBtn = document.getElementById("themeBtn");
if (themeBtn) themeBtn.style.display = "none";
const menuBtn = document.getElementById("menuBtn");
if (menuBtn) menuBtn.onclick = () => {
  const open = document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("scrim").classList.toggle("show", open);
  menuBtn.setAttribute("aria-expanded", open);
};
document.getElementById("scrim").onclick = closeSidebar;
document.getElementById("sidebarClose").onclick = closeSidebar;

applyTheme();
render();

window.go = go;
window.addExam = addExam;
window.removeExam = removeExam;
window.closeSidebar = closeSidebar;
window.openChapter = openChapter;
window.filterSubject = filterSubject;
window.renderChapters = renderChapters;
window.updatePaperFilter = updatePaperFilter;
window.toggle = toggle;
window.counter = counter;
window.finalCounter = finalCounter;
window.mock = mock;
window.toggleTheme = toggleTheme;
window.exportData = exportData;
window.importData = importData;
window.resetAll = resetAll;
window.manualSync = manualSync;
window.signOut = signOut;
window.enc = enc;

// ══════════════════════════════════════════════════════════════
// BOOTSTRAP SYNC — runs after UI is rendered
// ══════════════════════════════════════════════════════════════
(async function bootstrapSync() {
  const migrateFlag = localStorage.getItem('cadence_migrate_local') === '1';
  if (migrateFlag) {
    localStorage.removeItem('cadence_migrate_local');
    await pushRemote();
    setSyncStatus('synced');
    return;
  }
  setSyncStatus('syncing');
  const remote = await pullRemote();
  if (remote && remote.state && remote.updated_at) {
    state = merge(clone(DEFAULT), remote.state);
    localStorage.setItem(KEY, JSON.stringify(state));
    render();
    setSyncStatus('synced');
  } else if (remote && remote.state === null) {
    // Server has no data yet — push current local state
    await pushRemote();
    setSyncStatus('synced');
  } else {
    setSyncStatus('error');
  }
})();

// Flush pending push if user closes tab
window.addEventListener('beforeunload', () => {
  if (pushTimer && TOKEN) {
    navigator.sendBeacon?.(
      '/api/state',
      new Blob([JSON.stringify({ state })], { type: 'application/json' })
    );
  }
});
})();

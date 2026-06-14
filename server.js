import express from "express";
import cron from "node-cron";
import { Resend } from "resend";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.FRONTEND_URL || "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";
const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return getDefaultData();
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return getDefaultData(); }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getDefaultData() {
  return {
    members: [
      { id: 1, name: "Alex",   email: "", color: "#E8A87C" },
      { id: 2, name: "Jordan", email: "", color: "#85C1E9" },
      { id: 3, name: "Sam",    email: "", color: "#82E0AA" },
      { id: 4, name: "Riley",  email: "", color: "#F1948A" },
    ],
    chores: [],
    tasks: [],
    dailyLog: {},
    alertTimes: ["08:00", "12:00", "17:00"],
    alertEnabled: [true, true, true],
  };
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FREQ_DAYS = { daily: 7, "5x": 5, "3x": 3, "2x": 2, weekly: 1 };

function getWeekOffset() {
  const epoch = new Date("2024-01-01");
  const now = new Date();
  return Math.floor((now - epoch) / (7 * 24 * 60 * 60 * 1000));
}

function getTodayDayName() {
  const d = new Date().getDay();
  return DAYS[d === 0 ? 6 : d - 1];
}

function generateSchedule(members, chores, weekOffset) {
  const schedule = {};
  DAYS.forEach(day => {
    schedule[day] = {};
    members.forEach(m => { schedule[day][m.id] = null; });
  });
  const choreAssignments = {};
  chores.forEach(chore => {
    const dpw = FREQ_DAYS[chore.frequency] ?? 1;
    let activeDays = [];
    if (dpw === 7) activeDays = [...DAYS];
    else if (dpw === 5) activeDays =
cat > server.js << 'EOF'
import express from "express";
import cron from "node-cron";
import { Resend } from "resend";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.FRONTEND_URL || "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";
const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return getDefaultData();
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return getDefaultData(); }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getDefaultData() {
  return {
    members: [
      { id: 1, name: "Alex",   email: "", color: "#E8A87C" },
      { id: 2, name: "Jordan", email: "", color: "#85C1E9" },
      { id: 3, name: "Sam",    email: "", color: "#82E0AA" },
      { id: 4, name: "Riley",  email: "", color: "#F1948A" },
    ],
    chores: [],
    tasks: [],
    dailyLog: {},
    alertTimes: ["08:00", "12:00", "17:00"],
    alertEnabled: [true, true, true],
  };
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FREQ_DAYS = { daily: 7, "5x": 5, "3x": 3, "2x": 2, weekly: 1 };

function getWeekOffset() {
  const epoch = new Date("2024-01-01");
  const now = new Date();
  return Math.floor((now - epoch) / (7 * 24 * 60 * 60 * 1000));
}

function getTodayDayName() {
  const d = new Date().getDay();
  return DAYS[d === 0 ? 6 : d - 1];
}

function generateSchedule(members, chores, weekOffset) {
  const schedule = {};
  DAYS.forEach(day => {
    schedule[day] = {};
    members.forEach(m => { schedule[day][m.id] = null; });
  });
  const choreAssignments = {};
  chores.forEach(chore => {
    const dpw = FREQ_DAYS[chore.frequency] ?? 1;
    let activeDays = [];
    if (dpw === 7) activeDays = [...DAYS];
    else if (dpw === 5) activeDays = DAYS.slice(0, 5);
    else if (dpw === 3) activeDays = [DAYS[0], DAYS[2], DAYS[4]];
    else if (dpw === 2) activeDays = [DAYS[0], DAYS[3]];
    else activeDays = [DAYS[weekOffset % 7]];
    choreAssignments[chore.id] = activeDays;
  });
  [...chores].forEach((chore, i) => {
    const memberIndex = (i + weekOffset) % members.length;
    const primaryMember = members[memberIndex];
    const days = choreAssignments[chore.id] || [];
    days.forEach(day => {
      if (!schedule[day][primaryMember.id]) {
        schedule[day][primaryMember.id] = chore;
      } else {
        const other = members.find(m => m.id !== primaryMember.id && !schedule[day][m.id]);
        if (other) schedule[day][other.id] = chore;
      }
    });
  });
  return schedule;
}

function makeToken() { return crypto.randomBytes(16).toString("hex"); }
function completeUrl(token) { return `${process.env.BACKEND_URL || "http://localhost:3001"}/complete/${token}`; }

async function sendChoreEmail(member, chore, token) {
  const url = completeUrl(token);
  await resend.emails.send({
    from: FROM_EMAIL,
    to: member.email,
    subject: `🏠 Your chore for today — ${member.name}`,
    html: `<div style="font-family:monospace;max-width:480px;margin:0 auto;background:#0F0E0C;color:#E8E2D9;border-radius:12px;padding:32px;">
      <div style="font-size:20px;font-weight:700;color:#E8A87C;">chorehouse 🏠</div>
      <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:16px 0;"/>
      <p style="color:rgba(232,226,217,0.7);">Hey <strong style="color:#E8E2D9;">${member.name}</strong>, your chore for today is:</p>
      <div style="background:rgba(255,255,255,0.05);border-left:3px solid ${member.color};border-radius:8px;padding:16px 20px;margin:20px 0;">
        <div style="font-size:18px;color:#E8E2D9;font-weight:600;">${chore.name}</div>
      </div>
      <a href="${url}" style="display:inline-block;background:${member.color};color:#0F0E0C;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;">✓ Mark as Complete</a>
    </div>`,
  });
}

async function sendReminderEmail(member, chore, token) {
  const url = completeUrl(token);
  await resend.emails.send({
    from: FROM_EMAIL,
    to: member.email,
    subject: `⏰ Reminder — ${chore.name} still pending`,
    html: `<div style="font-family:monospace;max-width:480px;margin:0 auto;background:#0F0E0C;color:#E8E2D9;border-radius:12px;padding:32px;">
      <div style="font-size:20px;font-weight:700;color:#E8A87C;">chorehouse 🏠</div>
      <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:16px 0;"/>
      <p style="color:rgba(232,226,217,0.7);">Hey <strong style="color:#E8E2D9;">${member.name}</strong> — gentle nudge! Still waiting on:</p>
      <div style="background:rgba(255,255,255,0.05);border-left:3px solid ${member.color};border-radius:8px;padding:16px 20px;margin:20px 0;">
        <div style="font-size:18px;color:#E8E2D9;font-weight:600;">${chore.name}</div>
      </div>
      <a href="${url}" style="display:inline-block;background:${member.color};color:#0F0E0C;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;">✓ Mark as Complete</a>
    </div>`,
  });
}

async function runAlerts(alertIndex) {
  const data = loadData();
  const { members, chores, alertEnabled, dailyLog } = data;
  if (!alertEnabled[alertIndex]) return;
  const today = new Date().toISOString().split("T")[0];
  const dayName = getTodayDayName();
  const schedule = generateSchedule(members, chores, getWeekOffset());
  for (const member of members) {
    if (!member.email) continue;
    const chore = schedule[dayName][member.id];
    if (!chore) continue;
    const logKey = `${today}:${member.id}`;
    const existing = dailyLog[logKey];
    if (existing?.done) continue;
    if (alertIndex === 0) {
      const token = makeToken();
      data.dailyLog[logKey] = { choreId: chore.id, done: false, token };
      saveData(data);
      try { await sendChoreEmail(member, chore, token); } catch (e) { console.error(`Email failed for ${member.name}:`, e.message); }
    } else {
      const token = existing?.token || makeToken();
      if (!existing) { data.dailyLog[logKey] = { choreId: chore.id, done: false, token }; saveData(data); }
      try { await sendReminderEmail(member, chore, token); } catch (e) { console.error(`Reminder failed for ${member.name}:`, e.message); }
    }
  }
  console.log(`Alert ${alertIndex + 1} processed at ${new Date().toISOString()}`);
}

function parseCron(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return `${m} ${h} * * *`;
}

function scheduleCrons() {
  const data = loadData();
  data.alertTimes.forEach((time, i) => {
    cron.schedule(parseCron(time), () => runAlerts(i), { timezone: process.env.TZ || "America/Los_Angeles" });
    console.log(`Scheduled alert ${i + 1} at ${time}`);
  });
}

app.get("/complete/:token", (req, res) => {
  const data = loadData();
  const entry = Object.entries(data.dailyLog).find(([, v]) => v.token === req.params.token);
  if (!entry) return res.send(`<body style="font-family:monospace;background:#0F0E0C;color:#E8E2D9;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div style="text-align:center"><div style="font-size:48px">⚠</div><div style="color:#F1948A;margin-top:16px">Link expired or invalid.</div></div></body>`);
  const [key, val] = entry;
  if (val.done) return res.send(`<body style="font-family:monospace;background:#0F0E0C;color:#E8E2D9;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div style="text-align:center"><div style="font-size:48px">✓</div><div style="color:#82E0AA;margin-top:16px">Already marked done!</div></div></body>`);
  data.dailyLog[key].done = true;
  saveData(data);
  res.send(`<body style="font-family:monospace;background:#0F0E0C;color:#E8E2D9;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div style="text-align:center"><div style="font-size:48px">🎉</div><div style="color:#82E0AA;margin-top:16px;font-size:20px">Chore complete!</div></div></body>`);
});

app.get("/data", (req, res) => res.json(loadData()));
app.post("/data", (req, res) => {
  const data = loadData();
  const { members, chores, tasks, alertTimes, alertEnabled } = req.body;
  if (members) data.members = members;
  if (chores) data.chores = chores;
  if (tasks) data.tasks = tasks;
  if (alertTimes) data.alertTimes = alertTimes;
  if (alertEnabled) data.alertEnabled = alertEnabled;
  saveData(data);
  res.json({ ok: true });
});

app.get("/status/today", (req, res) => {
  const data = loadData();
  const today = new Date().toISOString().split("T")[0];
  const entries = Object.entries(data.dailyLog)
    .filter(([k]) => k.startsWith(today))
    .map(([k, v]) => {
      const memberId = parseInt(k.split(":")[1]);
      const member = data.members.find(m => m.id === memberId);
      const chore = data.chores.find(c => c.id === v.choreId);
      return { member: member?.name, chore: chore?.name, done: v.done };
    });
  res.json(entries);
});

app.post("/test-email", async (req, res) => {
  const data = loadData();
  const member = data.members.find(m => m.id === req.body.memberId);
  if (!member?.email) return res.status(400).json({ error: "No email set for this member" });
  try {
    await sendChoreEmail(member, { name: "Test chore — it works! 🎉", category: "Test" }, makeToken());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { console.log(`Chorehouse backend on port ${PORT}`); scheduleCrons(); });

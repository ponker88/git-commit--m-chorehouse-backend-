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
  res.header("Access-Control-Allow-Origin", "*");
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
      { id: 1, name: "Alex", email: "", color: "#E8A87C" },
      { id: 2, name: "Jordan", email: "", color: "#85C1E9" },
      { id: 3, name: "Sam", email: "", color: "#82E0AA" },
      { id: 4, name: "Riley", email: "", color: "#F1948A" },
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
  return Math.floor((new Date() - epoch) / (7 * 24 * 60 * 60 * 1000));
}

function getTodayDayName() {
  const d = new Date().getDay();
  return DAYS[d === 0 ? 6 : d - 1];
}

function generateSchedule(members, chores, weekOffset) {
  const schedule = {};
  DAYS.forEach(day => { schedule[day] = {}; members.forEach(m => { schedule[day][m.id] = null; }); });
  const choreAssignments = {};
  chores.forEach(chore => {
    const dpw = FREQ_DAYS[chore.frequency] || 1;
    let activeDays = [];
    if (dpw === 7) activeDays = [...DAYS];
    else if (dpw === 5) activeDays = DAYS.slice(0, 5);
    else if (dpw === 3) activeDays = [DAYS[0], DAYS[2], DAYS[4]];
    else if (dpw === 2) activeDays = [DAYS[0], DAYS[3]];
    else activeDays = [DAYS[weekOffset % 7]];
    choreAssignments[chore.id] = activeDays;
  });
  [...chores].forEach((chore, i) => {
    const primaryMember = members[(i + weekOffset) % members.length];
    (choreAssignments[chore.id] || []).forEach(day => {
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
function completeUrl(token) { return (process.env.BACKEND_URL || "http://localhost:3001") + "/complete/" + token; }

async function sendChoreEmail(member, chore, token) {
  await resend.emails.send({
    from: FROM_EMAIL,
    to: member.email,
    subject: "Your chore for today - " + member.name,
    html: "<div style='font-family:monospace;max-width:480px;background:#0F0E0C;color:#E8E2D9;border-radius:12px;padding:32px;'><div style='font-size:20px;font-weight:700;color:#E8A87C;'>chorehouse</div><hr style='border:none;border-top:1px solid rgba(255,255,255,0.1);margin:16px 0;'/><p style='color:rgba(232,226,217,0.7);'>Hey <strong style='color:#E8E2D9;'>" + member.name + "</strong>, your chore for today is:</p><div style='background:rgba(255,255,255,0.05);border-left:3px solid " + member.color + ";border-radius:8px;padding:16px 20px;margin:20px 0;'><div style='font-size:18px;color:#E8E2D9;font-weight:600;'>" + chore.name + "</div></div><a href='" + completeUrl(token) + "' style='display:inline-block;background:" + member.color + ";color:#0F0E0C;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;'>Mark as Complete</a></div>",
  });
}

async function sendReminderEmail(member, chore, token) {
  await resend.emails.send({
    from: FROM_EMAIL,
    to: member.email,
    subject: "Reminder - " + chore.name + " still pending",
    html: "<div style='font-family:monospace;max-width:480px;background:#0F0E0C;color:#E8E2D9;border-radius:12px;padding:32px;'><div style='font-size:20px;font-weight:700;color:#E8A87C;'>chorehouse</div><hr style='border:none;border-top:1px solid rgba(255,255,255,0.1);margin:16px 0;'/><p style='color:rgba(232,226,217,0.7);'>Hey <strong style='color:#E8E2D9;'>" + member.name + "</strong> - gentle nudge! Still waiting on:</p><div style='background:rgba(255,255,255,0.05);border-left:3px solid " + member.color + ";border-radius:8px;padding:16px 20px;margin:20px 0;'><div style='font-size:18px;color:#E8E2D9;font-weight:600;'>" + chore.name + "</div></div><a href='" + completeUrl(token) + "' style='display:inline-block;background:" + member.color + ";color:#0F0E0C;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;'>Mark as Complete</a></div>",
  });
}

async function sendTaskEmail(member, task) {
  await resend.emails.send({
    from: FROM_EMAIL,
    to: member.email,
    subject: "Task reminder - " + task.title,
    html: "<div style='font-family:monospace;max-width:480px;background:#0F0E0C;color:#E8E2D9;border-radius:12px;padding:32px;'><div style='font-size:20px;font-weight:700;color:#E8A87C;'>chorehouse</div><hr style='border:none;border-top:1px solid rgba(255,255,255,0.1);margin:16px 0;'/><p style='color:rgba(232,226,217,0.7);'>Hey <strong style='color:#E8E2D9;'>" + member.name + "</strong>, you have a task to complete:</p><div style='background:rgba(255,255,255,0.05);border-left:3px solid " + member.color + ";border-radius:8px;padding:16px 20px;margin:20px 0;'><div style='font-size:18px;color:#E8E2D9;font-weight:600;'>" + task.title + "</div>" + (task.notes ? "<div style='font-size:12px;color:rgba(232,226,217,0.5);margin-top:6px;'>" + task.notes + "</div>" : "") + "<div style='font-size:10px;color:rgba(232,226,217,0.35);margin-top:8px;text-transform:uppercase;letter-spacing:1px;'>" + task.priority + " priority</div></div><p style='font-size:12px;color:rgba(232,226,217,0.4);'>Mark this task done in the Chorehouse dashboard to stop reminders.</p></div>",
  });
}

const taskReminders = {};

async function runAlerts(alertIndex) {
  const data = loadData();
  if (!data.alertEnabled[alertIndex]) return;
  const today = new Date().toISOString().split("T")[0];
  const schedule = generateSchedule(data.members, data.chores, getWeekOffset());
  for (const member of data.members) {
    if (!member.email) continue;
    const chore = schedule[getTodayDayName()][member.id];
    if (!chore) continue;
    const logKey = today + ":" + member.id;
    const existing = data.dailyLog[logKey];
    if (existing && existing.done) continue;
    if (alertIndex === 0) {
      const token = makeToken();
      data.dailyLog[logKey] = { choreId: chore.id, done: false, token };
      saveData(data);
      try { await sendChoreEmail(member, chore, token); } catch (e) { console.error("Email failed for " + member.name + ":", e.message); }
    } else {
      const token = (existing && existing.token) || makeToken();
      if (!existing) { data.dailyLog[logKey] = { choreId: chore.id, done: false, token }; saveData(data); }
      try { await sendReminderEmail(member, chore, token); } catch (e) { console.error("Reminder failed for " + member.name + ":", e.message); }
    }
  }
  console.log("Alert " + (alertIndex + 1) + " processed at " + new Date().toISOString());
}

function scheduleCrons() {
  const data = loadData();
  data.alertTimes.forEach((time, i) => {
    const parts = time.split(":");
    const h = parseInt(parts[0]);
    const m = parseInt(parts[1]);
    cron.schedule(m + " " + h + " * * *", () => runAlerts(i), { timezone: process.env.TZ || "America/Los_Angeles" });
    console.log("Scheduled alert " + (i + 1) + " at " + time);
  });
  cron.schedule("0 * * * *", async () => {
    console.log("Hourly task reminder check at " + new Date().toISOString());
    for (const id of Object.keys(taskReminders)) {
      const entry = taskReminders[id];
      if (!entry || entry.done) { delete taskReminders[id]; continue; }
      try {
        await sendTaskEmail(entry.member, entry.task);
        console.log("Hourly task reminder sent: " + entry.task.title + " -> " + entry.member.name);
      } catch (e) { console.error("Hourly task reminder failed:", e.message); }
    }
  }, { timezone: process.env.TZ || "America/Los_Angeles" });
}

app.get("/complete/:token", (req, res) => {
  const data = loadData();
  const entry = Object.entries(data.dailyLog).find(function(e) { return e[1].token === req.params.token; });
  if (!entry) return res.send("<body style='font-family:monospace;background:#0F0E0C;color:#E8E2D9;display:flex;align-items:center;justify-content:center;min-height:100vh;'><div style='text-align:center'><div style='font-size:48px'>!</div><div style='color:#F1948A;margin-top:16px'>Link expired.</div></div></body>");
  if (entry[1].done) return res.send("<body style='font-family:monospace;background:#0F0E0C;color:#E8E2D9;display:flex;align-items:center;justify-content:center;min-height:100vh;'><div style='text-align:center'><div style='font-size:48px'>v</div><div style='color:#82E0AA;margin-top:16px'>Already done!</div></div></body>");
  data.dailyLog[entry[0]].done = true;
  saveData(data);
  res.send("<body style='font-family:monospace;background:#0F0E0C;color:#E8E2D9;display:flex;align-items:center;justify-content:center;min-height:100vh;'><div style='text-align:center'><div style='font-size:48px'>:)</div><div style='color:#82E0AA;margin-top:16px;font-size:20px'>Chore complete!</div></div></body>");
});

app.get("/data", (req, res) => res.json(loadData()));

app.post("/data", (req, res) => {
  const data = loadData();
  if (req.body.members) data.members = req.body.members;
  if (req.body.chores) data.chores = req.body.chores;
  if (req.body.tasks) data.tasks = req.body.tasks;
  if (req.body.alertTimes) data.alertTimes = req.body.alertTimes;
  if (req.body.alertEnabled) data.alertEnabled = req.body.alertEnabled;
  saveData(data);
  res.json({ ok: true });
});

app.post("/task-notify", async (req, res) => {
  const { task, member } = req.body;
  if (!task || !member || !member.email) return res.status(400).json({ error: "Missing task or member" });
  try {
    await sendTaskEmail(member, task);
    taskReminders[task.id] = { task, member, done: false };
    console.log("Task notification sent: " + task.title + " -> " + member.name);
    res.json({ ok: true });
  } catch (e) {
    console.error("Task email failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/task-complete", (req, res) => {
  const { taskId } = req.body;
  if (taskReminders[taskId]) delete taskReminders[taskId];
  res.json({ ok: true });
});

app.get("/status/today", (req, res) => {
  const data = loadData();
  const today = new Date().toISOString().split("T")[0];
  const entries = Object.entries(data.dailyLog)
    .filter(function(e) { return e[0].startsWith(today); })
    .map(function(e) {
      const memberId = parseInt(e[0].split(":")[1]);
      const member = data.members.find(function(m) { return m.id === memberId; });
      const chore = data.chores.find(function(c) { return c.id === e[1].choreId; });
      return { member: member && member.name, chore: chore && chore.name, done: e[1].done };
    });
  res.json(entries);
});

app.post("/test-email", async (req, res) => {
  const data = loadData();
  const member = data.members.find(function(m) { return m.id === req.body.memberId; });
  if (!member || !member.email) return res.status(400).json({ error: "No email set for this member" });
  try {
    await sendChoreEmail(member, { name: "Test chore - it works!", category: "Test" }, makeToken());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, function() { console.log("Chorehouse backend on port " + PORT); scheduleCrons(); });

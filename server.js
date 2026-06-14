// ============================================================
//  Chorehouse Backend  –  server.js
//  Node.js + Express + Resend + node-cron
// ============================================================

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

// Allow requests from your Netlify frontend
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.FRONTEND_URL || "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || "chorehouse@yourdomain.com";
const DATA_FILE = path.join(__dirname, "data.json");

// ── Persistence (simple JSON file — fine for household scale) ──────────────
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
    chores: [
      { id: 1, name: "Vacuum living room", frequency: "2x",     category: "Cleaning"     },
      { id: 2, name: "Wash dishes",        frequency: "daily",  category: "Kitchen"      },
      { id: 3, name: "Take out trash",     frequency: "2x",     category: "Maintenance"  },
      { id: 4, name: "Mop floors",         frequency: "weekly", category: "Cleaning"     },
      { id: 5, name: "Clean bathrooms",    frequency: "2x",     category: "Cleaning"     },
      { id: 6, name: "Laundry",            frequency: "2x",     category: "Laundry"      },
      { id: 7, name: "Grocery run",        frequency: "weekly", category: "Errands"      },
      { id: 8, name: "Wipe counters",      frequency: "daily",  category: "Kitchen"      },
    ],
    tasks: [],
    // Map of "YYYY-MM-DD:memberId" → { choreId, done, token }
    dailyLog: {},
    alertTimes: ["08:00", "12:00", "17:00"],
    alertEnabled: [true, true, true],
  };
}

// ── Schedule logic (mirrors the frontend) ─────────────────────────────────
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FREQ_DAYS = { daily: 7, "5x": 5, "3x": 3, "2x": 2, weekly: 1 };

function getWeekOffset() {
  // Week offset = number of weeks since a fixed epoch (2024-01-01)
  const epoch = new Date("2024-01-01");
  const now = new Date();
  return Math.floor((now - epoch) / (7 * 24 * 60 * 60 * 1000));
}

function getTodayDayName() {
  const d = new Date().getDay(); // 0=Sun
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

// ── Email sending ──────────────────────────────────────────────────────────
function makeToken() {
  return crypto.randomBytes(16).toString("hex");
}

function completeUrl(token) {
  return `${process.env.BACKEND_URL || "http://localhost:3001"}/complete/${token}`;
}

async function sendChoreEmail(member, chore, token) {
  const url = completeUrl(token);
  const html = `
    <div style="font-family:monospace;max-width:480px;margin:0 auto;background:#0F0E0C;color:#E8E2D9;border-radius:12px;padding:32px;">
      <div style="font-size:20px;font-weight:700;margin-bottom:8px;color:#E8A87C;">chorehouse 🏠</div>
      <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:16px 0;"/>
      <p style="font-size:14px;color:rgba(232,226,217,0.7);margin-bottom:16px;">Hey <strong style="color:#E8E2D9;">${member.name}</strong>,</p>
      <p style="font-size:14px;color:rgba(232,226,217,0.7);margin-bottom:20px;">Your chore for today is:</p>
      <div style="background:rgba(255,255,255,0.05);border:1px solid ${member.color}44;border-left:3px solid ${member.color};border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <div style="font-size:18px;color:#E8E2D9;font-weight:600;">${chore.name}</div>
        ${chore.category ? `<div style="font-size:11px;color:rgba(232,226,217,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:1px;">${chore.category}</div>` : ""}
      </div>
      <a href="${url}" style="display:inline-block;background:${member.color};color:#0F0E0C;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:13px;letter-spacing:0.5px;">
        ✓ Mark as Complete
      </a>
      <p style="font-size:11px;color:rgba(232,226,217,0.3);margin-top:24px;">
        You'll get a reminder if this isn't marked done by your set times.<br/>
        Manage your schedule at <a href="${process.env.FRONTEND_URL || "#"}" style="color:rgba(232,226,217,0.4);">chorehouse</a>.
      </p>
    </div>`;

  await resend.emails.send({
    from: FROM_EMAIL,
    to: member.email,
    subject: `🏠 Your chore for today — ${member.name}`,
    html,
  });
}

async function sendReminderEmail(member, chore, token) {
  const url = completeUrl(token);
  const html = `
    <div style="font-family:monospace;max-width:480px;margin:0 auto;background:#0F0E0C;color:#E8E2D9;border-radius:12px;padding:32px;">
      <div style="font-size:20px;font-weight:700;margin-bottom:8px;color:#E8A87C;">chorehouse 🏠</div>
      <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:16px 0;"/>
      <p style="font-size:14px;color:rgba(232,226,217,0.7);margin-bottom:16px;">Hey <strong style="color:#E8E2D9;">${member.name}</strong> — gentle nudge!</p>
      <p style="font-size:13px;color:rgba(232,226,217,0.55);margin-bottom:20px;">This chore still needs doing today:</p>
      <div style="background:rgba(255,255,255,0.05);border:1px solid ${member.color}44;border-left:3px solid ${member.color};border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <div style="font-size:18px;color:#E8E2D9;font-weight:600;">${chore.name}</div>
      </div>
      <a href="${url}" style="display:inline-block;background:${member.color};color:#0F0E0C;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:13px;">
        ✓ Mark as Complete
      </a>
    </div>`;

  await resend.emails.send({
    from: FROM_EMAIL,
    to: member.email,
    subject: `⏰ Reminder — ${chore.name} still pending`,
    html,
  });
}

// ── Core daily job ─────────────────────────────────────────────────────────
async function runAlerts(alertIndex) {
  const data = loadData();
  const { members, chores, alertTimes, alertEnabled, dailyLog } = data;
  if (!alertEnabled[alertIndex]) return;

  const today = new Date().toISOString().split("T")[0];
  const dayName = getTodayDayName();
  const weekOffset = getWeekOffset();
  const schedule = generateSchedule(members, chores, weekOffset);

  for (const member of members) {
    if (!member.email) continue;
    const chore = schedule[dayName][member.id];
    if (!chore) continue;

    const logKey = `${today}:${member.id}`;
    const existing = dailyLog[logKey];

    // Already marked done — skip all reminders
    if (existing?.done) continue;

    if (alertIndex === 0) {
      // Morning: always send and create log entry
      const token = makeToken();
      data.dailyLog[logKey] = { choreId: chore.id, done: false, token };
      saveData(data);
      try { await sendChoreEmail(member, chore, token); }
      catch (e) { console.error(`Email failed for ${member.name}:`, e.message); }
    } else {
      // Follow-up: only send if not done
      const token = existing?.token || makeToken();
      if (!existing) { data.dailyLog[logKey] = { choreId: chore.id, done: false, token }; saveData(data); }
      try { await sendReminderEmail(member, chore, token); }
      catch (e) { console.error(`Reminder failed for ${member.name}:`, e.message); }
    }
  }
  console.log(`[${new Date().toISOString()}] Alert ${alertIndex + 1} processed.`);
}

// ── Schedule cron jobs from stored times ───────────────────────────────────
function parseCron(timeStr) {
  // "08:00" → "0 8 * * *"
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

// ── Routes ─────────────────────────────────────────────────────────────────

// Mark complete via email link
app.get("/complete/:token", (req, res) => {
  const { token } = req.params;
  const data = loadData();
  const entry = Object.entries(data.dailyLog).find(([, v]) => v.token === token);
  if (!entry) return res.send(doneHtml("This link has expired or is invalid.", false));

  const [key, val] = entry;
  if (val.done) return res.send(doneHtml("Already marked as done — nice work! ✓", true));

  data.dailyLog[key].done = true;
  saveData(data);
  res.send(doneHtml("Chore marked as complete! Great work 🎉", true));
});

function doneHtml(msg, success) {
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chorehouse</title></head>
  <body style="font-family:monospace;background:#0F0E0C;color:#E8E2D9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
    <div style="text-align:center;padding:40px;">
      <div style="font-size:48px;margin-bottom:16px;">${success ? "✓" : "⚠"}</div>
      <div style="font-size:20px;font-weight:700;color:${success?"#82E0AA":"#F1948A"};margin-bottom:12px;">chorehouse</div>
      <div style="font-size:15px;color:rgba(232,226,217,0.7);">${msg}</div>
    </div>
  </body></html>`;
}

// ── Data sync API (called by frontend to push config) ──────────────────────
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

// Today's status — useful for the dashboard
app.get("/status/today", (req, res) => {
  const data = loadData();
  const today = new Date().toISOString().split("T")[0];
  const todayEntries = Object.entries(data.dailyLog)
    .filter(([k]) => k.startsWith(today))
    .map(([k, v]) => {
      const memberId = parseInt(k.split(":")[1]);
      const member = data.members.find(m => m.id === memberId);
      const chore = data.chores.find(c => c.id === v.choreId);
      return { member: member?.name, chore: chore?.name, done: v.done };
    });
  res.json(todayEntries);
});

// Test endpoint — sends a single test email
app.post("/test-email", async (req, res) => {
  const { memberId } = req.body;
  const data = loadData();
  const member = data.members.find(m => m.id === memberId);
  if (!member?.email) return res.status(400).json({ error: "Member not found or no email set" });
  const chore = { name: "Test chore — it works! 🎉", category: "Test" };
  try {
    await sendChoreEmail(member, chore, makeToken());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
// ── Task notification routes ───────────────────────────────────────────────

// taskReminders: { taskId: { task, member, done, nextSendTime } }
const taskReminders = {};

async function sendTaskEmail(member, task, token) {
  const doneUrl = (process.env.BACKEND_URL || "http://localhost:3001") + "/task-done/" + token;
  await resend.emails.send({
    from: FROM_EMAIL,
    to: member.email,
    subject: "Task reminder - " + task.title,
    html: "<div style='font-family:monospace;max-width:480px;background:#0F0E0C;color:#E8E2D9;border-radius:12px;padding:32px;'><div style='font-size:20px;font-weight:700;color:#E8A87C;'>chorehouse</div><hr style='border:none;border-top:1px solid rgba(255,255,255,0.1);margin:16px 0;'/><p style='color:rgba(232,226,217,0.7);'>Hey <strong style='color:#E8E2D9;'>" + member.name + "</strong>, you have a task to complete:</p><div style='background:rgba(255,255,255,0.05);border-left:3px solid " + member.color + ";border-radius:8px;padding:16px 20px;margin:20px 0;'><div style='font-size:18px;color:#E8E2D9;font-weight:600;'>" + task.title + "</div>" + (task.notes ? "<div style='font-size:12px;color:rgba(232,226,217,0.5);margin-top:6px;'>" + task.notes + "</div>" : "") + "<div style='font-size:10px;color:rgba(232,226,217,0.35);margin-top:8px;text-transform:uppercase;letter-spacing:1px;'>" + task.priority + " priority</div></div><a href='" + doneUrl + "' style='display:inline-block;background:" + member.color + ";color:#0F0E0C;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;'>Mark as Complete</a></div>",
  });
}

// Send immediate notification when a task is assigned
app.post("/task-notify", async (req, res) => {
  const { task, member } = req.body;
  if (!task || !member || !member.email) return res.status(400).json({ error: "Missing task or member" });
  try {
    const token = makeToken();
    await sendTaskEmail(member, task, token);
    taskReminders[task.id] = { task, member, done: false, token };
    console.log("Task notification sent for: " + task.title + " -> " + member.name);
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

cron.schedule("0 * * * *", async () => {
  console.log("Hourly task reminder check at " + new Date().toISOString());
  for (const id of Object.keys(taskReminders)) {
    const entry = taskReminders[id];
    if (!entry || entry.done) { delete taskReminders[id]; continue; }
    try {
      await sendTaskEmail(entry.member, entry.task, entry.token || makeToken());
      console.log("Hourly reminder sent: " + entry.task.title + " -> " + entry.member.name);
    } catch (e) {
      console.error("Hourly reminder failed:", e.message);
    }
  }
}, { timezone: process.env.TZ || "America/Los_Angeles" });

app.get("/task-done/:token", (req, res) => {
  const token = req.params.token;
  const entry = Object.values(taskReminders).find(function(e) { return e.token === token; });
  if (!entry) return res.send("<body style='font-family:monospace;background:#0F0E0C;color:#E8E2D9;display:flex;align-items:center;justify-content:center;min-height:100vh;'><div style='text-align:center'><div style='font-size:48px'>!</div><div style='color:#F1948A;margin-top:16px'>Link expired or already done.</div></div></body>");
  entry.done = true;
  delete taskReminders[entry.task.id];
  res.send("<body style='font-family:monospace;background:#0F0E0C;color:#E8E2D9;display:flex;align-items:center;justify-content:center;min-height:100vh;'><div style='text-align:center'><div style='font-size:48px'>:)</div><div style='color:#82E0AA;margin-top:16px;font-size:20px'>Task complete! Great work.</div></div></body>");
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Chorehouse backend running on port ${PORT}`);
  scheduleCrons();
});

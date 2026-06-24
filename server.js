// ============================================================
//  Chorehouse Backend  –  server.js
//  Node.js + Express + Resend + node-cron
// ============================================================

import express from "express";
import cron from "node-cron";
import { Resend } from "resend";
import crypto from "crypto";
import pg from "pg";

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

// ── Persistence (Postgres via Supabase — survives restarts/redeploys) ──────
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chorehouse_data (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);
  const { rows } = await pool.query(`SELECT data FROM chorehouse_data WHERE id = 1;`);
  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO chorehouse_data (id, data) VALUES (1, $1::jsonb);`,
      [JSON.stringify(getDefaultData())]
    );
    console.log("No existing row found — initialized chorehouse_data with default data.");
  } else {
    const d = rows[0].data;
    console.log(`Existing data found: ${d.members?.length ?? 0} members, ${d.chores?.length ?? 0} chores.`);
  }
}

async function loadData() {
  const { rows } = await pool.query(`SELECT data FROM chorehouse_data WHERE id = 1;`);
  if (rows.length === 0) {
    const def = getDefaultData();
    await pool.query(
      `INSERT INTO chorehouse_data (id, data) VALUES (1, $1::jsonb);`,
      [JSON.stringify(def)]
    );
    return def;
  }
  // pg auto-parses JSONB columns back into JS objects on read, so rows[0].data
  // is already a JS object here — no JSON.parse needed on this side.
  const data = rows[0].data;

  // Defensive normalization: these fields may be missing or null in rows
  // written before they were added, or if a JSONB round-trip coerces them.
  if (!data.taskReminders || typeof data.taskReminders !== "object" || Array.isArray(data.taskReminders)) {
    data.taskReminders = {};
  }
  if (!data.dailyLog || typeof data.dailyLog !== "object" || Array.isArray(data.dailyLog)) {
    data.dailyLog = {};
  }
  if (!data.alertTimes) data.alertTimes = ["08:00", "12:00", "17:00"];
  if (!data.alertEnabled) data.alertEnabled = [true, true, true];
  if (!Array.isArray(data.tasks)) data.tasks = [];

  // Ensure all taskReminder keys are strings (large integer IDs can get
  // mangled during JSONB serialisation if stored as numeric keys).
  const reminders = data.taskReminders;
  const stringKeyedReminders = {};
  for (const k of Object.keys(reminders)) {
    stringKeyedReminders[String(k)] = reminders[k];
  }
  data.taskReminders = stringKeyedReminders;

  return data;
}

async function saveData(data) {
  await pool.query(
    `INSERT INTO chorehouse_data (id, data) VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET data = $1::jsonb;`,
    [JSON.stringify(data)]
  );
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
      // fixedDays: only used by "weekly" chores — array of day abbreviations (e.g. ["Mon"])
      // eligibleMemberIds: which member ids this chore rotates among. [] or omitted = all members.
      // rotationIndex: persisted cursor into the eligible pool for fair round-robin rotation.
      { id: 1, name: "Vacuum living room", frequency: "2x",     category: "Cleaning",    eligibleMemberIds: [], rotationIndex: 0 },
      { id: 2, name: "Wash dishes",        frequency: "daily",  category: "Kitchen",     eligibleMemberIds: [], rotationIndex: 0 },
      { id: 3, name: "Take out trash",     frequency: "weekly", category: "Maintenance", eligibleMemberIds: [], rotationIndex: 0, fixedDays: ["Thu"] },
      { id: 4, name: "Mop floors",         frequency: "weekly", category: "Cleaning",    eligibleMemberIds: [], rotationIndex: 0, fixedDays: ["Mon"] },
      { id: 5, name: "Clean bathrooms",    frequency: "2x",     category: "Cleaning",    eligibleMemberIds: [], rotationIndex: 0 },
      { id: 6, name: "Laundry",            frequency: "2x",     category: "Laundry",     eligibleMemberIds: [], rotationIndex: 0 },
      { id: 7, name: "Grocery run",        frequency: "weekly", category: "Errands",     eligibleMemberIds: [], rotationIndex: 0, fixedDays: ["Sat"] },
      { id: 8, name: "Wipe counters",      frequency: "daily",  category: "Kitchen",     eligibleMemberIds: [], rotationIndex: 0 },
    ],
    tasks: [],
    // Active hourly-reminder tasks: { [taskId]: { task, member, done, token } }
    // Persisted (not in-memory) so reminders survive server restarts.
    taskReminders: {},
    // Map of "YYYY-MM-DD:memberId" → { choreId, done, token }
    dailyLog: {},
    // Tracks the last ISO week number we advanced rotation for, so we only
    // advance each chore's rotationIndex once per week even with multiple requests.
    lastRotationWeek: null,
    alertTimes: ["08:00", "12:00", "17:00"],
    alertEnabled: [true, true, true],
  };
}

// ── Schedule logic (mirrors the frontend) ─────────────────────────────────
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// How many days per week each high-frequency chore is active
const FREQ_DAYS = { daily: 7, "5x": 5, "3x": 3, "2x": 2 };

// How many weeks between each occurrence for low-frequency chores
const FREQ_WEEKS = { weekly: 1, "2weeks": 2, monthly: 4, quarterly: 12 };

// Whether a frequency is "low" (fixed-day, rotation-tracked) vs "high" (within-week)
function isLowFreq(frequency) {
  return frequency in FREQ_WEEKS;
}

function getWeekOffset() {
  const epoch = new Date("2024-01-01");
  const now = new Date();
  return Math.floor((now - epoch) / (7 * 24 * 60 * 60 * 1000));
}

function getTodayDayName() {
  const d = new Date().getDay(); // 0=Sun
  return DAYS[d === 0 ? 6 : d - 1];
}

function eligiblePoolFor(chore, members) {
  const ids = chore.eligibleMemberIds;
  if (!ids || ids.length === 0) return members;
  const pool = members.filter(m => ids.includes(m.id));
  return pool.length > 0 ? pool : members;
}

// Advances each low-frequency chore's rotationIndex based on its own cadence.
// Each chore tracks its own lastAdvancedWeek so a monthly chore only advances
// every 4 weeks, a quarterly chore every 12 weeks, etc. — independently of
// what other chores are doing.
function advanceRotationsIfNeeded(data) {
  const weekOffset = getWeekOffset();
  let changed = false;
  data.chores.forEach(chore => {
    if (!isLowFreq(chore.frequency)) return;
    const cadence = FREQ_WEEKS[chore.frequency] || 1;
    const pool = eligiblePoolFor(chore, data.members);
    const lastAdvanced = chore.lastAdvancedWeek ?? null;

    if (lastAdvanced === null) {
      // First ever run for this chore — clamp index to pool size, don't advance.
      chore.rotationIndex = (chore.rotationIndex || 0) % pool.length;
      chore.lastAdvancedWeek = weekOffset;
      changed = true;
    } else if (weekOffset >= lastAdvanced + cadence) {
      // Enough weeks have passed for this chore's cadence — advance it.
      chore.rotationIndex = ((chore.rotationIndex || 0) + 1) % pool.length;
      chore.lastAdvancedWeek = weekOffset;
      changed = true;
    }
  });
  // Keep the legacy lastRotationWeek in sync for backwards compatibility.
  if (changed) data.lastRotationWeek = weekOffset;
  return changed;
}

// Returns true only in the first week of each cadence window.
// e.g. a 2-week chore is due week 0, 2, 4, 6... (not every week)
// a monthly chore (4-week cadence) is due week 0, 4, 8, 12...
function isDueThisWeek(chore) {
  if (!isLowFreq(chore.frequency)) return true; // daily/2x always active
  if (chore.frequency === "weekly") return true; // weekly always due
  const weekOffset = getWeekOffset();
  const lastAdvanced = chore.lastAdvancedWeek ?? weekOffset;
  // Only due in the exact week it was last advanced (first week of its window)
  return weekOffset === lastAdvanced;
}

function generateSchedule(data) {
  const { members, chores } = data;
  const weekOffset = getWeekOffset();
  const schedule = {};
  DAYS.forEach(day => {
    schedule[day] = {};
    members.forEach(m => { schedule[day][m.id] = null; });
  });

  // Chores that couldn't be placed on a given day because everyone in their
  // eligible pool already had a chore that day. Surfaced to the frontend so
  // nothing silently disappears — you can see it and adjust the day/pool.
  const unscheduled = []; // { choreId, choreName, day }

  // Track which non-weekly slots are filled per day so daily/2x chores
  // still avoid double-booking a member on the same day.
  function placeOnDay(day, chore, member) {
    if (!schedule[day][member.id]) {
      schedule[day][member.id] = chore;
      return true;
    }
    return false;
  }

  chores.forEach((chore, i) => {
    const pool = eligiblePoolFor(chore, members);

    if (isLowFreq(chore.frequency)) {
      // Fixed-day chores (weekly, 2weeks, monthly, quarterly).
      // Only appear in the schedule during the week they're due.
      if (!isDueThisWeek(chore)) return;

      const preferredDays = (chore.fixedDays && chore.fixedDays.length > 0) ? chore.fixedDays : [DAYS[weekOffset % 7]];
      const idx = (chore.rotationIndex || 0) % pool.length;
      const assignee = pool[idx];

      preferredDays.forEach(preferredDay => {
        // Try the preferred day first (primary assignee, then others in pool).
        let placed = placeOnDay(preferredDay, chore, assignee);
        if (!placed) {
          for (let offset = 1; offset < pool.length; offset++) {
            const candidate = pool[(idx + offset) % pool.length];
            if (placeOnDay(preferredDay, chore, candidate)) { placed = true; break; }
          }
        }
        // Everyone in the pool is booked on the preferred day — spill to the
        // next available day in the week where at least one pool member is free.
        if (!placed) {
          const startIdx = DAYS.indexOf(preferredDay);
          for (let d = 1; d < DAYS.length; d++) {
            const altDay = DAYS[(startIdx + d) % DAYS.length];
            // Try primary assignee first, then rest of pool.
            if (placeOnDay(altDay, chore, assignee)) { placed = true; break; }
            for (let offset = 1; offset < pool.length; offset++) {
              const candidate = pool[(idx + offset) % pool.length];
              if (placeOnDay(altDay, chore, candidate)) { placed = true; break; }
            }
            if (placed) break;
          }
        }
        if (!placed) unscheduled.push({ choreId: chore.id, choreName: chore.name, day: preferredDay });
      });
      return;
    }

    // Daily / 2x / etc — rotates through the eligible pool day by day, so a
    // "daily" chore actually cycles between different people across the week
    // instead of locking onto one person for all 7 days.
    const dpw = FREQ_DAYS[chore.frequency] ?? 1;
    let activeDays = [];
    if (dpw === 7) activeDays = [...DAYS];
    else if (dpw === 5) activeDays = DAYS.slice(0, 5);
    else if (dpw === 3) activeDays = [DAYS[0], DAYS[2], DAYS[4]];
    else if (dpw === 2) activeDays = [DAYS[0], DAYS[3]];
    else activeDays = [DAYS[weekOffset % 7]];

    activeDays.forEach((day, dayPos) => {
      // Each day within the chore's active days advances to the next person
      // in the pool, so e.g. a daily chore with 4 eligible people cycles
      // through all 4 roughly twice a week instead of sticking to one person.
      const memberIndex = (i + weekOffset + dayPos) % pool.length;
      const primaryMember = pool[memberIndex];
      let placed = placeOnDay(day, chore, primaryMember);
      if (!placed) {
        // Try other pool members on the same day.
        const other = pool.find(m => !schedule[day][m.id]);
        if (other) {
          placed = placeOnDay(day, chore, other);
        }
      }
      // Everyone in pool is booked on this active day — spill to a different
      // day that isn't already one of this chore's active days.
      if (!placed) {
        const spillDays = DAYS.filter(d => !activeDays.includes(d));
        for (const altDay of spillDays) {
          if (placeOnDay(altDay, chore, primaryMember)) { placed = true; break; }
          const other = pool.find(m => !schedule[altDay][m.id]);
          if (other && placeOnDay(altDay, chore, other)) { placed = true; break; }
        }
      }
      if (!placed) unscheduled.push({ choreId: chore.id, choreName: chore.name, day });
    });
  });

  if (unscheduled.length > 0) {
    console.warn("Chores could not be scheduled (everyone eligible already booked that day):", unscheduled);
  }

  return { schedule, unscheduled };
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
  const data = await loadData();
  // loadData() now normalises dailyLog and taskReminders — no extra guards needed here.
  const { members, alertTimes, alertEnabled, dailyLog } = data;
  if (!alertEnabled[alertIndex]) return;

  // Feature 3: advance each weekly chore's fair-rotation cursor once per week.
  const advanced = advanceRotationsIfNeeded(data);
  if (advanced) await saveData(data);

  const today = new Date().toISOString().split("T")[0];
  const dayName = getTodayDayName();
  const { schedule } = generateSchedule(data);

  for (const member of members) {
    if (!member.email) continue;
    const chore = schedule[dayName][member.id];
    if (!chore) continue;

    const logKey = `${today}:${member.id}`;
    const existing = dailyLog[logKey];

    // Already marked done — skip all reminders
    console.log(`Alert ${alertIndex + 1} check: ${member.name} logKey=${logKey} existing=${JSON.stringify(existing)}`);
    if (existing?.done) { console.log(`-> Skipping ${member.name} (done)`); continue; }

    if (alertIndex === 0) {
      // Morning: always send and create log entry
      const token = makeToken();
      data.dailyLog[logKey] = { choreId: chore.id, done: false, token };
      await saveData(data);
      try { await sendChoreEmail(member, chore, token); }
      catch (e) { console.error(`Email failed for ${member.name}:`, e.message); }
    } else {
      // Follow-up: only send if not done
      const token = existing?.token || makeToken();
      if (!existing) { data.dailyLog[logKey] = { choreId: chore.id, done: false, token }; await saveData(data); }
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

// Keep references to the currently-registered alert cron jobs so we can
// cancel and rebuild them whenever alertTimes changes via Settings, instead
// of only ever scheduling once at server startup (which silently ignored
// any later time changes — the original bug).
let activeAlertCronJobs = [];

async function scheduleCrons() {
  // Cancel any previously-scheduled alert jobs first.
  activeAlertCronJobs.forEach((job) => job.stop());
  activeAlertCronJobs = [];

  const data = await loadData();
  data.alertTimes.forEach((time, i) => {
    const job = cron.schedule(parseCron(time), () => runAlerts(i), { timezone: process.env.TZ || "America/Los_Angeles" });
    activeAlertCronJobs.push(job);
    console.log(`Scheduled alert ${i + 1} at ${time}`);
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Mark complete via email link
app.get("/complete/:token", async (req, res) => {
  const { token } = req.params;
  const data = await loadData();
  if (!data.dailyLog) data.dailyLog = {};
  const entry = Object.entries(data.dailyLog).find(([, v]) => v.token === token);
  if (!entry) {
    console.log(`Complete: token not found in dailyLog. Known tokens: ${Object.values(data.dailyLog).map(v=>v.token).join(', ')}`);
    return res.send(doneHtml("This link has expired or is invalid.", false));
  }

  const [key, val] = entry;
  console.log(`Complete: found key=${key}, already done=${val.done}`);
  if (val.done) return res.send(doneHtml("Already marked as done — nice work! ✓", true));

  data.dailyLog[key].done = true;
  await saveData(data);
  console.log(`Complete: saved done=true for key=${key}`);
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
app.get("/data", async (req, res) => {
  try {
    const data = await loadData();
    // Make sure rotation is current whenever the frontend asks for data too,
    // so the displayed schedule always reflects the latest fair-rotation state.
    const advanced = advanceRotationsIfNeeded(data);
    if (advanced) await saveData(data);
    const { schedule, unscheduled } = generateSchedule(data);
    res.json({ ...data, schedule, unscheduled });
  } catch (e) {
    console.error("GET /data failed:", e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

app.post("/data", async (req, res) => {
  try {
    const data = await loadData();
    const { members, chores, tasks, alertTimes, alertEnabled } = req.body;
    if (members) data.members = members;
    if (chores) {
      // Preserve each existing chore's rotationIndex unless the incoming
      // payload explicitly changes its eligible pool (in which case reset to 0
      // so a newly restricted/expanded pool starts rotation cleanly).
      const prevById = Object.fromEntries((data.chores || []).map(c => [c.id, c]));
      data.chores = chores.map(c => {
        const prev = prevById[c.id];
        const samePool = prev && JSON.stringify(prev.eligibleMemberIds || []) === JSON.stringify(c.eligibleMemberIds || []);
        const sameFreq = prev && prev.frequency === c.frequency;
        return {
          ...c,
          // Reset rotation if pool changed; preserve if same pool/frequency.
          rotationIndex: samePool ? (prev.rotationIndex || 0) : 0,
          // Reset lastAdvancedWeek if frequency changed so new cadence starts fresh.
          lastAdvancedWeek: (samePool && sameFreq) ? (prev.lastAdvancedWeek ?? null) : null,
        };
      });
    }
    if (tasks) data.tasks = tasks;
    if (alertTimes) data.alertTimes = alertTimes;
    if (alertEnabled) data.alertEnabled = alertEnabled;
    await saveData(data);
    console.log(`Saved data: ${data.members.length} members, ${data.chores.length} chores.`);

    // If alert times changed, rebuild the cron schedule immediately instead
    // of waiting for the next server restart to pick up the new times.
    if (alertTimes) {
      await scheduleCrons();
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("POST /data failed:", e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Today's status — useful for the dashboard
app.get("/status/today", async (req, res) => {
  const data = await loadData();
  if (!data.dailyLog) data.dailyLog = {};
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
  const data = await loadData();
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
// Task notification routes ───────────────────────────────────────────────

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
    const data = await loadData();
    // Always store taskReminder keys as strings — large integer IDs stored as
    // numeric JSONB keys can be misread on the next load.
    data.taskReminders[String(task.id)] = { task, member, done: false, token };
    await saveData(data);
    console.log("Task notification sent for: " + task.title + " -> " + member.name);
    res.json({ ok: true });
  } catch (e) {
    console.error("Task email failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/task-complete", async (req, res) => {
  try {
    const { taskId } = req.body;
    const data = await loadData();
    // taskReminder keys are always strings; coerce incoming taskId to match.
    const key = String(taskId);
    let changed = false;
    // Stop hourly reminders for this task.
    if (data.taskReminders[key]) {
      delete data.taskReminders[key];
      changed = true;
    }
    // Mark the task as done in data.tasks so it persists across refreshes.
    data.tasks = (data.tasks || []).map((t) => {
      if (String(t.id) === key) { changed = true; return { ...t, done: true }; }
      return t;
    });
    if (changed) await saveData(data);
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /task-complete failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

cron.schedule("0 * * * *", async () => {
  console.log("Hourly task reminder check at " + new Date().toISOString());
  try {
    const data = await loadData();
    // loadData() now guarantees taskReminders is a plain object, but guard anyway.
    const reminders = data.taskReminders || {};
    let changed = false;
    for (const id of Object.keys(reminders)) {
      const entry = reminders[id];
      if (!entry || entry.done) { delete data.taskReminders[id]; changed = true; continue; }
      try {
        await sendTaskEmail(entry.member, entry.task, entry.token || makeToken());
        console.log("Hourly reminder sent: " + entry.task.title + " -> " + entry.member.name);
      } catch (e) {
        console.error("Hourly reminder failed:", e.message);
      }
    }
    if (changed) await saveData(data);
  } catch (e) {
    console.error("Hourly task reminder check failed:", e.message);
  }
}, { timezone: process.env.TZ || "America/Los_Angeles" });

app.get("/task-done/:token", async (req, res) => {
  const token = req.params.token;
  try {
    const data = await loadData();
    // loadData() guarantees taskReminders is a plain object.
    const entry = Object.values(data.taskReminders).find((e) => e && e.token === token);
    if (!entry) return res.send("<body style='font-family:monospace;background:#0F0E0C;color:#E8E2D9;display:flex;align-items:center;justify-content:center;min-height:100vh;'><div style='text-align:center'><div style='font-size:48px'>!</div><div style='color:#F1948A;margin-top:16px'>Link expired or already done.</div></div></body>");
    delete data.taskReminders[String(entry.task.id)];
    await saveData(data);
    res.send("<body style='font-family:monospace;background:#0F0E0C;color:#E8E2D9;display:flex;align-items:center;justify-content:center;min-height:100vh;'><div style='text-align:center'><div style='font-size:48px'>:)</div><div style='color:#82E0AA;margin-top:16px;font-size:20px'>Task complete! Great work.</div></div></body>");
  } catch (e) {
    console.error("GET /task-done failed:", e.message);
    res.status(500).send("Something went wrong.");
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

async function start() {
  try {
    await ensureSchema();
    console.log("Database schema ready.");
  } catch (e) {
    console.error("FATAL: could not connect to database. Check DATABASE_URL.", e.message);
    process.exit(1);
  }
  app.listen(PORT, async () => {
    console.log(`Chorehouse backend running on port ${PORT}`);
    await scheduleCrons();
  });
}

start();

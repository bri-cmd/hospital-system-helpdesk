require("dotenv").config();

const bcrypt = require("bcryptjs");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const multer = require("multer");
const path = require("path");
const fs = require("fs/promises");
const { createPool } = require("./db");
const { randomBytes, randomInt, timingSafeEqual } = require("crypto");
const { parse: parseCsv } = require("csv-parse/sync");

if (!process.env.SESSION_SECRET) {
  throw new Error("Missing required environment variable: SESSION_SECRET");
}

const app = express();
app.set("trust proxy", "loopback");
const pool = createPool();
const port = Number(process.env.PORT || 3001);
const avatarDirectory = path.join(__dirname, "..", "uploads", "avatars");

const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render("placeholder", {
      title: "Submission limit reached",
      message: "Too many ticket submissions have been received. Please try again later."
    });
  }
});
const notificationPollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 2, fieldSize: 1024, parts: 3 }
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        upgradeInsecureRequests: null
      }
    },
    strictTransportSecurity: false
  })
);
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/tickets/new") {
    return submissionLimiter(req, res, next);
  }
  next();
});
app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(
  session({
    name: "hs_helpdesk_session",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

app.use((req, res, next) => {
  if (req.session.user && !req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString("hex");
  }
  res.locals.csrfToken = req.session.user ? req.session.csrfToken : "";
  next();
});

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

async function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  try {
    const [users] = await pool.execute(
      "SELECT username, display_name, role, is_active, avatar_path FROM users WHERE id = ? LIMIT 1",
      [req.session.user.id]
    );
    const user = users[0];
    if (!user || !user.is_active) {
      return req.session.destroy((error) => {
        if (error) {
          return next(error);
        }
        res.clearCookie("hs_helpdesk_session", { httpOnly: true, sameSite: "lax" });
        res.redirect("/login?disabled=1");
      });
    }
    req.session.user.displayName = user.display_name;
    req.session.user.role = user.role;
    req.session.user.username = user.username;
    req.session.user.avatarPath = user.avatar_path;
    res.locals.currentUser = req.session.user;
    next();
  } catch (error) {
    next(error);
  }
}

function requireCsrf(req, res, next) {
  const submittedToken = req.get("x-csrf-token") || req.body?._csrf;
  const sessionToken = req.session.csrfToken;
  if (typeof submittedToken !== "string" || typeof sessionToken !== "string") {
    return res.status(403).json({ error: "Your session token is invalid. Refresh and try again." });
  }
  const submittedBytes = Buffer.from(submittedToken);
  const sessionBytes = Buffer.from(sessionToken);
  if (submittedBytes.length !== sessionBytes.length ||
      !timingSafeEqual(submittedBytes, sessionBytes)) {
    return res.status(403).json({ error: "Your session token is invalid. Refresh and try again." });
  }
  next();
}

function handleAvatarUpload(req, res, next) {
  avatarUpload.single("photo")(req, res, (error) => {
    if (!error) {
      return next();
    }
    return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error: error.code === "LIMIT_FILE_SIZE"
        ? "Photo must be 2 MB or smaller."
        : "Unable to upload the photo."
    });
  });
}

function validAvatarFilename(filename) {
  return typeof filename === "string" && /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(filename);
}

async function addNotification(executor, userId, type, message, link, dedupeKey = null) {
  await executor.execute(
    `INSERT INTO notifications (user_id, type, message, link, dedupe_key)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [userId, type, message, link, dedupeKey]
  );
}

function safeNotificationLink(link) {
  return typeof link === "string" && link.startsWith("/") && !link.startsWith("//")
    ? link
    : "/staff/dashboard";
}

async function notifyAdmins(executor, type, message, link, dedupePrefix = null) {
  const [admins] = await executor.execute(
    "SELECT id FROM users WHERE role = 'admin'"
  );
  for (const admin of admins) {
    await addNotification(
      executor,
      admin.id,
      type,
      message,
      link,
      dedupePrefix ? `${dedupePrefix}:${admin.id}` : null
    );
  }
}

async function ensureOverduePmsNotifications() {
  const [overdueHospitals] = await pool.execute(
    `SELECT h.id, h.name
     FROM hospitals h
     JOIN pms_items p ON p.hospital_id = h.id
     WHERE p.next_pms < CURRENT_DATE()
     GROUP BY h.id, h.name`
  );
  const [[databaseDate]] = await pool.execute(
    "SELECT DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today"
  );
  const today = databaseDate.today;
  for (const hospital of overdueHospitals) {
    await notifyAdmins(
      pool,
      "pms_overdue",
      `${hospital.name} has PMS items overdue.`,
      `/staff/monitoring/${hospital.id}`,
      `pms-overdue:${hospital.id}:${today}`
    );
  }
}

const ticketStatuses = {
  pending: "Pending",
  approved: "Approved",
  in_progress: "In Progress",
  waiting_for_parts: "Waiting for parts",
  resolved: "Resolved"
};
const editableTicketStatuses = ["approved", "in_progress", "waiting_for_parts", "resolved"];
const ticketPriorities = ["Urgent", "High", "Medium", "Low"];
const machineStatuses = ["In stock", "In use", "Under repair"];
const machineItems = ["Filters", "Compressor parts", "Gauges and instruments", "Other"];
const pmsStatuses = {
  preparing: "Preparing",
  expiring_soon: "Expiring soon",
  overdue: "Overdue",
  for_update: "For update"
};
const pmsStatusOrder = ["preparing", "expiring_soon", "overdue", "for_update"];
const pmsCsvHeaders = [
  "hospital",
  "group",
  "item",
  "part_number",
  "qty",
  "frequency_months",
  "last_done",
  "next_pms"
];
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

function getTodayDate() {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");
}

function dateOnly(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0")
    ].join("-");
  }
  return String(value).slice(0, 10);
}

function daysFromToday(date, today = getTodayDate()) {
  if (!date) {
    return null;
  }
  const dateUtc = Date.parse(`${date}T00:00:00Z`);
  const todayUtc = Date.parse(`${today}T00:00:00Z`);
  return Math.round((dateUtc - todayUtc) / 86400000);
}

function getPmsItemStatus(nextPms, today = getTodayDate()) {
  if (!nextPms) {
    return "for_update";
  }
  const days = daysFromToday(nextPms, today);
  if (days < 0) {
    return "overdue";
  }
  if (days <= 30) {
    return "expiring_soon";
  }
  return "preparing";
}

function formatPmsDate(value) {
  if (!value) {
    return "—";
  }
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function isValidDateOnly(value) {
  if (!value) {
    return true;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function addMonthsToDate(date, months) {
  const [year, month, day] = date.split("-").map(Number);
  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return [
    targetYear,
    String(normalizedMonth + 1).padStart(2, "0"),
    String(targetDay).padStart(2, "0")
  ].join("-");
}

async function getPmsOverview() {
  const today = getTodayDate();
  const [[hospitals], [rows]] = await Promise.all([
    pool.execute("SELECT id, name FROM hospitals ORDER BY name"),
    pool.execute(
      `SELECT p.id, p.hospital_id, p.group_name, p.item, p.part_number, p.qty,
              p.frequency_months, p.last_done, p.next_pms, p.notes, h.name AS hospital_name
       FROM pms_items p
       JOIN hospitals h ON h.id = p.hospital_id
       ORDER BY h.name, p.group_name, p.item`
    )
  ]);
  const counts = { preparing: 0, expiring_soon: 0, overdue: 0, for_update: 0 };
  const perHospital = new Map(
    hospitals.map((hospital) => [
      String(hospital.id),
      { ...hospital, counts: { preparing: 0, expiring_soon: 0, overdue: 0, for_update: 0 }, total: 0, items: [] }
    ])
  );
  const items = rows.map((row) => {
    const nextPms = dateOnly(row.next_pms);
    const lastDone = dateOnly(row.last_done);
    const daysLeft = daysFromToday(nextPms, today);
    const status = getPmsItemStatus(nextPms, today);
    counts[status] += 1;
    const item = { ...row, next_pms: nextPms, last_done: lastDone, days_left: daysLeft, status };
    const hospital = perHospital.get(String(row.hospital_id));
    hospital.counts[status] += 1;
    hospital.total += 1;
    hospital.items.push(item);
    return item;
  });
  const hospitalRows = [...perHospital.values()].map((hospital) => ({
    ...hospital,
    on_schedule: hospital.total ? Math.round((hospital.counts.preparing / hospital.total) * 100) : 0
  }));
  const urgentHospitals = (status) => {
    const result = [];
    for (const hospital of hospitalRows) {
      const matching = hospital.items
        .filter((item) => item.status === status)
        .sort((left, right) => left.days_left - right.days_left);
      if (matching.length > 0) {
        const urgentItem = matching[0];
        result.push({
          hospital_id: hospital.id,
          hospital_name: hospital.name,
          item_count: matching.length,
          group_name: urgentItem.group_name,
          days_left: urgentItem.days_left
        });
      }
    }
    return result.sort((left, right) =>
      status === "overdue"
        ? left.days_left - right.days_left
        : left.days_left - right.days_left
    );
  };

  return {
    today,
    hospitals: hospitalRows.sort((left, right) =>
      right.counts.overdue - left.counts.overdue || left.name.localeCompare(right.name)
    ),
    items,
    counts,
    overdueHospitals: urgentHospitals("overdue"),
    expiringHospitals: urgentHospitals("expiring_soon")
  };
}

function requireAdmin(req, res, next) {
  if (req.session.user.role !== "admin") {
    return res.status(403).render("error", { title: "Access denied" });
  }
  next();
}

function getReportMonthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return null;
  }
  const [year, monthNumber] = month.split("-").map(Number);
  if (year < 1000) {
    return null;
  }
  const start = `${month}-01`;
  const nextMonth = new Date(Date.UTC(year, monthNumber, 1));
  const end = [
    nextMonth.getUTCFullYear(),
    String(nextMonth.getUTCMonth() + 1).padStart(2, "0"),
    "01"
  ].join("-");
  return { start, end };
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsvDateTime(value) {
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString().slice(0, 19).replace("T", " ");
}

function sendCsv(res, filename, headers, rows) {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(","));
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.send(`\uFEFF${lines.join("\r\n")}\r\n`);
}

function formatAverageDuration(milliseconds) {
  if (milliseconds === null) {
    return "No resolved tickets";
  }
  const minutes = milliseconds > 0
    ? Math.max(1, Math.round(milliseconds / 60000))
    : 0;
  if (minutes < 60) {
    return `${minutes} min`;
  }
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${minutes % 60} min`;
}

function getMachineInventoryStatus(machine) {
  const qty = Number(machine.qty);
  const reorderLevel = Number(machine.reorder_level);
  if (machine.status === "In stock" && qty === 0) {
    return "Out of stock";
  }
  if (machine.status === "In stock" && qty > 0 && qty <= reorderLevel) {
    return "Low stock";
  }
  return machine.status;
}

function renderPmsImport(res, options = {}) {
  return res.status(options.statusCode || 200).render("pms-import", {
    title: "Import PMS Data",
    activePage: "monitoring",
    notifications: options.notifications,
    errors: options.errors || [],
    previewRows: options.previewRows || [],
    previewCount: (options.previewRows || []).length
  });
}

async function renderPmsHospital(req, res, statusCode = 200, errorMessage = null) {
  const hospitalId = String(req.params.hospitalId || "");
  if (!/^\d+$/.test(hospitalId)) {
    return res.status(404).render("placeholder", {
      title: "Hospital Not Found",
      message: "The hospital could not be found."
    });
  }
  const [[hospitals], [rows]] = await Promise.all([
    pool.execute("SELECT id, name FROM hospitals WHERE id = ? LIMIT 1", [hospitalId]),
    pool.execute(
      `SELECT id, hospital_id, group_name, item, part_number, qty, frequency_months,
              last_done, next_pms, notes
       FROM pms_items
       WHERE hospital_id = ?
       ORDER BY group_name, item, id`,
      [hospitalId]
    )
  ]);
  const hospital = hospitals[0];
  if (!hospital) {
    return res.status(404).render("placeholder", {
      title: "Hospital Not Found",
      message: "The hospital could not be found."
    });
  }

  const today = getTodayDate();
  const items = rows.map((row) => {
    const lastDone = dateOnly(row.last_done);
    const nextPms = dateOnly(row.next_pms);
    return {
      ...row,
      last_done: lastDone,
      next_pms: nextPms,
      days_left: daysFromToday(nextPms, today),
      status: getPmsItemStatus(nextPms, today)
    };
  });
  const counts = { preparing: 0, expiring_soon: 0, overdue: 0, for_update: 0 };
  items.forEach((item) => {
    counts[item.status] += 1;
  });
  const filter = typeof req.query.status === "string" && ["all", ...pmsStatusOrder].includes(req.query.status)
    ? req.query.status
    : "all";
  const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const visibleItems = items.filter((item) => {
    const matchesStatus = filter === "all" || item.status === filter;
    const haystack = `${item.group_name} ${item.item} ${item.part_number || ""}`.toLowerCase();
    return matchesStatus && (!search || haystack.includes(search.toLowerCase()));
  });
  const [historyRows] = await pool.execute(
    `SELECT ph.pms_item_id, ph.actor_name, ph.old_values, ph.new_values, ph.created_at
     FROM pms_item_history ph
     JOIN pms_items pi ON pi.id = ph.pms_item_id
     WHERE pi.hospital_id = ?
     ORDER BY ph.created_at DESC, ph.id DESC`,
    [hospitalId]
  );
  const histories = new Map();
  for (const entry of historyRows) {
    const current = histories.get(String(entry.pms_item_id)) || [];
    current.push({
      ...entry,
      old_values: typeof entry.old_values === "string" ? JSON.parse(entry.old_values) : entry.old_values,
      new_values: typeof entry.new_values === "string" ? JSON.parse(entry.new_values) : entry.new_values
    });
    histories.set(String(entry.pms_item_id), current);
  }
  const groups = [];
  for (const item of visibleItems) {
    let group = groups[groups.length - 1];
    if (!group || group.name !== item.group_name) {
      group = { name: item.group_name, items: [] };
      groups.push(group);
    }
    group.items.push({ ...item, history: histories.get(String(item.id)) || [] });
  }

  return res.status(statusCode).render("pms-hospital", {
    title: hospital.name,
    activePage: "monitoring",
    notifications: await getNotifications(req.session.user),
    hospital,
    today,
    counts,
    total: items.length,
    onSchedule: items.length ? Math.round((counts.preparing / items.length) * 100) : 0,
    groups,
    filter,
    search,
    canEdit: req.session.user.role === "admin",
    errorMessage,
    pmsStatuses,
    formatDate: formatPmsDate
  });
}

async function renderPmsHospitalSafely(req, res, next, statusCode, errorMessage) {
  try {
    return await renderPmsHospital(req, res, statusCode, errorMessage);
  } catch (error) {
    return next(error);
  }
}

function handlePmsCsvUpload(req, res, next) {
  csvUpload.single("csvFile")(req, res, (error) => {
    if (!error) {
      return next();
    }
    getNotifications(req.session.user)
      .then((notifications) => renderPmsImport(res, {
        statusCode: 400,
        notifications,
        errors: [error.code === "LIMIT_FILE_SIZE"
          ? "CSV file must be 5 MB or smaller."
          : "Unable to upload the CSV file."]
      }))
      .catch(next);
  });
}

async function getNotifications(user) {
  await ensureOverduePmsNotifications();
  const [[counts]] = await pool.execute(
    `SELECT COUNT(*) AS unread_count
     FROM notifications WHERE user_id = ? AND is_read = FALSE`,
    [user.id]
  );
  const [[latest]] = await pool.execute(
    "SELECT COALESCE(MAX(id), 0) AS max_id FROM notifications WHERE user_id = ?",
    [user.id]
  );
  const [items] = await pool.execute(
    `SELECT id, type, message, link, is_read, created_at
     FROM notifications WHERE user_id = ?
     ORDER BY id DESC LIMIT 30`,
    [user.id]
  );
  return {
    count: Number(counts.unread_count) || 0,
    maxId: Number(latest.max_id) || 0,
    items
  };
}

async function renderTicketDetail(req, res, statusCode = 200, errorMessage = null) {
  const { ticketNumber } = req.params;
  if (!/^\d{6}$/.test(ticketNumber)) {
    return res.status(404).render("placeholder", {
      title: "Page Not Found",
      message: "The page you requested could not be found."
    });
  }

  async function renderTicketDetailSafely(req, res, next, statusCode, errorMessage) {
    try {
      return await renderTicketDetail(req, res, statusCode, errorMessage);
    } catch (error) {
      return next(error);
    }
  }

  const [tickets] = await pool.execute(
    `SELECT t.id, t.ticket_number, t.subject, t.description, t.status, t.priority,
            t.assigned_to, t.created_at, h.name AS hospital_name,
            u.display_name AS assigned_name
     FROM tickets t
     JOIN hospitals h ON h.id = t.hospital_id
     LEFT JOIN users u ON u.id = t.assigned_to
     WHERE t.ticket_number = ?
     LIMIT 1`,
    [ticketNumber]
  );
  const ticket = tickets[0];
  if (!ticket) {
    return res.status(404).render("placeholder", {
      title: "Ticket Not Found",
      message: "The ticket number could not be found."
    });
  }

  const [historyRows] = await pool.execute(
    `SELECT actor_name, action, details, created_at, is_public
     FROM ticket_history
     WHERE ticket_id = ?
     ORDER BY created_at ASC, id ASC`,
    [ticket.id]
  );
  const [staff] = await pool.execute(
    "SELECT id, display_name FROM users WHERE role = 'staff' AND is_active = TRUE ORDER BY display_name"
  );
  const notifications = await getNotifications(req.session.user);
  const isPending = ticket.status === "pending";
  const isResolved = ticket.status === "resolved";
  const canEdit = !isPending && (!isResolved || req.session.user.role === "admin");

  return res.status(statusCode).render("ticket-detail", {
    title: `Ticket-${ticket.ticket_number}`,
    activePage: "tickets",
    ticket,
    history: historyRows,
    staff,
    notifications,
    ticketStatuses,
    editableTicketStatuses,
    ticketPriorities,
    canApprove: isPending && req.session.user.role === "admin",
    canEdit,
    errorMessage
  });
}

app.get("/", (req, res) => {
  res.render("home", { title: "Hospital Systems Helpdesk" });
});

app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/staff/dashboard");
  }
  res.render("login", {
    title: "Staff Sign In",
    error: req.query.disabled ? "This account is disabled. Contact an administrator." : null
  });
});

app.post("/login", async (req, res, next) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  try {
    const [rows] = await pool.execute(
      `SELECT id, username, password_hash, display_name, role, is_active
       FROM users WHERE username = ? LIMIT 1`,
      [username]
    );
    const user = rows[0];
    const passwordMatches = user && await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return res.status(401).render("login", {
        title: "Staff Sign In",
        error: "The username or password is incorrect."
      });
    }

    if (!user.is_active) {
      return res.status(403).render("login", {
        title: "Staff Sign In",
        error: "This account is disabled. Contact an administrator."
      });
    }

    const [signInResult] = await pool.execute(
      "UPDATE users SET last_sign_in = CURRENT_TIMESTAMP WHERE id = ? AND is_active = TRUE",
      [user.id]
    );
    if (signInResult.affectedRows === 0) {
      const [currentUsers] = await pool.execute(
        "SELECT is_active FROM users WHERE id = ? LIMIT 1",
        [user.id]
      );
      if (!currentUsers[0] || !currentUsers[0].is_active) {
        return res.status(403).render("login", {
          title: "Staff Sign In",
          error: "This account is disabled. Contact an administrator."
        });
      }
    }

    req.session.regenerate((error) => {
      if (error) {
        return next(error);
      }
      req.session.user = {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role
      };
      req.session.save((saveError) => {
        if (saveError) {
          return next(saveError);
        }
        res.redirect("/staff/dashboard");
      });
    });
  } catch (error) {
    next(error);
  }
});

app.post("/logout", requireLogin, requireCsrf, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) {
      return next(error);
    }
    res.clearCookie("hs_helpdesk_session", { httpOnly: true, sameSite: "lax" });
    res.redirect("/");
  });
});

app.get("/staff/notifications/poll", requireLogin, notificationPollLimiter, async (req, res, next) => {
  const sinceInput = req.query.since ?? "0";
  if (typeof sinceInput !== "string" || !/^\d+$/.test(sinceInput) ||
      !Number.isSafeInteger(Number(sinceInput))) {
    return res.status(400).json({ error: "Invalid notification cursor." });
  }
  try {
    await ensureOverduePmsNotifications();
    res.set("Cache-Control", "no-store");
    const [items] = await pool.execute(
      `SELECT id, type, message, link, is_read, created_at
       FROM notifications WHERE user_id = ? AND id > ?
       ORDER BY id ASC LIMIT 50`,
      [req.session.user.id, Number(sinceInput)]
    );
    const [[counts]] = await pool.execute(
      "SELECT COUNT(*) AS unread_count FROM notifications WHERE user_id = ? AND is_read = FALSE",
      [req.session.user.id]
    );
    res.json({
      count: Number(counts.unread_count) || 0,
      items: items.map((item) => ({
        ...item,
        link: `/staff/notifications/${item.id}/open`
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/staff/notifications/read-all", requireLogin, requireCsrf, async (req, res, next) => {
  try {
    await pool.execute(
      "UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND is_read = FALSE",
      [req.session.user.id]
    );
    res.json({ count: 0 });
  } catch (error) {
    next(error);
  }
});

app.get("/staff/notifications/:id/open", requireLogin, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) {
    return res.sendStatus(404);
  }
  try {
    const [items] = await pool.execute(
      "SELECT link FROM notifications WHERE id = ? AND user_id = ? LIMIT 1",
      [req.params.id, req.session.user.id]
    );
    if (!items.length) {
      return res.sendStatus(404);
    }
    res.redirect(safeNotificationLink(items[0].link));
  } catch (error) {
    next(error);
  }
});

app.post("/staff/notifications/:id/open", requireLogin, requireCsrf, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) {
    return res.sendStatus(404);
  }
  try {
    const [items] = await pool.execute(
      "SELECT link FROM notifications WHERE id = ? AND user_id = ? LIMIT 1",
      [req.params.id, req.session.user.id]
    );
    if (!items.length) {
      return res.sendStatus(404);
    }
    await pool.execute(
      "UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.user.id]
    );
    res.redirect(303, safeNotificationLink(items[0].link));
  } catch (error) {
    next(error);
  }
});

app.get("/avatars/:filename", async (req, res, next) => {
  const { filename } = req.params;
  if (!validAvatarFilename(filename)) {
    return res.sendStatus(404);
  }
  try {
    const [owners] = await pool.execute(
      "SELECT id FROM users WHERE avatar_path = ? LIMIT 1",
      [filename]
    );
    if (!owners.length) {
      return res.sendStatus(404);
    }
    res.set("Cache-Control", "public, max-age=3600");
    res.sendFile(filename, { root: avatarDirectory }, (error) => {
      if (error && !res.headersSent) {
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/staff/profile/photo", requireLogin, requireCsrf, handleAvatarUpload, async (req, res, next) => {
  let newFilename = null;
  let newAvatarPersisted = false;
  try {
    const removePhoto = req.body.removePhoto === "1";
    if (!removePhoto && !req.file) {
      return res.status(400).json({ error: "Choose a JPG, PNG, or WebP photo." });
    }

    let extension = null;
    if (!removePhoto) {
      const { buffer, mimetype } = req.file;
      if (mimetype === "image/jpeg" && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        extension = "jpg";
      } else if (mimetype === "image/png" &&
                 buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        extension = "png";
      } else if (mimetype === "image/webp" &&
                 buffer.toString("ascii", 0, 4) === "RIFF" &&
                 buffer.toString("ascii", 8, 12) === "WEBP") {
        extension = "webp";
      }
      if (!extension) {
        return res.status(400).json({ error: "Photo must be a valid JPG, PNG, or WebP image." });
      }
    }

    const [users] = await pool.execute(
      "SELECT avatar_path FROM users WHERE id = ? LIMIT 1",
      [req.session.user.id]
    );
    if (!users[0]) {
      return res.status(404).json({ error: "Account not found." });
    }
    const oldFilename = users[0].avatar_path;

    if (removePhoto) {
      await pool.execute("UPDATE users SET avatar_path = NULL WHERE id = ?", [req.session.user.id]);
      req.session.user.avatarPath = null;
    } else {
      await fs.mkdir(avatarDirectory, { recursive: true });
      newFilename = `${randomBytes(16).toString("hex")}.${extension}`;
      await fs.writeFile(path.join(avatarDirectory, newFilename), req.file.buffer, { flag: "wx" });
      await pool.execute("UPDATE users SET avatar_path = ? WHERE id = ?", [newFilename, req.session.user.id]);
      newAvatarPersisted = true;
      req.session.user.avatarPath = newFilename;
    }

    if (validAvatarFilename(oldFilename)) {
      try {
        await fs.unlink(path.join(avatarDirectory, oldFilename));
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    return res.json({
      avatarUrl: req.session.user.avatarPath ? `/avatars/${req.session.user.avatarPath}` : null
    });
  } catch (error) {
    if (newFilename && !newAvatarPersisted) {
      try {
        await fs.unlink(path.join(avatarDirectory, newFilename));
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") {
          return next(cleanupError);
        }
      }
    }
    next(error);
  }
});

app.post("/staff/profile/password", requireLogin, requireCsrf, async (req, res, next) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  const confirmPassword = String(req.body.confirmPassword || "");
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: "New password and confirmation do not match." });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [users] = await connection.execute(
      "SELECT username, password_hash FROM users WHERE id = ? LIMIT 1 FOR UPDATE",
      [req.session.user.id]
    );
    const user = users[0];
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      await connection.rollback();
      return res.status(400).json({ error: "Current password is incorrect." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await connection.execute("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, user.id]);
    await connection.execute(
      `INSERT INTO user_account_history
         (actor_user_id, actor_name, target_user_id, target_username, action, details)
       VALUES (?, ?, ?, ?, 'Password changed', 'User changed their own password.')`,
      [user.id, req.session.user.displayName, user.id, user.username]
    );
    await connection.commit();
    res.json({ message: "Password changed." });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

async function renderAccountsPage(req, res, options = {}) {
  const [[accounts], [history]] = await Promise.all([
    pool.execute(
      `SELECT id, username, display_name, role, is_active, is_primary_admin, last_sign_in
       FROM users ORDER BY display_name, username`
    ),
    pool.execute(
      `SELECT actor_name, target_username, action, details, created_at
       FROM user_account_history ORDER BY created_at DESC, id DESC LIMIT 25`
    )
  ]);
  const notices = {
    added: "Account added.",
    updated: "Account updated.",
    password: "Password reset.",
    enabled: "Account enabled.",
    disabled: "Account disabled.",
    unchanged: "No account changes were needed."
  };
  return res.status(options.statusCode || 200).render("accounts", {
    title: "Accounts",
    activePage: "accounts",
    notifications: await getNotifications(req.session.user),
    accounts,
    history,
    errorMessage: options.errorMessage || null,
    notice: notices[req.query.notice] || null,
    addValues: options.addValues || { name: "", username: "", role: "staff" }
  });
}

app.get("/staff/accounts", requireLogin, requireAdmin, async (req, res, next) => {
  try {
    await renderAccountsPage(req, res);
  } catch (error) {
    next(error);
  }
});

app.post("/staff/accounts", requireLogin, requireAdmin, async (req, res, next) => {
  const displayName = String(req.body.name || "").trim();
  const username = String(req.body.username || "").trim();
  const role = String(req.body.role || "");
  const password = String(req.body.password || "");
  const addValues = { name: displayName, username, role };

  if (!displayName || displayName.length > 120 || !username || username.length > 80 ||
      !["admin", "staff"].includes(role) || password.length < 8 ||
      Buffer.byteLength(password, "utf8") > 72) {
    try {
      return await renderAccountsPage(req, res, {
        statusCode: 400,
        errorMessage: "Enter a name (up to 120 characters), username (up to 80 characters), valid role, and a password of 8 to 72 UTF-8 bytes.",
        addValues
      });
    } catch (error) {
      return next(error);
    }
  }

  let connection;
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `INSERT INTO users (username, password_hash, display_name, role)
       VALUES (?, ?, ?, ?)`,
      [username, passwordHash, displayName, role]
    );
    await connection.execute(
      `INSERT INTO user_account_history
         (actor_user_id, actor_name, target_user_id, target_username, action, details)
       VALUES (?, ?, ?, ?, 'Account added', ?)`,
      [
        req.session.user.id,
        req.session.user.displayName,
        result.insertId,
        username,
        `Created ${role} account "${username}".`
      ]
    );
    await connection.commit();
    res.redirect("/staff/accounts?notice=added");
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    if (error.code === "ER_DUP_ENTRY") {
      try {
        return await renderAccountsPage(req, res, {
          statusCode: 409,
          errorMessage: "That username is already in use.",
          addValues
        });
      } catch (renderError) {
        return next(renderError);
      }
    }
    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.post("/staff/accounts/:accountId/edit", requireLogin, requireAdmin, async (req, res, next) => {
  const accountId = String(req.params.accountId || "");
  const displayName = String(req.body.name || "").trim();
  const role = String(req.body.role || "");
  if (!/^\d+$/.test(accountId) || !displayName || displayName.length > 120 ||
      !["admin", "staff"].includes(role)) {
    try {
      return await renderAccountsPage(req, res, {
        statusCode: 400,
        errorMessage: "Enter a valid name and role."
      });
    } catch (error) {
      return next(error);
    }
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT id, username, display_name, role, is_primary_admin FROM users WHERE id = ? FOR UPDATE",
      [accountId]
    );
    const account = rows[0];
    if (!account) {
      await connection.rollback();
      return res.status(404).render("placeholder", {
        title: "Account Not Found",
        message: "The account could not be found."
      });
    }
    if (account.is_primary_admin && role !== "admin") {
      await connection.rollback();
      return await renderAccountsPage(req, res, {
        statusCode: 400,
        errorMessage: "The main admin account cannot be demoted."
      });
    }

    const changes = [];
    if (account.display_name !== displayName) {
      changes.push(`name changed from "${account.display_name}" to "${displayName}"`);
    }
    if (account.role !== role) {
      changes.push(`role changed from ${account.role} to ${role}`);
    }
    if (!changes.length) {
      await connection.rollback();
      return res.redirect("/staff/accounts?notice=unchanged");
    }
    await connection.execute(
      "UPDATE users SET display_name = ?, role = ? WHERE id = ?",
      [displayName, role, accountId]
    );
    await connection.execute(
      `INSERT INTO user_account_history
         (actor_user_id, actor_name, target_user_id, target_username, action, details)
       VALUES (?, ?, ?, ?, 'Account updated', ?)`,
      [
        req.session.user.id,
        req.session.user.displayName,
        account.id,
        account.username,
        changes.join("; ")
      ]
    );
    await connection.commit();
    res.redirect("/staff/accounts?notice=updated");
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.post("/staff/accounts/:accountId/reset-password", requireLogin, requireAdmin, async (req, res, next) => {
  const accountId = String(req.params.accountId || "");
  const password = String(req.body.password || "");
  if (!/^\d+$/.test(accountId) || password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
    try {
      return await renderAccountsPage(req, res, {
        statusCode: 400,
        errorMessage: "The temporary password must contain 8 to 72 UTF-8 bytes."
      });
    } catch (error) {
      return next(error);
    }
  }

  let connection;
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT id, username FROM users WHERE id = ? FOR UPDATE",
      [accountId]
    );
    if (!rows[0]) {
      await connection.rollback();
      return res.status(404).render("placeholder", {
        title: "Account Not Found",
        message: "The account could not be found."
      });
    }
    await connection.execute("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, accountId]);
    await connection.execute(
      `INSERT INTO user_account_history
         (actor_user_id, actor_name, target_user_id, target_username, action, details)
       VALUES (?, ?, ?, ?, 'Password reset', 'Temporary password reset by administrator.')`,
      [req.session.user.id, req.session.user.displayName, rows[0].id, rows[0].username]
    );
    await connection.commit();
    res.redirect("/staff/accounts?notice=password");
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.post("/staff/accounts/:accountId/status", requireLogin, requireAdmin, async (req, res, next) => {
  const accountId = String(req.params.accountId || "");
  const action = String(req.body.action || "");
  if (!/^\d+$/.test(accountId) || !["disable", "enable"].includes(action)) {
    try {
      return await renderAccountsPage(req, res, {
        statusCode: 400,
        errorMessage: "Select a valid account status action."
      });
    } catch (error) {
      return next(error);
    }
  }
  if (action === "disable" && String(req.session.user.id) === accountId) {
    try {
      return await renderAccountsPage(req, res, {
        statusCode: 400,
        errorMessage: "You cannot disable your own account."
      });
    } catch (error) {
      return next(error);
    }
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT id, username, is_active, is_primary_admin FROM users WHERE id = ? FOR UPDATE",
      [accountId]
    );
    const account = rows[0];
    if (!account) {
      await connection.rollback();
      return res.status(404).render("placeholder", {
        title: "Account Not Found",
        message: "The account could not be found."
      });
    }
    if (action === "disable" && String(account.id) === String(req.session.user.id)) {
      await connection.rollback();
      return await renderAccountsPage(req, res, {
        statusCode: 400,
        errorMessage: "You cannot disable your own account."
      });
    }
    if (action === "disable" && account.is_primary_admin) {
      await connection.rollback();
      return await renderAccountsPage(req, res, {
        statusCode: 400,
        errorMessage: "The main admin account cannot be disabled."
      });
    }
    const isActive = action === "enable";
    if (Boolean(account.is_active) === isActive) {
      await connection.rollback();
      return res.redirect("/staff/accounts?notice=unchanged");
    }

    await connection.execute("UPDATE users SET is_active = ? WHERE id = ?", [isActive, accountId]);
    await connection.execute(
      `INSERT INTO user_account_history
         (actor_user_id, actor_name, target_user_id, target_username, action, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.session.user.id,
        req.session.user.displayName,
        account.id,
        account.username,
        isActive ? "Account enabled" : "Account disabled",
        `${isActive ? "Enabled" : "Disabled"} account "${account.username}".`
      ]
    );
    await connection.commit();
    res.redirect(`/staff/accounts?notice=${isActive ? "enabled" : "disabled"}`);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

async function getSelectedReportHospital(value) {
  const [hospitals] = await pool.execute("SELECT id, name FROM hospitals ORDER BY name");
  if (!value || value === "all") {
    return { hospitals, selectedHospital: null, errorMessage: null };
  }
  const selectedHospital = /^\d+$/.test(value)
    ? hospitals.find((hospital) => String(hospital.id) === value)
    : null;
  return {
    hospitals,
    selectedHospital: selectedHospital || null,
    errorMessage: selectedHospital ? null : "Select a valid hospital."
  };
}

app.get("/staff/reports", requireLogin, async (req, res, next) => {
  const requestedMonth = typeof req.query.month === "string" ? req.query.month : "";
  const currentMonth = getTodayDate().slice(0, 7);
  const month = requestedMonth ? requestedMonth : currentMonth;
  const period = getReportMonthRange(month);
  const reportMonth = period ? month : currentMonth;
  const reportPeriod = period || getReportMonthRange(currentMonth);

  try {
    const filter = await getSelectedReportHospital(
      typeof req.query.hospital === "string" ? req.query.hospital : "all"
    );
    const selectedHospital = filter.selectedHospital;
    const isStaff = req.session.user.role === "staff";
    const ticketConditions = ["t.created_at >= ?", "t.created_at < ?"];
    const ticketParams = [reportPeriod.start, reportPeriod.end];
    if (selectedHospital) {
      ticketConditions.push("t.hospital_id = ?");
      ticketParams.push(selectedHospital.id);
    }
    if (isStaff) {
      ticketConditions.push("t.assigned_to = ?");
      ticketParams.push(req.session.user.id);
    }
    const ticketWhere = ticketConditions.join(" AND ");
    const [hospitalTickets, statusRows, priorityRows, resolvedRows] = await Promise.all([
      pool.execute(
        `SELECT h.name AS hospital_name, COUNT(*) AS count
         FROM tickets t JOIN hospitals h ON h.id = t.hospital_id
         WHERE ${ticketWhere}
         GROUP BY h.id, h.name
         ORDER BY count DESC, h.name`,
        ticketParams
      ),
      pool.execute(
        `SELECT t.status, COUNT(*) AS count
         FROM tickets t WHERE ${ticketWhere}
         GROUP BY t.status`,
        ticketParams
      ),
      pool.execute(
        `SELECT t.priority, COUNT(*) AS count
         FROM tickets t WHERE ${ticketWhere}
         GROUP BY t.priority`,
        ticketParams
      ),
      pool.execute(
        `SELECT t.id,
                TIMESTAMPDIFF(SECOND, t.created_at, MAX(th.created_at)) AS duration_seconds
         FROM tickets t
         JOIN ticket_history th ON th.ticket_id = t.id
         WHERE th.action = 'Status changed'
           AND th.details LIKE '% to Resolved%'
           AND th.created_at >= ? AND th.created_at < ?
           ${selectedHospital ? "AND t.hospital_id = ?" : ""}
           ${isStaff ? "AND t.assigned_to = ?" : ""}
         GROUP BY t.id, t.created_at`,
        [
          reportPeriod.start,
          reportPeriod.end,
          ...(selectedHospital ? [selectedHospital.id] : []),
          ...(isStaff ? [req.session.user.id] : [])
        ]
      )
    ]);
    const statusCounts = Object.fromEntries(Object.keys(ticketStatuses).map((status) => [status, 0]));
    statusRows[0].forEach((row) => {
      statusCounts[row.status] = Number(row.count) || 0;
    });
    const received = Object.values(statusCounts).reduce((total, count) => total + count, 0);
    const priorityCounts = Object.fromEntries(ticketPriorities.map((priority) => [priority, 0]));
    priorityRows[0].forEach((row) => {
      priorityCounts[row.priority] = Number(row.count) || 0;
    });
    const durations = resolvedRows[0]
      .map((ticket) => Number(ticket.duration_seconds) * 1000)
      .filter((duration) => Number.isFinite(duration) && duration >= 0);
    const averageDuration = durations.length
      ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
      : null;

    const pms = await getPmsOverview();
    const pmsHospitals = pms.hospitals
      .filter((hospital) => !selectedHospital || String(hospital.id) === String(selectedHospital.id))
      .sort((left, right) => left.name.localeCompare(right.name));
    const pmsTotal = pmsHospitals.reduce((total, hospital) => total + hospital.total, 0);
    const pmsPreparing = pmsHospitals.reduce((total, hospital) => total + hospital.counts.preparing, 0);
    const notifications = await getNotifications(req.session.user);
    res.render("reports", {
      title: "Reports",
      activePage: "reports",
      notifications,
      hospitals: filter.hospitals,
      selectedMonth: reportMonth,
      selectedHospitalId: selectedHospital ? String(selectedHospital.id) : "all",
      ticketStatuses,
      errorMessage: filter.errorMessage || (!period && requestedMonth ? "Select a valid month." : null),
      received,
      resolved: resolvedRows[0].length,
      pending: statusCounts.pending || 0,
      averageDuration: formatAverageDuration(averageDuration),
      pmsOnSchedule: pmsTotal ? Math.round((pmsPreparing / pmsTotal) * 100) : 0,
      hospitalTickets: hospitalTickets[0].map((row) => ({ ...row, count: Number(row.count) })),
      maxHospitalTickets: Math.max(1, ...hospitalTickets[0].map((row) => Number(row.count))),
      statusCounts,
      priorityCounts,
      pmsHospitals
    });
  } catch (error) {
    console.error("Failed to load reports:", error);
    next(error);
  }
});

app.get("/staff/reports/export/tickets.csv", requireLogin, requireAdmin, async (req, res, next) => {
  const month = typeof req.query.month === "string" && req.query.month
    ? req.query.month
    : getTodayDate().slice(0, 7);
  const period = getReportMonthRange(month);
  if (!period) {
    return res.status(400).send("Select a valid month.");
  }
  try {
    const filter = await getSelectedReportHospital(
      typeof req.query.hospital === "string" ? req.query.hospital : "all"
    );
    if (filter.errorMessage) {
      return res.status(400).send(filter.errorMessage);
    }
    const params = [period.start, period.end];
    const hospitalCondition = filter.selectedHospital ? "AND t.hospital_id = ?" : "";
    if (filter.selectedHospital) {
      params.push(filter.selectedHospital.id);
    }
    const [tickets] = await pool.execute(
      `SELECT t.ticket_number, h.name AS hospital_name, t.subject, t.priority, t.status,
              u.display_name AS assigned_name, t.created_at
       FROM tickets t
       LEFT JOIN hospitals h ON h.id = t.hospital_id
       LEFT JOIN users u ON u.id = t.assigned_to
       WHERE t.created_at >= ? AND t.created_at < ? ${hospitalCondition}
       ORDER BY t.created_at, t.id`,
      params
    );
    sendCsv(res, `tickets-${month}.csv`,
      ["Ticket number", "Hospital", "Subject", "Priority", "Status", "Assigned to", "Created at"],
      tickets.map((ticket) => [
        ticket.ticket_number,
        ticket.hospital_name,
        ticket.subject,
        ticket.priority,
        ticketStatuses[ticket.status] || ticket.status,
        ticket.assigned_name,
        toCsvDateTime(ticket.created_at)
      ])
    );
  } catch (error) {
    next(error);
  }
});

app.get("/staff/reports/export/pms.csv", requireLogin, requireAdmin, async (req, res, next) => {
  try {
    const pms = await getPmsOverview();
    sendCsv(res, "pms-items.csv",
      ["Hospital", "Group", "Item", "Part number", "Quantity", "Frequency months", "Last done", "Next PMS", "Status"],
      pms.items.map((item) => [
        item.hospital_name,
        item.group_name,
        item.item,
        item.part_number,
        item.qty,
        item.frequency_months,
        dateOnly(item.last_done),
        dateOnly(item.next_pms),
        pmsStatuses[item.status]
      ])
    );
  } catch (error) {
    next(error);
  }
});

app.get("/app/reports", requireLogin, (req, res) => {
  res.redirect("/staff/reports");
});

app.get("/app/monitoring", requireLogin, (req, res) => {
  res.redirect("/staff/monitoring");
});

app.get("/app/dashboard", requireLogin, (req, res) => {
  res.redirect("/staff/dashboard");
});

app.get("/staff/monitoring", requireLogin, async (req, res, next) => {
  try {
    const pms = await getPmsOverview();
    res.render("pms-overview", {
      title: "PMS Monitoring",
      activePage: "monitoring",
      notifications: await getNotifications(req.session.user),
      today: pms.today,
      hospitalCount: pms.hospitals.length,
      itemCount: pms.items.length,
      counts: pms.counts,
      hospitals: pms.hospitals,
      overdueHospitals: pms.overdueHospitals.slice(0, 5),
      expiringHospitals: pms.expiringHospitals.slice(0, 5),
      pmsStatuses
    });
  } catch (error) {
    next(error);
  }
});

app.get("/staff/inventory", requireLogin, (req, res) => {
  res.redirect(301, "/staff/machines");
});

app.get("/staff/inventory/new", requireLogin, requireAdmin, (req, res) => {
  res.redirect(301, "/staff/machines/new");
});

app.get("/staff/machines", requireLogin, async (req, res, next) => {
  const categories = ["All machines", "Filters", "Compressor parts", "Instruments", "Other"];
  const category = categories.includes(req.query.category) ? req.query.category : "All machines";
  const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const conditions = [];
  const params = [];
  if (category === "Filters" || category === "Compressor parts" || category === "Other") {
    conditions.push("item = ?");
    params.push(category);
  } else if (category === "Instruments") {
    conditions.push("item = 'Gauges and instruments'");
  }
  if (search) {
    conditions.push("(item_name LIKE ? OR part_number LIKE ? OR description LIKE ?)");
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  try {
    const [machines] = await pool.execute(
      `SELECT id, item_name, item, part_number, qty, reorder_level, description, status
       FROM machines
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY item_name`,
      params
    );
    res.render("inventory", {
      title: "Machines",
      activePage: "machines",
      notifications: await getNotifications(req.session.user),
      machines: machines.map((machine) => ({
        ...machine,
        display_status: getMachineInventoryStatus(machine)
      })),
      categories,
      selectedCategory: category,
      search
    });
  } catch (error) {
    next(error);
  }
});

app.get("/staff/machines/new", requireLogin, requireAdmin, async (req, res, next) => {
  try {
    res.render("machine-new", {
      title: "Add machine",
      activePage: "machines",
      notifications: await getNotifications(req.session.user),
      values: {},
      machineStatuses,
      machineItems,
      errorMessage: null
    });
  } catch (error) {
    next(error);
  }
});

app.post("/staff/machines", requireLogin, requireAdmin, async (req, res, next) => {
  const values = {
    item_name: String(req.body.item_name || "").trim(),
    item: String(req.body.item || "").trim(),
    part_number: String(req.body.part_number || "").trim(),
    qty: String(req.body.qty || "").trim(),
    reorder_level: String(req.body.reorder_level || "").trim(),
    description: String(req.body.description || "").trim(),
    serial_number: String(req.body.serial_number || "").trim(),
    specs: String(req.body.specs || "").trim(),
    status: String(req.body.status || ""),
    notes: String(req.body.notes || "").trim()
  };
  const isValid = values.item_name.length > 0 && values.item_name.length <= 180 &&
    machineItems.includes(values.item) &&
    (!values.part_number || values.part_number.length <= 180) &&
    /^\d+$/.test(values.qty) && Number.isSafeInteger(Number(values.qty)) &&
    Number(values.qty) >= 0 && Number(values.qty) <= 2147483647 &&
    /^\d+$/.test(values.reorder_level) && Number.isSafeInteger(Number(values.reorder_level)) &&
    Number(values.reorder_level) <= 2147483647 &&
    (!values.serial_number || values.serial_number.length <= 120) &&
    machineStatuses.includes(values.status);
  if (!isValid) {
    try {
      return res.status(400).render("machine-new", {
        title: "Add machine",
        activePage: "machines",
        notifications: await getNotifications(req.session.user),
        values,
        machineStatuses,
        machineItems,
        errorMessage: "Enter an item name, type, whole-number quantity and reorder level, and valid status."
      });
    } catch (error) {
      return next(error);
    }
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `INSERT INTO machines
         (item_name, item, part_number, qty, reorder_level, description, specs, serial_number, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.item_name,
        values.item,
        values.part_number || null,
        Number(values.qty),
        Number(values.reorder_level),
        values.description || null,
        values.specs || null,
        values.serial_number || null,
        values.status,
        values.notes || null
      ]
    );
    const newValues = {
      ...values,
      qty: Number(values.qty),
      reorder_level: Number(values.reorder_level),
      part_number: values.part_number || null,
      description: values.description || null,
      specs: values.specs || null,
      serial_number: values.serial_number || null,
      notes: values.notes || null
    };
    await connection.execute(
      `INSERT INTO machine_history
         (machine_id, actor_user_id, actor_name, old_values, new_values)
       VALUES (?, ?, ?, ?, ?)`,
      [
        result.insertId,
        req.session.user.id,
        req.session.user.displayName,
        JSON.stringify({}),
        JSON.stringify(newValues)
      ]
    );
    await connection.commit();
    res.redirect(`/staff/machines/${result.insertId}`);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    if (error.code === "ER_DUP_ENTRY") {
      try {
        return res.status(409).render("machine-new", {
          title: "Add machine",
          activePage: "machines",
          notifications: await getNotifications(req.session.user),
          values,
          machineStatuses,
          machineItems,
          errorMessage: "The machine could not be saved."
        });
      } catch (renderError) {
        return next(renderError);
      }
    }
    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.get("/staff/inventory/:id", requireLogin, (req, res) => {
  res.redirect(301, `/staff/machines/${req.params.id}`);
});

app.get("/staff/machines/:id", requireLogin, async (req, res, next) => {
  const machineId = String(req.params.id || "");
  if (!/^\d+$/.test(machineId)) {
    return res.status(404).render("placeholder", {
      title: "Machine Not Found",
      message: "The machine could not be found."
    });
  }
  try {
    const [[machines], [historyRows]] = await Promise.all([
      pool.execute(
        `SELECT id, item_name, item, part_number, qty, reorder_level, description, specs, serial_number, status, notes,
                created_at, updated_at
         FROM machines WHERE id = ? LIMIT 1`,
        [machineId]
      ),
      pool.execute(
        `SELECT actor_name, old_values, new_values, created_at
         FROM machine_history WHERE machine_id = ?
         ORDER BY created_at DESC, id DESC`,
        [machineId]
      )
    ]);
    const machine = machines[0];
    if (!machine) {
      return res.status(404).render("placeholder", {
        title: "Machine Not Found",
        message: "The machine could not be found."
      });
    }
    const history = historyRows.map((entry) => ({
      ...entry,
      old_values: typeof entry.old_values === "string" ? JSON.parse(entry.old_values) : entry.old_values,
      new_values: typeof entry.new_values === "string" ? JSON.parse(entry.new_values) : entry.new_values
    }));
    res.render("machine-detail", {
      title: machine.item_name,
      activePage: "machines",
      notifications: await getNotifications(req.session.user),
      machine: { ...machine, display_status: getMachineInventoryStatus(machine) },
      machineStatuses,
      machineItems,
      editValues: machine,
      history,
      canEdit: req.session.user.role === "admin",
      errorMessage: null
    });
  } catch (error) {
    next(error);
  }
});

app.post("/staff/machines/:id/edit", requireLogin, requireAdmin, async (req, res, next) => {
  const machineId = String(req.params.id || "");
  const values = {
    item_name: String(req.body.item_name || "").trim(),
    item: String(req.body.item || "").trim(),
    part_number: String(req.body.part_number || "").trim(),
    qty: String(req.body.qty || "").trim(),
    reorder_level: String(req.body.reorder_level || "").trim(),
    description: String(req.body.description || "").trim(),
    serial_number: String(req.body.serial_number || "").trim(),
    specs: String(req.body.specs || "").trim(),
    status: String(req.body.status || ""),
    notes: String(req.body.notes || "").trim()
  };
  if (!/^\d+$/.test(machineId) || !values.item_name || values.item_name.length > 180 ||
      !machineItems.includes(values.item) || !/^\d+$/.test(values.qty) ||
      !Number.isSafeInteger(Number(values.qty)) || Number(values.qty) < 0 ||
      Number(values.qty) > 2147483647 || (values.part_number && values.part_number.length > 180) ||
      (values.serial_number && values.serial_number.length > 120) ||
      !/^\d+$/.test(values.reorder_level) ||
      !Number.isSafeInteger(Number(values.reorder_level)) ||
      Number(values.reorder_level) > 2147483647 ||
      !machineStatuses.includes(values.status)) {
    try {
      const [[machines], [historyRows]] = await Promise.all([
        pool.execute(
          `SELECT id, item_name, item, part_number, qty, reorder_level, description, specs, serial_number, status, notes,
                  created_at, updated_at
           FROM machines WHERE id = ? LIMIT 1`,
          [machineId]
        ),
        pool.execute(
          `SELECT actor_name, old_values, new_values, created_at
           FROM machine_history WHERE machine_id = ?
           ORDER BY created_at DESC, id DESC`,
          [machineId]
        )
      ]);
      const machine = machines[0];
      if (!machine) {
        return res.status(404).render("placeholder", {
          title: "Machine Not Found",
          message: "The machine could not be found."
        });
      }
      const history = historyRows.map((entry) => ({
        ...entry,
        old_values: typeof entry.old_values === "string" ? JSON.parse(entry.old_values) : entry.old_values,
        new_values: typeof entry.new_values === "string" ? JSON.parse(entry.new_values) : entry.new_values
      }));
      return res.status(400).render("machine-detail", {
        title: machine.item_name,
        activePage: "machines",
        notifications: await getNotifications(req.session.user),
        machine: { ...machine, display_status: getMachineInventoryStatus(machine) },
        machineStatuses,
        machineItems,
        editValues: values,
        history,
        canEdit: true,
        errorMessage: "Enter valid machine details."
      });
    } catch (error) {
      return next(error);
    }
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT item_name, item, part_number, qty, reorder_level, description, specs, serial_number, status, notes
       FROM machines WHERE id = ? FOR UPDATE`,
      [machineId]
    );
    const machine = rows[0];
    if (!machine) {
      await connection.rollback();
      return res.status(404).render("placeholder", {
        title: "Machine Not Found",
        message: "The machine could not be found."
      });
    }
    const oldValues = {
      ...machine,
      qty: Number(machine.qty),
      reorder_level: Number(machine.reorder_level)
    };
    const newValues = {
      item_name: values.item_name,
      item: values.item,
      part_number: values.part_number || null,
      qty: Number(values.qty),
      reorder_level: Number(values.reorder_level),
      description: values.description || null,
      specs: values.specs || null,
      serial_number: values.serial_number || null,
      status: values.status,
      notes: values.notes || null
    };
    const oldChanged = {};
    const newChanged = {};
    for (const key of Object.keys(oldValues)) {
      if (oldValues[key] !== newValues[key]) {
        oldChanged[key] = oldValues[key];
        newChanged[key] = newValues[key];
      }
    }
    if (!Object.keys(newChanged).length) {
      await connection.rollback();
      return res.redirect(`/staff/machines/${machineId}`);
    }
    await connection.execute(
      `UPDATE machines
       SET item_name = ?, item = ?, part_number = ?, qty = ?, reorder_level = ?, description = ?,
           specs = ?, serial_number = ?, status = ?, notes = ?
       WHERE id = ?`,
      [
        newValues.item_name,
        newValues.item,
        newValues.part_number,
        newValues.qty,
        newValues.reorder_level,
        newValues.description,
        newValues.specs,
        newValues.serial_number,
        newValues.status,
        newValues.notes,
        machineId
      ]
    );
    await connection.execute(
      `INSERT INTO machine_history
         (machine_id, actor_user_id, actor_name, old_values, new_values)
       VALUES (?, ?, ?, ?, ?)`,
      [
        machineId,
        req.session.user.id,
        req.session.user.displayName,
        JSON.stringify(oldChanged),
        JSON.stringify(newChanged)
      ]
    );
    await connection.commit();
    res.redirect(`/staff/machines/${machineId}`);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).render("error", { title: "The machine could not be saved" });
    }
    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.get("/staff/monitoring/import/template.csv", requireLogin, requireAdmin, (req, res) => {
  res.type("text/csv");
  res.set("Content-Disposition", "attachment; filename=\"pms-import-template.csv\"");
  res.send(`${pmsCsvHeaders.join(",")}\r\n`);
});

app.get("/staff/monitoring/import", requireLogin, requireAdmin, async (req, res, next) => {
  try {
    renderPmsImport(res, {
      notifications: await getNotifications(req.session.user),
      errors: req.query.imported ? [`Imported ${String(req.query.imported)} PMS item(s).`] : []
    });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/staff/monitoring/import/preview",
  requireLogin,
  requireAdmin,
  handlePmsCsvUpload,
  async (req, res, next) => {
    delete req.session.pmsImportPreview;
    const errors = [];
    if (!req.file) {
      return renderPmsImport(res, {
        statusCode: 400,
        notifications: await getNotifications(req.session.user),
        errors: ["Choose a CSV file to preview."]
      });
    }

    try {
      const source = req.file.buffer.toString("utf8");
      const headerRows = parseCsv(source, { bom: true, to: 1, trim: true });
      const headers = headerRows[0] || [];
      const normalizedHeaders = headers.map((header) => String(header).trim().toLowerCase());
      if (normalizedHeaders.length !== pmsCsvHeaders.length ||
          pmsCsvHeaders.some((header) => !normalizedHeaders.includes(header))) {
        return renderPmsImport(res, {
          statusCode: 400,
          notifications: await getNotifications(req.session.user),
          errors: [`CSV columns must be: ${pmsCsvHeaders.join(", ")}.`]
        });
      }

      const records = parseCsv(source, {
        bom: true,
        columns: (columns) => columns.map((header) => String(header).trim().toLowerCase()),
        skip_empty_lines: true,
        trim: true,
        relax_column_count: false
      });
      if (records.length === 0) {
        return renderPmsImport(res, {
          statusCode: 400,
          notifications: await getNotifications(req.session.user),
          errors: ["CSV contains no data rows."]
        });
      }
      if (records.length > 2000) {
        return renderPmsImport(res, {
          statusCode: 400,
          notifications: await getNotifications(req.session.user),
          errors: ["CSV can contain at most 2,000 data rows."]
        });
      }

      const [hospitals] = await pool.execute("SELECT id, name FROM hospitals");
      const hospitalsByName = new Map(
        hospitals.map((hospital) => [hospital.name.trim().toLowerCase(), hospital])
      );
      const previewRows = [];
      records.forEach((record, index) => {
        const rowNumber = index + 2;
        const hospitalName = String(record.hospital || "").trim();
        const hospital = hospitalsByName.get(hospitalName.toLowerCase());
        const frequencyMonths = Number(record.frequency_months);
        const lastDone = String(record.last_done || "").trim();
        const nextPms = String(record.next_pms || "").trim();
        let valid = true;

        if (!hospital) {
          errors.push(`Row ${rowNumber}: unknown hospital "${hospitalName}".`);
          valid = false;
        }
        for (const field of ["group", "item", "qty"]) {
          if (!String(record[field] || "").trim()) {
            errors.push(`Row ${rowNumber}: ${field} is required.`);
            valid = false;
          }
        }
        const fieldLimits = [
          ["group", 160],
          ["item", 180],
          ["part_number", 180],
          ["qty", 40]
        ];
        for (const [field, maxLength] of fieldLimits) {
          if (String(record[field] || "").trim().length > maxLength) {
            errors.push(`Row ${rowNumber}: ${field} must be ${maxLength} characters or fewer.`);
            valid = false;
          }
        }
        if (![6, 12, 24, 60].includes(frequencyMonths)) {
          errors.push(`Row ${rowNumber}: frequency_months must be 6, 12, 24, or 60.`);
          valid = false;
        }
        if (!isValidDateOnly(lastDone) || !isValidDateOnly(nextPms)) {
          errors.push(`Row ${rowNumber}: dates must use YYYY-MM-DD.`);
          valid = false;
        }
        if (!valid) {
          return;
        }
        previewRows.push({
          hospital_id: hospital.id,
          hospital: hospital.name,
          group_name: String(record.group).trim(),
          item: String(record.item).trim(),
          part_number: String(record.part_number || "").trim(),
          qty: String(record.qty).trim(),
          frequency_months: frequencyMonths,
          last_done: lastDone || null,
          next_pms: nextPms || null
        });
      });
      req.session.pmsImportPreview = previewRows;
      renderPmsImport(res, {
        statusCode: errors.length ? 400 : 200,
        notifications: await getNotifications(req.session.user),
        errors,
        previewRows
      });
    } catch (error) {
      if (typeof error.code === "string" && error.code.startsWith("CSV_")) {
        return renderPmsImport(res, {
          statusCode: 400,
          notifications: await getNotifications(req.session.user),
          errors: [`Unable to parse CSV: ${error.message}`]
        });
      }
      next(error);
    }
  }
);

app.post("/staff/monitoring/import/confirm", requireLogin, requireAdmin, async (req, res, next) => {
  const rows = req.session.pmsImportPreview;
  if (!Array.isArray(rows) || rows.length === 0) {
    return renderPmsImport(res, {
      statusCode: 400,
      notifications: await getNotifications(req.session.user),
      errors: ["Preview a CSV with valid rows before confirming the import."]
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    for (const row of rows) {
      await connection.execute(
        `INSERT INTO pms_items
           (hospital_id, group_name, item, part_number, qty, frequency_months, last_done, next_pms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.hospital_id,
          row.group_name,
          row.item,
          row.part_number || null,
          row.qty,
          row.frequency_months,
          row.last_done,
          row.next_pms
        ]
      );
    }
    await connection.commit();
    delete req.session.pmsImportPreview;
    res.redirect(`/staff/monitoring/import?imported=${rows.length}`);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.get("/staff/monitoring/:hospitalId", requireLogin, async (req, res, next) => {
  try {
    await renderPmsHospital(req, res);
  } catch (error) {
    next(error);
  }
});

app.post("/staff/monitoring/:hospitalId/items/:itemId", requireLogin, requireAdmin, async (req, res, next) => {
  const { hospitalId, itemId } = req.params;
  if (!/^\d+$/.test(hospitalId) || !/^\d+$/.test(itemId)) {
    return res.status(404).render("placeholder", {
      title: "PMS item not found",
      message: "The PMS item could not be found."
    });
  }

  const lastDoneInput = String(req.body.last_done || "").trim();
  const nextPmsInput = String(req.body.next_pms || "").trim();
  const notesInput = String(req.body.notes || "").trim();
  if (!isValidDateOnly(lastDoneInput) || !isValidDateOnly(nextPmsInput) || notesInput.length > 5000) {
    return renderPmsHospitalSafely(
      req,
      res,
      next,
      400,
      "Enter valid dates and keep notes to 5,000 characters or fewer."
    );
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [items] = await connection.execute(
      `SELECT id, frequency_months, last_done, next_pms, notes
       FROM pms_items
       WHERE id = ? AND hospital_id = ?
       FOR UPDATE`,
      [itemId, hospitalId]
    );
    const item = items[0];
    if (!item) {
      await connection.rollback();
      return res.status(404).render("placeholder", {
        title: "PMS item not found",
        message: "The PMS item could not be found."
      });
    }

    const oldValues = {
      last_done: dateOnly(item.last_done),
      next_pms: dateOnly(item.next_pms),
      notes: item.notes || ""
    };
    const lastDone = lastDoneInput || null;
    const nextPms = lastDone !== oldValues.last_done && lastDone
      ? addMonthsToDate(lastDone, Number(item.frequency_months))
      : nextPmsInput || null;
    const newValues = { last_done: lastDone, next_pms: nextPms, notes: notesInput };
    const oldChanged = {};
    const newChanged = {};
    for (const key of Object.keys(oldValues)) {
      if (oldValues[key] !== newValues[key]) {
        oldChanged[key] = oldValues[key];
        newChanged[key] = newValues[key];
      }
    }
    if (Object.keys(newChanged).length === 0) {
      await connection.rollback();
      return renderPmsHospitalSafely(req, res, next, 400, "Change a date or note before saving.");
    }

    await connection.execute(
      "UPDATE pms_items SET last_done = ?, next_pms = ?, notes = ? WHERE id = ?",
      [newValues.last_done, newValues.next_pms, newValues.notes || null, item.id]
    );
    await connection.execute(
      `INSERT INTO pms_item_history
         (pms_item_id, actor_user_id, actor_name, old_values, new_values)
       VALUES (?, ?, ?, ?, ?)`,
      [
        item.id,
        req.session.user.id,
        req.session.user.displayName,
        JSON.stringify(oldChanged),
        JSON.stringify(newChanged)
      ]
    );
    await connection.commit();
    res.redirect(`/staff/monitoring/${hospitalId}`);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.get("/staff/dashboard", requireLogin, async (req, res, next) => {
  const isStaff = req.session.user.role === "staff";
  const ticketScope = isStaff ? "WHERE assigned_to = ?" : "";
  const ticketParams = isStaff ? [req.session.user.id] : [];
  const openScope = isStaff
    ? "WHERE assigned_to = ? AND status <> 'resolved'"
    : "WHERE status <> 'resolved'";
  const pendingScope = isStaff
    ? "WHERE assigned_to = ? AND status = 'pending'"
    : "WHERE status = 'pending'";

  try {
    const [[{ openTickets }]] = await pool.execute(
      `SELECT COUNT(*) AS openTickets FROM tickets ${openScope}`,
      isStaff ? [req.session.user.id] : []
    );
    const [[{ pendingTickets }]] = await pool.execute(
      `SELECT COUNT(*) AS pendingTickets FROM tickets ${pendingScope}`,
      isStaff ? [req.session.user.id] : []
    );
    const [recentTickets] = await pool.execute(
      `SELECT t.ticket_number, t.subject, t.status, t.created_at, h.name AS hospital_name
       FROM tickets t
       JOIN hospitals h ON h.id = t.hospital_id
       ${ticketScope}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 5`,
      ticketParams
    );
    const notifications = await getNotifications(req.session.user);
    const pms = await getPmsOverview();

    res.render("dashboard", {
      title: "Dashboard",
      activePage: "dashboard",
      notifications,
      openTickets: Number(openTickets),
      pendingTickets: Number(pendingTickets),
      pmsExpiringSoon: pms.counts.expiring_soon,
      pmsOverdue: pms.counts.overdue,
      pmsOverdueHospitals: pms.overdueHospitals.slice(0, 3),
      pmsExpiringHospitals: pms.expiringHospitals.slice(0, 3),
      recentTickets,
      ticketStatuses
    });
  } catch (error) {
    next(error);
  }
});

app.get("/app/tickets", requireLogin, (req, res) => {
  res.redirect("/staff/tickets");
});

app.get("/staff/tickets", requireLogin, async (req, res, next) => {
  const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const requestedStatus = typeof req.query.status === "string" ? req.query.status : "all";
  const selectedStatus = ["all", "open", ...Object.keys(ticketStatuses)].includes(requestedStatus)
    ? requestedStatus
    : "all";
  const conditions = [];
  const params = [];

  if (selectedStatus === "open") {
    conditions.push("t.status <> 'resolved'");
  } else if (selectedStatus !== "all") {
    conditions.push("t.status = ?");
    params.push(selectedStatus);
  }
  if (search) {
    conditions.push("(t.ticket_number LIKE ? OR h.name LIKE ? OR t.subject LIKE ?)");
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  try {
    const [tickets] = await pool.execute(
      `SELECT t.ticket_number, t.subject, t.status, t.priority, t.created_at, h.name AS hospital_name
       FROM tickets t
       JOIN hospitals h ON h.id = t.hospital_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY t.created_at DESC, t.id DESC`,
      params
    );
    const notifications = await getNotifications(req.session.user);
    res.render("ticket-queue", {
      title: "Ticket queue",
      activePage: "tickets",
      tickets,
      search,
      selectedStatus,
      ticketStatuses,
      notifications
    });
  } catch (error) {
    next(error);
  }
});

app.get("/staff/tickets/:ticketNumber", requireLogin, async (req, res, next) => {
  try {
    await renderTicketDetail(req, res);
  } catch (error) {
    next(error);
  }
});

app.post("/staff/tickets/:ticketNumber/approve", requireLogin, async (req, res, next) => {
  if (req.session.user.role !== "admin") {
    return res.status(403).render("error", { title: "Access denied" });
  }
  if (!/^\d{6}$/.test(req.params.ticketNumber)) {
    return res.status(404).render("placeholder", {
      title: "Page Not Found",
      message: "The page you requested could not be found."
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [tickets] = await connection.execute(
      "SELECT id, status, assigned_to, ticket_number, subject FROM tickets WHERE ticket_number = ? FOR UPDATE",
      [req.params.ticketNumber]
    );
    const ticket = tickets[0];
    if (!ticket) {
      await connection.rollback();
      return res.status(404).render("placeholder", {
        title: "Ticket Not Found",
        message: "The ticket number could not be found."
      });
    }
    if (ticket.status !== "pending") {
      await connection.rollback();
      return res.redirect(`/staff/tickets/${req.params.ticketNumber}`);
    }

    await connection.execute("UPDATE tickets SET status = 'approved' WHERE id = ?", [ticket.id]);
    await connection.execute(
      `INSERT INTO ticket_history (ticket_id, actor_user_id, actor_name, action, details, is_public)
       VALUES (?, ?, ?, 'Approved', ?, TRUE)`,
      [
        ticket.id,
        req.session.user.id,
        req.session.user.displayName,
        `Approved by ${req.session.user.displayName}`
      ]
    );
    if (ticket.assigned_to) {
      await addNotification(
        connection,
        ticket.assigned_to,
        "ticket_approved",
        `Ticket-${ticket.ticket_number} was approved.`,
        `/staff/tickets/${ticket.ticket_number}`
      );
    } else {
      await notifyAdmins(
        connection,
        "ticket_approved",
        `Ticket-${ticket.ticket_number} was approved.`,
        `/staff/tickets/${ticket.ticket_number}`
      );
    }
    await connection.commit();
    res.redirect(`/staff/tickets/${req.params.ticketNumber}`);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.post("/staff/tickets/:ticketNumber/update", requireLogin, async (req, res, next) => {
  if (!/^\d{6}$/.test(req.params.ticketNumber)) {
    return res.status(404).render("placeholder", {
      title: "Page Not Found",
      message: "The page you requested could not be found."
    });
  }

  const status = String(req.body.status || "");
  const assignedTo = String(req.body.assignedTo || "");
  const note = String(req.body.note || "").trim();
  const publicMessage = String(req.body.publicMessage || "").trim();
  const priority = String(req.body.priority || "");
  if ((note && note.length > 5000) || (publicMessage && publicMessage.length > 2000)) {
    return renderTicketDetailSafely(
      req,
      res,
      next,
      400,
      "Notes must be 5,000 characters or fewer and public messages 2,000 characters or fewer."
    );
  }
  if (req.session.user.role === "admin" && priority && !ticketPriorities.includes(priority)) {
    return renderTicketDetailSafely(req, res, next, 400, "Select a valid priority.");
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [tickets] = await connection.execute(
      `SELECT id, ticket_number, subject, status, priority, assigned_to
       FROM tickets
       WHERE ticket_number = ?
       FOR UPDATE`,
      [req.params.ticketNumber]
    );
    const ticket = tickets[0];
    if (!ticket) {
      await connection.rollback();
      return res.status(404).render("placeholder", {
        title: "Ticket Not Found",
        message: "The ticket number could not be found."
      });
    }
    if (ticket.status === "pending" || (ticket.status === "resolved" && req.session.user.role !== "admin")) {
      await connection.rollback();
      return res.status(403).render("error", { title: "Ticket cannot be edited" });
    }
    if (!editableTicketStatuses.includes(status)) {
      await connection.rollback();
      return renderTicketDetailSafely(req, res, next, 400, "Select a valid ticket status.");
    }

    let technician = null;
    if (assignedTo) {
      if (!/^\d+$/.test(assignedTo)) {
        await connection.rollback();
        return renderTicketDetailSafely(req, res, next, 400, "Select a valid staff technician.");
      }
      const [staff] = await connection.execute(
        "SELECT id, display_name FROM users WHERE id = ? AND role = 'staff' AND is_active = TRUE LIMIT 1",
        [assignedTo]
      );
      technician = staff[0];
      if (!technician) {
        await connection.rollback();
        return renderTicketDetailSafely(req, res, next, 400, "Select a valid staff technician.");
      }
    }

    const assignmentChanged = String(ticket.assigned_to || "") !== assignedTo;
    const effectiveStatus = assignmentChanged && technician ? "in_progress" : status;
    const changes = [];

    if (ticket.status !== effectiveStatus) {
      changes.push({
        action: "Status changed",
        details: effectiveStatus === "resolved"
          ? "Status changed to Resolved"
          : `Status changed from ${ticketStatuses[ticket.status]} to ${ticketStatuses[effectiveStatus]}`,
        isPublic: true
      });
    }
    if (assignmentChanged) {
      changes.push({
        action: "Technician assignment changed",
        details: technician
          ? `Assigned to ${technician.display_name}`
          : "Technician assignment removed",
        isPublic: false
      });
    }
    if (req.session.user.role === "admin" && priority && ticket.priority !== priority) {
      changes.push({
        action: "Priority changed",
        details: `Priority changed from ${ticket.priority} to ${priority}`,
        isPublic: false
      });
    }
    if (note) {
      changes.push({ action: "Note", details: note, isPublic: false });
    }
    if (publicMessage) {
      changes.push({ action: "Public message", details: publicMessage, isPublic: true });
    }
    if (changes.length === 0) {
      await connection.rollback();
      return renderTicketDetailSafely(req, res, next, 400, "Make an update or add a note before saving.");
    }

    await connection.execute(
      `UPDATE tickets
       SET status = ?, assigned_to = ?, priority = ?
       WHERE id = ?`,
      [
        effectiveStatus,
        assignedTo || null,
        req.session.user.role === "admin" && priority ? priority : ticket.priority,
        ticket.id
      ]
    );
    for (const change of changes) {
      await connection.execute(
        `INSERT INTO ticket_history
           (ticket_id, actor_user_id, actor_name, action, details, is_public)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          ticket.id,
          req.session.user.id,
          req.session.user.displayName,
          change.action,
          change.details,
          change.isPublic
        ]
      );
    }
    const ticketLink = `/staff/tickets/${ticket.ticket_number}`;
    if (assignmentChanged && technician) {
      await addNotification(
        connection,
        technician.id,
        "ticket_assigned",
        `Ticket-${ticket.ticket_number} was assigned to you: ${ticket.subject}`,
        ticketLink
      );
    }
    const statusRecipientId = assignedTo || ticket.assigned_to;
    if (ticket.status !== effectiveStatus && statusRecipientId) {
      await addNotification(
        connection,
        statusRecipientId,
        "ticket_status",
        `Ticket-${ticket.ticket_number} status changed to ${ticketStatuses[effectiveStatus]}.`,
        ticketLink
      );
      await notifyAdmins(
        connection,
        "ticket_status",
        `Ticket-${ticket.ticket_number} status changed to ${ticketStatuses[effectiveStatus]}.`,
        ticketLink
      );
    }
    if (publicMessage) {
      if (statusRecipientId) {
        await addNotification(
          connection,
          statusRecipientId,
          "ticket_message",
          `A public message was added to Ticket-${ticket.ticket_number}.`,
          ticketLink
        );
      }
      await notifyAdmins(
        connection,
        "ticket_message",
        `A public message was added to Ticket-${ticket.ticket_number}.`,
        ticketLink
      );
    }
    await connection.commit();
    res.redirect(`/staff/tickets/${req.params.ticketNumber}`);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.get("/tickets/new", (req, res) => {
  pool.execute("SELECT id, name FROM hospitals ORDER BY name")
    .then(([hospitals]) => {
      res.render("ticket-new", {
        title: "Open a New Ticket",
        hospitals,
        values: { summary: "", hospitalId: "", details: "" },
        errors: []
      });
    })
    .catch((error) => {
      console.error("Failed to load hospitals:", error.message);
      res.status(500).render("error", { title: "Unable to load ticket form" });
    });
});

app.post("/tickets/new", async (req, res, next) => {
  const summary = String(req.body.summary || "").trim();
  const hospitalId = String(req.body.hospitalId || "").trim();
  const details = String(req.body.details || "").trim();
  const values = { summary, hospitalId, details };
  const errors = [];

  if (!summary) {
    errors.push("Issue Summary is required.");
  } else if (summary.length > 180) {
    errors.push("Issue Summary must be 180 characters or fewer.");
  }
  if (!hospitalId || !/^\d+$/.test(hospitalId)) {
    errors.push("Please select a hospital.");
  }
  if (!details) {
    errors.push("Details are required.");
  } else if (details.length > 5000) {
    errors.push("Details must be 5,000 characters or fewer.");
  }

  try {
    const [hospitals] = await pool.execute("SELECT id, name FROM hospitals ORDER BY name");
    const selectedHospital = hospitals.find((hospital) => String(hospital.id) === hospitalId);
    if (hospitalId && !selectedHospital) {
      errors.push("Please select a hospital from the list.");
    }
    if (errors.length > 0) {
      return res.status(400).render("ticket-new", {
        title: "Open a New Ticket",
        hospitals,
        values,
        errors
      });
    }

    const connection = await pool.getConnection();
    let ticketNumber;
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        ticketNumber = String(randomInt(100000, 1000000));
        await connection.beginTransaction();
        try {
          const [ticketResult] = await connection.execute(
            `INSERT INTO tickets
               (ticket_number, hospital_id, subject, description, status)
             VALUES (?, ?, ?, ?, 'pending')`,
            [ticketNumber, selectedHospital.id, summary, details]
          );
          await connection.execute(
            `INSERT INTO ticket_history
             (ticket_id, actor_user_id, actor_name, action, details, is_public)
             VALUES (?, NULL, 'employee (Self-service)', 'Ticket created by employee (Self-service)', 'Ticket submitted through the public self-service form.', TRUE)`,
            [ticketResult.insertId]
          );
          await notifyAdmins(
            connection,
            "ticket_new",
            `A new ticket was submitted: Ticket-${ticketNumber}.`,
            `/staff/tickets/${ticketNumber}`
          );
          await connection.commit();
          break;
        } catch (error) {
          await connection.rollback();
          const isTicketNumberCollision =
            error.code === "ER_DUP_ENTRY" &&
            String(error.sqlMessage || "").includes("uq_tickets_ticket_number");
          if (!isTicketNumberCollision || attempt === 9) {
            throw error;
          }
        }
      }
    } finally {
      connection.release();
    }

    res.redirect(303, `/tickets/sent/${ticketNumber}`);
  } catch (error) {
    next(error);
  }
});

app.get("/tickets/sent/:ticketNumber", async (req, res, next) => {
  const { ticketNumber } = req.params;
  if (!/^\d{6}$/.test(ticketNumber)) {
    return res.status(404).render("placeholder", {
      title: "Page Not Found",
      message: "The page you requested could not be found."
    });
  }

  try {
    const [tickets] = await pool.execute(
      "SELECT ticket_number FROM tickets WHERE ticket_number = ? LIMIT 1",
      [ticketNumber]
    );
    if (tickets.length === 0) {
      return res.status(404).render("placeholder", {
        title: "Page Not Found",
        message: "The page you requested could not be found."
      });
    }

    res.render("ticket-submitted", {
      title: "Request sent",
      ticketNumber: tickets[0].ticket_number
    });
  } catch (error) {
    next(error);
  }
});

app.get("/tickets/status", async (req, res, next) => {
  const rawTicketNumber = req.query.ticketNumber || "";
  const ticketNumber = typeof rawTicketNumber === "string" ? rawTicketNumber.trim() : "";
  const errors = [];
  let ticket = null;
  let history = [];

  if (ticketNumber) {
    if (!/^\d{6}$/.test(ticketNumber)) {
      errors.push("Enter a valid 6-digit ticket number.");
    } else {
      try {
        const [tickets] = await pool.execute(
          `SELECT t.ticket_number, t.subject, t.status, t.created_at, t.updated_at,
                  h.name AS hospital_name, u.display_name AS assigned_name
           FROM tickets t
           JOIN hospitals h ON h.id = t.hospital_id
           LEFT JOIN users u ON u.id = t.assigned_to
           WHERE t.ticket_number = ?
           LIMIT 1`,
          [ticketNumber]
        );
        ticket = tickets[0] || null;
        if (ticket) {
          [history] = await pool.execute(
            `SELECT action, details, created_at
             FROM ticket_history
             WHERE ticket_id = (
               SELECT id FROM tickets WHERE ticket_number = ? LIMIT 1
             ) AND is_public = TRUE
             ORDER BY created_at ASC, id ASC`,
            [ticketNumber]
          );
        }
      } catch (error) {
        return next(error);
      }
    }
  }

  res.render("ticket-status", {
    title: "Check Ticket Status",
    ticketNumber,
    ticket,
    history,
    errors
  });
});

app.use((req, res) => {
  res.status(404).render("placeholder", {
    title: "Page Not Found",
    message: "The page you requested could not be found."
  });
});

app.use((error, req, res, next) => {
  console.error("Request failed:", error.message);
  if (res.headersSent) {
    return next(error);
  }
  res.status(500).render("error", { title: "Something went wrong" });
});

const host = process.env.HOST || "127.0.0.1";
const server = app.listen(port, host, () => {
  console.log(`Hospital Systems Helpdesk listening on ${host}:${port}.`);
});

function closeServer() {
  server.close(() => {
    pool.end().then(() => process.exit(0)).catch((error) => {
      console.error("Failed to close database pool:", error.message);
      process.exit(1);
    });
  });
}

process.on("SIGINT", closeServer);
process.on("SIGTERM", closeServer);

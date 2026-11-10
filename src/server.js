require("dotenv").config();

const bcrypt = require("bcryptjs");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const multer = require("multer");
const path = require("path");
const { createPool } = require("./db");
const { randomInt } = require("crypto");
const { parse: parseCsv } = require("csv-parse/sync");

if (!process.env.SESSION_SECRET) {
  throw new Error("Missing required environment variable: SESSION_SECRET");
}

const app = express();
const pool = createPool();
const port = Number(process.env.PORT || 3001);

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

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.disable("x-powered-by");
app.use(helmet());
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
  res.locals.currentUser = req.session.user || null;
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
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
  const whereClause = user.role === "admin" ? "t.status = 'pending'" : "t.assigned_to = ?";
  const params = user.role === "admin" ? [] : [user.id];
  const [[{ count }]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM tickets t WHERE ${whereClause}`,
    params
  );
  const [tickets] = await pool.execute(
    `SELECT t.ticket_number, t.subject, h.name AS hospital_name
     FROM tickets t
     JOIN hospitals h ON h.id = t.hospital_id
     WHERE ${whereClause}
     ORDER BY t.updated_at DESC, t.id DESC
     LIMIT 5`,
    params
  );

  return { count: Number(count), tickets };
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
    "SELECT id, display_name FROM users WHERE role = 'staff' ORDER BY display_name"
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
  res.render("login", { title: "Staff Sign In", error: null });
});

app.post("/login", async (req, res, next) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  try {
    const [rows] = await pool.execute(
      "SELECT id, username, password_hash, display_name, role FROM users WHERE username = ? LIMIT 1",
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

app.post("/logout", requireLogin, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) {
      return next(error);
    }
    res.clearCookie("hs_helpdesk_session", { httpOnly: true, sameSite: "lax" });
    res.redirect("/");
  });
});

const staffPages = [
  { path: "reports", label: "Reports" }
];

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

for (const page of staffPages) {
  app.get(`/app/${page.path}`, requireLogin, async (req, res, next) => {
    try {
      const notifications = await getNotifications(req.session.user);
      res.render("staff-page", {
        title: page.label,
        activePage: page.path,
        pageLabel: page.label,
        notifications
      });
    } catch (error) {
      next(error);
    }
  });
}

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
      "SELECT id, status FROM tickets WHERE ticket_number = ? FOR UPDATE",
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
      `SELECT id, status, priority, assigned_to
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
        "SELECT id, display_name FROM users WHERE id = ? AND role = 'staff' LIMIT 1",
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
        details: `Status changed from ${ticketStatuses[ticket.status]} to ${ticketStatuses[effectiveStatus]}`,
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
            `INSERT INTO tickets (ticket_number, hospital_id, subject, description, status)
             VALUES (?, ?, ?, ?, 'pending')`,
            [ticketNumber, selectedHospital.id, summary, details]
          );
          await connection.execute(
            `INSERT INTO ticket_history
             (ticket_id, actor_user_id, actor_name, action, details, is_public)
             VALUES (?, NULL, 'employee (Self-service)', 'Ticket created by employee (Self-service)', 'Ticket submitted through the public self-service form.', TRUE)`,
            [ticketResult.insertId]
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

const server = app.listen(port, () => {
  console.log(`Hospital Systems Helpdesk listening on port ${port}.`);
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

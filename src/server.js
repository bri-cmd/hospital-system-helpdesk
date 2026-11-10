require("dotenv").config();

const bcrypt = require("bcryptjs");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("path");
const { createPool } = require("./db");
const { randomInt } = require("crypto");

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
  { path: "monitoring", label: "Monitoring" },
  { path: "reports", label: "Reports" }
];

app.get("/app/dashboard", requireLogin, (req, res) => {
  res.redirect("/staff/dashboard");
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

    res.render("dashboard", {
      title: "Dashboard",
      activePage: "dashboard",
      notifications,
      openTickets: Number(openTickets),
      pendingTickets: Number(pendingTickets),
      pmsExpiringSoon: 0,
      pmsOverdue: 0,
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

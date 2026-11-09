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

app.get("/", (req, res) => {
  res.render("home", { title: "Hospital Systems Helpdesk" });
});

app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/app/dashboard");
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
        res.redirect("/app/dashboard");
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
  { path: "dashboard", label: "Dashboard" },
  { path: "tickets", label: "Ticket queue" },
  { path: "monitoring", label: "Monitoring" },
  { path: "reports", label: "Reports" }
];

for (const page of staffPages) {
  app.get(`/app/${page.path}`, requireLogin, (req, res) => {
    res.render("staff-page", {
      title: page.label,
      activePage: page.path,
      pageLabel: page.label
    });
  });
}

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

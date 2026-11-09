require("dotenv").config();

const bcrypt = require("bcryptjs");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const path = require("path");
const { createPool } = require("./db");

if (!process.env.SESSION_SECRET) {
  throw new Error("Missing required environment variable: SESSION_SECRET");
}

const app = express();
const pool = createPool();
const port = Number(process.env.PORT || 3001);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.disable("x-powered-by");
app.use(helmet());
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
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
  res.render("placeholder", {
    title: "Open a New Ticket",
    message: "Ticket submission will be available in a later stage."
  });
});

app.get("/tickets/status", (req, res) => {
  res.render("placeholder", {
    title: "Check Ticket Status",
    message: "Ticket status lookup will be available in a later stage."
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

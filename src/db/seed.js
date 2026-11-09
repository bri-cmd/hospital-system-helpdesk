require("dotenv").config();

const bcrypt = require("bcryptjs");
const { createPool } = require("../db");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function seed() {
  const pool = createPool();
  const users = [
    {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD"),
      displayName: requiredEnv("ADMIN_NAME"),
      role: "admin"
    },
    {
      username: requiredEnv("STAFF_USERNAME"),
      password: requiredEnv("STAFF_PASSWORD"),
      displayName: requiredEnv("STAFF_NAME"),
      role: "staff"
    }
  ];

  try {
    for (const user of users) {
      const passwordHash = await bcrypt.hash(user.password, 12);
      await pool.execute(
        `INSERT INTO users (username, password_hash, display_name, role)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), display_name = VALUES(display_name), role = VALUES(role)`,
        [user.username, passwordHash, user.displayName, user.role]
      );
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO hospitals (code, name)
         VALUES ('BMC-DEMO', 'BMC Demonstration Hospital')
         ON DUPLICATE KEY UPDATE name = VALUES(name)`
      );
      const [[hospital]] = await connection.execute(
        "SELECT id FROM hospitals WHERE code = 'BMC-DEMO' LIMIT 1"
      );
      await connection.execute(
        `INSERT INTO tickets (ticket_number, hospital_id, subject, description, status)
         VALUES ('HS-DEMO-0001', ?, 'Oxygen plant pressure alarm', 'Demonstration ticket for an oxygen plant pressure alarm.', 'pending')
         ON DUPLICATE KEY UPDATE hospital_id = VALUES(hospital_id), subject = VALUES(subject), description = VALUES(description)`,
        [hospital.id]
      );
      const [[ticket]] = await connection.execute(
        "SELECT id FROM tickets WHERE ticket_number = 'HS-DEMO-0001' LIMIT 1"
      );
      await connection.execute(
        `INSERT INTO ticket_history (ticket_id, actor_name, action, details)
         SELECT ?, 'System', 'Ticket created', 'Initial demonstration ticket.'
         WHERE NOT EXISTS (
           SELECT 1 FROM ticket_history WHERE ticket_id = ? AND action = 'Ticket created'
         )`,
        [ticket.id, ticket.id]
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    console.log("Database seed completed.");
  } finally {
    await pool.end();
  }
}

seed().catch((error) => {
  console.error("Database seed failed:", error.message);
  process.exitCode = 1;
});

require("dotenv").config();

const bcrypt = require("bcryptjs");
const { createPool } = require("../db");

const hospitals = [
  ["RTR", "RTR"],
  ["SUMC", "SUMC"],
  ["CUMC", "CUMC"],
  ["TAGUM-MEDICAL-CITY", "Tagum Medical City"],
  ["CIUDAD-DE-ZAMBOANGA", "Ciudad de Zamboanga"],
  ["PMMG-PPC-HOSPITAL", "PMMG-PPC Hospital"],
  ["TAGUM-DOCTORS-HOSPITAL", "Tagum Doctors Hospital"],
  ["ADVENTIST-VALENCIA", "Adventist Medical Center - Valencia"],
  ["GATCHALIAN-MEDICAL", "Gatchalian Medical Center"],
  ["SAN-ISIDRO-POLYMEDIC", "San Isidro Polymedic General Hospital"],
  ["VISAYAS-MED", "Visayas Med"],
  ["NEGROS-POLYMEDIC", "Negros Polymedic Hospital"],
  ["BROKENSHIRE-MEDICAL", "Brokenshire Medical Center"],
  ["CAUAYAN-MEDICAL", "Cauayan Medical Specialist Hospital"],
  ["SURIGAO-DOC", "Surigao DOC"],
  ["CARAGA-O1", "Caraga Regional Hospital (O1)"],
  ["CARAGA-O2", "Caraga Regional Hospital (O2)"],
  ["MACTAN-MEDICAL", "Mactan Medical"]
];

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
      await connection.execute("DELETE FROM tickets WHERE ticket_number = 'HS-DEMO-0001'");
      await connection.execute(
        `DELETE FROM hospitals
         WHERE code = 'BMC-DEMO'
           AND NOT EXISTS (SELECT 1 FROM tickets WHERE hospital_id = hospitals.id)`
      );
      for (const [code, name] of hospitals) {
        await connection.execute(
          `INSERT INTO hospitals (code, name)
           VALUES (?, ?)
           ON DUPLICATE KEY UPDATE name = VALUES(name)`,
          [code, name]
        );
      }
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

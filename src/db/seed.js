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

// Sample PMS data for Gatchalian Medical Center and three other hospitals.
const samplePmsItems = [
  ["Gatchalian Medical Center", "Air Treatment", "Pre-Filter", "Filter, Element - E0620X5", "1 PC/S", 6, "2026-05-18", "2026-11-18"],
  ["Gatchalian Medical Center", "Air Treatment", "Dust Filter", "FILTER ELEMENT E0620X1", "1 PC/S", 6, "2026-05-18", "2026-11-18"],
  ["Gatchalian Medical Center", "Air Treatment", "Oil Filter", "FILTER ELEMENT E0620XA", "1 PC/S", 6, "2026-05-18", "2026-11-18"],
  ["Gatchalian Medical Center", "Air Treatment", "Particle Filter", "Filter, Element - E0620RXA", "1 PC/S", 6, "2026-05-18", "2026-11-18"],
  ["Gatchalian Medical Center", "Air Treatment", "Bacterial Filter", "Filter, Element OG-M100Y", "1 PC/S", 24, null, null],
  ["Gatchalian Medical Center", "Air Treatment", "Sterile Filter", "Filter Element - OG-M100YSR", "1 PC/S", 24, null, null],
  ["Gatchalian Medical Center", "Air Treatment", "Carbon Tower", "ACTIVATED CARBON", "3 BAG", 60, null, null],
  ["Gatchalian Medical Center", "Compressor #1 - COMP AIR-L18-75A", "Air Filter", "Air Filter - 100001611", "1 PC/S", 6, "2026-05-27", "2026-11-27"],
  ["Gatchalian Medical Center", "Compressor #1 - COMP AIR-L18-75A", "Oil Filter", "Oil Filter - A04819974", "1 PC/S", 6, "2026-05-27", "2026-11-27"],
  ["Gatchalian Medical Center", "Compressor #1 - COMP AIR-L18-75A", "Air-Oil Separator", "Air-Oil Separator - A10525274", "1 PC/S", 12, "2026-05-27", "2027-05-27"],
  ["Gatchalian Medical Center", "Compressor #1 - COMP AIR-L18-75A", "Oil Change", "Compressor Oil - ORELUBE", "1 PAIL", 6, "2026-05-27", "2026-11-27"],
  ["Gatchalian Medical Center", "Compressor #1 - COMP AIR-L18-75A", "V-Belt", "V-Belt", "3 PC/S", 12, null, null],
  ["Gatchalian Medical Center", "Compressor #2", "Air Filter", "Air Filter - 100001611", "1 PC/S", 6, "2026-05-18", "2026-11-18"],
  ["Gatchalian Medical Center", "Compressor #2", "Oil Filter", "Oil Filter - A04819974", "1 PC/S", 6, "2026-05-18", "2026-11-18"],
  ["Gatchalian Medical Center", "Compressor #2", "Air-Oil Separator", "Air-Oil Separator - A10525274", "1 PC/S", 12, "2026-05-18", "2027-05-18"],
  ["Gatchalian Medical Center", "Compressor #2", "Oil Change", "Compressor Oil - ORELUBE", "1 PAIL", 6, "2026-05-18", "2026-11-18"],
  ["Gatchalian Medical Center", "Compressor #2", "V-Belt", "V-Belt", "3 PC/S", 12, null, null],
  ["Gatchalian Medical Center", "Calibration & Other", "Pressure Gauge (Calibration)", "0-400 psi (O2 Receiver)", "1 PC/S", 12, "2025-06-03", "2026-06-03"],
  ["Gatchalian Medical Center", "Calibration & Other", "Pressure Gauge (Calibration)", "0-400 psi (Air receiver)", "1 PC/S", 12, "2025-06-03", "2026-06-03"],
  ["Gatchalian Medical Center", "Calibration & Other", "Pressure Gauge (Calibration)", "0-400 psi (Manifold)", "1 PC/S", 12, "2025-05-08", "2026-05-08"],
  ["Gatchalian Medical Center", "Calibration & Other", "Pressure Gauge (Calibration)", "0-4000psi (Calibrated)", "2 PC/S", 12, null, null],
  ["Gatchalian Medical Center", "Calibration & Other", "O2 Purity Analyzer (Cell)", "Grfy / Southland", "1 PC/S", 12, null, null],
  ["Gatchalian Medical Center", "Calibration & Other", "Handheld Analyzer (Calibration)", "All / Southland", "1 PC/S", 12, "2025-05-08", "2026-05-08"],
  ["Gatchalian Medical Center", "Calibration & Other", "Room Temperature (Calibration)", "DIGITAL", "1 PC/S", 12, "2025-04-24", "2026-04-24"],
  ["RTR", "Air Treatment", "Oil Filter", "Air plant oil filter", "1 PC/S", 6, "2026-05-20", "2026-11-20"],
  ["SUMC", "Calibration & Other", "Pressure Gauge (Calibration)", "Plant pressure gauge", "1 PC/S", 12, "2025-10-30", "2026-10-30"],
  ["Mactan Medical", "Air Treatment", "Bacterial Filter", "Air treatment bacterial filter", "1 PC/S", 24, "2025-03-01", "2027-03-01"]
];

const sampleTickets = [
  {
    number: "740201",
    hospital: "RTR",
    subject: "Oxygen plant pressure is fluctuating",
    details: "The oxygen plant delivery pressure has been fluctuating during the morning shift.",
    priority: "High",
    status: "pending"
  },
  {
    number: "740202",
    hospital: "SUMC",
    subject: "Air compressor is overheating",
    details: "The air compressor temperature rises above its normal range after extended operation.",
    priority: "Urgent",
    status: "approved"
  },
  {
    number: "740203",
    hospital: "Tagum Medical City",
    subject: "Low oxygen reserve pressure",
    details: "The oxygen reserve pressure is lower than expected and requires inspection.",
    priority: "High",
    status: "in_progress",
    technician: "tech1"
  },
  {
    number: "740204",
    hospital: "Brokenshire Medical Center",
    subject: "Replacement valve needed for air plant",
    details: "A replacement valve is required before the air plant repair can be completed.",
    priority: "Medium",
    status: "waiting_for_parts",
    technician: "tech2"
  },
  {
    number: "740205",
    hospital: "Mactan Medical",
    subject: "Oxygen plant alarm cleared after inspection",
    details: "The plant alarm was investigated and the system is operating within its normal range.",
    priority: "Low",
    status: "resolved",
    technician: "tech1"
  }
];

const ticketStatusLabels = {
  approved: "Approved",
  in_progress: "In Progress",
  waiting_for_parts: "Waiting for parts",
  resolved: "Resolved"
};

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
    },
    {
      username: `${requiredEnv("STAFF_USERNAME")}-tech1`.slice(0, 80),
      password: requiredEnv("STAFF_PASSWORD"),
      displayName: "Hospital Systems Technician 1",
      role: "staff"
    },
    {
      username: `${requiredEnv("STAFF_USERNAME")}-tech2`.slice(0, 80),
      password: requiredEnv("STAFF_PASSWORD"),
      displayName: "Hospital Systems Technician 2",
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

      for (const [
        hospitalName,
        groupName,
        item,
        partNumber,
        qty,
        frequencyMonths,
        lastDone,
        nextPms
      ] of samplePmsItems) {
        const [[hospital]] = await connection.execute(
          "SELECT id FROM hospitals WHERE name = ? LIMIT 1",
          [hospitalName]
        );
        if (!hospital) {
          throw new Error(`Sample PMS hospital not found: ${hospitalName}`);
        }
        const [existing] = await connection.execute(
          `SELECT id FROM pms_items
           WHERE hospital_id = ? AND group_name = ? AND item = ? AND part_number = ?
           LIMIT 1`,
          [hospital.id, groupName, item, partNumber]
        );
        if (existing.length === 0) {
          await connection.execute(
            `INSERT INTO pms_items
               (hospital_id, group_name, item, part_number, qty, frequency_months, last_done, next_pms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [hospital.id, groupName, item, partNumber, qty, frequencyMonths, lastDone, nextPms]
          );
        }
      }

      const [[staffUser]] = await connection.execute(
        "SELECT username FROM users WHERE username = ? LIMIT 1",
        [requiredEnv("STAFF_USERNAME")]
      );
      const technicianOneUsername = `${staffUser.username}-tech1`.slice(0, 80);
      const technicianTwoUsername = `${staffUser.username}-tech2`.slice(0, 80);
      const [technicians] = await connection.execute(
        "SELECT id, username FROM users WHERE username IN (?, ?)",
        [technicianOneUsername, technicianTwoUsername]
      );

      for (const sample of sampleTickets) {
        const [[hospital]] = await connection.execute(
          "SELECT id FROM hospitals WHERE name = ? LIMIT 1",
          [sample.hospital]
        );
        const technician = sample.technician
          ? technicians.find((user) => user.username === `${staffUser.username}-${sample.technician}`.slice(0, 80))
          : null;
        const [ticketResult] = await connection.execute(
          `INSERT INTO tickets
             (ticket_number, hospital_id, subject, description, priority, status, assigned_to)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE ticket_number = VALUES(ticket_number)`,
          [
            sample.number,
            hospital.id,
            sample.subject,
            sample.details,
            sample.priority,
            sample.status,
            technician ? technician.id : null
          ]
        );
        const ticketId = ticketResult.insertId || (
          await connection.execute("SELECT id FROM tickets WHERE ticket_number = ? LIMIT 1", [sample.number])
        )[0][0].id;

        const [createdHistory] = await connection.execute(
          "SELECT id FROM ticket_history WHERE ticket_id = ? AND action = 'Ticket created by employee (Self-service)' LIMIT 1",
          [ticketId]
        );
        if (createdHistory.length === 0) {
          await connection.execute(
            `INSERT INTO ticket_history (ticket_id, actor_name, action, details, is_public)
             VALUES (?, 'employee (Self-service)', 'Ticket created by employee (Self-service)', 'Ticket submitted through the public self-service form.', TRUE)`,
            [ticketId]
          );
        }
        if (sample.status !== "pending") {
          const [statusHistory] = await connection.execute(
            "SELECT id FROM ticket_history WHERE ticket_id = ? AND action = 'Status changed' LIMIT 1",
            [ticketId]
          );
          if (statusHistory.length === 0) {
            await connection.execute(
              `INSERT INTO ticket_history (ticket_id, actor_name, action, details, is_public)
               VALUES (?, 'Hospital Systems', 'Status changed', ?, TRUE)`,
              [ticketId, `Status changed to ${ticketStatusLabels[sample.status]}.`]
            );
          }
        }
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

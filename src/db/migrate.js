require("dotenv").config();

const mysql = require("mysql2/promise");
const { getDatabaseConfig } = require("../db");

async function migrate() {
  const config = getDatabaseConfig();
  const database = config.database;
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    charset: config.charset
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, "``")}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.changeUser({ database });

    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        username VARCHAR(80) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(120) NOT NULL,
        role ENUM('admin', 'staff') NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS hospitals (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(180) NOT NULL,
        code VARCHAR(40) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_hospitals_code (code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        ticket_number VARCHAR(40) NOT NULL,
        hospital_id BIGINT UNSIGNED NULL,
        subject VARCHAR(180) NOT NULL,
        description TEXT NOT NULL,
        status ENUM('pending', 'approved', 'in_progress', 'waiting_for_parts', 'resolved') NOT NULL DEFAULT 'pending',
        assigned_to BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_tickets_ticket_number (ticket_number),
        KEY ix_tickets_hospital_id (hospital_id),
        KEY ix_tickets_assigned_to (assigned_to),
        CONSTRAINT fk_tickets_hospital FOREIGN KEY (hospital_id) REFERENCES hospitals (id) ON DELETE SET NULL,
        CONSTRAINT fk_tickets_assigned_user FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS ticket_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        ticket_id BIGINT UNSIGNED NOT NULL,
        actor_user_id BIGINT UNSIGNED NULL,
        actor_name VARCHAR(120) NOT NULL,
        action VARCHAR(120) NOT NULL,
        details TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY ix_ticket_history_ticket_id_created_at (ticket_id, created_at),
        CONSTRAINT fk_ticket_history_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
        CONSTRAINT fk_ticket_history_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [publicColumn] = await connection.query(
      "SHOW COLUMNS FROM ticket_history WHERE Field = 'is_public'"
    );
    if (publicColumn.length === 0) {
      await connection.query(
        "ALTER TABLE ticket_history ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT FALSE AFTER details"
      );
    }

    console.log("Database migration completed.");
  } finally {
    await connection.end();
  }
}

migrate().catch((error) => {
  console.error("Database migration failed:", error.message);
  process.exitCode = 1;
});

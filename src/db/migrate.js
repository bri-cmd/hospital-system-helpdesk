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
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        is_primary_admin BOOLEAN NOT NULL DEFAULT FALSE,
        last_sign_in TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const userColumns = [
      ["is_active", "BOOLEAN NOT NULL DEFAULT TRUE"],
      ["is_primary_admin", "BOOLEAN NOT NULL DEFAULT FALSE"],
      ["last_sign_in", "TIMESTAMP NULL"]
    ];
    for (const [column, definition] of userColumns) {
      const [existingColumns] = await connection.query(
        "SHOW COLUMNS FROM users WHERE Field = ?",
        [column]
      );
      if (existingColumns.length === 0) {
        await connection.query(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
      }
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_account_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        actor_user_id BIGINT UNSIGNED NULL,
        actor_name VARCHAR(120) NOT NULL,
        target_user_id BIGINT UNSIGNED NULL,
        target_username VARCHAR(80) NOT NULL,
        action VARCHAR(40) NOT NULL,
        details VARCHAR(500) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY ix_user_account_history_created (created_at),
        CONSTRAINT fk_user_account_history_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_user_account_history_target FOREIGN KEY (target_user_id) REFERENCES users (id) ON DELETE SET NULL
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

    for (const table of ["pms_items", "tickets"]) {
      const [[tableExists]] = await connection.query(
        `SELECT COUNT(*) AS count
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
      );
      if (!Number(tableExists.count)) {
        continue;
      }
      const [constraints] = await connection.query(
        `SELECT CONSTRAINT_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
           AND COLUMN_NAME = 'equipment_id' AND REFERENCED_TABLE_NAME = 'equipment'`,
        [table]
      );
      for (const constraint of constraints) {
        const name = constraint.CONSTRAINT_NAME.replace(/`/g, "``");
        await connection.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``);
      }
      const [equipmentColumns] = await connection.query(
        `SHOW COLUMNS FROM \`${table}\` WHERE Field = 'equipment_id'`
      );
      if (equipmentColumns.length) {
        await connection.query(`ALTER TABLE \`${table}\` DROP COLUMN equipment_id`);
      }
    }

    await connection.query("DROP TABLE IF EXISTS equipment_history");
    await connection.query("DROP TABLE IF EXISTS equipment");

    await connection.query(`
      CREATE TABLE IF NOT EXISTS machines (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        asset_tag VARCHAR(80) NULL,
        item_name VARCHAR(180) NOT NULL DEFAULT '',
        item VARCHAR(120) NOT NULL,
        part_number VARCHAR(180) NULL,
        qty INT UNSIGNED NOT NULL DEFAULT 1,
        description TEXT NULL,
        specs TEXT NULL,
        serial_number VARCHAR(120) NULL,
        reorder_level INT UNSIGNED NOT NULL DEFAULT 1,
        status ENUM('In stock', 'In use', 'Under repair') NOT NULL DEFAULT 'In stock',
        notes TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_machines_asset_tag (asset_tag),
        KEY ix_machines_item (item),
        KEY ix_machines_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [reorderLevelColumn] = await connection.query(
      "SHOW COLUMNS FROM machines WHERE Field = 'reorder_level'"
    );
    if (reorderLevelColumn.length === 0) {
      await connection.query(
        "ALTER TABLE machines ADD COLUMN reorder_level INT UNSIGNED NOT NULL DEFAULT 1 AFTER qty"
      );
    }

    const [itemNameColumn] = await connection.query(
      "SHOW COLUMNS FROM machines WHERE Field = 'item_name'"
    );
    if (itemNameColumn.length === 0) {
      await connection.query(
        "ALTER TABLE machines ADD COLUMN item_name VARCHAR(180) NOT NULL DEFAULT '' AFTER asset_tag"
      );
    }
    await connection.query(
      "UPDATE machines SET item_name = asset_tag WHERE (item_name IS NULL OR item_name = '') AND asset_tag IS NOT NULL"
    );
    await connection.query("ALTER TABLE machines MODIFY asset_tag VARCHAR(80) NULL");

    await connection.query(
      "ALTER TABLE machines MODIFY status ENUM('Verified', 'Needs check', 'In stock', 'In use', 'Under repair') NOT NULL DEFAULT 'In stock'"
    );
    await connection.query(
      "UPDATE machines SET status = 'In stock' WHERE status IN ('Verified', 'Needs check')"
    );
    await connection.query(
      "UPDATE machines SET item = CASE WHEN item = 'Compressor' THEN 'Compressor parts' WHEN item IN ('Computer', 'Printer', 'Tool', 'Other') THEN 'Other' ELSE item END WHERE item IN ('Computer', 'Printer', 'Compressor', 'Tool', 'Other')"
    );
    await connection.query(
      "ALTER TABLE machines MODIFY status ENUM('In stock', 'In use', 'Under repair') NOT NULL DEFAULT 'In stock'"
    );

    await connection.query(`
      CREATE TABLE IF NOT EXISTS machine_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        machine_id BIGINT UNSIGNED NOT NULL,
        actor_user_id BIGINT UNSIGNED NULL,
        actor_name VARCHAR(120) NOT NULL,
        old_values JSON NOT NULL,
        new_values JSON NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY ix_machine_history_machine_created (machine_id, created_at),
        CONSTRAINT fk_machine_history_machine FOREIGN KEY (machine_id) REFERENCES machines (id) ON DELETE CASCADE,
        CONSTRAINT fk_machine_history_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS pms_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        hospital_id BIGINT UNSIGNED NOT NULL,
        group_name VARCHAR(160) NOT NULL,
        item VARCHAR(180) NOT NULL,
        part_number VARCHAR(180) NULL,
        qty VARCHAR(40) NOT NULL,
        frequency_months SMALLINT UNSIGNED NOT NULL,
        last_done DATE NULL,
        next_pms DATE NULL,
        notes TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY ix_pms_items_hospital_id (hospital_id),
        KEY ix_pms_items_next_pms (next_pms),
        CONSTRAINT fk_pms_items_hospital FOREIGN KEY (hospital_id) REFERENCES hospitals (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS pms_item_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        pms_item_id BIGINT UNSIGNED NOT NULL,
        actor_user_id BIGINT UNSIGNED NULL,
        actor_name VARCHAR(120) NOT NULL,
        old_values JSON NOT NULL,
        new_values JSON NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY ix_pms_item_history_item_created (pms_item_id, created_at),
        CONSTRAINT fk_pms_history_item FOREIGN KEY (pms_item_id) REFERENCES pms_items (id) ON DELETE CASCADE,
        CONSTRAINT fk_pms_history_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        ticket_number VARCHAR(40) NOT NULL,
        hospital_id BIGINT UNSIGNED NULL,
        subject VARCHAR(180) NOT NULL,
        description TEXT NOT NULL,
        priority ENUM('Urgent', 'High', 'Medium', 'Low') NOT NULL DEFAULT 'Medium',
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

    const [priorityColumn] = await connection.query(
      "SHOW COLUMNS FROM tickets WHERE Field = 'priority'"
    );
    if (priorityColumn.length === 0) {
      await connection.query(
        "ALTER TABLE tickets ADD COLUMN priority ENUM('Urgent', 'High', 'Medium', 'Low') NOT NULL DEFAULT 'Medium' AFTER description"
      );
    }

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

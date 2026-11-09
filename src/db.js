const mysql = require("mysql2/promise");

function getDatabaseConfig() {
  const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing database configuration: ${missing.join(", ")}`);
  }

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    waitForConnections: true,
    connectionLimit: 10,
    charset: "utf8mb4"
  };
}

function createPool() {
  return mysql.createPool(getDatabaseConfig());
}

module.exports = { createPool, getDatabaseConfig };

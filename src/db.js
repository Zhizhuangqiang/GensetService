const { Pool } = require("pg");

function sslOptions() {
  if (process.env.AIVEN_CA_CERT) {
    return {
      rejectUnauthorized: true,
      ca: process.env.AIVEN_CA_CERT.replace(/\\n/g, "\n"),
    };
  }

  return {
    rejectUnauthorized:
      String(process.env.DB_SSL_REJECT_UNAUTHORIZED).toLowerCase() === "true",
  };
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslOptions(),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error", error);
});

module.exports = pool;

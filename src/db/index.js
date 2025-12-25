import pkg from "pg";
import dotenv from "dotenv";

dotenv.config(); // აუცილებლად პირველ რიგში

const { Pool } = pkg;

export const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT),
  ssl: {
    rejectUnauthorized: false,
  },
});

pool
  .query("select 1")
  .then(() => console.log("✅ DB Connected"))
  .catch((err) => console.error("❌ DB Error", err));

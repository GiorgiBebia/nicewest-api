import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";

dotenv.config();

// DATE ტიპი (მაგ. birth_date) დაბრუნდეს როგორც "YYYY-MM-DD" ტექსტი, დროის სარტყლის წანაცვლების გარეშე
pkg.types.setTypeParser(1082, (v) => v);

// კონფიგურაციის არჩევა: ან DATABASE_URL, ან ცალკეული პარამეტრები
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: Number(process.env.DB_PORT),
    };

export const pool = new Pool({
  ...poolConfig,
  // Supabase-ს SSL სჭირდება; საკუთარ სერვერზე (იგივე მანქანაზე) DB_SSL=false ჩაწერე
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool
  .query("SELECT 1")
  .then(() => console.log("✅ DB Connected & Optimized"))
  .catch((err) => {
    console.error("❌ DB Connection Error:", err.message);
  });

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});

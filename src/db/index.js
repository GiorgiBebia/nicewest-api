import pkg from "pkg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pkg;

// ვიყენებთ ან მთლიან CONNECTION_STRING-ს, ან ცალკეულ პარამეტრებს
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
  ssl: {
    rejectUnauthorized: false,
  },
  // --- ოპტიმიზაციის პარამეტრები ---
  max: 20, // მაქსიმუმ რამდენი კავშირი იყოს ღია ერთდროულად
  idleTimeoutMillis: 30000, // 30 წამი შეინახოს კავშირი, სანამ დახურავს უმოქმედობის გამო
  connectionTimeoutMillis: 5000, // 5 წამი ეცადოს დაკავშირებას, სანამ ერორს დააბრუნებს
});

// კავშირის შემოწმება ჩართვისას
pool
  .query("SELECT 1")
  .then(() => console.log("✅ DB Connected & Optimized"))
  .catch((err) => {
    console.error("❌ DB Connection Error:", err.message);
  });

// შეცდომების დამჭერი "მძინარე" კლიენტებისთვის
pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});

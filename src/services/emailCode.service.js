import crypto from "crypto";
import dotenv from "dotenv";
import { pool } from "../db/index.js";

dotenv.config();

// ერთჯერადი 6-ნიშნა კოდები ელფოსტისთვის (რეგისტრაციის დადასტურება და პაროლის აღდგენა).
// ბაზაში ინახება მხოლოდ HMAC ჰეში, თვითონ კოდი არსად ინახება.

export const CODE_TTL_MIN = 10; // კოდის სიცოცხლე წუთებში
export const RESEND_COOLDOWN_SEC = 60; // ახალი კოდის მოთხოვნას შორის მინიმალური დრო
export const MAX_ATTEMPTS = 5; // არასწორი მცდელობების ლიმიტი ერთ კოდზე

const HMAC_SECRET = `${process.env.JWT_SECRET}:email-code`;

const hashCode = (email, purpose, code) =>
  crypto.createHmac("sha256", HMAC_SECRET).update(`${purpose}:${email}:${code}`).digest("hex");

const safeEqualHex = (a, b) => {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

const codeError = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

// ქმნის ახალ კოდს და ინახავს მის ჰეშს. აბრუნებს კოდს (გასაგზავნად).
// payload === undefined: არსებული payload რჩება (გამოიყენება "ხელახლა გაგზავნისას"),
// თუ მოლოდინში ჩანაწერი არ არსებობს, აგდებს NO_PENDING-ს.
// თუ cooldown-ი არ გასულა, აგდებს COOLDOWN-ს (retryAfter წამებში).
export const issueCode = async ({ email, purpose, payload }) => {
  const prev = await pool.query("SELECT created_at FROM email_codes WHERE email = $1 AND purpose = $2", [
    email,
    purpose,
  ]);

  if (prev.rows.length > 0) {
    const elapsedSec = (Date.now() - new Date(prev.rows[0].created_at).getTime()) / 1000;
    if (elapsedSec < RESEND_COOLDOWN_SEC) {
      throw codeError("COOLDOWN", { retryAfter: Math.ceil(RESEND_COOLDOWN_SEC - elapsedSec) });
    }
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const codeHash = hashCode(email, purpose, code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000);

  if (payload === undefined) {
    const upd = await pool.query(
      `UPDATE email_codes
       SET code_hash = $3, attempts = 0, expires_at = $4, created_at = NOW()
       WHERE email = $1 AND purpose = $2`,
      [email, purpose, codeHash, expiresAt],
    );
    if (upd.rowCount === 0) throw codeError("NO_PENDING");
  } else {
    await pool.query(
      `INSERT INTO email_codes (email, purpose, code_hash, payload, attempts, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 0, $5, NOW())
       ON CONFLICT (email, purpose)
       DO UPDATE SET code_hash = EXCLUDED.code_hash,
                     payload = EXCLUDED.payload,
                     attempts = 0,
                     expires_at = EXCLUDED.expires_at,
                     created_at = NOW()`,
      [email, purpose, codeHash, payload === null ? null : JSON.stringify(payload), expiresAt],
    );
  }

  // ძველი, გადაუხდელი ჩანაწერების გაწმენდა
  pool.query("DELETE FROM email_codes WHERE expires_at < NOW() - INTERVAL '1 day'").catch(() => {});

  return code;
};

// ამოწმებს კოდს. ყოველი მცდელობა ითვლება (MAX_ATTEMPTS-ის შემდეგ კოდი იბლოკება).
// აბრუნებს { ok: true, id, payload } ან { ok: false, reason: "invalid" | "expired", attemptsLeft? }
// კოდი ამ ფუნქციით არ იხარჯება: წარმატების შემდეგ გამოიძახეთ consumeCode(id).
export const checkCode = async ({ email, purpose, code }) => {
  const row = await pool.query(
    `UPDATE email_codes
     SET attempts = attempts + 1
     WHERE email = $1 AND purpose = $2 AND attempts < $3 AND expires_at > NOW()
     RETURNING id, code_hash, payload, attempts`,
    [email, purpose, MAX_ATTEMPTS],
  );

  if (row.rows.length === 0) return { ok: false, reason: "expired" };

  const rec = row.rows[0];
  if (!safeEqualHex(rec.code_hash, hashCode(email, purpose, code))) {
    return { ok: false, reason: "invalid", attemptsLeft: Math.max(0, MAX_ATTEMPTS - rec.attempts) };
  }

  return { ok: true, id: rec.id, payload: rec.payload };
};

// კოდის ერთჯერადად გახარჯვა. აბრუნებს true-ს მხოლოდ იმ მოთხოვნაზე, რომელმაც რეალურად წაშალა.
export const consumeCode = async (id) => {
  const r = await pool.query("DELETE FROM email_codes WHERE id = $1", [id]);
  return r.rowCount === 1;
};

export const dropCode = (email, purpose) =>
  pool.query("DELETE FROM email_codes WHERE email = $1 AND purpose = $2", [email, purpose]);

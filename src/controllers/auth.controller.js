import bcrypt from "bcrypt";
import { pool } from "../db/index.js";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

console.log();

if (!JWT_SECRET) throw new Error("JWT_SECRET არ არის განსაზღვრული");
if (!JWT_REFRESH_SECRET) console.warn("გაფრთხილება: JWT_REFRESH_SECRET არ არის განსაზღვრული .env ფაილში");

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// დამხმარე ფუნქცია ტოკენების გენერაციისთვის
const generateTokens = (user) => {
  const accessToken = jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "15m" }, // Access ტოკენი მოქმედებს 15 წუთი
  );

  const refreshToken = jwt.sign(
    { id: user.id },
    JWT_REFRESH_SECRET,
    { expiresIn: "30d" }, // Refresh ტოკენი მოქმედებს 30 დღე
  );

  return { accessToken, refreshToken };
};

export const register = async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: "ყველა ველი აუცილებელია" });
    }

    const usernameTrim = username.trim();
    const emailTrim = email.trim().toLowerCase();

    if (!emailRegex.test(emailTrim)) {
      return res.status(400).json({ message: "მოყვანილი Email არასწორია" });
    }

    const existing = await pool.query(
      "SELECT username, email FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)",
      [usernameTrim, emailTrim],
    );

    if (existing.rows.length > 0) {
      const found = existing.rows[0];
      if (found.username.toLowerCase() === usernameTrim.toLowerCase()) {
        return res.status(400).json({ message: "ეს მომხმარებლის სახელი უკვე დაკავებულია" });
      }
      return res.status(400).json({ message: "ეს Email უკვე გამოყენებულია" });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email`,
      [usernameTrim, emailTrim, hash],
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა რეგისტრაციისას" });
  }
};

export const login = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "ყველა ველი აუცილებელია" });
    }

    const result = await pool.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [username.trim()]);

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "მომხმარებელი ვერ მოიძებნა" });
    }

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ message: "პაროლი არასწორია" });
    }

    // ტოკენების გენერაცია
    const { accessToken, refreshToken } = generateTokens(user);

    // ძველი რეფრეშ ტოკენების წაშლა და ახალის შენახვა ბაზაში
    await pool.query("DELETE FROM user_refresh_tokens WHERE user_id = $1", [user.id]);
    await pool.query("INSERT INTO user_refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)", [
      user.id,
      refreshToken,
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ]);

    res.json({
      token: accessToken, // ფრონტენდი ამას ელოდება როგორც 'token'
      refreshToken: refreshToken,
      user: { id: user.id, username: user.username, email: user.email },
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ message: "სერვერის შეცდომა ავტორიზაციისას" });
  }
};

export const refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ message: "No Refresh Token" });

    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);

    // შემოწმება ბაზაში
    const dbTokenResult = await pool.query("SELECT * FROM user_refresh_tokens WHERE token = $1 AND user_id = $2", [
      refreshToken,
      decoded.id,
    ]);

    if (dbTokenResult.rows.length === 0) {
      return res.status(403).json({ message: "Invalid Refresh Token" });
    }

    // იუზერის მონაცემების ამოღება ახალი Access Token-ისთვის
    const userResult = await pool.query("SELECT id, username FROM users WHERE id = $1", [decoded.id]);
    const user = userResult.rows[0];

    if (!user) return res.status(403).json({ message: "User not found" });

    // მხოლოდ Access Token-ის განახლება
    const newAccessToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "15m" });

    res.json({ accessToken: newAccessToken });
  } catch (e) {
    console.error("REFRESH ERROR:", e);
    res.status(403).json({ message: "Expired or Invalid Refresh Token" });
  }
};

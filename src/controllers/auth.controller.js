import bcrypt from "bcrypt";
import { pool } from "../db/index.js";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "default_refresh_secret_change_me_in_production";

if (!JWT_SECRET) {
  console.error("კრიტიკული შეცდომა: JWT_SECRET არ არის განსაზღვრული!");
}

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// დამხმარე ფუნქცია ტოკენების გენერაციისთვის
const generateTokens = (user) => {
  // ტესტირებისთვის დაყენებულია 2 წუთი (შემდეგ შეცვალე '1h'-ზე)
  const accessToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "2m" });

  const refreshToken = jwt.sign({ id: user.id }, JWT_REFRESH_SECRET, { expiresIn: "30d" });

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

    const { accessToken, refreshToken } = generateTokens(user);

    await pool.query("DELETE FROM user_refresh_tokens WHERE user_id = $1", [user.id]);
    await pool.query("INSERT INTO user_refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)", [
      user.id,
      refreshToken,
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ]);

    res.json({
      token: accessToken,
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

    const dbTokenResult = await pool.query("SELECT * FROM user_refresh_tokens WHERE token = $1 AND user_id = $2", [
      refreshToken,
      decoded.id,
    ]);

    if (dbTokenResult.rows.length === 0) {
      return res.status(403).json({ message: "Invalid Refresh Token" });
    }

    const userResult = await pool.query("SELECT id, username FROM users WHERE id = $1", [decoded.id]);
    const user = userResult.rows[0];

    if (!user) return res.status(403).json({ message: "User not found" });

    // აქაც 2 წუთი, რომ ტესტირება სწორად წავიდეს
    const newAccessToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "2m" });

    res.json({ accessToken: newAccessToken });
  } catch (e) {
    console.error("REFRESH ERROR:", e);
    res.status(403).json({ message: "Expired or Invalid Refresh Token" });
  }
};

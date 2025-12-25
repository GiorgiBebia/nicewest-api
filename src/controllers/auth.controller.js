import bcrypt from "bcrypt";
import { pool } from "../db/index.js";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET არ არის განსაზღვრული");

// Email ვალიდაციის regex
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

    // Username ან Email-ის არსებობის შემოწმება
    const existing = await pool.query(
      "SELECT * FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)",
      [usernameTrim, emailTrim]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ message: "Username ან Email უკვე გამოყენებულია" });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email`,
      [usernameTrim, emailTrim, hash]
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ message: "Register error", error: "სერვერის შეცდომა მოხდა" });
  }
};

export const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: "ყველა ველი აუცილებელია" });
    }

    const usernameTrim = username.trim();

    // Case-insensitive username
    const result = await pool.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [usernameTrim]);

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "User not found" });
    }

    const user = result.rows[0];

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ message: "პაროლი არასწორია" });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ message: "Login error", error: "სერვერის შეცდომა მოხდა" });
  }
};

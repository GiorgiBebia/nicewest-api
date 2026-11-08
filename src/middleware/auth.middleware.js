import jwt from "jsonwebtoken";
import { pool } from "../db/index.js";

export const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ message: "No token provided" });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }

  try {
    // ბაზიდან ვამოწმებთ იუზერს, მის ადმინისტრატორობას და დაბლოკვის სტატუსს
    const result = await pool.query("SELECT id, username, is_admin, is_banned FROM users WHERE id = $1", [decoded.id]);

    if (result.rows.length === 0) {
      // 401 + code: კლიენტი ხვდება, რომ ანგარიში აღარ არსებობს და გამოდის სისტემიდან
      return res.status(401).json({ message: "User not found", code: "USER_NOT_FOUND" });
    }

    const user = result.rows[0];

    if (user.is_banned) {
      return res.status(403).json({ message: "User is banned", code: "BANNED" });
    }

    req.user = {
      id: Number(user.id), // bigint pg-დან string-ად მოდის, ვაქცევთ რიცხვად
      username: user.username,
      is_admin: user.is_admin,
    };

    next();
  } catch (error) {
    console.error("AUTH MIDDLEWARE DB ERROR:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

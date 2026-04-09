import jwt from "jsonwebtoken";
import { pool } from "../db/index.js"; // დარწმუნდი რომ პული სწორად გაქვს იმპორტირებული

export const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ message: "No token provided" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ბაზიდან ვამოწმებთ იუზერს და მის სტატუსს
    const result = await pool.query("SELECT id, is_admin FROM users WHERE id = $1", [decoded.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    // აქ ვავსებთ req.user-ს ბაზის რეალური მონაცემებით
    req.user = {
      id: result.rows[0].id,
      is_admin: result.rows[0].is_admin, // აქ უკვე 100% იქნება მნიშვნელობა
    };

    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

import jwt from "jsonwebtoken";
import { pool } from "../db/index.js"; // დარწმუნდი რომ პული სწორად გაქვს იმპორტირებული

export const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ message: "No token provided" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ბაზიდან ვამოწმებთ იუზერს, მის ადმინისტრატორობას და დაბლოკვის სტატუსს
    const result = await pool.query("SELECT id, is_admin, is_banned FROM users WHERE id = $1", [decoded.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = result.rows[0];

    // თუ მომხმარებელი დაბლოკილია, ვბლოკავთ ნებისმიერ მოთხოვნას
    if (user.is_banned) {
      return res.status(403).json({ message: "User is banned" });
    }

    // აქ ვავსებთ req.user-ს ბაზის რეალური მონაცემებით
    req.user = {
      id: user.id,
      is_admin: user.is_admin,
    };

    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

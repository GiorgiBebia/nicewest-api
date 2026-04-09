import express from "express";
import { getStats } from "../controllers/admin.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { isAdmin } from "../middleware/admin.middleware.js";

const router = express.Router();

router.get(
  "/stats",
  (req, res, next) => {
    next();
  },
  authMiddleware,
  isAdmin,
  getStats,
);

export default router;

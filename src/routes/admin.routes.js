import express from "express";
import { getStats, searchUsers, getPendingUsers, updateUserStatus } from "../controllers/admin.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { isAdmin } from "../middleware/admin.middleware.js";

const router = express.Router();

router.get("/stats", authMiddleware, isAdmin, getStats);
router.get("/search-users", authMiddleware, isAdmin, searchUsers);

// ახალი როუტები ვერიფიკაციისთვის
router.get("/pending-users", authMiddleware, isAdmin, getPendingUsers);
router.put("/update-status", authMiddleware, isAdmin, updateUserStatus);

export default router;

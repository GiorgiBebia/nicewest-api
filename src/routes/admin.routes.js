import express from "express";
import {
  getStats,
  searchUsers,
  getPendingUsers,
  updateUserStatus,
  getAdminReports, // ახალი
  resolveReport, // ახალი
  banUserByAdmin, // ახალი
  getChatHistoryForAdmin,
} from "../controllers/admin.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { isAdmin } from "../middleware/admin.middleware.js";

const router = express.Router();

router.get("/stats", authMiddleware, isAdmin, getStats);
router.get("/search-users", authMiddleware, isAdmin, searchUsers);

// როუტები ვერიფიკაციისთვის
router.get("/pending-users", authMiddleware, isAdmin, getPendingUsers);
router.put("/update-status", authMiddleware, isAdmin, updateUserStatus);

// ახალი როუტები რეპორტების მართვისთვის
router.get("/reports", authMiddleware, isAdmin, getAdminReports);
router.post("/reports/resolve", authMiddleware, isAdmin, resolveReport);
router.post("/user/ban", authMiddleware, isAdmin, banUserByAdmin);

// არ დაგავიწყდეს getChatHistoryForAdmin-ის იმპორტირება ფაილის თავში!
router.get("/reports/chat-history", authMiddleware, isAdmin, getChatHistoryForAdmin);
export default router;

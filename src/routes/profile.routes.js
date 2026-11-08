import express from "express";
import {
  updateProfile,
  getMe,
  getDiscovery,
  getMatches,
  getChatMessages,
  sendMessage,
  markAsRead,
  updateLocation,
  getUserProfile,
  reportUser,
  blockUser,
} from "../controllers/profile.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { messageLimiter } from "../middleware/rateLimit.middleware.js";

const router = express.Router();

router.get("/me", authMiddleware, getMe);
router.post("/update", authMiddleware, updateProfile);
router.post("/location", authMiddleware, updateLocation);
router.get("/discovery", authMiddleware, getDiscovery);
router.get("/matches", authMiddleware, getMatches);
router.get("/messages/:partnerId", authMiddleware, getChatMessages);
router.post("/messages/send", authMiddleware, messageLimiter, sendMessage);
router.put("/messages/read/:partnerId", authMiddleware, markAsRead);
router.get("/user", authMiddleware, getUserProfile);

router.post("/report", authMiddleware, reportUser);
router.post("/block", authMiddleware, blockUser);

export default router;

import express from "express";
import {
  updateProfile,
  getMe,
  getDiscovery,
  addLike,
  getMatches,
  getChatMessages,
  sendMessage,
  markAsRead,
  updateLocation,
} from "../controllers/profile.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = express.Router();

router.get("/me", authMiddleware, getMe);
router.post("/update", authMiddleware, updateProfile);
router.post("/location", authMiddleware, updateLocation); // ახალი
router.get("/discovery", authMiddleware, getDiscovery);
router.post("/like", authMiddleware, addLike);
router.get("/matches", authMiddleware, getMatches);
router.get("/messages/:partnerId", authMiddleware, getChatMessages);
router.post("/messages/send", authMiddleware, sendMessage);
router.put("/messages/read/:partnerId", authMiddleware, markAsRead);

export default router;

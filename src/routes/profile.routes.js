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
} from "../controllers/profile.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = express.Router();

// საკუთარი პროფილის წამოღება
router.get("/me", authMiddleware, getMe);

// პროფილის განახლება
router.post("/update", authMiddleware, updateProfile);

// ახალი: სხვა იუზერების წამოღება (Discovery)
router.get("/discovery", authMiddleware, getDiscovery);

router.post("/like", authMiddleware, addLike);

router.get("/matches", authMiddleware, getMatches);

// ჩატის როუტები
router.get("/messages/:partnerId", authMiddleware, getChatMessages);
router.post("/messages/send", authMiddleware, sendMessage);

router.get("/matches", authMiddleware, getMatches);

router.put("/messages/read/:partnerId", authMiddleware, markAsRead);

export default router;

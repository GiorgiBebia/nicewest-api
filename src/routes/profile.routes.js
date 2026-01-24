import express from "express";
import { updateProfile, getMe, getDiscovery } from "../controllers/profile.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = express.Router();

// საკუთარი პროფილის წამოღება
router.get("/me", authMiddleware, getMe);

// პროფილის განახლება
router.post("/update", authMiddleware, updateProfile);

// ახალი: სხვა იუზერების წამოღება (Discovery)
router.get("/discovery", authMiddleware, getDiscovery);

export default router;

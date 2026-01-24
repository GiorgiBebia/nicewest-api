import { Router } from "express";
import { updateProfile, getMe } from "../controllers/profile.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/me", authMiddleware, getMe);

// პროფილის ყველა ცვლილება → ავტომატური save
router.post("/update", authMiddleware, updateProfile);

export default router;

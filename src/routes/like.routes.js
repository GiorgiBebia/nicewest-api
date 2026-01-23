import { Router } from "express";
import { likeUser } from "../controllers/like.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = Router();
router.post("/", authMiddleware, likeUser);

export default router;

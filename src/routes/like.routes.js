import { Router } from "express";
import { likeUser, getLikesStatus } from "../controllers/like.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/", authMiddleware, likeUser);
router.get("/status", authMiddleware, getLikesStatus); // დარჩენილი ლაიქების რაოდენობის შესამოწმებლად

export default router;

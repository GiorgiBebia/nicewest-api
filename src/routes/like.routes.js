import { Router } from "express";
import { likeUser, dislikeUser, getLikesStatus } from "../controllers/like.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/", authMiddleware, likeUser);
router.post("/dislike", authMiddleware, dislikeUser);
router.get("/status", authMiddleware, getLikesStatus); // დარჩენილი ლაიქების რაოდენობის შესამოწმებლად

export default router;

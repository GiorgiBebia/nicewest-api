import { Router } from "express";
import {
  likeUser,
  dislikeUser,
  getLikesStatus,
  getUsersWhoLikedMe,
  addRewardLikes,
} from "../controllers/like.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/", authMiddleware, likeUser);
router.post("/dislike", authMiddleware, dislikeUser);
router.get("/status", authMiddleware, getLikesStatus);
router.get("/received", authMiddleware, getUsersWhoLikedMe);
router.post("/reward", authMiddleware, addRewardLikes);

export default router;

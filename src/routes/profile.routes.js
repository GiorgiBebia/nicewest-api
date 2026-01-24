import { Router } from "express";
import { updateProfile, deleteProfileImage, getMe } from "../controllers/profile.controler.js";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();

router.get("/me", authMiddleware, getMe);

// პროფილის ყველა ცვლილება → ავტომატური save
router.post("/update", authMiddleware, updateProfile);

// ფოტოს წაშლა → deleted_images
router.post("/delete-image", authMiddleware, deleteProfileImage);

export default router;

import express from "express";
import { getStats } from "../controllers/admin.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { isAdmin } from "../middleware/admin.middleware.js";
import { searchUsers } from "../controllers/admin.controller.js";

const router = express.Router();

router.get("/stats", authMiddleware, isAdmin, getStats);

router.get("/search-users", authMiddleware, isAdmin, searchUsers);

export default router;

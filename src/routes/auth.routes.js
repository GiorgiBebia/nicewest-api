import { Router } from "express";
import {
  register,
  login,
  socialLogin,
  refresh,
  logout,
  syncDevice,
  resetPassword,
  forgotPassword,
  verifyRegistration,
  resendRegistrationCode,
  deleteAccount,
  logAppOpen,
} from "../controllers/auth.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
  codeVerifyLimiter,
  emailCodeAddressLimiter,
  emailCodeIpLimiter,
  loginIpLimiter,
  loginUserLimiter,
  registerLimiter,
  registerEmailLimiter,
} from "../middleware/rateLimit.middleware.js";

const router = Router();

router.post("/register", registerLimiter, registerEmailLimiter, register);
router.post("/register/verify", codeVerifyLimiter, verifyRegistration);
router.post("/register/resend", emailCodeIpLimiter, emailCodeAddressLimiter, resendRegistrationCode);
router.post("/forgot-password", emailCodeIpLimiter, emailCodeAddressLimiter, forgotPassword);
router.post("/login", loginIpLimiter, loginUserLimiter, login);
router.post("/social-login", registerLimiter, socialLogin);
router.post("/refresh", refresh);
router.post("/logout", logout);

router.post("/log-open", authMiddleware, logAppOpen);
router.post("/sync-device", authMiddleware, syncDevice);
router.post("/reset-password", codeVerifyLimiter, resetPassword);
router.delete("/delete-account", authMiddleware, deleteAccount);

export default router;

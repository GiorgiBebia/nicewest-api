// src/middleware/admin.middleware.js
export const isAdmin = (req, res, next) => {
  console.log("User from request:", req.user); // <--- ნახე აქ რა იბეჭდება ტერმინალში

  if (req.user && req.user.is_admin) {
    next();
  } else {
    console.log("Access denied for user:", req.user?.id);
    return res.status(403).json({
      success: false,
      message: "წვდომა უარყოფილია: საჭიროა ადმინისტრატორის უფლებები",
    });
  }
};

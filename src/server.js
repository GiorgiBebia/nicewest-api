import dotenv from "dotenv";
import app from "./app.js";

dotenv.config();

const PORT = process.env.PORT || 3000;

// სერვერის გაშვება ხდება მხოლოდ აქ
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server is live on: http://0.0.0.0:${PORT}`);
});

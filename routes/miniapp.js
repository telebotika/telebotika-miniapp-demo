import { Router } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateInitData } from "../utils/telegram-auth.js";

const router = Router();
export const apiRouter = Router();
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const miniappPage = path.resolve(currentDirectory, "../public/miniapp.html");
const { Pool } = pg;

router.get("/", (_request, response) => {
  response.sendFile(miniappPage);
});

apiRouter.post("/auth/init-data", async (request, response) => {
  const validation = validateInitData(request.body?.initDataRaw);
  if (!validation.valid) {
    return response.status(403).json({
      valid: false,
      error: "Invalid signature",
    });
  }

  const { userId, firstName } = validation;

  if (!process.env.DATABASE_URL) {
    console.error("Cannot save authenticated Telegram user without DATABASE_URL");
    return response.status(500).json({
      valid: false,
      error: "Unable to save user",
    });
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      "INSERT INTO users (telegram_user_id, first_name) VALUES ($1, $2) ON CONFLICT (telegram_user_id) DO UPDATE SET first_name = EXCLUDED.first_name",
      [String(userId), firstName],
    );
  } catch {
    console.error("Failed to save authenticated Telegram user");
    return response.status(500).json({
      valid: false,
      error: "Unable to save user",
    });
  } finally {
    await pool.end().catch(() => {});
  }

  return response.json({
    valid: true,
    userId,
    firstName,
  });
});

export default router;
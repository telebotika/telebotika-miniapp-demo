import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import systemRoutes from "./routes/system.js";
import botRoutes from "./routes/bot.js";
import miniappRoutes, { apiRouter as miniappApiRoutes } from "./routes/miniapp.js";
import adminRoutes from "./routes/admin.js";

const app = express();
const currentDirectory =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());

// Данные не кешируем: иначе CDN отдаёт старый ответ после правки.
app.use((request, response, next) => {
  if (request.path.startsWith("/api") || request.path === "/health") {
    response.set("Cache-Control", "no-store");
  }
  next();
});
app.use("/bot", botRoutes);
app.use("/miniapp", miniappRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api", miniappApiRoutes);
app.use(systemRoutes);
app.get("/favicon.ico", (_request, response) => {
  response.status(204).end();
});
app.use(express.static(path.join(currentDirectory, "public")));

export default app;
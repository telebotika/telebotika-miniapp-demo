import app from "./app.js";
import paymentsRouter from "./routes/payments.js";

const port = Number(process.env.PORT) || 3000;

app.use("/api/payments", paymentsRouter);

app.listen(port, "0.0.0.0", () => {
  console.log(`Telegram Mini App boilerplate listening on port ${port}`);
});
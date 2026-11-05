import serverless from "serverless-http";
import app from "../../app.js";
import paymentsRouter from "../../routes/payments.js";

app.use("/api/payments", paymentsRouter);

export const handler = serverless(app);

import { createHmac, timingSafeEqual } from "node:crypto";

const invalidResult = () => ({
  valid: false,
  userId: null,
  firstName: null,
});

export function validateInitData(initDataRaw) {
  const botToken = process.env.BOT_TOKEN;
  if (typeof initDataRaw !== "string" || !botToken) {
    return invalidResult();
  }

  try {
    const params = new URLSearchParams(initDataRaw);
    const hashes = params.getAll("hash");
    const users = params.getAll("user");
    if (
      hashes.length !== 1 ||
      users.length !== 1 ||
      !/^[a-f0-9]{64}$/i.test(hashes[0])
    ) {
      return invalidResult();
    }

    const dataCheckString = [...params.entries()]
      .filter(([key]) => key !== "hash")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();
    const calculatedHash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest();
    const receivedHash = Buffer.from(hashes[0], "hex");
    if (
      receivedHash.length !== calculatedHash.length ||
      !timingSafeEqual(receivedHash, calculatedHash)
    ) {
      return invalidResult();
    }

    const user = JSON.parse(users[0]);
    if (
      !Number.isSafeInteger(user?.id) ||
      user.id <= 0 ||
      typeof user.first_name !== "string" ||
      user.first_name.length === 0
    ) {
      return invalidResult();
    }

    return {
      valid: true,
      userId: user.id,
      firstName: user.first_name,
    };
  } catch {
    return invalidResult();
  }
}
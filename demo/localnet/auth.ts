import { createHmac } from "node:crypto";

const audience = "https://canton.network.global";
export const adminUser = "ledger-api-user";

export function localToken(user: string, secret: string) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1_000);
  const signingInput = `${encode({ alg: "HS256" })}.${encode({
    sub: user,
    aud: audience,
    scope: "",
    iat: now,
    exp: now + 7 * 24 * 60 * 60,
    iss: "unsafe-auth",
  })}`;
  return `${signingInput}.${createHmac("sha256", secret).update(signingInput).digest("base64url")}`;
}

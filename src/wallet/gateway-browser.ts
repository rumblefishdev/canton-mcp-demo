import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

export function reviewPage(origin: URL, reviewUrl: string) {
  const page = new URL("/review", origin);
  page.searchParams.set("wallet", reviewUrl);
  return page.href;
}

export async function startBrowserSession(
  origin: URL,
  login: URL,
  acceptToken: (token: string) => Promise<void>,
  loginHint?: string,
) {
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    !origin.port
  )
    throw new Error(
      "The wallet connection page requires a loopback HTTP URL and port.",
    );

  const challenge = randomUUID();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.headers.host !== origin.host) {
      res.writeHead(403).end();
      return;
    }
    const url = URL.parse(req.url ?? "/", origin);
    if (req.method === "POST" && url?.pathname === "/session") {
      if (
        req.headers.origin !== origin.origin ||
        req.headers["x-wallet-challenge"] !== challenge
      ) {
        res.writeHead(403).end();
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 16_384) throw new Error("Invalid wallet session.");
          chunks.push(chunk);
        }
        const token = Buffer.concat(chunks).toString("utf8");
        if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token))
          throw new Error("Invalid wallet session.");
        await acceptToken(token);
        res.writeHead(204).end();
      } catch {
        res
          .writeHead(400)
          .end(
            "Connection failed. If Gateway skipped the login form, sign out in the wallet window and try again. Otherwise, check the Client ID, Client Secret and Splice LocalNet selection.",
          );
      }
      return;
    }
    if (
      req.method !== "GET" ||
      (url?.pathname !== "/" && url?.pathname !== "/review")
    ) {
      res.writeHead(404).end();
      return;
    }
    const review = url.pathname === "/review";
    const target = review
      ? URL.parse(url.searchParams.get("wallet") ?? "")
      : login;
    if (
      !target ||
      target.origin !== login.origin ||
      target.username ||
      target.password ||
      (review && target.pathname !== "/approve/index.html")
    ) {
      res.writeHead(400).end();
      return;
    }
    const label = review
      ? "Open payment in Wallet Gateway"
      : "Connect Wallet Gateway";
    const nonce = randomUUID();
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
    const settings = JSON.stringify({
      target: target.href,
      walletOrigin: login.origin,
      challenge,
      review,
      loginHint,
    }).replaceAll("<", "\\u003c");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`
<!doctype html><html lang="en"><meta charset="utf-8"><title>${label}</title>
<h1>${label}</h1>
${review ? "" : '<p id="hint"></p>'}
<button id="wallet" type="button">${label}</button>
<p id="status" role="status"></p>
<script nonce="${nonce}">
const { target, walletOrigin, challenge, review, loginHint } = ${settings};
const statusMessage = document.querySelector("#status");
if (!review && loginHint) document.querySelector("#hint").textContent = loginHint;
let popup;
let handshake;
let waitingSince;
let originAcknowledged = false;
let connected = false;
let checking = false;
document.querySelector("#wallet").onclick = () => {
  clearInterval(handshake);
  connected = false;
  originAcknowledged = false;
  popup = window.open(target, "canton-wallet", "popup,width=540,height=760");
  if (!popup) {
    statusMessage.textContent = "Allow the browser to open Wallet Gateway and try again.";
    return;
  }
  waitingSince = Date.now();
  if (!review) statusMessage.textContent = "Complete login in the wallet window, then return here for confirmation.";
  handshake = setInterval(() => {
    if (popup.closed) {
      clearInterval(handshake);
      if (!review && !connected) statusMessage.textContent = "Wallet connection was not completed. Click Connect Wallet Gateway to try again.";
    } else {
      if (!originAcknowledged) {
        popup.postMessage({ type: "SPLICE_WALLET_BROADCAST_ORIGIN", origin: location.origin }, walletOrigin);
      }
      if (!review && !checking && !connected && Date.now() - waitingSince > 15000)
        statusMessage.textContent = "Still waiting for the wallet connection. Check the wallet window, the selected network and the login details.";
    }
  }, 250);
};
window.addEventListener("message", async (event) => {
  if (event.origin !== walletOrigin || event.source !== popup) return;
  if (event.data?.type === "SPLICE_WALLET_BROADCAST_ORIGIN_ACK") {
    originAcknowledged = true;
    return;
  }
  if (checking || event.data?.type !== "SPLICE_WALLET_IDP_AUTH_SUCCESS" || typeof event.data.token !== "string") return;
  checking = true;
  try {
    if (!review) statusMessage.textContent = "Checking the wallet session and configured party...";
    const response = await fetch("/session", {
      method: "POST",
      headers: { "x-wallet-challenge": challenge },
      body: event.data.token,
    });
    statusMessage.textContent = response.ok ? "Wallet connected. Return to your MCP client." : await response.text();
    if (response.ok) {
      connected = true;
      clearInterval(handshake);
      if (!review) popup.close();
    } else clearInterval(handshake);
  } catch {
    statusMessage.textContent = "The local wallet companion could not be reached.";
  } finally {
    checking = false;
  }
});
</script></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(origin.port), origin.hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

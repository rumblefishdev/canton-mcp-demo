// Connect the toolkit companion to the LocalNet Gateway.
import { z } from "zod";
import { ledgerEnd } from "../../../dist/mcp/shared/ledger.js";
import {
  readProfile,
  readProfileDocument,
  requireReaderSocket,
} from "../../../dist/mcp/shared/profile.js";
import {
  runWalletCompanion,
  type WalletSession,
} from "../../../dist/wallet/companion.js";
import {
  reviewPage,
  startBrowserSession,
} from "../../../dist/wallet/gateway-browser.js";
import {
  createGatewayInspector,
  createGatewayProvider,
  gatewaySessionConfig,
} from "../../../dist/wallet/gateway.js";
import { hashingSchemeVersion, verifyPrepared } from "./prepared.js";
import { reviewContext } from "./review-context.js";
import { paymentReviewer } from "./payment.js";

const browserOrigin = new URL(
  process.env.CANTON_WALLET_BROWSER_URL ?? "http://127.0.0.1:3031",
);

try {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const profile = await readProfile();
  const { walletGateway } = z
    .object({ walletGateway: gatewaySessionConfig })
    .parse(await readProfileDocument());
  const login = await createGatewayProvider(walletGateway).connect();
  if (!login) throw new Error("The Gateway did not return a login URL.");
  let browserSession: { token: string; session: WalletSession } | undefined;
  let connectionError: string | undefined;
  const browser = await startBrowserSession(
    browserOrigin,
    login,
    async (token) => {
      const provider = createGatewayProvider(walletGateway, token);
      try {
        await provider.verifyAccount(profile.sender);
        await ledgerEnd(provider.ledger);
      } catch (error) {
        connectionError =
          "The wallet session could not access the configured party or ledger. Check the LocalNet wallet user, secret, and network, then reconnect.";
        console.error(
          `Wallet connection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      connectionError = undefined;
      browserSession = {
        token,
        session: {
          provider,
          verifiedReviews: {
            ...createGatewayInspector(walletGateway, token),
            async plan(id) {
              const { proposal, config } = await reviewContext(id);
              await paymentReviewer.checkPolicy(proposal);
              const plan = await paymentReviewer.plan(proposal, token, config);
              return {
                commands: plan,
                async verify(prepared) {
                  const verified = await verifyPrepared(
                    { ...prepared, hashingSchemeVersion },
                    config,
                    id,
                  );
                  return {
                    hash: verified.hash,
                    details: plan.verify(verified),
                  };
                },
              };
            },
          },
        },
      };
      console.log("Wallet connected for ledger reads and payment review.");
    },
    "Select Splice LocalNet, replace the prefilled Client ID, and enter the Client Secret. Both values are printed in the demo terminal.",
  );
  console.log(`Connect Wallet Gateway at ${browserOrigin.href}`);
  try {
    await runWalletCompanion({
      sender: profile.sender,
      socketPath: requireReaderSocket(),
      connectionUrl: browserOrigin,
      connectionError: () => connectionError,
      walletName: "Wallet Gateway",
      presentApproval: (approval) => reviewPage(browserOrigin, approval.href),
      session: () => browserSession?.session,
      signal: shutdown.signal,
    });
  } finally {
    browser.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

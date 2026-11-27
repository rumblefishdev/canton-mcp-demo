// Use the disposable LocalNet Gateway for fixture creation and funding.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  walletRpc,
  type WalletCommands,
} from "../../../dist/wallet/cip0103.js";
import {
  createGatewayProvider,
  gatewayApprovalReference,
} from "../../../dist/wallet/gateway.js";

const origin = "http://127.0.0.1:3030";
export const localGateway = {
  dappUrl: origin + "/api/v0/dapp",
  userApiUrl: origin + "/api/v0/user",
  networkId: "canton:mcp-localnet",
};

export function walletUserFromProfile(profile: unknown) {
  const record = z
    .object({
      walletUser: z.string().optional(),
      signerUser: z.string().optional(),
    })
    .parse(profile);
  return record.walletUser ?? record.signerUser;
}

export async function fixtureWallet(username: string, secret: string) {
  const { accessToken } = z.object({ accessToken: z.string() }).parse(
    await walletRpc(localGateway.userApiUrl)("selfSignedAccessToken", {
      clientId: username,
      clientSecret: secret,
      networkId: localGateway.networkId,
    }),
  );
  const user = walletRpc(localGateway.userApiUrl, accessToken);
  // Use an origin separate from the interactive browser companion.
  await user("addSession", {
    networkId: localGateway.networkId,
    origin: "http://localhost:3031",
  });
  const provider = createGatewayProvider(localGateway, accessToken);
  return {
    provider,
    user,
    dapp: walletRpc(localGateway.dappUrl, accessToken),
    async submit(party: string, commands: WalletCommands) {
      const commandId = randomUUID();
      const approval = await provider.requestApproval(
        commandId,
        party,
        commands,
      );
      const transactionId = gatewayApprovalReference(approval, commandId);
      const parameters = { transactionId, partyId: party };
      await user("sign", parameters);
      await user("execute", parameters);
      return z
        .object({
          status: z.literal("executed"),
          preparedTransactionHash: z.string(),
        })
        .parse(await user("getTransaction", { transactionId }))
        .preparedTransactionHash;
    },
  };
}

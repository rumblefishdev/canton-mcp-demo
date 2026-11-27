import {
  asset,
  cantonInstrumentId,
  checkPolicy,
  readPolicy,
  transferSchema,
} from "../../../dist/mcp/tools/payments/payment-rules.js";
import type { Proposal } from "../../../dist/mcp/shared/proposals.js";
import type { WalletPaymentConfig } from "./config.js";
import { transferWallet, verifyPayment } from "./payment-effects.js";
import type { VerifiedTransaction } from "./prepared.js";

function parseTransfer(input: unknown) {
  if (
    typeof input === "object" &&
    input !== null &&
    "asset" in input &&
    input.asset === cantonInstrumentId
  ) {
    return transferSchema.parse({ ...input, asset });
  }
  return transferSchema.parse(input);
}

export const paymentReviewer = {
  async checkPolicy(proposal: Proposal) {
    const policy = await readPolicy();
    const reason = checkPolicy(parseTransfer(proposal.input), policy);
    if (reason) throw new Error(reason);
  },
  async plan(proposal: Proposal, token: string, config: WalletPaymentConfig) {
    const transfer = parseTransfer(proposal.input);
    const sdk = await transferWallet(config, token);
    const [command, disclosedContracts] = await sdk.token.transfer.create({
      sender: config.sender,
      recipient: transfer.recipient,
      amount: transfer.amount,
      instrumentId: cantonInstrumentId,
      registryUrl: config.registryUrl,
    });
    return {
      commands: [command],
      disclosedContracts,
      verify(transaction: VerifiedTransaction) {
        const verified = verifyPayment(
          transaction,
          config,
          transfer,
          command.ExerciseCommand.contractId,
        );
        return [
          "Canton Coin transfer",
          `From   ${verified.sender}`,
          `To     ${verified.recipient}`,
          `Amount ${verified.amount} ${verified.asset} (network fees may apply)`,
        ];
      },
    };
  },
};

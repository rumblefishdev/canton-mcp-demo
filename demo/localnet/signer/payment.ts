import {
  checkPolicy,
  readPolicy,
  transferSchema,
} from "../../../dist/mcp/tools/payments/payment-rules.js";
import { readPaymentSignerConfig } from "./config.js";
import type { Reviewer } from "./reviewers.js";
import { transferWallet, verifyPayment } from "./wallet.js";

export const paymentReviewer: Reviewer = {
  async checkPolicy({ proposal }) {
    const policy = await readPolicy();
    const reason = checkPolicy(transferSchema.parse(proposal.input), policy);
    if (reason) throw new Error(reason);
    return policy.reviewSeconds;
  },
  async plan({ proposal, token }) {
    const config = await readPaymentSignerConfig();
    const transfer = transferSchema.parse(proposal.input);
    const sdk = await transferWallet(config, token);
    const [command, disclosedContracts] = await sdk.token.transfer.create({
      sender: config.sender,
      recipient: transfer.recipient,
      amount: transfer.amount,
      instrumentId: transfer.asset,
      registryUrl: config.registryUrl,
      expirationDate: new Date(proposal.expiresAt),
    });
    return {
      commands: [command],
      disclosedContracts,
      verify(transaction) {
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

import { SDK } from "@canton-network/wallet-sdk";
import {
  amountUnits,
  cantonInstrumentId,
  type Transfer,
} from "../../../dist/mcp/tools/payments/payment-rules.js";
import type { WalletPaymentConfig } from "./config.js";
import { singleRootExercise, type VerifiedTransaction } from "./prepared.js";

export const transferChoice = "TransferFactory_Transfer";
export const completedTransfer = "TransferInstructionResult_Completed";
export function transferWallet(config: WalletPaymentConfig, token: string) {
  const auth = { method: "static" as const, token };
  return SDK.create({
    auth,
    ledgerClientUrl: config.ledgerUrl,
    synchronizerId: config.synchronizer,
    token: { registries: [config.registryUrl], auth },
  });
}

export function verifyPayment(
  transaction: VerifiedTransaction,
  config: WalletPaymentConfig,
  transfer: Transfer,
  factoryContractId: string,
) {
  const exercise = singleRootExercise(transaction);
  const argument = exercise.chosenValue?.sum;
  const fields = argument?.oneofKind === "record" ? argument.record.fields : [];
  const admin = fields[0]?.value?.sum;
  const payment = fields[1]?.value?.sum;
  const values =
    payment?.oneofKind === "record"
      ? payment.record.fields.map((field) => field.value?.sum)
      : [];
  const [sender, recipient, amount, instrument] = values;
  const instrumentFields =
    instrument?.oneofKind === "record"
      ? instrument.record.fields.map((field) => field.value?.sum)
      : [];
  const exerciseResult = exercise.exerciseResult?.sum;
  const outcome =
    exerciseResult?.oneofKind === "record"
      ? exerciseResult.record.fields[0]?.value?.sum
      : undefined;
  if (
    exercise.choiceId !== transferChoice ||
    exercise.contractId !== factoryContractId ||
    exercise.templateId?.packageId !== config.instrumentPackageId ||
    exercise.templateId.moduleName !== "Splice.ExternalPartyAmuletRules" ||
    exercise.templateId.entityName !== "ExternalPartyAmuletRules" ||
    exercise.interfaceId?.moduleName !==
      "Splice.Api.Token.TransferInstructionV1" ||
    exercise.interfaceId.entityName !== "TransferFactory" ||
    exercise.actingParties.length !== 1 ||
    exercise.actingParties[0] !== config.sender ||
    admin?.oneofKind !== "party" ||
    admin.party !== config.instrumentAdmin ||
    sender?.oneofKind !== "party" ||
    sender.party !== config.sender ||
    recipient?.oneofKind !== "party" ||
    recipient.party !== transfer.recipient ||
    amount?.oneofKind !== "numeric" ||
    amountUnits(amount.numeric) !== amountUnits(transfer.amount) ||
    instrumentFields[0]?.oneofKind !== "party" ||
    instrumentFields[0].party !== config.instrumentAdmin ||
    instrumentFields[1]?.oneofKind !== "text" ||
    instrumentFields[1].text !== cantonInstrumentId
  ) {
    throw new Error(
      "The signed payload must match the requested Canton Coin transfer.",
    );
  }
  if (
    outcome?.oneofKind !== "variant" ||
    outcome.variant.constructor !== completedTransfer
  ) {
    throw new Error(
      "The prepared payment is not a one-step transfer. Check the recipient’s preapproval.",
    );
  }
  return {
    sender: sender.party,
    recipient: recipient.party,
    amount: amount.numeric,
    asset: transfer.asset,
  };
}

// Load the proposal and the matching LocalNet wallet profile.
import { readProposal } from "../../../dist/mcp/shared/proposals.js";
import { readWalletPaymentConfig } from "./config.js";

export async function reviewContext(requestId: string) {
  const proposal = await readProposal(requestId);
  if (
    proposal?.kind !== "proposal" ||
    proposal.requestId !== requestId ||
    proposal.reviewMode !== "wallet" ||
    proposal.action !== "payment"
  ) {
    throw new Error("This wallet proposal is unavailable.");
  }
  const config = await readWalletPaymentConfig();
  if (
    (proposal.party && proposal.party !== config.sender) ||
    (proposal.synchronizer && proposal.synchronizer !== config.synchronizer)
  ) {
    throw new Error("The proposal belongs to another party or synchronizer.");
  }
  return { proposal, config };
}

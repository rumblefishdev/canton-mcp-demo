import type { Ledger } from "../../../dist/mcp/shared/ledger.js";
import type { Proposal } from "../../../dist/mcp/shared/proposals.js";
import { groupRequestAction } from "../../../dist/mcp/tools/splitwell/group-request.js";
import type { SignerConfig } from "./config.js";
import { groupRequestReviewer } from "./group-request.js";
import { paymentReviewer } from "./payment.js";
import type { VerifiedTransaction } from "./prepared.js";

export type ReviewContext = {
  proposal: Proposal;
  config: SignerConfig;
  token: string;
  ledger: Ledger;
};
type ReviewPlan = {
  commands: object[];
  disclosedContracts: object[];
  verify(transaction: VerifiedTransaction): string[];
};
export type Reviewer = {
  checkPolicy(context: ReviewContext): Promise<number>;
  plan(context: ReviewContext): Promise<ReviewPlan>;
};

export const reviewers = new Map<string, Reviewer>([
  ["payment", paymentReviewer],
  [groupRequestAction, groupRequestReviewer],
]);

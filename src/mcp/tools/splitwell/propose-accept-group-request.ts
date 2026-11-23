// Load the Splitwell request under the reader's permissions and queue it for review.
import type { McpServer } from "@modelcontextprotocol/server";
import { connectReader, registerAction } from "../../shared/actions.js";
import {
  assessGroupRequest,
  groupRequestAction,
  groupRequestInput,
} from "./group-request.js";

export const registerProposeAcceptGroupRequestTool = (
  server: McpServer,
): void => {
  registerAction(server, {
    id: groupRequestAction,
    tool: "propose_accept_group_request",
    description:
      "Read an active Splitwell group request by contract ID and queue its acceptance for human review.",
    inputSchema: groupRequestInput,
    async assess({ contract_id }, profile) {
      const { ledger } = await connectReader(profile);
      return assessGroupRequest(ledger, profile.sender, contract_id);
    },
  });
};

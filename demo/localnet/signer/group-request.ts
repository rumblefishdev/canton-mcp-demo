import { isDeepStrictEqual } from "node:util";
import {
  assessGroupRequest,
  groupRequestChoice,
  groupRequestInput,
  splitwellModule,
} from "../../../dist/mcp/tools/splitwell/group-request.js";
import { singleRootExercise } from "./prepared.js";
import type { ReviewContext, Reviewer } from "./reviewers.js";

async function checkGroupRequest({ proposal, config, ledger }: ReviewContext) {
  const { contract_id } = groupRequestInput.parse(proposal.input);
  const assessment = await assessGroupRequest(
    ledger,
    config.sender,
    contract_id,
  );
  if ("reason" in assessment) throw new Error(assessment.reason);
  if (
    !isDeepStrictEqual(proposal.terms, assessment.terms) ||
    assessment.terms.synchronizerId.split("::").slice(0, 2).join("::") !==
      config.synchronizer
  ) {
    throw new Error(
      "The group request no longer matches the proposal terms or the configured network.",
    );
  }
  return { ...assessment, contract_id };
}

export const groupRequestReviewer: Reviewer = {
  async checkPolicy(context) {
    return (await checkGroupRequest(context)).reviewSeconds;
  },
  async plan(context) {
    const { terms, contract_id } = await checkGroupRequest(context);
    const [packageId] = terms.templateId.split(":");
    const group = terms.group;
    return {
      commands: [
        {
          ExerciseCommand: {
            templateId: terms.templateId,
            contractId: contract_id,
            choice: groupRequestChoice,
            choiceArgument: {},
          },
        },
      ],
      disclosedContracts: [],
      verify(transaction) {
        const exercise = singleRootExercise(transaction);
        const { nodes } = transaction;
        if (
          exercise.choiceId !== groupRequestChoice ||
          exercise.contractId !== contract_id ||
          exercise.templateId?.packageId !== packageId ||
          exercise.templateId.moduleName !== splitwellModule ||
          exercise.templateId.entityName !== "GroupRequest" ||
          exercise.interfaceId !== undefined ||
          exercise.actingParties.length !== 1 ||
          exercise.actingParties[0] !== group.provider ||
          !exercise.consuming ||
          exercise.children.length !== 1 ||
          nodes.length !== 2
        ) {
          throw new Error(
            "The prepared transaction does not accept the selected Splitwell request.",
          );
        }
        const child = nodes.find(
          (node) => node.nodeId === exercise.children[0],
        )?.versionedNode;
        const created =
          child?.oneofKind === "v1" ? child.v1.nodeType : undefined;
        const returned = exercise.exerciseResult?.sum;
        if (
          created?.oneofKind !== "create" ||
          returned?.oneofKind !== "contractId" ||
          returned.contractId !== created.create.contractId ||
          created.create.templateId?.packageId !== packageId ||
          created.create.templateId.moduleName !== splitwellModule ||
          created.create.templateId.entityName !== "Group"
        ) {
          throw new Error(
            "The prepared Splitwell acceptance must create exactly one group.",
          );
        }
        const argument = created.create.argument?.sum;
        const fields =
          argument?.oneofKind === "record"
            ? argument.record.fields.map((field) => field.value?.sum)
            : [];
        const [owner, dso, members, id, provider, duration] = fields;
        const groupId =
          id?.oneofKind === "record"
            ? id.record.fields[0]?.value?.sum
            : undefined;
        const micros =
          duration?.oneofKind === "record"
            ? duration.record.fields[0]?.value?.sum
            : undefined;
        if (
          fields.length !== 6 ||
          owner?.oneofKind !== "party" ||
          owner.party !== group.owner ||
          dso?.oneofKind !== "party" ||
          dso.party !== group.dso ||
          provider?.oneofKind !== "party" ||
          provider.party !== group.provider ||
          members?.oneofKind !== "list" ||
          !isDeepStrictEqual(
            members.list.elements.map((member) =>
              member.sum?.oneofKind === "party" ? member.sum.party : undefined,
            ),
            group.members,
          ) ||
          groupId?.oneofKind !== "text" ||
          groupId.text !== group.id.unpack ||
          micros?.oneofKind !== "int64" ||
          micros.int64 !== group.acceptDuration.microseconds
        ) {
          throw new Error(
            "The prepared group does not match the request terms.",
          );
        }
        return [
          "Splitwell group request acceptance",
          `Request  ${contract_id}`,
          `Group    ${JSON.stringify(groupId.text)}`,
          `Owner    ${owner.party}`,
          `Provider ${provider.party}`,
          `DSO      ${dso.party}`,
          `Members  ${group.members.join(", ") || "(none)"}`,
          `Transfer review window ${micros.int64} microseconds`,
        ];
      },
    };
  },
};

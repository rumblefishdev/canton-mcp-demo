// Translate Canton transaction events into the activity tools’ response shape.
import type { Transaction } from "../../shared/ledger.js";

export function summarize(transaction: Transaction) {
  const { updateId, commandId, offset, effectiveAt, events } = transaction;
  return {
    update_id: updateId,
    command_id: commandId,
    offset,
    effective_at: effectiveAt,
    events: events.map((event) => {
      if ("CreatedEvent" in event)
        return { type: "created", ...event.CreatedEvent };
      if ("ArchivedEvent" in event)
        return { type: "archived", ...event.ArchivedEvent };
      const { exerciseResult, ...exercise } = event.ExercisedEvent;
      return {
        type: "exercised",
        ...exercise,
        outcome: exerciseResult?.output.tag,
      };
    }),
  };
}

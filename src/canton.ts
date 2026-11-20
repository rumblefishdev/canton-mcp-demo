import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readConfig, readOptional, requestPath, writeOnce } from './state.js';

export const userId = 'canton_mcp_demo';
export const pingPackage = 'canton-builtin-admin-workflow-ping';
export const pingPackageId = 'de2cc2f90eb523414ff54e899951dadd8789a4c07e0f71f6d6c9eaf57d412a54';
export const pingModule = 'Canton.Internal.Ping';
const templateId = `#${pingPackage}:${pingModule}:Ping`;
const hashingScheme = 'HASHING_SCHEME_VERSION_V3';

export const preparedSchema = z.object({
  preparedTransaction: z.string().min(1),
  preparedTransactionHash: z.string().min(1),
  hashingSchemeVersion: z.literal(hashingScheme),
});

export function releaseDirectory() {
  const release = process.env.CANTON_RELEASE;
  if (!release) throw new Error('Set CANTON_RELEASE to the unpacked Canton release directory.');
  return release;
}

async function ledgerUrl() {
  if (process.env.CANTON_LEDGER_URL) return process.env.CANTON_LEDGER_URL;
  const ports = z.object({ participant1: z.object({ jsonApi: z.number().int().min(1).max(65535) }) });
  const { participant1 } = ports.parse(JSON.parse(await readFile(join(releaseDirectory(), 'canton_ports.json'), 'utf8')));
  return `http://127.0.0.1:${participant1.jsonApi}`;
}

export async function ledger(path: string, body?: object): Promise<unknown> {
  const response = await fetch(new URL(path, await ledgerUrl()), {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Canton ${path} returned ${response.status}: ${(await response.text()).slice(0, 800)}`);
  return response.json();
}

export async function preparePing() {
  const { alice, bob, synchronizer } = await readConfig();
  const requestId = randomUUID();
  const response = preparedSchema.parse(await ledger('/v2/interactive-submission/prepare', {
    userId,
    commandId: requestId,
    actAs: [alice],
    synchronizerId: synchronizer,
    maxRecordTime: new Date(Date.now() + 5 * 60_000).toISOString(),
    hashingSchemeVersion: hashingScheme,
    packageIdSelectionPreference: [],
    commands: [{ CreateCommand: { templateId, createArguments: { id: requestId, initiator: alice, responder: bob } } }],
  }));
  await writeOnce(requestPath(requestId, 'prepared.json'), JSON.stringify(response));
  const review = process.env.CANTON_REVIEW_COMMAND ?? 'npm run review --';
  return { request_id: requestId, status: 'awaiting_review', review: `Run ${review} ${requestId} in the operator terminal.` };
}

export async function pingStatus(requestId: string) {
  const result = await readOptional(requestPath(requestId, 'result.json'));
  if (result) return z.object({ status: z.literal('confirmed'), update_id: z.string() }).parse(JSON.parse(result));
  const decision = await readOptional(requestPath(requestId, 'decision'));
  if (decision) return { status: decision === 'reject' ? 'rejected' : 'submission_unresolved' };
  const pending = await readOptional(requestPath(requestId, 'prepared.json'));
  return { status: pending ? 'awaiting_review' : 'unknown' };
}

export async function listActivePings() {
  const { alice } = await readConfig();
  const { offset } = z.object({ offset: z.union([z.number(), z.string()]) }).parse(await ledger('/v2/state/ledger-end'));
  const entries = z.array(z.object({ contractEntry: z.object({
    JsActiveContract: z.object({ createdEvent: z.object({ contractId: z.string() }) }).optional(),
  }) })).parse(await ledger('/v2/state/active-contracts', {
    activeAtOffset: offset,
    eventFormat: { filtersByParty: { [alice]: { cumulative: [{
      identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } },
    }] } }, verbose: false },
  }));
  return { party: alice, contract_ids: entries.flatMap(({ contractEntry }) => {
    const active = contractEntry.JsActiveContract;
    return active ? [active.createdEvent.contractId] : [];
  }) };
}

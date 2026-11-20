import { createPrivateKey, generateKeyPairSync, sign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PreparedTransaction } from '@canton-network/core-ledger-proto';
import { computePreparedTransactionHash } from '@canton-network/core-tx-hashing';
import { z } from 'zod';
import { ledger, pingModule, pingPackage, pingPackageId, pingStatus, preparedSchema, releaseDirectory, userId } from './canton.js';
import { configPath, readConfig, readOptional, requestPath, signerKeyPath, writeOnce } from './state.js';

function signHash(hash: Uint8Array, privateKey: KeyObject, fingerprint: string) {
  return {
    signature: sign(null, hash, privateKey).toString('base64'),
    format: 'SIGNATURE_FORMAT_RAW',
    signedBy: fingerprint,
    signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519',
  };
}

async function onboard() {
  if (await readOptional(signerKeyPath) || await readOptional(configPath)) {
    throw new Error('Demo state already exists. Use a fresh .state directory for a new node.');
  }
  const synchronizer = (await readFile(join(releaseDirectory(), 'synchronizer_id'), 'utf8')).trim();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const topology = z.object({
    publicKeyFingerprint: z.string(), multiHash: z.string(), topologyTransactions: z.array(z.string()),
  }).parse(await ledger('/v2/parties/external/generate-topology', {
    synchronizer,
    partyHint: 'alice',
    publicKey: {
      format: 'CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO',
      keyData: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      keySpec: 'SIGNING_KEY_SPEC_EC_CURVE25519',
    },
  }));
  const fingerprint = topology.publicKeyFingerprint;
  const { partyId: alice } = z.object({ partyId: z.string() }).parse(await ledger('/v2/parties/external/allocate', {
    synchronizer, userId: '', waitForAllocation: true,
    onboardingTransactions: topology.topologyTransactions.map(transaction => ({ transaction })),
    multiHashSignatures: [signHash(Buffer.from(topology.multiHash, 'base64'), privateKey, fingerprint)],
  }));
  const { partyDetails: { party: bob } } = z.object({ partyDetails: z.object({ party: z.string() }) })
    .parse(await ledger('/v2/parties', { partyIdHint: `bob-${fingerprint.slice(-12)}`, identityProviderId: '' }));

  await writeOnce(signerKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  await writeOnce(configPath, JSON.stringify({ alice, bob, fingerprint, synchronizer }));
  console.log('Alice and Bob are ready. The operator CLI uses Alice’s test key.');
}

async function review(requestId: string) {
  if ((await pingStatus(requestId)).status !== 'awaiting_review') throw new Error('This request is unavailable for review.');
  const { alice, bob, synchronizer, fingerprint } = await readConfig();
  const request = preparedSchema.parse(JSON.parse(await readFile(requestPath(requestId, 'prepared.json'), 'utf8')));
  const hash = await computePreparedTransactionHash(request.preparedTransaction, request.hashingSchemeVersion);
  const expected = Buffer.from(request.preparedTransactionHash, 'base64');
  if (expected.length !== hash.length || !timingSafeEqual(hash, expected)) {
    throw new Error('Prepared transaction hash does not match. Request refused.');
  }

  const { transaction, metadata } = PreparedTransaction.fromBinary(Buffer.from(request.preparedTransaction, 'base64'));
  const node = transaction?.nodes[0];
  const action = node?.versionedNode.oneofKind === 'v1' ? node.versionedNode.v1.nodeType : undefined;
  if (!transaction || transaction.nodes.length !== 1 || transaction.roots.length !== 1
      || transaction.roots[0] !== node?.nodeId || action?.oneofKind !== 'create'
      || metadata?.submitterInfo?.commandId !== requestId
      || metadata.submitterInfo.actAs.length !== 1 || metadata.submitterInfo.actAs[0] !== alice
      || metadata.synchronizerId !== `${synchronizer}::37-0` || metadata.inputContracts.length !== 0) {
    throw new Error('Only a single Ping creation by Alice is allowed.');
  }
  const { create } = action;
  const argument = create.argument?.sum;
  const fields = argument?.oneofKind === 'record' ? argument.record.fields : [];
  const values = fields.map(field => field.value?.sum);
  if (create.packageName !== pingPackage || create.templateId?.packageId !== pingPackageId
      || create.templateId.moduleName !== pingModule || create.templateId.entityName !== 'Ping'
      || values.length !== 3 || values[0]?.oneofKind !== 'text' || values[0].text !== requestId
      || values[1]?.oneofKind !== 'party' || values[1].party !== alice
      || values[2]?.oneofKind !== 'party' || values[2].party !== bob
      || create.signatories.length !== 1 || create.signatories[0] !== alice
      || create.stakeholders.length !== 2 || !create.stakeholders.includes(alice) || !create.stakeholders.includes(bob)) {
    throw new Error('Prepared contract does not match the demo policy.');
  }
  const deadline = metadata.maxRecordTime;
  if (deadline === undefined || deadline <= BigInt(Date.now()) * 1_000n) {
    throw new Error('This request expired. Prepare a new one.');
  }
  console.log(`Create ${create.templateId.moduleName}:${create.templateId.entityName}`);
  console.log(`From ${values[1].party}\nTo   ${values[2].party}\nHash ${Buffer.from(hash).toString('hex')}`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question('Type approve or reject: ').finally(() => prompt.close());
  const decision = answer.trim().toLowerCase();
  if (decision !== 'approve' && decision !== 'reject') throw new Error('No decision recorded.');
  if (decision === 'approve' && deadline <= BigInt(Date.now()) * 1_000n) throw new Error('This request expired.');
  await writeOnce(requestPath(requestId, 'decision'), decision);
  if (decision === 'reject') {
    console.log('Rejected. No transaction submitted.');
    return;
  }
  const key = createPrivateKey(await readFile(signerKeyPath));
  const response = z.object({ updateId: z.string().min(1) }).parse(await ledger('/v2/interactive-submission/executeAndWait', {
    userId, submissionId: requestId,
    preparedTransaction: request.preparedTransaction,
    hashingSchemeVersion: request.hashingSchemeVersion,
    deduplicationPeriod: { DeduplicationDuration: { value: { seconds: 600, nanos: 0 } } },
    partySignatures: { signatures: [{ party: alice, signatures: [signHash(hash, key, fingerprint)] }] },
  }));
  await writeOnce(requestPath(requestId, 'result.json'), JSON.stringify({ status: 'confirmed', update_id: response.updateId }));
  console.log(`Canton confirmed ledger update ${response.updateId}`);
}

const [command, requestId] = process.argv.slice(2);
try {
  if (command === 'onboard') await onboard();
  else if (command === 'review' && requestId) await review(requestId);
  else throw new Error('Use npm run onboard or npm run review -- REQUEST_ID.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

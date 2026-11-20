import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const stateDirectory = fileURLToPath(new URL('../.state/', import.meta.url));
export const configPath = join(stateDirectory, 'parties.json');
export const signerKeyPath = join(process.env.CANTON_SIGNER_DIRECTORY ?? stateDirectory, 'alice.pem');
export const requestIdSchema = z.uuid();
export const configSchema = z.object({
  alice: z.string(), bob: z.string(), fingerprint: z.string(), synchronizer: z.string(),
});

export function requestPath(requestId: string, suffix: string) {
  return join(stateDirectory, `${requestIdSchema.parse(requestId)}.${suffix}`);
}

export async function readOptional(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

export async function readConfig() {
  return configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
}

export async function writeOnce(path: string, contents: string) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, 'write-'));
  try {
    const file = join(temporary, 'data');
    await writeFile(file, contents, { mode: 0o600 });
    await link(file, path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

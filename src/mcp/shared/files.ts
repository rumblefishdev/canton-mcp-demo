import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

export const requestIdSchema = z.uuid();

export async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

async function writeAtomic(
  path: string,
  contents: string,
  publish: typeof link,
) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, "write-"));
  try {
    const file = join(temporary, "data");
    await writeFile(file, contents, { mode: 0o600 });
    await publish(file, path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export const writeOnce = (path: string, contents: string) =>
  writeAtomic(path, contents, link);
export const replaceFile = (path: string, contents: string) =>
  writeAtomic(path, contents, rename);

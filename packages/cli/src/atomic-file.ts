import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, lstat, rename, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type Phase = "after-temp-create" | "after-write" | "after-file-sync" | "after-rename" | "after-dir-sync";
type FaultHook = (phase: Phase) => Promise<void>;

function fail(): never { throw new Error("PRIVATE_FILE_INVALID"); }

async function privateStat(path: string, kind: "file" | "directory") {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) fail();
  if ((stat.mode & 0o777) !== (kind === "file" ? 0o600 : 0o700)) fail();
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail();
  return stat;
}

export async function createPrivateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await privateStat(path, "directory");
}

export async function withWriterLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  await privateStat(directory, "directory");
  const lock = join(directory, ".writer-lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("STORE_LOCKED");
    throw error;
  }
  try { return await work(); }
  finally { await rmdir(lock); }
}

export async function readPrivateFile(path: string, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail();
  await privateStat(dirname(path), "directory");
  const before = await privateStat(path, "file");
  if (before.size > maxBytes) fail();
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
        after.size > maxBytes || (after.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && after.uid !== process.getuid())) fail();
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) fail();
    return new Uint8Array(bytes);
  } finally { await handle.close(); }
}

export function createAtomicFiles(fault: FaultHook = async () => {}) {
  return {
    replacePrivateFile: async (path: string, bytes: Uint8Array): Promise<void> => {
      const directory = dirname(path);
      await privateStat(directory, "directory");
      try { await privateStat(path, "file"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const temporary = join(directory, `.${basename(path)}.tmp-${randomBytes(16).toString("hex")}`);
      const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 ||
            (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail();
        await fault("after-temp-create");
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
          if (bytesWritten <= 0) fail();
          offset += bytesWritten;
        }
        await fault("after-write");
        await handle.sync();
        await fault("after-file-sync");
      } finally { await handle.close(); }
      await rename(temporary, path);
      await fault("after-rename");
      const parent = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { await parent.sync(); }
      finally { await parent.close(); }
      await fault("after-dir-sync");
    },
  };
}

export const replacePrivateFile = createAtomicFiles().replacePrivateFile;

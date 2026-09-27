import { spawn } from "node:child_process";
import { mkdtemp, lstat, readFile, readdir, rm, symlink, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrivateDirectory, readPrivateFile, replacePrivateFile, withWriterLock, createAtomicFiles } from "../src/atomic-file.js";
import { sealEnvelope } from "../src/envelope.js";
import { encodeOwnerSnapshot, initializeOwnerState } from "../src/state.js";
import type { WalletStateV1 } from "../src/state.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cutxo-atomic-"));
  roots.push(root);
  const directory = join(root, "owner");
  await createPrivateDirectory(directory);
  return { root, directory, file: join(directory, "state.enc") };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function readInFreshProcess(directory: string, owner = false) {
  const source = owner ? `import { readOwnerState } from ${JSON.stringify(new URL("../dist/state.js", import.meta.url).href)};
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const state = await readOwnerState(process.argv[1], Buffer.concat(chunks));
    process.stdout.write(state.restoration);` :
    `import { readPrivateFile } from ${JSON.stringify(new URL("../dist/atomic-file.js", import.meta.url).href)};
    process.stdout.write(Buffer.from(await readPrivateFile(process.argv[1], 16777216)).toString("base64"));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, owner ? directory : join(directory, "state.enc")],
    { stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; let error = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { error += String(chunk); });
  child.stdin.end(owner ? "test-passphrase" : "");
  await new Promise<void>((resolve, reject) => {
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`reader exit ${code}: ${error}`)));
    child.once("error", reject);
  });
  return output;
}

describe("private atomic files", () => {
  it("serializes writers across processes without deleting a residual lock", async () => {
    const { directory } = await fixture();
    const script = `import { withWriterLock } from ${JSON.stringify(new URL("../dist/atomic-file.js", import.meta.url).href)};
      try { await withWriterLock(process.argv[1], async () => process.stdout.write("WRONG")); }
      catch { process.stdout.write("BLOCKED"); }`;
    await withWriterLock(directory, async () => {
      await expect(withWriterLock(directory, async () => "second")).rejects.toThrow();
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, directory], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", data => { stdout += String(data); });
      child.stderr.on("data", data => { stderr += String(data); });
      await new Promise<void>((resolve, reject) => {
        child.once("exit", code => code === 0 ? resolve() : reject(new Error(`contender exited ${code}: ${stderr}`)));
        child.once("error", reject);
      });
      expect(stdout).toBe("BLOCKED");
    });
    expect(await withWriterLock(directory, async () => "third")).toBe("third");
    await mkdir(join(directory, ".writer-lock"), { mode: 0o700 });
    await writeFile(join(directory, ".writer-lock", "pid"), "99999999");
    await expect(withWriterLock(directory, async () => "bad")).rejects.toThrow();
    expect(await readFile(join(directory, ".writer-lock", "pid"), "utf8")).toBe("99999999");
  });

  it("enforces private owner and mode and rejects symlinks", async () => {
    const { root, directory, file } = await fixture();
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    await replacePrivateFile(file, new TextEncoder().encode("secret"));
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(new TextDecoder().decode(await readPrivateFile(file, 10))).toBe("secret");
    await chmod(file, 0o644);
    await expect(readPrivateFile(file, 10)).rejects.toThrow();
    await expect(replacePrivateFile(file, new Uint8Array([1]))).rejects.toThrow();
    await chmod(file, 0o600);
    await chmod(directory, 0o755);
    await expect(withWriterLock(directory, async () => 1)).rejects.toThrow();
    await chmod(directory, 0o700);
    const link = join(root, "link");
    await symlink(file, link);
    await expect(readPrivateFile(link, 10)).rejects.toThrow();
    await expect(replacePrivateFile(link, new Uint8Array([1]))).rejects.toThrow();
  });

  it("preserves a complete generation around failed write and rename", async () => {
    const { directory, file } = await fixture();
    const old = new TextEncoder().encode("old");
    const next = new TextEncoder().encode("next");
    await replacePrivateFile(file, old);
    for (const phase of ["after-temp-create", "after-write", "after-file-sync", "after-rename", "after-dir-sync"] as const) {
      const atomic = createAtomicFiles(async point => { if (point === phase) throw new Error(phase); });
      await expect(atomic.replacePrivateFile(file, next)).rejects.toThrow(phase);
      const actual = Buffer.from(await readInFreshProcess(directory), "base64").toString("utf8");
      expect(actual).toBe(phase === "after-temp-create" || phase === "after-write" || phase === "after-file-sync" ? "old" : "next");
      if (actual === "next") await replacePrivateFile(file, old);
    }
    expect((await readdir(directory)).some(name => name.startsWith(".state.enc.tmp-"))).toBe(true);
    expect(new TextDecoder().decode(await readPrivateFile(file, 10))).toBe("old");
  });

  it("opens only a complete encrypted owner generation in a new process after every interruption", async () => {
    const { directory, file } = await fixture();
    const owner = "0x1111111111111111111111111111111111111111" as const;
    const pool = "0x2222222222222222222222222222222222222222" as const;
    const context = { chainId: 31337n, pool, deploymentBlock: 1n, verifier: pool,
      parametersHash: `0x${"ab".repeat(32)}` as const, finalityMode: "local-simulated" as const };
    const initial: WalletStateV1 = { schemaVersion: 1, context, owner, receiptKeys: [], activeReceiptKeyId: null,
      operations: {}, sync: null, restoration: "ready" };
    const pass = Buffer.from("test-passphrase");
    await initializeOwnerState(directory, pass, initial);
    const original = await readPrivateFile(file, 16 * 1024 * 1024);
    const plaintext = encodeOwnerSnapshot({ ...initial, restoration: "needs-resync" });
    const replacement = await sealEnvelope(plaintext, pass);
    plaintext.fill(0);
    for (const phase of ["after-temp-create", "after-write", "after-file-sync", "after-rename", "after-dir-sync"] as const) {
      await replacePrivateFile(file, original);
      const atomic = createAtomicFiles(async point => { if (point === phase) throw new Error(phase); });
      await expect(atomic.replacePrivateFile(file, replacement)).rejects.toThrow(phase);
      expect(await readInFreshProcess(directory, true)).toBe(
        phase === "after-temp-create" || phase === "after-write" || phase === "after-file-sync" ? "ready" : "needs-resync");
    }
  });
});

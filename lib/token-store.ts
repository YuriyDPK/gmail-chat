import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type GoogleTokens = { accessToken: string; refreshToken: string; expiresAt: number };
const directory = path.join(process.cwd(), ".gmail-chat-tokens");
function key() {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is required");
  return createHash("sha256").update(process.env.AUTH_SECRET).digest();
}
function file(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid session");
  return path.join(directory, id);
}
export async function saveTokens(id: string, tokens: GoogleTokens) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  const data = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  const target = file(id), temp = `${target}.${randomBytes(8).toString("hex")}`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, target);
}
export async function loadTokens(id: string): Promise<GoogleTokens | null> {
  try {
    const data = await readFile(file(id));
    const decipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"));
  } catch { return null; }
}
export async function deleteTokens(id: string) { await unlink(file(id)).catch(() => {}); }

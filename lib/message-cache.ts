import "server-only";
import type { gmail_v1 } from "googleapis";

type Entry = { message: gmail_v1.Schema$Message; expires: number; bytes: number };
const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<gmail_v1.Schema$Message>>();
const ttl = 120_000;
const maxBytes = 24 * 1024 * 1024;
let totalBytes = 0;
const keyFor = (sessionId: string, messageId: string) => `${sessionId}:${messageId}`;
function remove(key: string) { const entry = entries.get(key); if (entry) { totalBytes -= entry.bytes; entries.delete(key); } }
export async function cachedMessage(sessionId: string, messageId: string, load: () => Promise<gmail_v1.Schema$Message>) {
  const key = keyFor(sessionId, messageId);
  const entry = entries.get(key);
  if (entry && entry.expires > Date.now()) { entries.delete(key); entries.set(key, entry); return entry.message; }
  remove(key);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = load().then(message => {
    if (pending.get(key) === request) {
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (bytes <= maxBytes / 4) {
        while (totalBytes + bytes > maxBytes && entries.size) remove(entries.keys().next().value!);
        entries.set(key, { message, expires: Date.now() + ttl, bytes }); totalBytes += bytes;
      }
    }
    return message;
  }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}
export function invalidateMessages(sessionId: string, ids: string[]) {
  for (const id of ids) for (const variant of [id, `metadata:${id}`]) { const key = keyFor(sessionId, variant); remove(key); pending.delete(key); }
}
export function clearMessageCache(sessionId: string) {
  const prefix = `${sessionId}:`;
  for (const key of entries.keys()) if (key.startsWith(prefix)) remove(key);
  for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
}

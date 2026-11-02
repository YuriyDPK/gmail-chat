import "server-only";
import { getToken } from "next-auth/jwt";
import { google, gmail_v1 } from "googleapis";
import { accessToken } from "@/lib/auth";
import { attachmentInfo } from "@/lib/attachment";
import { cachedMessage, invalidateMessages } from "@/lib/message-cache";
import type { MailMessage, Attachment } from "@/lib/mail-types";

const sessions = new WeakMap<gmail_v1.Gmail, string>();
export async function gmailFor(request: Request) {
  const token = await getToken({ req: request as never, secret: process.env.AUTH_SECRET });
  if (!token || typeof token.tokenStoreId !== "string") throw new Error("SESSION_EXPIRED");
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: await accessToken(token.tokenStoreId) });
  const gmail = google.gmail({ version: "v1", auth });
  sessions.set(gmail, token.tokenStoreId);
  return gmail;
}
export async function getFullMessage(gmail: gmail_v1.Gmail, id: string) {
  const session = sessions.get(gmail);
  const load = async () => (await gmail.users.messages.get({ userId: "me", id, format: "full" })).data;
  return session ? cachedMessage(session, id, load) : load();
}
export async function getMessageMetadata(gmail: gmail_v1.Gmail, id: string) {
  const session = sessions.get(gmail);
  const load = async () => (await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] })).data;
  return session ? cachedMessage(session, `metadata:${id}`, load) : load();
}
export function invalidateCachedMessages(gmail: gmail_v1.Gmail, ids: string[]) {
  const session = sessions.get(gmail);
  if (session) invalidateMessages(session, ids);
}
export function errorResponse(error: unknown) {
  console.error("Gmail request failed:", error instanceof Error ? error.message : "unknown error");
  const expired = (error instanceof Error && error.message === "SESSION_EXPIRED") || (error as { code?: number })?.code === 401;
  const details = error as { code?: number; errors?: { reason?: string }[]; message?: string };
  const quota = details?.code === 429 || details?.errors?.some(item => /rateLimitExceeded|userRateLimitExceeded/i.test(item.reason || "")) || /quota exceeded|rate limit/i.test(details?.message || "");
  return Response.json({ error: expired ? "Сессия истекла. Войдите снова." : quota ? "Превышен лимит запросов Gmail. Подождите минуту и повторите попытку." : "Не удалось выполнить запрос к Gmail. Попробуйте ещё раз." }, { status: expired ? 401 : quota ? 429 : 502, headers: { "Cache-Control": "no-store" } });
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !!origin && origin === new URL(request.url).origin;
}
function decode(data?: string | null) { return data ? Buffer.from(data, "base64url").toString("utf8") : ""; }
function decodeMimeHeader(value: string) {
  return value.replace(/(=\?[^?\s]+\?[bq]\?[^?]*\?=)\s+(?==\?[^?\s]+\?[bq]\?)/gi, "$1").replace(/=\?([^?\s]+)\?([bq])\?([^?]*)\?=/gi, (original, charset: string, encoding: string, content: string) => {
    try {
      const bytes = encoding.toLowerCase() === "b" ? Buffer.from(content, "base64") : Buffer.from(content.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
      try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString("utf8"); }
    } catch { return original; }
  });
}
function address(input: string) {
  const match = input.match(/^(.*?)\s*<([^<>]+)>/);
  const email = (match ? match[2] : input).trim().replace(/^mailto:/i, "").toLowerCase();
  return { email, name: (match ? match[1].trim().replace(/^"|"$/g, "") : "") || email };
}
function htmlText(html: string) {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>|<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?\s*>|<\/p>|<\/div>|<\/li>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff))).trim();
}
export function parseMessage(message: gmail_v1.Schema$Message, ownEmail: string): MailMessage {
  const headers = message.payload?.headers || [];
  const header = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
  const from = address(decodeMimeHeader(header("from")));
  const to = decodeMimeHeader(header("to"));
  const recipients = to.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).map(address);
  const outgoing = from.email === ownEmail.toLowerCase();
  const contact = outgoing ? recipients.find(r => r.email && r.email !== ownEmail.toLowerCase()) || from : from;
  let plain = "", html = "";
  const attachments: Attachment[] = [];
  function walk(part: gmail_v1.Schema$MessagePart, path: string) {
    const attachment = attachmentInfo(part, path);
    if (attachment) attachments.push(attachment);
    else if (part.mimeType === "text/plain" && part.body?.data) plain += decode(part.body.data);
    else if (part.mimeType === "text/html" && part.body?.data) html += decode(part.body.data);
    part.parts?.forEach((child, index) => walk(child, `${path}_${index}`));
  }
  if (message.payload) walk(message.payload, "0");
  return { id: message.id || "", threadId: message.threadId || "", from: from.email, fromName: from.name, to, subject: decodeMimeHeader(header("subject")) || "Без темы", date: Number(message.internalDate) || Date.parse(header("date")) || 0, text: (plain || htmlText(html) || message.snippet || "").trim(), ...(html ? { html } : {}), snippet: message.snippet || "", outgoing, unread: !!message.labelIds?.includes("UNREAD"), messageId: header("message-id"), references: header("references"), attachments, contactEmail: contact.email, contactName: contact.name };
}

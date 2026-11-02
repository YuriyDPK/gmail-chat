import { randomBytes } from "node:crypto";
import { checkOrigin, errorResponse, gmailFor } from "@/lib/gmail";
const clean = (value: string) => value.replace(/[\r\n]/g, " ").trim();
const encoded = (value: string) => `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
export async function POST(request: Request) {
  if (!checkOrigin(request)) return new Response("Forbidden", { status: 403 });
  try {
    const form = await request.formData();
    const to = clean(String(form.get("to") || ""));
    const subject = clean(String(form.get("subject") || ""));
    const text = String(form.get("text") || "").trim();
    const threadId = clean(String(form.get("threadId") || ""));
    const messageId = clean(String(form.get("messageId") || ""));
    const references = clean(String(form.get("references") || ""));
    const files = form.getAll("files").filter((file): file is File => file instanceof File);
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(to) || (!text && !files.length) || subject.length > 500 || text.length > 500000 || files.reduce((sum, f) => sum + f.size, 0) > 15 * 1024 * 1024 || (threadId && !/^[\w-]+$/.test(threadId))) return Response.json({ error: "Проверьте адрес, текст и размер вложений (до 15 МБ)." }, { status: 400 });
    const boundary = `gmail-chat-${randomBytes(18).toString("hex")}`;
    const headers = [`To: ${to}`, `Subject: ${encoded(subject || "Без темы")}`, "MIME-Version: 1.0"];
    if (messageId && /^<[^<>\s]+>$/.test(messageId)) {
      headers.push(`In-Reply-To: ${messageId}`);
      headers.push(`References: ${[...references.matchAll(/<[^<>\s]+>/g)].map(m => m[0]).concat(messageId).join(" ")}`);
    }
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [`--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", Buffer.from(text).toString("base64").replace(/.{1,76}/g, "$&\r\n")];
    for (const file of files) {
      let filename = "";
      for (const character of Array.from(clean(file.name).toWellFormed())) {
        if (filename.length >= 200 || encodeURIComponent(filename + character).length > 600) break;
        filename += character;
      }
      filename ||= "attachment";
      const fallback = filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
      const mime = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.type) ? file.type.toLowerCase() : "application/octet-stream";
      const extended = encodeURIComponent(filename).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
      parts.push(`--${boundary}`, `Content-Type: ${mime}; name="${fallback}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${fallback}"; filename*=UTF-8''${extended}`, "", Buffer.from(await file.arrayBuffer()).toString("base64").replace(/.{1,76}/g, "$&\r\n"));
    }
    parts.push(`--${boundary}--`, "");
    const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`).toString("base64url");
    const gmail = await gmailFor(request);
    const result = await gmail.users.messages.send({ userId: "me", requestBody: { raw, ...(threadId ? { threadId } : {}) } });
    return Response.json({ id: result.data.id, threadId: result.data.threadId });
  } catch (error) { return errorResponse(error); }
}

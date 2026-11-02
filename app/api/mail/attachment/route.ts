import { connection } from "next/server";
import { findAttachment, imageMimeType } from "@/lib/attachment";
import { errorResponse, getFullMessage, gmailFor } from "@/lib/gmail";
export async function GET(request: Request) {
  await connection();
  try {
    const url = new URL(request.url), messageId = url.searchParams.get("messageId"), id = url.searchParams.get("id");
    // Older browser tabs can still use Gmail's opaque attachment ID, including padding.
    if (!messageId || !id || !/^[\w-]+$/.test(messageId) || id.length > 4096 || /[\x00-\x1f\x7f]/.test(id)) return new Response("Invalid attachment", { status: 400 });
    const gmail = await gmailFor(request);
    const message = await getFullMessage(gmail, messageId);
    const found = message.payload && findAttachment(message.payload, id);
    if (!found) return new Response("Not found", { status: 404 });
    const { part, info } = found;
    let data = part.body?.data;
    if (part.body?.attachmentId && (data == null || (data === "" && (part.body.size || 0) > 0))) {
      data = (await gmail.users.messages.attachments.get({ userId: "me", messageId, id: part.body.attachmentId })).data.data;
    }
    if (typeof data !== "string") return Response.json({ error: "Вложение недоступно в Gmail." }, { status: 502 });
    const bytes = Buffer.from(data, "base64url");
    const imageType = imageMimeType(info.mimeType, info.filename);
    const preview = url.searchParams.get("preview") === "1" && imageType;
    const encodedName = encodeURIComponent(info.filename.toWellFormed()).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": preview ? imageType : "application/octet-stream", "Content-Disposition": `${preview ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${encodedName}`, "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

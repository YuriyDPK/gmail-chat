import type { gmail_v1 } from "googleapis";
import type { Attachment } from "@/lib/mail-types";

const imageTypes: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
export function imageMimeType(mime: string, filename: string): string | undefined {
  const type = mime.split(";")[0].trim().toLowerCase();
  if (/^image\/(jpeg|png|gif|webp|avif)$/.test(type)) return type;
  if (type !== "application/octet-stream" && type !== "application/binary" && type !== "") return undefined;
  return imageTypes[filename.split(".").pop()?.toLowerCase() || ""];
}
function header(part: gmail_v1.Schema$MessagePart, name: string) {
  return part.headers?.find(item => item.name?.toLowerCase() === name)?.value || "";
}
function parameter(value: string, name: string, extendedOnly = false): string {
  const pieces = [...value.matchAll(new RegExp(`(?:^|;)\\s*${name}\\*(\\d+)(\\*)?\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "gi"))]
    .map(match => ({ index: Number(match[1]), encoded: !!match[2], value: match[3] || match[4] || "" }))
    .sort((a, b) => a.index - b.index);
  if (pieces.length && pieces.every((piece, index) => piece.index === index) && (!extendedOnly || pieces.some(piece => piece.encoded))) {
    const joined = pieces.map(piece => piece.value).join("").replace(/^[^']*'[^']*'/, "");
    try { return decodeURIComponent(joined); } catch { return joined; }
  }
  const extended = value.match(new RegExp(`(?:^|;)\\s*${name}\\*\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i"));
  if (extended) {
    const raw = (extended[1] || extended[2] || "").replace(/^[^']*'[^']*'/, "");
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  if (extendedOnly) return "";
  const simple = value.match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"((?:\\\\.|[^"\\\\])*)"|([^;\\s]*))`, "i"));
  return (simple?.[1] || simple?.[2] || "").replace(/\\(["\\])/g, "$1");
}
export function attachmentInfo(part: gmail_v1.Schema$MessagePart, path: string): Attachment | null {
  const mime = (part.mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase();
  const disposition = header(part, "content-disposition");
  const contentType = header(part, "content-type");
  const named = parameter(disposition, "filename", true) || part.filename || parameter(disposition, "filename") || parameter(contentType, "name");
  const filename = named.replace(/[\r\n\0]/g, " ").trim();
  const isImage = mime.startsWith("image/") || !!imageMimeType(mime, filename);
  const bodyAvailable = !!part.body && (!!part.body.attachmentId || typeof part.body.data === "string");
  const isOtherBody = bodyAvailable && mime !== "text/plain" && mime !== "text/html" && !mime.startsWith("multipart/");
  const isAttachment = !!filename || /^\s*attachment(?:\s*;|\s*$)/i.test(disposition) || isImage || isOtherBody;
  if (!isAttachment || !bodyAvailable) return null;
  const contentId = header(part, "content-id").trim().replace(/^<|>$/g, "");
  const extension: Record<string, string> = { "application/pdf": ".pdf", "application/zip": ".zip", "text/calendar": ".ics", "message/rfc822": ".eml", "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif" };
  const fallbackName = (isImage ? "Изображение" : "Вложение") + (extension[mime] || "");
  return { id: `part_${path}`, filename: filename || fallbackName, mimeType: imageMimeType(mime, filename) || mime, size: part.body?.size || 0, ...(contentId ? { contentId } : {}) };
}
export function findAttachment(part: gmail_v1.Schema$MessagePart, id: string, path = "0"): { part: gmail_v1.Schema$MessagePart; info: Attachment } | null {
  const info = attachmentInfo(part, path);
  if (info && (info.id === id || part.body?.attachmentId === id || (id === `inline_${path}` && typeof part.body?.data === "string"))) return { part, info };
  for (const [index, child] of (part.parts || []).entries()) {
    const found = findAttachment(child, id, `${path}_${index}`);
    if (found) return found;
  }
  return null;
}

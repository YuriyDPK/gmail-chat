"use client";

import { useState } from "react";
import Image from "next/image";
import { Download, FileText, ImageOff, LoaderCircle } from "lucide-react";
import type { Attachment } from "@/lib/mail-types";

export function attachmentUrl(messageId: string, id: string, preview = false) {
  return `/api/mail/attachment?messageId=${encodeURIComponent(messageId)}&id=${encodeURIComponent(id)}${preview ? "&preview=1" : ""}`;
}
export function isPreviewImage(mime: string) { return /^image\/(jpeg|png|gif|webp|avif)$/i.test(mime); }

export function AttachmentCard({ messageId, attachment, compact = false }: { messageId: string; attachment: Attachment; compact?: boolean }) {
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  async function download() {
    if (downloading) return;
    setDownloading(true); setError("");
    try {
      const response = await fetch(attachmentUrl(messageId, attachment.id));
      if (!response.ok) {
        let message = "Не удалось скачать вложение. Попробуйте ещё раз.";
        try { message = (await response.json()).error || message; } catch { /* Non-JSON error. */ }
        throw new Error(message);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = attachment.filename; document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { setError(error instanceof Error ? error.message : "Не удалось скачать вложение."); }
    finally { setDownloading(false); }
  }
  const showPreview = isPreviewImage(attachment.mimeType) && !compact;
  return <div className="attachment-item">
    {showPreview && <div className="image-attachment">{previewFailed ? <div className="image-unavailable"><ImageOff size={20}/> Не удалось загрузить изображение <button type="button" onClick={() => setPreviewFailed(false)}>Повторить</button></div> : <a href={attachmentUrl(messageId, attachment.id, true)} target="_blank" rel="noreferrer" aria-label={`Открыть изображение ${attachment.filename}`}><Image unoptimized width={440} height={300} src={attachmentUrl(messageId, attachment.id, true)} alt={attachment.filename} onError={() => setPreviewFailed(true)}/></a>}</div>}
    <button className="attachment attachment-download" type="button" onClick={download} disabled={downloading} aria-label={`Скачать ${attachment.filename}`}><span className="attachment-icon">{downloading ? <LoaderCircle size={18} className="spin"/> : showPreview ? <Download size={18}/> : <FileText size={18}/>}</span><span><strong>{attachment.filename}</strong><small>{attachment.size ? `${(attachment.size / 1024).toFixed(0)} КБ · скачать` : "Скачать файл"}</small></span></button>
    {error && <div className="attachment-error" role="alert">{error}</div>}
  </div>;
}

export function MediaImage({ messageId, attachment }: { messageId: string; attachment: Attachment }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <button type="button" className="media-image-error" onClick={() => setFailed(false)} aria-label={`Повторить загрузку ${attachment.filename}`}><ImageOff size={22}/><span>Не удалось загрузить<br/>Повторить</span></button>;
  return <a href={attachmentUrl(messageId, attachment.id, true)} target="_blank" rel="noreferrer" aria-label={`Открыть ${attachment.filename}`}><Image unoptimized width={220} height={220} src={attachmentUrl(messageId, attachment.id, true)} alt={attachment.filename} onError={() => setFailed(true)}/></a>;
}

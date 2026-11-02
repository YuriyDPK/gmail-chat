"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { prepareEmailDocument } from "@/lib/email-html";
import { referencesInlineImage, type Attachment } from "@/lib/mail-types";

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid image"));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function EmailBody({ id, html, attachments }: { id: string; html: string; attachments: Attachment[] }) {
  const [srcDoc, setSrcDoc] = useState("");
  const [height, setHeight] = useState(280);
  const [inlineFailed, setInlineFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const inline = useMemo(() => attachments.filter(a => referencesInlineImage(html, a.contentId) && /^image\/(jpeg|png|gif|webp|avif)$/i.test(a.mimeType)), [attachments, html]);

  useEffect(() => {
    const controller = new AbortController();
    async function render() {
      const images: Record<string, string> = {};
      // Render the message immediately while embedded images load separately.
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setSrcDoc(prepareEmailDocument(html, images));
      setInlineFailed(false);
      if (!inline.length) return;
      const results = await Promise.all(inline.map(async image => {
        try {
          const response = await fetch(`/api/mail/attachment?messageId=${encodeURIComponent(id)}&id=${encodeURIComponent(image.id)}&preview=1`, { signal: controller.signal });
          if (!response.ok) return false;
          const data = await toDataUrl(await response.blob());
          if (image.contentId) images[image.contentId.toLowerCase()] = data;
          return true;
        } catch { return false; }
      }));
      if (!controller.signal.aborted) { setInlineFailed(results.some(result => !result)); setSrcDoc(prepareEmailDocument(html, images)); }
    }
    void render();
    return () => controller.abort();
  }, [id, html, inline, retry]);

  useEffect(() => () => observer.current?.disconnect(), []);
  function frameLoaded() {
    const document = frame.current?.contentDocument;
    if (!document?.body) return;
    observer.current?.disconnect();
    const body = document.body;
    const iframe = frame.current!;
    let scale = 1;
    let previousWidth = 0;
    const measure = () => setHeight(Math.ceil(Math.max(100, body.scrollHeight * scale, body.getBoundingClientRect().height)));
    const fit = () => {
      const available = iframe.clientWidth;
      if (!available) return;
      previousWidth = available;
      body.style.zoom = "1";
      const natural = Math.max(available, body.scrollWidth, document.documentElement.scrollWidth);
      scale = Math.min(1, available / natural);
      body.style.zoom = String(scale);
      measure();
    };
    fit();
    observer.current = new ResizeObserver(() => { if (iframe.clientWidth !== previousWidth) fit(); else measure(); });
    observer.current.observe(body);
    observer.current.observe(iframe);
    for (const image of document.images) image.addEventListener("load", fit, { once: true });
  }
  return <div className="email-body">
    {inlineFailed && <div className="inline-image-error" role="alert">Не удалось загрузить некоторые встроенные изображения. <button type="button" onClick={() => setRetry(value => value + 1)}>Повторить</button></div>}
    {srcDoc ? <iframe ref={frame} className="email-frame" title="Содержимое письма" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={srcDoc} onLoad={frameLoaded} style={{ height }}/> : <div className="email-loading">Загружаем письмо…</div>}
  </div>;
}

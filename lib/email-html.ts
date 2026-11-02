import DOMPurify from "dompurify";

/** Build an isolated document; call only in the browser. */
export function prepareEmailDocument(html: string, inlineImages: Record<string, string>): string {
  const sanitized = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ["script", "iframe", "frame", "frameset", "object", "embed", "form", "input", "button", "textarea", "select", "base", "meta", "link", "audio", "video", "source", "svg", "math"],
    FORBID_ATTR: ["srcset", "formaction"],
  });
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  const safeData = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;
  function resolveCid(src: string) {
    let id = src.replace(/^cid:/i, "").replace(/^<|>$/g, "");
    try { id = decodeURIComponent(id); } catch { /* Keep the original Content-ID. */ }
    const data = inlineImages[id.toLowerCase()];
    return data && safeData.test(data) ? data : "";
  }
  function resolveCssImages(css: string) {
    return css.replace(/url\(\s*(["']?)cid:([^"'\)\s]+)\1\s*\)/gi, (_match, _quote, id: string) => {
      const data = resolveCid(id);
      return data ? `url("${data}")` : "none";
    });
  }
  for (const image of document.querySelectorAll("img")) {
    const src = image.getAttribute("src")?.trim() || "";
    if (/^cid:/i.test(src)) {
      const data = resolveCid(src);
      if (data) image.setAttribute("src", data); else image.removeAttribute("src");
    } else if (src.startsWith("//")) {
      image.setAttribute("src", `https:${src}`);
    } else if (!/^https?:\/\//i.test(src) && !safeData.test(src)) {
      image.removeAttribute("src");
    }
    image.setAttribute("referrerpolicy", "no-referrer");
  }
  for (const element of document.querySelectorAll("[background]")) {
    const background = element.getAttribute("background")?.trim() || "";
    if (/^cid:/i.test(background)) {
      const data = resolveCid(background);
      if (data) element.setAttribute("background", data); else element.removeAttribute("background");
    } else if (background.startsWith("//")) element.setAttribute("background", `https:${background}`);
    else if (!/^https?:\/\//i.test(background) && !safeData.test(background)) element.removeAttribute("background");
  }
  for (const element of document.querySelectorAll("[style]")) element.setAttribute("style", resolveCssImages(element.getAttribute("style") || ""));
  for (const style of document.querySelectorAll("style")) style.textContent = resolveCssImages(style.textContent || "");
  for (const link of document.querySelectorAll("a")) {
    const href = link.getAttribute("href")?.trim() || "";
    if (!/^(?:https?:\/\/|mailto:)/i.test(href)) link.removeAttribute("href");
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  const referrer = document.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  const styles = document.createElement("style");
  styles.textContent = "html,body{margin:0;padding:0}body{overflow-wrap:anywhere;color:#202d3a;background:#fff;font-family:Arial,sans-serif}img{max-width:100%;height:auto}table{max-width:100%}";
  document.head.prepend(csp, referrer, styles);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

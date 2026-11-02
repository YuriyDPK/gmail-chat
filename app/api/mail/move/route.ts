import { checkOrigin, errorResponse, gmailFor, invalidateCachedMessages, parseMessage } from "@/lib/gmail";

// Actions are scoped to messages, because a Gmail thread can contain messages
// with different labels and a contact can participate in several threads.
export async function POST(request: Request) {
  if (!checkOrigin(request)) return new Response("Forbidden", { status: 403 });
  try {
    const { email, action, folder } = await request.json();
    if (typeof email !== "string" || /[{}()\[\]:]/.test(email) || !/^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/.test(email) || email.length > 254 || !["all", "archive", "spam"].includes(folder) || !["archive", "spam", "inbox"].includes(action) || (action === "inbox" && folder === "all") || (action === "archive" && folder !== "all") || (action === "spam" && folder === "spam")) {
      return Response.json({ error: "Некорректное действие." }, { status: 400 });
    }
    const gmail = await gmailFor(request);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const ownEmail = profile.data.emailAddress;
    if (!ownEmail) throw new Error("Missing Gmail account address");
    const scope = action === "archive" ? "in:inbox -in:spam -in:trash -in:drafts" : action === "spam" ? "-in:spam -in:trash -in:drafts" : folder === "spam" ? "in:spam -in:trash -in:drafts" : "-in:inbox -in:sent -in:spam -in:trash -in:drafts";
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await gmail.users.messages.list({ userId: "me", maxResults: 500, pageToken, includeSpamTrash: folder === "spam", q: `{from:${email} to:${email}} ${scope}` });
      ids.push(...(page.data.messages || []).map(message => message.id).filter((id): id is string => !!id));
      pageToken = page.data.nextPageToken || undefined;
    } while (pageToken);
    const matching: string[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      const batch = await Promise.all(ids.slice(i, i + 10).map(async id => {
        try {
          const result = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "To"] });
          const message = parseMessage(result.data, ownEmail);
          return message.contactEmail === email.toLowerCase() && (action !== "spam" || !message.outgoing) ? id : null;
        } catch (error: unknown) { if ((error as { code?: number }).code === 404) return null; throw error; }
      }));
      matching.push(...batch.filter((id): id is string => !!id));
    }
    const addLabelIds = action === "spam" ? ["SPAM"] : action === "inbox" ? ["INBOX"] : [];
    const removeLabelIds = action === "archive" || action === "spam" ? ["INBOX"] : folder === "spam" ? ["SPAM"] : [];
    let moved = 0;
    for (let i = 0; i < matching.length; i += 1000) {
      const ids = matching.slice(i, i + 1000);
      try { await gmail.users.messages.batchModify({ userId: "me", requestBody: { ids, addLabelIds, removeLabelIds } }); invalidateCachedMessages(gmail, ids); moved += ids.length; }
      catch { return Response.json({ error: `Не все письма удалось переместить. Перемещено: ${moved}. Повторите попытку.` }, { status: 502 }); }
    }
    return Response.json({ moved });
  } catch (error) { return errorResponse(error); }
}

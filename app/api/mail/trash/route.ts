import { checkOrigin, errorResponse, gmailFor, invalidateCachedMessages, parseMessage } from "@/lib/gmail";

export async function POST(request: Request) {
  if (!checkOrigin(request)) return new Response("Forbidden", { status: 403 });
  try {
    const { email, folder = "all" } = await request.json();
    if (typeof email !== "string" || /[{}()\[\]:]/.test(email) || !/^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/.test(email) || email.length > 254) {
      return Response.json({ error: "Некорректный адрес контакта." }, { status: 400 });
    }
    if (folder !== "all" && folder !== "archive" && folder !== "spam") return new Response("Invalid folder", { status: 400 });
    const gmail = await gmailFor(request);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const ownEmail = profile.data.emailAddress || "";
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await gmail.users.messages.list({ userId: "me", maxResults: 500, pageToken, q: `{from:${email} to:${email}} ${folder === "spam" ? "in:spam -in:trash -in:drafts" : "-in:trash -in:spam -in:drafts"}`, includeSpamTrash: folder === "spam" });
      ids.push(...(page.data.messages || []).map(m => m.id).filter((id): id is string => !!id));
      pageToken = page.data.nextPageToken || undefined;
    } while (pageToken);
    // Gmail search can match more addresses than the current chat. Verify every
    // message against the same contact grouping used by the chat list.
    const matched: string[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      const batch = await Promise.all(ids.slice(i, i + 10).map(async id => {
        try {
          const message = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "To"] });
          return parseMessage(message.data, ownEmail).contactEmail === email.toLowerCase() ? id : null;
        } catch (error: unknown) { if ((error as { code?: number }).code === 404) return null; throw error; }
      }));
      matched.push(...batch.filter((id): id is string => !!id));
    }
    let deleted = 0;
    for (let i = 0; i < matched.length; i += 10) {
      const results = await Promise.allSettled(matched.slice(i, i + 10).map(id => gmail.users.messages.trash({ userId: "me", id })));
      const successful = matched.slice(i, i + 10).filter((_, index) => results[index].status === "fulfilled");
      invalidateCachedMessages(gmail, successful);
      deleted += successful.length;
      if (results.some(result => result.status === "rejected")) {
        return Response.json({ error: `Не все письма удалось переместить в корзину. Перемещено: ${deleted}. Обновите список и повторите попытку.` }, { status: 502 });
      }
    }
    return Response.json({ deleted });
  } catch (error) { return errorResponse(error); }
}

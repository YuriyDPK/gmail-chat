import { checkOrigin, errorResponse, getMessageMetadata, gmailFor, parseMessage } from "@/lib/gmail";

export async function POST(request: Request) {
  if (!checkOrigin(request)) return new Response("Forbidden", { status: 403 });
  try {
    const { emails, folder, history = false } = await request.json();
    if (!Array.isArray(emails) || emails.length > 50 || !emails.every(email => typeof email === "string" && email.length <= 254 && !/[{}()\[\]:]/.test(email) && /^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/.test(email)) || !["all", "archive", "spam"].includes(folder) || typeof history !== "boolean" || (history && emails.length !== 1)) return new Response("Invalid contacts", { status: 400 });
    const gmail = await gmailFor(request);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const ownEmail = profile.data.emailAddress || "";
    const scope = folder === "spam" ? "in:spam -in:trash -in:drafts" : folder === "archive" ? "-in:inbox -in:sent -in:trash -in:spam -in:drafts" : "-in:trash -in:spam -in:drafts";
    const groups = await Promise.all([...new Set<string>(emails)].map(async email => {
      const found = [];
      let pageToken: string | undefined;
      let pages = 0;
      do {
        const list = await gmail.users.messages.list({ userId: "me", maxResults: history ? 50 : 20, pageToken, includeSpamTrash: folder === "spam", q: `{from:${email} to:${email}} ${scope}` });
        const refs = list.data.messages || [];
        const batchSize = history ? 10 : 1;
        for (let i = 0; i < refs.length && found.length < (history ? 20 : 1); i += batchSize) {
          const batch = await Promise.all(refs.slice(i, i + batchSize).map(async ref => {
            if (!ref.id) return null;
            try { const message = parseMessage(await getMessageMetadata(gmail, ref.id), ownEmail); return message.contactEmail === email.toLowerCase() ? message : null; }
            catch (error: unknown) { if ((error as { code?: number }).code === 404) return null; throw error; }
          }));
          found.push(...batch.filter((message): message is NonNullable<typeof message> => !!message));
        }
        pageToken = list.data.nextPageToken || undefined;
        pages++;
      } while (pageToken && found.length < (history ? 20 : 1) && pages < 3);
      return found.slice(0, history ? 20 : 1);
    }));
    return Response.json({ messages: groups.flat() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

import { connection } from "next/server";
import { errorResponse, getMessageMetadata, gmailFor, parseMessage } from "@/lib/gmail";

export async function GET(request: Request) {
  await connection();
  try {
    const url = new URL(request.url);
    const email = (url.searchParams.get("email") || "").toLowerCase();
    const folder = url.searchParams.get("folder") || "all";
    if (email.length > 254 || /[{}()\[\]:]/.test(email) || !/^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/.test(email) || !["all", "archive", "spam"].includes(folder)) return new Response("Invalid contact", { status: 400 });
    const gmail = await gmailFor(request);
    const scope = folder === "spam" ? "in:spam -in:trash -in:drafts" : folder === "archive" ? "-in:inbox -in:sent -in:trash -in:spam -in:drafts" : "-in:trash -in:spam -in:drafts";
    const [profile, list] = await Promise.all([
      gmail.users.getProfile({ userId: "me" }),
      gmail.users.messages.list({ userId: "me", maxResults: 20, pageToken: url.searchParams.get("pageToken") || undefined, includeSpamTrash: folder === "spam", q: `{from:${email} to:${email}} ${scope}` }),
    ]);
    const ownEmail = profile.data.emailAddress || "";
    const refs = list.data.messages || [];
    const messages = [];
    for (let i = 0; i < refs.length; i += 10) {
      const batch = await Promise.all(refs.slice(i, i + 10).map(async ref => {
        if (!ref.id) return null;
        try { const message = parseMessage(await getMessageMetadata(gmail, ref.id), ownEmail); return message.contactEmail === email ? message : null; }
        catch (error: unknown) { if ((error as { code?: number }).code === 404) return null; throw error; }
      }));
      messages.push(...batch.filter((message): message is NonNullable<typeof message> => !!message));
    }
    return Response.json({ messages, email: ownEmail, nextPageToken: list.data.nextPageToken || undefined }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

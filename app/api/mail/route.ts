import { connection } from "next/server";
import { gmailFor, errorResponse, getMessageMetadata, parseMessage } from "@/lib/gmail";
export async function GET(request: Request) {
  await connection();
  try {
    const gmail = await gmailFor(request);
    const url = new URL(request.url);
    const folder = url.searchParams.get("folder") || "all";
    if (!["all", "archive", "spam"].includes(folder)) return Response.json({ error: "Неизвестный раздел." }, { status: 400 });
    const search = (url.searchParams.get("q") || "").trim();
    const limit = url.searchParams.get("limit") || "50";
    if (limit !== "20" && limit !== "50") return new Response("Invalid limit", { status: 400 });
    if (search.length > 200 || /[\x00-\x1f\x7f]/.test(search)) return Response.json({ error: "Слишком длинный или некорректный запрос." }, { status: 400 });
    const scope = folder === "spam" ? "in:spam -in:trash -in:drafts" : folder === "archive" ? "-in:inbox -in:sent -in:trash -in:spam -in:drafts" : "-in:trash -in:spam -in:drafts";
    const q = search ? `${scope} ${search}` : scope;
    const [profile, list] = await Promise.all([
      gmail.users.getProfile({ userId: "me" }),
      gmail.users.messages.list({ userId: "me", maxResults: Number(limit), pageToken: url.searchParams.get("pageToken") || undefined, q, includeSpamTrash: folder === "spam" }),
    ]);
    const email = profile.data.emailAddress || "";
    const refs = list.data.messages || [];
    const messages = [];
    for (let i = 0; i < refs.length; i += 10) {
      const batch = await Promise.all(refs.slice(i, i + 10).map(async ref => {
        try { const message = await getMessageMetadata(gmail, ref.id!); return parseMessage(message, email); }
        catch (error: unknown) { if ((error as { code?: number }).code === 404) return null; throw error; }
      }));
      messages.push(...batch.filter((message): message is NonNullable<typeof message> => !!message));
    }
    return Response.json({ messages, email, nextPageToken: list.data.nextPageToken || undefined }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

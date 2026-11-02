import { checkOrigin, errorResponse, getFullMessage, gmailFor, parseMessage } from "@/lib/gmail";

export async function POST(request: Request) {
  if (!checkOrigin(request)) return new Response("Forbidden", { status: 403 });
  try {
    const { ids } = await request.json();
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every(id => typeof id === "string" && /^[\w-]+$/.test(id))) return new Response("Invalid messages", { status: 400 });
    const gmail = await gmailFor(request);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress || "";
    const messages = [];
    const unique = [...new Set<string>(ids)];
    for (let i = 0; i < unique.length; i += 10) {
      const batch = await Promise.all(unique.slice(i, i + 10).map(async id => {
        try { return parseMessage(await getFullMessage(gmail, id), email); }
        catch (error: unknown) { if ((error as { code?: number }).code === 404) return null; throw error; }
      }));
      messages.push(...batch.filter((message): message is NonNullable<typeof message> => !!message));
    }
    return Response.json({ messages }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

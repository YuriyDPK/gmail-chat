import { checkOrigin, errorResponse, gmailFor, invalidateCachedMessages } from "@/lib/gmail";
export async function POST(request: Request) {
  if (!checkOrigin(request)) return new Response("Forbidden", { status: 403 });
  try {
    const { ids } = await request.json();
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every(id => typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id))) return new Response("Invalid messages", { status: 400 });
    if (ids.length) { const gmail = await gmailFor(request); await gmail.users.messages.batchModify({ userId: "me", requestBody: { ids, removeLabelIds: ["UNREAD"] } }); invalidateCachedMessages(gmail, ids); }
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}

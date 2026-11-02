export type Attachment = { id: string; filename: string; mimeType: string; size: number; contentId?: string };
export type MailMessage = { id: string; threadId: string; from: string; fromName: string; to: string; subject: string; date: number; text: string; html?: string; snippet: string; outgoing: boolean; unread: boolean; messageId: string; references: string; attachments: Attachment[]; contactEmail: string; contactName: string };
export type MailPage = { messages: MailMessage[]; nextPageToken?: string; email: string };

export function referencesInlineImage(html: string, contentId?: string) {
  if (!contentId) return false;
  const source = html.toLowerCase();
  return source.includes(`cid:${contentId.toLowerCase()}`) || source.includes(`cid:${encodeURIComponent(contentId).toLowerCase()}`);
}

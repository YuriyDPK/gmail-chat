import type { MailMessage } from "@/lib/mail-types";

export type OutboxItem = {
  clientId: string;
  account: string;
  email: string;
  name: string;
  subject: string;
  text: string;
  files: File[];
  date: number;
  threadId: string;
  messageId: string;
  references: string;
  status: "sending" | "sent" | "failed";
  sentId?: string;
  sentThreadId?: string;
  error?: string;
};

export function createOutboxIdentity() {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  return { clientId: `pending-${random}`, date: Date.now() };
}

export function outboxMessage(item: OutboxItem): MailMessage {
  return {
    id: item.sentId || item.clientId,
    threadId: item.sentThreadId || item.threadId || item.clientId,
    from: item.account,
    fromName: item.account,
    to: item.email,
    subject: item.subject,
    date: item.date,
    text: item.text,
    snippet: item.text || (item.files.length ? `Вложение: ${item.files.map(file => file.name).join(", ")}` : ""),
    outgoing: true,
    unread: false,
    messageId: "",
    references: "",
    attachments: [],
    contactEmail: item.email,
    contactName: item.name,
  };
}

export function mergeOutbox(messages: MailMessage[], outbox: OutboxItem[]): MailMessage[] {
  const ids = new Set(messages.map(message => message.id));
  const pending = outbox.map(outboxMessage).filter(message => !ids.has(message.id));
  return [...messages, ...pending];
}

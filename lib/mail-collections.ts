import type { MailMessage, MailPage } from "@/lib/mail-types";

function pagesWithLatest(pages: MailPage[], latest?: MailPage): MailMessage[] {
  if (!pages.length) return [];
  return [...(latest || pages[0]).messages, ...pages.slice(1).flatMap(page => page.messages)];
}

/** Keep recent mail and archived mail together without duplicating messages. */
export function combineMailboxPages(pages: MailPage[], latest?: MailPage, archivePages: MailPage[] = [], archiveLatest?: MailPage): MailMessage[] {
  const seen = new Set<string>();
  return [...pagesWithLatest(pages, latest), ...pagesWithLatest(archivePages, archiveLatest)].filter(message => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

/** Keep a selected search match visible even when it predates the recent window. */
export function visibleWithSearchMatches(messages: MailMessage[], limit: number, seeds: MailMessage[]): MailMessage[] {
  const recent = messages.slice(-limit);
  const recentIds = new Set(recent.map(message => message.id));
  const seedIds = new Set(seeds.map(message => message.id));
  return [...messages.filter(message => seedIds.has(message.id) && !recentIds.has(message.id)), ...recent];
}

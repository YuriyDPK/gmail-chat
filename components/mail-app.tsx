"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { EmailBody } from "@/components/email-body";
import { AttachmentCard, MediaImage, isPreviewImage } from "@/components/attachment-card";
import { SessionProvider, signIn, signOut, useSession } from "next-auth/react";
import { QueryClient, QueryClientProvider, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ArrowLeft, Check, ChevronDown, CircleAlert, Image as ImageIcon, Inbox, LoaderCircle, LogOut, Mail, Menu, MessageCircle, Moon, MoreVertical, PanelLeftClose, PanelLeftOpen, Paperclip, PenLine, Pin, PinOff, RefreshCw, Search, Send, ShieldAlert, Sun, Trash2, X } from "lucide-react";
import { referencesInlineImage, type MailMessage, type MailPage } from "@/lib/mail-types";
import { createOutboxIdentity, mergeOutbox, outboxMessage, type OutboxItem } from "@/lib/outbox";
import { combineMailboxPages, visibleWithSearchMatches } from "@/lib/mail-collections";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });
export function MailApp() { return <SessionProvider><QueryClientProvider client={queryClient}><App /></QueryClientProvider></SessionProvider>; }
const palette = ["#e79e79", "#8e9ed5", "#73b69f", "#d895a9", "#79aeca", "#b7a17c", "#a18ac4"];
function color(s: string) { let n = 0; for (const c of s) n = (n * 31 + c.charCodeAt(0)) >>> 0; return palette[n % palette.length]; }
function initials(name: string) { const parts = name.replace(/@.*/, "").trim().split(/[\s._-]+/).filter(Boolean); return (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || "?").slice(0, 2)).toUpperCase(); }
function Avatar({ name, small = false }: { name: string; small?: boolean }) { return <span className={`avatar ${small ? "avatar-small" : ""}`} style={{ background: color(name) }}>{initials(name)}</span>; }
function time(date: number) { return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(date); }
function listTime(date: number) { const d = new Date(date), now = new Date(); if (d.toDateString() === now.toDateString()) return time(date); if (now.getTime() - date < 6 * 86400000) return new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(date); return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(date); }
function day(date: number) { const d = new Date(date), now = new Date(), yesterday = new Date(); yesterday.setDate(now.getDate() - 1); if (d.toDateString() === now.toDateString()) return "Сегодня"; if (d.toDateString() === yesterday.toDateString()) return "Вчера"; return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }).format(date); }
class RequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function jsonRequest(url: string, init?: RequestInit) { const response = await fetch(url, init); if (!response.ok) { let message = "Что-то пошло не так. Попробуйте ещё раз."; try { message = (await response.json()).error || message; } catch {} throw new RequestError(message, response.status); } return response.json(); }

type Folder = "all" | "archive" | "spam";
const noMessages: MailMessage[] = [];
type Conversation = { email: string; name: string; messages: MailMessage[]; last: MailMessage; unread: number };
function subscribeTheme(callback: () => void) { window.addEventListener("gmail-chat-theme", callback); return () => window.removeEventListener("gmail-chat-theme", callback); }
function themeSnapshot() { const value = localStorage.getItem("gmail-chat-theme"); return value ? value === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches; }
function subscribePins(callback: () => void) { window.addEventListener("gmail-chat-pins", callback); window.addEventListener("storage", callback); return () => { window.removeEventListener("gmail-chat-pins", callback); window.removeEventListener("storage", callback); }; }
function validPin(email: string) { return email.length <= 254 && !/[{}()\[\]:]/.test(email) && /^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/.test(email); }
function pinSnapshot(key: string) { try { return key ? localStorage.getItem(key) || "[]" : "[]"; } catch { return "[]"; } }
function App() {
  const { data: session, status } = useSession();
  const query = useQueryClient();
  const [folder, setFolder] = useState<Folder>("all");
  const [moveError, setMoveError] = useState("");
  const [moveNotice, setMoveNotice] = useState("");
  const [moving, setMoving] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchSeedState, setSearchSeedState] = useState<{ account: string; folder: Folder; messages: MailMessage[] } | null>(null);
  const [thread, setThread] = useState("");
  const [messageLimit, setMessageLimit] = useState(20);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState("");
  const [readError, setReadError] = useState("");
  const [compose, setCompose] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [menu, setMenu] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ email: string; x: number; y: number } | null>(null);
  const [deleteChat, setDeleteChat] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaTab, setMediaTab] = useState<"images" | "files">("images");
  const dragDepth = useRef(0);
  const dark = useSyncExternalStore(subscribeTheme, themeSnapshot, () => false);
  const account = session?.user?.email?.toLowerCase() || "";
  const searchSeeds = searchSeedState?.account === account && searchSeedState.folder === folder ? searchSeedState.messages : noMessages;
  const pinKey = session?.user?.email ? `gmail-chat-pins:${session.user.email.toLowerCase()}` : "";
  const pinsRaw = useSyncExternalStore(subscribePins, () => pinSnapshot(pinKey), () => "[]");
  const pins = useMemo<string[]>(() => { try { const data = JSON.parse(pinsRaw); return Array.isArray(data) ? [...new Set<string>(data.filter((email): email is string => typeof email === "string" && validPin(email)).map((email: string) => email.toLowerCase()))].slice(0, 50) : []; } catch { return []; } }, [pinsRaw]);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  useEffect(() => { const timer = window.setTimeout(() => setSearchTerm(search.trim()), 300); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => {
    const preventFileNavigation = (event: globalThis.DragEvent) => { if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault(); };
    const endDrag = () => { dragDepth.current = 0; setDragging(false); };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    window.addEventListener("drop", endDrag);
    window.addEventListener("dragend", endDrag);
    return () => { window.removeEventListener("dragover", preventFileNavigation); window.removeEventListener("drop", preventFileNavigation); window.removeEventListener("drop", endDrag); window.removeEventListener("dragend", endDrag); };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, [menu]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOutside = (event: PointerEvent) => { if (!contextMenuRef.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", closeOutside); window.addEventListener("scroll", close, true); window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", closeOutside); window.removeEventListener("scroll", close, true); window.removeEventListener("keydown", escape); };
  }, [contextMenu]);
  const searchActive = !!search.trim();
  const searchReady = searchActive && searchTerm === search.trim();
  const mail = useInfiniteQuery({ queryKey: ["mail", session?.user?.email, folder], enabled: status === "authenticated", initialPageParam: "", queryFn: ({ pageParam, signal }) => jsonRequest(`/api/mail?folder=${folder}${pageParam ? `&pageToken=${encodeURIComponent(pageParam)}` : ""}`, { signal }) as Promise<MailPage>, getNextPageParam: last => last.nextPageToken, refetchOnWindowFocus: false, retry: (count, error) => !(error instanceof RequestError && error.status === 429) && count < 1 });
  const latestMail = useQuery({ queryKey: ["mail-latest", session?.user?.email, folder], enabled: status === "authenticated" && !!mail.data, queryFn: ({ signal }) => jsonRequest(`/api/mail?folder=${folder}`, { signal }) as Promise<MailPage>, staleTime: 60000, refetchInterval: 60000, retry: (count, error) => !(error instanceof RequestError && error.status === 429) && count < 1 });
  const archiveMail = useInfiniteQuery({ queryKey: ["mail", session?.user?.email, "archive"], enabled: status === "authenticated" && folder === "all" && !searchActive, initialPageParam: "", queryFn: ({ pageParam, signal }) => jsonRequest(`/api/mail?folder=archive&limit=20${pageParam ? `&pageToken=${encodeURIComponent(pageParam)}` : ""}`, { signal }) as Promise<MailPage>, getNextPageParam: last => last.nextPageToken, refetchOnWindowFocus: false, retry: (count, error) => !(error instanceof RequestError && error.status === 429) && count < 1 });
  const archiveLatest = useQuery({ queryKey: ["mail-latest", session?.user?.email, "archive"], enabled: status === "authenticated" && folder === "all" && !searchActive && !!archiveMail.data, queryFn: ({ signal }) => jsonRequest("/api/mail?folder=archive&limit=20", { signal }) as Promise<MailPage>, staleTime: 60000, refetchInterval: 60000, retry: (count, error) => !(error instanceof RequestError && error.status === 429) && count < 1 });
  const searchMail = useInfiniteQuery({ queryKey: ["mail-search", session?.user?.email, folder, searchTerm], enabled: status === "authenticated" && searchReady, initialPageParam: "", queryFn: ({ pageParam, signal }) => jsonRequest(`/api/mail?folder=${folder}&q=${encodeURIComponent(searchTerm)}${pageParam ? `&pageToken=${encodeURIComponent(pageParam)}` : ""}`, { signal }) as Promise<MailPage>, getNextPageParam: last => last.nextPageToken, staleTime: 30000, refetchOnWindowFocus: false, retry: (count, error) => !(error instanceof RequestError && error.status === 429) && count < 1 });
  useEffect(() => {
    if (!latestMail.data) return;
    query.setQueryData(["mail", session?.user?.email, folder], (old: { pages: MailPage[]; pageParams: unknown[] } | undefined) => old?.pages.length === 1 && old.pages[0] !== latestMail.data ? { ...old, pages: [latestMail.data] } : old);
  }, [latestMail.data, query, session?.user?.email, folder]);
  useEffect(() => {
    if (folder !== "all" || !archiveLatest.data) return;
    query.setQueryData(["mail", session?.user?.email, "archive"], (old: { pages: MailPage[]; pageParams: unknown[] } | undefined) => old?.pages.length === 1 && old.pages[0] !== archiveLatest.data ? { ...old, pages: [archiveLatest.data] } : old);
  }, [archiveLatest.data, query, session?.user?.email, folder]);
  const loadedMessages = useMemo(() => {
    if (searchActive) return searchReady ? searchMail.data?.pages.flatMap(page => page.messages) || [] : [];
    return combineMailboxPages(mail.data?.pages || [], latestMail.data, folder === "all" ? archiveMail.data?.pages : undefined, folder === "all" ? archiveLatest.data : undefined);
  }, [searchActive, searchReady, searchMail.data, mail.data, latestMail.data, folder, archiveMail.data, archiveLatest.data]);
  const missingPins = useMemo(() => { const loaded = new Set(loadedMessages.map(message => message.contactEmail)); return pins.filter(email => !loaded.has(email)); }, [loadedMessages, pins]);
  const pinnedMail = useQuery({ queryKey: ["pinned-mail", session?.user?.email, folder, missingPins], enabled: status === "authenticated" && !searchActive && !!(mail.data || (folder === "all" && archiveMail.data)) && missingPins.length > 0, queryFn: ({ signal }) => jsonRequest("/api/mail/pins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emails: missingPins, folder }), signal }) as Promise<{ messages: MailMessage[] }>, refetchInterval: 60000, retry: (count, error) => !(error instanceof RequestError && error.status === 429) && count < 1 });
  const contactHistory = useInfiniteQuery({ queryKey: ["contact-history", session?.user?.email, folder, selected], enabled: status === "authenticated" && !searchActive && !!selected && validPin(selected), initialPageParam: "", queryFn: ({ pageParam, signal }) => jsonRequest(`/api/mail/contact?folder=${folder}&email=${encodeURIComponent(selected || "")}${pageParam ? `&pageToken=${encodeURIComponent(pageParam)}` : ""}`, { signal }) as Promise<MailPage>, getNextPageParam: last => last.nextPageToken, staleTime: 120000, refetchOnWindowFocus: false, retry: (count, error) => !(error instanceof RequestError && error.status === 429) && count < 1 });
  const serverMessages = useMemo(() => searchActive ? loadedMessages : [...loadedMessages, ...(pinnedMail.data?.messages || []), ...(contactHistory.data?.pages.flatMap(page => page.messages) || []), ...searchSeeds.filter(message => message.contactEmail === selected)], [searchActive, loadedMessages, pinnedMail.data, contactHistory.data, searchSeeds, selected]);
  // Contact search results disappear when another chat is opened; only the mailbox list confirms durable reconciliation.
  const mailboxIds = useMemo(() => new Set(loadedMessages.map(message => message.id)), [loadedMessages]);
  const visibleOutbox = useMemo(() => folder === "all" && !searchActive ? outbox.filter(item => item.account === account) : [], [outbox, account, folder, searchActive]);
  const outboxById = new Map(visibleOutbox.map(item => [item.sentId || item.clientId, item]));
  const unindexedSent = visibleOutbox.some(item => item.status === "sent" && item.sentId && !mailboxIds.has(item.sentId));
  const refreshLatest = latestMail.refetch;
  useEffect(() => {
    if (!unindexedSent || !mail.data || status !== "authenticated") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const delays = [1500, 3000, 6000, 12000, 30000, 60000];
    const schedule = () => { timer = setTimeout(async () => { const result = await refreshLatest({ cancelRefetch: false }); if (cancelled) return; attempt = result.error instanceof RequestError && result.error.status === 429 ? delays.length - 1 : Math.min(attempt + 1, delays.length - 1); schedule(); }, delays[attempt]); };
    schedule();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [unindexedSent, mail.data, status, refreshLatest]);
  const conversations = useMemo(() => {
    const groups = new Map<string, Conversation>();
    const seen = new Set<string>();
    for (const message of mergeOutbox(serverMessages, visibleOutbox)) {
      if (!message.contactEmail || seen.has(message.id)) continue;
      seen.add(message.id);
      let group = groups.get(message.contactEmail);
      if (!group) { group = { email: message.contactEmail, name: message.contactName, messages: [], last: message, unread: 0 }; groups.set(message.contactEmail, group); }
      group.messages.push(message); if (message.unread) group.unread++;
      if (message.date > group.last.date) { group.last = message; if (message.contactName !== message.contactEmail) group.name = message.contactName; }
      if (group.name === group.email && message.contactName !== message.contactEmail) group.name = message.contactName;
    }
    return [...groups.values()].map(g => ({ ...g, messages: g.messages.sort((a, b) => a.date - b.date) })).sort((a, b) => { const ai = pins.indexOf(a.email), bi = pins.indexOf(b.email); return ai >= 0 && bi >= 0 ? ai - bi : ai >= 0 ? -1 : bi >= 0 ? 1 : b.last.date - a.last.date; });
  }, [serverMessages, visibleOutbox, pins]);
  const active = conversations.find(c => c.email === selected);
  const filtered = conversations;
  const matchingMessages = (active?.messages || []).filter(m => !thread || m.threadId === thread);
  const visibleMessages = visibleWithSearchMatches(matchingMessages, messageLimit, searchSeeds);
  const activeIds = visibleMessages.filter(m => !outboxById.has(m.id) || !!outboxById.get(m.id)?.sentId).map(m => m.id);
  const details = useQuery<MailMessage[]>({ queryKey: ["mail-details", session?.user?.email, active?.email, activeIds], enabled: status === "authenticated" && activeIds.length > 0, staleTime: 120000, refetchOnWindowFocus: false, refetchInterval: current => { if (current.state.error instanceof RequestError && current.state.error.status === 429) return false; const loaded = new Set((current.state.data || []).map(message => message.id)); return activeIds.some(id => outboxById.get(id)?.status === "sent" && !loaded.has(id)) ? 5000 : false; }, placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === session?.user?.email && previousQuery?.queryKey[2] === active?.email ? previous : undefined, retry: (count, error) => !(error instanceof RequestError && error.status === 429) && count < 1, queryFn: async ({ signal }) => { const messages: MailMessage[] = []; for (let i = 0; i < activeIds.length; i += 100) { const page: { messages: MailMessage[] } = await jsonRequest("/api/mail/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: activeIds.slice(i, i + 100) }), signal }); messages.push(...page.messages); } return messages; } });
  const detailMap = new Map((details.data || []).map(m => [m.id, m]));
  const displayedMessages = visibleMessages.map(m => { const full = detailMap.get(m.id); const pending = outboxById.get(m.id); return full ? { ...full, unread: m.unread } : pending ? outboxMessage(pending) : m; });
  const shown = displayedMessages;
  const latest = shown[shown.length - 1];
  const focusedSearch = searchSeeds.find(message => shown.some(item => item.id === message.id));
  const replyTarget = focusedSearch ? detailMap.get(focusedSearch.id) : [...shown].reverse().find(message => detailMap.has(message.id));
  const replyReady = !!replyTarget;
  const filesInChat = displayedMessages.flatMap(m => m.attachments.map(attachment => ({ messageId: m.id, attachment })));
  const media = filesInChat.filter(({ attachment }) => isPreviewImage(attachment.mimeType));
  const reconciled = visibleOutbox.filter(item => item.sentId && mailboxIds.has(item.sentId) && detailMap.has(item.sentId)).map(item => item.clientId).join(",");
  useEffect(() => { if (!reconciled) return; let active = true; queueMicrotask(() => { if (active) { const ids = new Set(reconciled.split(",")); setOutbox(items => items.filter(item => !ids.has(item.clientId))); } }); return () => { active = false; }; }, [reconciled]);
  const listLoading = searchActive ? !searchReady || searchMail.isLoading : (mail.isLoading && !(folder === "all" && archiveMail.data)) || (folder === "all" && !filtered.length && archiveMail.isLoading);
  const listError = searchActive ? (searchMail.isError && !searchMail.data ? searchMail.error : null) : (mail.isError && !mail.data && !(folder === "all" && archiveMail.data) ? mail.error : null);
  const listHasNext = searchActive ? searchReady && !!searchMail.hasNextPage : !!mail.hasNextPage || (folder === "all" && !!archiveMail.hasNextPage);
  const listFetchingNext = searchActive ? searchMail.isFetchingNextPage : mail.isFetchingNextPage || (folder === "all" && archiveMail.isFetchingNextPage);
  function loadMoreList() {
    if (searchActive) { if (searchMail.hasNextPage) void searchMail.fetchNextPage(); return; }
    if (mail.hasNextPage) void mail.fetchNextPage();
    if (folder === "all" && archiveMail.hasNextPage) void archiveMail.fetchNextPage();
  }
  const threadOptions = active ? [...new Map([...active.messages].reverse().map(m => [m.threadId, m.subject])).entries()] : [];
  const focusMessageId = searchSeeds.find(message => shown.some(item => item.id === message.id))?.id;
  useEffect(() => { if (focusMessageId) document.getElementById(`message-${focusMessageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); else bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [selected, thread, latest?.id, focusMessageId]);
  useEffect(() => {
    if (!active || searchActive) return;
    const ids = active.messages.filter(m => m.unread && (!thread || m.threadId === thread)).map(m => m.id);
    if (!ids.length) return;
    let cancelled = false;
    const markRead = async () => { for (let i = 0; i < ids.length; i += 500) await jsonRequest("/api/mail/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids.slice(i, i + 500) }) }); };
    markRead().then(() => { if (!cancelled) {
      setReadError("");
      const mark = (message: MailMessage) => ids.includes(message.id) ? { ...message, unread: false } : message;
      query.setQueriesData({ queryKey: ["mail", session?.user?.email] }, (old: { pages: MailPage[]; pageParams: unknown[] } | undefined) => old && ({ ...old, pages: old.pages.map(page => ({ ...page, messages: page.messages.map(mark) })) }));
      query.setQueriesData({ queryKey: ["mail-latest", session?.user?.email] }, (old: MailPage | undefined) => old && ({ ...old, messages: old.messages.map(mark) }));
      query.setQueriesData({ queryKey: ["mail-search", session?.user?.email] }, (old: { pages: MailPage[]; pageParams: unknown[] } | undefined) => old && ({ ...old, pages: old.pages.map(page => ({ ...page, messages: page.messages.map(mark) })) }));
      query.setQueriesData({ queryKey: ["contact-history", session?.user?.email] }, (old: { pages: MailPage[]; pageParams: unknown[] } | undefined) => old && ({ ...old, pages: old.pages.map(page => ({ ...page, messages: page.messages.map(mark) })) }));
      query.setQueriesData({ queryKey: ["pinned-mail", session?.user?.email] }, (old: { messages: MailMessage[] } | undefined) => old && ({ ...old, messages: old.messages.map(mark) }));
      setSearchSeedState(current => current && current.account === account && current.messages.some(message => message.unread && ids.includes(message.id)) ? { ...current, messages: current.messages.map(mark) } : current);
    } }).catch(() => { if (!cancelled) setReadError("Не удалось отметить письма прочитанными."); });
    return () => { cancelled = true; };
  }, [active, thread, query, session?.user?.email, account, searchActive]);
  function togglePin(email: string) {
    if (!pinKey) return;
    if (!validPin(email)) { setMoveError("Не удалось закрепить чат: некорректный адрес контакта."); setContextMenu(null); return; }
    const next = pins.includes(email) ? pins.filter(item => item !== email) : [email, ...pins];
    if (next.length > 50) { setMoveError("Можно закрепить до 50 чатов."); setContextMenu(null); return; }
    try { localStorage.setItem(pinKey, JSON.stringify(next)); window.dispatchEvent(new Event("gmail-chat-pins")); setMoveError(""); }
    catch { setMoveError("Не удалось сохранить закрепление в браузере."); }
    setContextMenu(null);
  }
  function choose(email: string) { const found = searchActive ? (searchMail.data?.pages.flatMap(page => page.messages).filter(message => message.contactEmail === email).slice(0, 20) || []) : []; setSearchSeedState(found.length ? { account, folder, messages: found } : null); if (searchActive) { setSearch(""); setSearchTerm(""); } setMediaOpen(false); setSelected(email); setThread(""); setMessageLimit(20); setCompose(false); setDraft(""); setFiles([]); setSendError(""); setReadError(""); }
  function changeFolder(next: Folder) { setFolder(next); setSelected(null); setCompose(false); setThread(""); setMessageLimit(20); setDraft(""); setFiles([]); setSearch(""); setSearchTerm(""); setSearchSeedState(null); setMoveError(""); setMoveNotice(""); setContextMenu(null); }
  async function moveChat(email: string, action: "archive" | "spam" | "inbox") {
    if (moving) return;
    setMoving(true); setMoveError(""); setMoveNotice(""); setContextMenu(null);
    try {
      const result: { moved: number } = await jsonRequest("/api/mail/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, action, folder }) });
      if (!result.moved) { setMoveNotice("Подходящих писем для перемещения нет."); return; }
      setMoveNotice(action === "archive" ? `В архиве: ${result.moved}. Они также видны в разделе «Все».` : `Перемещено писем: ${result.moved}.`);
      if (selected === email) { setSelected(null); setThread(""); setMediaOpen(false); }
      setSearchSeedState(current => current?.messages.some(message => message.contactEmail === email) ? null : current);
      await Promise.all([query.resetQueries({ queryKey: ["mail"] }), query.invalidateQueries({ queryKey: ["pinned-mail"] }), query.invalidateQueries({ queryKey: ["contact-history"] }), query.invalidateQueries({ queryKey: ["mail-latest"] })]);
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : "Не удалось переместить письма.");
      await Promise.all([query.invalidateQueries({ queryKey: ["mail"] }), query.invalidateQueries({ queryKey: ["pinned-mail"] }), query.invalidateQueries({ queryKey: ["contact-history"] }), query.invalidateQueries({ queryKey: ["mail-latest"] })]);
    } finally { setMoving(false); }
  }
  function toggleTheme() { const next = !dark; localStorage.setItem("gmail-chat-theme", next ? "dark" : "light"); window.dispatchEvent(new Event("gmail-chat-theme")); setMenu(false); }
  function addFiles(incoming: File[]) {
    const next = [...files, ...incoming];
    if (next.reduce((sum, file) => sum + file.size, 0) > 15 * 1024 * 1024) { setSendError("Общий размер вложений не должен превышать 15 МиБ."); return; }
    setSendError(""); setFiles(next);
  }
  function dragEnter(event: DragEvent<HTMLElement>) {
    if (!Array.from(event.dataTransfer.types).includes("Files") || (!active && !compose)) return;
    event.preventDefault(); dragDepth.current += 1; setDragging(true);
  }
  function dragLeave(event: DragEvent<HTMLElement>) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false);
  }
  function dropFiles(event: DragEvent<HTMLElement>) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    if (active || compose) addFiles(Array.from(event.dataTransfer.files));
  }
  async function trashChat() {
    if (!deleteChat || deleting) return;
    setDeleting(true); setDeleteError("");
    try {
      await jsonRequest("/api/mail/trash", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: deleteChat.email, folder }) });
      if (selected === deleteChat.email) { setSelected(null); setDraft(""); setFiles([]); setMediaOpen(false); }
      setOutbox(items => items.filter(item => item.account !== account || item.email !== deleteChat.email));
      setSearchSeedState(current => current?.messages.some(message => message.contactEmail === deleteChat.email) ? null : current);
      if (pins.includes(deleteChat.email)) togglePin(deleteChat.email);
      setDeleteChat(null);
      await Promise.all([query.resetQueries({ queryKey: ["mail"] }), query.invalidateQueries({ queryKey: ["pinned-mail"] }), query.invalidateQueries({ queryKey: ["contact-history"] }), query.invalidateQueries({ queryKey: ["mail-latest"] })]);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Не удалось удалить чат.");
      await Promise.all([query.invalidateQueries({ queryKey: ["mail"] }), query.invalidateQueries({ queryKey: ["pinned-mail"] }), query.invalidateQueries({ queryKey: ["contact-history"] }), query.invalidateQueries({ queryKey: ["mail-latest"] })]);
    } finally { setDeleting(false); }
  }
  async function deliver(item: OutboxItem) {
    if (sendingRef.current) return;
    sendingRef.current = true; setSending(true);
    setOutbox(items => items.map(current => current.clientId === item.clientId ? { ...current, status: "sending", error: undefined } : current));
    const data = new FormData();
    data.set("to", item.email); data.set("subject", item.subject); data.set("text", item.text);
    if (item.threadId) { data.set("threadId", item.threadId); data.set("messageId", item.messageId); data.set("references", item.references); }
    item.files.forEach(file => data.append("files", file));
    try {
      const result: { id?: string; threadId?: string } = await jsonRequest("/api/mail/send", { method: "POST", body: data });
      setOutbox(items => items.map(current => current.clientId === item.clientId ? { ...current, status: "sent", sentId: result.id, sentThreadId: result.threadId } : current));
      // Refreshing the list is independent of sending: an indexing delay must not turn success into a failure.
      void Promise.all([query.invalidateQueries({ queryKey: ["pinned-mail"] }), query.invalidateQueries({ queryKey: ["mail-latest"] })]).catch(() => {});
    } catch (error) {
      const definite = error instanceof RequestError && error.status >= 400 && error.status < 500 && error.status !== 408;
      const message = definite ? error.message : "Не удалось подтвердить отправку. Перед повтором проверьте «Отправленные» в Gmail.";
      setOutbox(items => items.map(current => current.clientId === item.clientId ? { ...current, status: "failed", error: message } : current));
    } finally { sendingRef.current = false; setSending(false); }
  }
  function editPending(item: OutboxItem) {
    if (draft || files.length) { setSendError("Сначала очистите поле ввода и удалите текущие вложения."); return; }
    setOutbox(items => items.filter(current => current.clientId !== item.clientId));
    setFolder("all"); setSelected(item.email); setDraft(item.text); setFiles(item.files); setSendError("");
    if (item.threadId) { setCompose(false); setThread(item.threadId); }
    else { setCompose(true); setRecipient(item.email); setSubject(item.subject === "Без темы" ? "" : item.subject); }
  }
  function send() {
    if (sendingRef.current || (!compose && !replyReady) || (!draft.trim() && !files.length)) return;
    const email = (compose ? recipient : active?.email || "").trim().toLowerCase();
    if (!account || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) { setSendError("Укажите корректный адрес получателя."); return; }
    const subjectValue = compose ? subject.trim() || "Без темы" : replyTarget ? (/^re:/i.test(replyTarget.subject) ? replyTarget.subject : `Re: ${replyTarget.subject}`) : "Без темы";
    if (subjectValue.length > 500 || draft.trim().length > 500000) { setSendError("Слишком длинная тема или текст письма."); return; }
    const item: OutboxItem = { ...createOutboxIdentity(), account, email, name: compose ? email : active?.name || email, subject: subjectValue, text: draft.trim(), files, threadId: compose ? "" : replyTarget?.threadId || "", messageId: compose ? "" : replyTarget?.messageId || "", references: compose ? "" : replyTarget?.references || "", status: "sending" };
    setOutbox(items => [...items.filter(current => !(current.account === item.account && current.sentId && mailboxIds.has(current.sentId) && detailMap.has(current.sentId))), item]);
    setDraft(""); setFiles([]); setSendError(""); setCompose(false); setSelected(email); setFolder("all"); setSearch(""); setSearchTerm(""); setSearchSeedState(null); setThread(""); setRecipient(""); setSubject("");
    void deliver(item);
  }
  if (status === "loading") return <div className="screen-center"><LoaderCircle className="spin" size={24}/></div>;
  if (status === "unauthenticated") return <div className="login-page"><div className="login-orb orb-one"/><div className="login-orb orb-two"/><main className="login-card"><div className="brand-mark"><Mail size={29}/></div><div className="login-eyebrow">ПОЧТА, КОТОРАЯ БЛИЖЕ</div><h1>Gmail, как диалог.</h1><p>Все письма с каждым контактом — в одной красивой переписке. Привычная почта, новый взгляд.</p><button className="google-button" onClick={() => signIn("google")}><span className="google-g">G</span> Продолжить с Google</button><div className="login-note">Для работы потребуется доступ к вашей почте Gmail</div></main><span className="login-footer">GMAIL CHAT <span>✦</span> ПОЧТА В ВАШЕМ РИТМЕ</span></div>;
  return <div className="app-shell">
    <aside className={`sidebar ${selected || compose ? "mobile-hidden" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div className="sidebar-top"><div className="top-line"><div className="menu-wrap" ref={menuRef}><button className="icon-button" aria-label="Меню" aria-expanded={menu} aria-haspopup="menu" onClick={() => { setContextMenu(null); setMenu(!menu); }}><Menu size={21}/></button>{menu && <div className="dropdown"><div className="dropdown-user"><strong>{session?.user?.name || "Аккаунт"}</strong><span>{session?.user?.email}</span></div><button onClick={toggleTheme}>{dark ? <Sun size={17}/> : <Moon size={17}/>} {dark ? "Светлая тема" : "Тёмная тема"}</button><button onClick={() => { setOutbox([]); setSearchSeedState(null); query.clear(); signOut(); }}><LogOut size={17}/> Выйти</button></div>}</div><div className="wordmark">gmail<span>chat</span><i>✦</i></div><button className="icon-button sidebar-collapse" title="Свернуть панель" aria-label="Свернуть панель" onClick={() => { setSidebarCollapsed(true); setMenu(false); }}><PanelLeftClose size={19}/></button><button className="icon-button compose-button" aria-label="Новое письмо" title="Новое письмо" onClick={() => { setCompose(true); setSelected(null); setDraft(""); setFiles([]); setSendError(""); }}><PenLine size={19}/></button></div>
      <label className="search-box"><Search size={18}/><input placeholder="Поиск по почте" value={search} onChange={e => setSearch(e.target.value)}/>{search && <button aria-label="Очистить поиск" onClick={() => setSearch("")}><X size={15}/></button>}</label></div>
      <nav className="folder-tabs" aria-label="Разделы почты"><button className={folder === "all" ? "selected" : ""} aria-current={folder === "all" ? "page" : undefined} onClick={() => changeFolder("all")}><Inbox size={16}/> Все</button><button className={folder === "archive" ? "selected" : ""} aria-current={folder === "archive" ? "page" : undefined} onClick={() => changeFolder("archive")}><Archive size={16}/> Архив</button><button className={folder === "spam" ? "selected" : ""} aria-current={folder === "spam" ? "page" : undefined} onClick={() => changeFolder("spam")}><ShieldAlert size={16}/> Спам</button></nav>
      <div className="list-heading"><span>{folder === "archive" ? "АРХИВ" : folder === "spam" ? "СПАМ" : "СООБЩЕНИЯ"}</span><span>{conversations.length > 0 ? conversations.length : ""}</span></div>
      {!searchActive && folder === "all" && mail.isError && !mail.data && archiveMail.data && <div className="folder-error" role="alert">Не удалось загрузить остальные письма: {mail.error.message}<button onClick={() => mail.refetch()}>Повторить</button></div>}{!searchActive && latestMail.isError && <div className="folder-error" role="alert">{latestMail.error.message}</div>}{!searchActive && folder === "all" && (archiveMail.isError || archiveLatest.isError) && <div className="folder-error" role="alert">Не удалось загрузить архив: {(archiveMail.error || archiveLatest.error)?.message}<button onClick={() => archiveMail.isFetchNextPageError ? archiveMail.fetchNextPage() : archiveMail.isError ? archiveMail.refetch() : archiveLatest.refetch()}>Повторить</button></div>}{mail.isRefetchError && <div className="folder-error" role="alert">{mail.error.message}</div>}{!searchActive && pinnedMail.isError && <div className="folder-error" role="alert">Не удалось загрузить закреплённые чаты: {pinnedMail.error.message}<button onClick={() => pinnedMail.refetch()}>Повторить</button></div>}{moving && <div className="folder-notice"><LoaderCircle className="spin" size={14}/> Перемещаем письма…</div>}{moveNotice && !moving && <div className="folder-notice" role="status">{moveNotice}<button aria-label="Закрыть" onClick={() => setMoveNotice("")}><X size={14}/></button></div>}{moveError && <div className="folder-error" role="alert">{moveError}<button aria-label="Закрыть" onClick={() => setMoveError("")}><X size={14}/></button></div>}
      <div className="chat-list">{listLoading ? <div className="list-status"><LoaderCircle className="spin" size={20}/> {searchActive ? "Ищем в Gmail…" : "Загружаем почту…"}</div> : listError ? <div className="list-status error"><CircleAlert size={20}/><span>{listError.message}</span><button onClick={() => searchActive ? searchMail.refetch() : mail.refetch()}>Повторить</button>{listError.message.includes("Войдите") && <button onClick={() => signIn("google")}>Войти снова</button>}</div> : filtered.length ? filtered.map(c => <button key={c.email} className={`chat-row ${selected === c.email && !compose ? "active" : ""}`} onClick={() => choose(c.email)} onContextMenu={event => { event.preventDefault(); setMenu(false); setContextMenu({ email: c.email, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 260)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 355)) }); }}><Avatar name={c.name}/><span className="chat-copy"><span className="chat-first"><strong>{c.name}</strong><span className="chat-row-meta">{pins.includes(c.email) && <Pin size={13} aria-label="Закреплён"/>}<time>{listTime(c.last.date)}</time></span></span><span className="chat-second"><span>{c.last.outgoing && <span className="you">Вы: </span>}{c.last.snippet || c.last.subject}</span>{c.unread > 0 && <b className="unread">{c.unread}</b>}</span></span></button>) : <div className="list-status">{search ? "Ничего не найдено. Попробуйте адрес контакта или другой запрос." : folder === "archive" ? "В архиве пока нет писем" : folder === "spam" ? "В спаме пока нет писем" : "Здесь появятся ваши переписки"}</div>}
      {searchActive && searchMail.isFetchNextPageError && <div className="folder-error" role="alert">{searchMail.error.message}</div>}{listHasNext && <button className="load-more" disabled={listFetchingNext} onClick={loadMoreList}>{listFetchingNext ? "Загружаем…" : searchActive ? "Показать ещё результаты" : "Загрузить более ранние письма"}</button>}</div>
      <div className="sidebar-bottom"><div className="account"><Avatar name={session?.user?.name || session?.user?.email || "Я"} small/><span><strong>{session?.user?.name || "Мой аккаунт"}</strong><small>{session?.user?.email}</small></span></div><button className="icon-button" title="Обновить" aria-label="Обновить" onClick={() => { if (searchActive) { if (searchReady) searchMail.refetch(); } else if (mail.data) { latestMail.refetch(); if (folder === "all" && archiveMail.data) archiveLatest.refetch(); if (missingPins.length) pinnedMail.refetch(); } else mail.refetch(); }}><RefreshCw size={17} className={(searchActive ? searchMail.isFetching : latestMail.isFetching || archiveLatest.isFetching || (mail.isFetching && !mail.isFetchingNextPage)) ? "spin" : ""}/></button></div>
    </aside>
    <main className={`conversation ${!selected && !compose ? "mobile-hidden" : ""} ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`} onDragEnter={dragEnter} onDragLeave={dragLeave} onDragOver={event => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={dropFiles}>
      {dragging && <div className="drop-overlay"><div className="drop-zone"><div className="drop-icon"><Paperclip size={31}/></div><strong>Перетащите файлы сюда</strong><span>Отпустите, чтобы прикрепить к сообщению</span></div></div>}
      {sidebarCollapsed && <button className="icon-button sidebar-expand" title="Развернуть панель" aria-label="Развернуть панель" onClick={() => setSidebarCollapsed(false)}><PanelLeftOpen size={20}/></button>}
      {active || compose ? <><header className="conversation-header"><button className="icon-button back-button" aria-label="Назад" onClick={() => { setSelected(null); setCompose(false); }}><ArrowLeft size={20}/></button>{active && !compose ? <><Avatar name={active.name} small/><div className="contact-title"><strong>{active.name}</strong><span>{active.email}</span></div><div className="thread-select"><select aria-label="Выбрать email-тред" value={thread} onChange={e => { setThread(e.target.value); setMessageLimit(20); }}><option value="">Все темы · {threadOptions.length}</option>{threadOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><ChevronDown size={14}/></div><button className="icon-button" aria-label="Медиа" title="Медиа" onClick={() => setMediaOpen(true)}><ImageIcon size={19}/></button><button className="icon-button" aria-label="Действия с чатом" title="Действия с чатом" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setContextMenu({ email: active.email, x: Math.max(8, box.right - 252), y: Math.max(8, Math.min(box.bottom + 6, window.innerHeight - 355)) }); }}><MoreVertical size={19}/></button></> : <div className="contact-title"><strong>Новое сообщение</strong><span>Начните новый диалог</span></div>}</header>
      {compose && <div className="compose-fields"><label><span>Кому</span><input type="email" placeholder="name@example.com" value={recipient} onChange={e => setRecipient(e.target.value)}/></label><label><span>Тема</span><input placeholder="Без темы" value={subject} onChange={e => setSubject(e.target.value)}/></label></div>}
      <div className="message-area">{compose ? <div className="compose-hint"><div className="hint-icon"><PenLine size={23}/></div><strong>Новое письмо</strong><span>Напишите сообщение, чтобы начать диалог</span></div> : <div className="message-stack">{matchingMessages.length > messageLimit && <button className="load-more" disabled={details.isFetching} onClick={() => setMessageLimit(limit => limit + 20)}>{details.isFetching ? "Загружаем…" : "Показать более ранние сообщения"}</button>}{matchingMessages.length <= messageLimit && contactHistory.hasNextPage && <button className="load-more" disabled={contactHistory.isFetchingNextPage} onClick={() => contactHistory.fetchNextPage()}>{contactHistory.isFetchingNextPage ? "Загружаем…" : "Загрузить более ранние письма этого чата"}</button>}{contactHistory.isFetchNextPageError && <div className="error-note" role="alert">{contactHistory.error.message}</div>}{shown.map((m, index) => {
        const pending = outboxById.get(m.id);
        const localOnly = !!pending && !detailMap.has(m.id);
        return <div key={pending?.clientId || m.id} id={`message-${m.id}`}>
          {(index === 0 || new Date(shown[index - 1].date).toDateString() !== new Date(m.date).toDateString()) && <div className="date-divider"><span>{day(m.date)}</span></div>}
          <article className={`bubble-row ${m.outgoing ? "outgoing" : "incoming"}`}><div className={`bubble ${m.html ? "bubble-html" : ""}`}>
            <div className="bubble-subject" title={m.subject}>{m.subject}</div>
            {!detailMap.has(m.id) && !pending ? <div className="message-loading">{details.isError ? "Не удалось загрузить письмо" : details.isFetching ? "Загружаем письмо…" : "Письмо недоступно"}</div> : m.html ? <EmailBody id={m.id} html={m.html} attachments={m.attachments}/> : <div className="message-text">{m.text}</div>}
            {localOnly && pending.files.map((file, fileIndex) => <div className="pending-file" key={`${file.name}-${fileIndex}`}><Paperclip size={15}/><span>{file.name}</span></div>)}
            {m.attachments.map(a => <AttachmentCard key={a.id} messageId={m.id} attachment={a} compact={!!m.html && referencesInlineImage(m.html, a.contentId)}/>)}
            {pending?.status === "failed" && <div className="send-failure" role="alert"><span>{pending.error || "Не удалось подтвердить отправку."}</span><div><button type="button" disabled={sending} onClick={() => void deliver(pending)}>Повторить</button><button type="button" onClick={() => editPending(pending)}>Изменить</button><button type="button" onClick={() => setOutbox(items => items.filter(item => item.clientId !== pending.clientId))}>Убрать</button></div></div>}
            <div className="bubble-meta">{time(m.date)} {pending?.status === "sending" ? <><LoaderCircle className="spin" size={13}/><span>Отправка</span></> : pending?.status === "failed" ? <><CircleAlert size={14}/><span>Ошибка отправки</span></> : m.outgoing ? <Check size={14}/> : null}</div>
          </div></article>
        </div>;
      })}<div ref={bottom}/></div>}</div>
      <div className="composer-wrap">{readError && <div className="error-note">{readError}</div>}{contactHistory.isError && !contactHistory.isFetchNextPageError && <div className="error-note">Не удалось загрузить историю: {contactHistory.error.message} <button onClick={() => contactHistory.refetch()}>Повторить</button></div>}{details.isError && <div className="error-note">{details.error.message} <button type="button" onClick={() => details.refetch()}>Повторить</button></div>}{sendError && <div className="error-note">{sendError}</div>}{!compose && replyTarget && <div className="reply-context">Ответ в теме: <strong>{replyTarget.subject}</strong></div>}{files.length > 0 && <div className="file-chips">{files.map((f, i) => <span key={`${f.name}-${i}`}>{f.name}<button aria-label={`Удалить ${f.name}`} onClick={() => setFiles(files.filter((_, n) => n !== i))}><X size={13}/></button></span>)}</div>}<div className="composer"><input ref={fileInput} type="file" multiple hidden onChange={e => { addFiles(Array.from(e.target.files || [])); e.target.value = ""; }}/><button className="icon-button attach-button" aria-label="Прикрепить файлы" onClick={() => fileInput.current?.click()}><Paperclip size={21}/></button><textarea rows={1} placeholder="Написать сообщение..." value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}/><button className="send-button" aria-label="Отправить" disabled={sending || (!compose && !replyReady) || (!draft.trim() && !files.length)} onClick={send}>{sending ? <LoaderCircle className="spin" size={19}/> : <Send size={19}/>}</button></div><div className="composer-caption">Enter — отправить <span>·</span> Shift + Enter — новая строка</div></div></> : <div className="empty-chat"><div className="empty-illustration"><div className="envelope"><Mail size={42}/><span>✦</span></div></div><h2>Всё начинается с письма</h2><p>Выберите переписку слева, чтобы продолжить разговор</p><div className="empty-pill"><Inbox size={14}/> ВАША ПОЧТА. ВАШ РИТМ.</div></div>}
    </main>
    {contextMenu && <div className="chat-context-menu" ref={contextMenuRef} role="menu" aria-label="Действия с чатом" style={{ left: contextMenu.x, top: contextMenu.y }}><div className="context-contact"><strong>{conversations.find(c => c.email === contextMenu.email)?.name || contextMenu.email}</strong><span>{contextMenu.email}</span></div><button role="menuitem" onClick={() => { choose(contextMenu.email); setContextMenu(null); }}><MessageCircle size={18}/> Открыть чат</button><button role="menuitem" onClick={() => { choose(contextMenu.email); setMediaOpen(true); setContextMenu(null); }}><ImageIcon size={18}/> Медиа</button><button role="menuitem" onClick={() => togglePin(contextMenu.email)}>{pins.includes(contextMenu.email) ? <PinOff size={18}/> : <Pin size={18}/>} {pins.includes(contextMenu.email) ? "Открепить чат" : "Закрепить чат"}</button><div className="context-divider"/>{folder === "all" && <button role="menuitem" disabled={moving} onClick={() => moveChat(contextMenu.email, "archive")}><Archive size={18}/> В архив</button>}{folder !== "all" && <button role="menuitem" disabled={moving} onClick={() => moveChat(contextMenu.email, "inbox")}><ArchiveRestore size={18}/> Во входящие</button>}{folder !== "spam" && <button role="menuitem" disabled={moving} onClick={() => moveChat(contextMenu.email, "spam")}><ShieldAlert size={18}/> В спам (полученные)</button>}<button className="context-danger" role="menuitem" onClick={() => { const chat = conversations.find(c => c.email === contextMenu.email); if (chat) { setDeleteChat(chat); setDeleteError(""); } setContextMenu(null); }}><Trash2 size={18}/> Удалить чат</button></div>}
    {deleteChat && <div className="modal-backdrop" onClick={() => { if (!deleting) setDeleteChat(null); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-chat-title" onClick={event => event.stopPropagation()}><h2 id="delete-chat-title">Удалить чат?</h2><p>{folder === "spam" ? <>Все письма из спама с контактом <strong>{deleteChat.name}</strong> ({deleteChat.email}) будут перемещены в корзину Gmail, включая ещё не загруженные. Остальные письма этого контакта не затрагиваются.</> : <>Все письма с контактом <strong>{deleteChat.name}</strong> ({deleteChat.email}) во всех темах будут перемещены в корзину Gmail, включая ещё не загруженные. Спам и черновики не затрагиваются.</>} Письма можно восстановить в Gmail.</p>{deleteError && <div className="error-note">{deleteError}</div>}<div className="dialog-actions"><button onClick={() => setDeleteChat(null)} disabled={deleting}>Отмена</button><button className="danger-button" onClick={trashChat} disabled={deleting}>{deleting ? "Удаляем…" : "Удалить чат"}</button></div></section></div>}
    {mediaOpen && active && <div className="modal-backdrop" onClick={() => setMediaOpen(false)}><section className="dialog media-dialog" role="dialog" aria-modal="true" aria-labelledby="media-title" onClick={event => event.stopPropagation()}><div className="media-heading"><div><h2 id="media-title">Медиа</h2><span>{active.name} · вложения из загруженных писем</span></div><button className="icon-button" aria-label="Закрыть" onClick={() => setMediaOpen(false)}><X size={20}/></button></div><div className="media-tabs" role="tablist" aria-label="Вложения"><button role="tab" aria-selected={mediaTab === "images"} onClick={() => setMediaTab("images")}>Изображения · {media.length}</button><button role="tab" aria-selected={mediaTab === "files"} onClick={() => setMediaTab("files")}>Файлы · {filesInChat.length}</button></div>{details.isFetching && !details.data ? <div className="media-empty"><LoaderCircle className="spin" size={20}/><span>Загружаем вложения…</span></div> : details.isError ? <div className="media-empty"><span>{details.error.message}</span><button onClick={() => details.refetch()}>Повторить</button></div> : mediaTab === "images" ? media.length ? <div className="media-grid">{media.map(({ messageId, attachment }) => <MediaImage key={`${messageId}-${attachment.id}`} messageId={messageId} attachment={attachment}/>)}</div> : <div className="media-empty"><ImageIcon size={24}/><span>В загруженных письмах пока нет изображений</span></div> : filesInChat.length ? <div className="media-files">{filesInChat.map(({ messageId, attachment }) => <AttachmentCard key={`${messageId}-${attachment.id}`} messageId={messageId} attachment={attachment} compact/>)}</div> : <div className="media-empty"><span>В загруженных письмах пока нет файлов</span></div>}{matchingMessages.length > messageLimit && <button className="load-more media-load-more" disabled={details.isFetching} onClick={() => setMessageLimit(limit => limit + 20)}>{details.isFetching ? "Загружаем…" : "Показать вложения более ранних сообщений"}</button>}{contactHistory.isFetchNextPageError && <div className="attachment-error" role="alert">{contactHistory.error.message}</div>}{contactHistory.hasNextPage && matchingMessages.length <= messageLimit && <button className="load-more media-load-more" disabled={contactHistory.isFetchingNextPage} onClick={() => contactHistory.fetchNextPage()}>{contactHistory.isFetchingNextPage ? "Загружаем…" : "Загрузить вложения из более ранних писем"}</button>}</section></div>}
  </div>;
}

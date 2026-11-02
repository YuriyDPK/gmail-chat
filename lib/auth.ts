import "server-only";
import { randomBytes } from "node:crypto";
import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { deleteTokens, loadTokens, saveTokens } from "@/lib/token-store";
import { clearMessageCache } from "@/lib/message-cache";

export const authOptions: NextAuthOptions = {
  secret: process.env.AUTH_SECRET,
  session: { strategy: "jwt" },
  providers: [GoogleProvider({
    clientId: process.env.AUTH_GOOGLE_ID || "",
    clientSecret: process.env.AUTH_GOOGLE_SECRET || "",
    authorization: { params: { scope: "openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send", access_type: "offline", prompt: "consent", response_type: "code" } },
  })],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        if (!account.access_token || !account.refresh_token) throw new Error("Google did not provide offline access. Please sign in again.");
        const id = randomBytes(32).toString("hex");
        await saveTokens(id, { accessToken: account.access_token, refreshToken: account.refresh_token, expiresAt: (account.expires_at || 0) * 1000 });
        token.tokenStoreId = id;
      }
      return token;
    },
    async session({ session }) { return session; },
  },
  events: { async signOut({ token }) { if (typeof token?.tokenStoreId === "string") await removeSession(token.tokenStoreId); } },
};

const refreshes = new Map<string, Promise<string>>();
async function removeSession(id: string) {
  await refreshes.get(id)?.catch(() => {});
  clearMessageCache(id);
  await deleteTokens(id);
}
export async function accessToken(id: string): Promise<string> {
  const tokens = await loadTokens(id);
  if (!tokens) throw new Error("SESSION_EXPIRED");
  if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
  let pending = refreshes.get(id);
  if (!pending) {
    pending = (async () => {
      const current = await loadTokens(id);
      if (!current) throw new Error("SESSION_EXPIRED");
      if (current.expiresAt > Date.now() + 60_000) return current.accessToken;
      const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.AUTH_GOOGLE_ID || "", client_secret: process.env.AUTH_GOOGLE_SECRET || "", refresh_token: current.refreshToken, grant_type: "refresh_token" }), cache: "no-store" });
      if (!response.ok) throw new Error("SESSION_EXPIRED");
      const data = await response.json();
      if (!data.access_token) throw new Error("SESSION_EXPIRED");
      await saveTokens(id, { accessToken: data.access_token, refreshToken: data.refresh_token || current.refreshToken, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 });
      return data.access_token as string;
    })().finally(() => refreshes.delete(id));
    refreshes.set(id, pending);
  }
  return pending;
}

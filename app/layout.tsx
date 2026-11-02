import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Gmail Chat", description: "Ваша почта в ритме диалога" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" suppressHydrationWarning><body>{children}</body></html>;
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OceanKing · 多 Agent 协作工作台",
  description: "以房间为公开事实、以 Agent 为持续执行主体的本地协作工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* OceanKing 自带完整主题，避免 Dark Reader 在水合前改写 SVG 属性。 */}
        <meta name="darkreader-lock" />
      </head>
      <body>{children}</body>
    </html>
  );
}

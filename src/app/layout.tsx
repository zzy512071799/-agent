import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: '漫剧 agent', description: 'AI 漫剧生产控制台' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}

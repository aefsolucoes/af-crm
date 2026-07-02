'use client';
import './globals.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useThemeStore } from '@/store/theme.store';

const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('af_background_theme')||'white';document.documentElement.setAttribute('data-theme',t);var img=localStorage.getItem('af_background_image');document.documentElement.style.setProperty('--app-bg-image', img ? 'url("'+img+'")' : 'none');}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30000, retry: 1 } },
  }));
  const initTheme = useThemeStore((s) => s.init);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <title>AF CRM — A&F Soluções Financeiras</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </body>
    </html>
  );
}

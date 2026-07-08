'use client';
import './globals.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/auth.store';

// Lê o tema direto do usuário logado (af_user), não de uma chave genérica —
// cada conta tem sua própria aparência, mesmo compartilhando o navegador.
const THEME_INIT_SCRIPT = `(function(){try{var u=JSON.parse(localStorage.getItem('af_user')||'null');var t=(u&&u.themeColor)||'white';document.documentElement.setAttribute('data-theme',t);var img=u&&u.themeImage;document.documentElement.style.setProperty('--app-bg-image', img ? 'url("'+img+'")' : 'none');var op=(u&&u.themeOpacity)||85;document.documentElement.style.setProperty('--app-surface-alpha', String(op/100));}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30000, retry: 1 } },
  }));
  const initAuth = useAuthStore((s) => s.init);

  useEffect(() => {
    initAuth();
  }, [initAuth]);

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

'use client';
import { useQuery } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { useAuthStore } from '@/store/auth.store';
import api from '@/lib/api';
import { Sparkles, ExternalLink, Settings } from 'lucide-react';
import Link from 'next/link';

interface UserWithAssistant {
  id: string;
  assistantProjectUrl: string | null;
}

// Não existe um GET "/me" — reaproveita a mesma listagem que a tela de
// Usuários já usa (aberta a qualquer logado, não só quem gerencia equipe) e
// acha o próprio registro pelo id da sessão.
async function fetchMyAssistantUrl(userId: string): Promise<string | null> {
  const { data } = await api.get('/api/users');
  const me = (data as UserWithAssistant[]).find((u) => u.id === userId);
  return me?.assistantProjectUrl || null;
}

export default function MeuAssistentePage() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'ADMIN';

  const { data: assistantUrl, isLoading } = useQuery({
    queryKey: ['my-assistant-url', user?.id],
    queryFn: () => fetchMyAssistantUrl(user!.id),
    enabled: !!user?.id,
  });

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Meu Assistente" subtitle="Atalho pro seu Projeto pessoal no Claude" />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-lg mx-auto mt-10">
          <div className="bg-white rounded-2xl border border-af-border shadow-sm p-8 text-center">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-af-blue to-af-mid flex items-center justify-center mx-auto mb-4">
              <Sparkles size={26} className="text-white" />
            </div>

            {isLoading ? (
              <p className="text-sm text-slate-400">Carregando…</p>
            ) : assistantUrl ? (
              <>
                <h2 className="text-lg font-bold text-slate-800 mb-1">Seu assistente está pronto</h2>
                <p className="text-sm text-slate-500 mb-6">
                  Abre numa aba nova o Projeto configurado pra você no Claude — com as instruções e o acesso combinados pro seu trabalho.
                </p>
                <a
                  href={assistantUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-af-mid text-white font-medium hover:bg-af-dark transition-colors"
                >
                  <ExternalLink size={16} />
                  Abrir meu assistente
                </a>
              </>
            ) : (
              <>
                <h2 className="text-lg font-bold text-slate-800 mb-1">Ainda não configurado</h2>
                <p className="text-sm text-slate-500 mb-6">
                  {isAdmin
                    ? 'Ninguém configurou o link do seu Projeto no Claude ainda. Você mesmo pode fazer isso em Usuários — edite o seu cadastro e cole o link em "Link do assistente pessoal".'
                    : 'Ninguém configurou o link do seu Projeto no Claude ainda. Peça pra um administrador configurar em Usuários — no cadastro de vocês, ele cola o link em "Link do assistente pessoal".'}
                </p>
                {isAdmin && (
                  <Link
                    href="/usuarios"
                    className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-af-mid text-white font-medium hover:bg-af-dark transition-colors"
                  >
                    <Settings size={16} />
                    Ir para Usuários
                  </Link>
                )}
              </>
            )}
          </div>

          <p className="text-xs text-slate-400 text-center mt-4">
            Isso só abre o Claude numa aba separada — nada dele roda dentro do CRM.
          </p>
        </div>
      </div>
    </div>
  );
}

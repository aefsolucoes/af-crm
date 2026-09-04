'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard, Kanban, Home, MessageSquare, CheckSquare, Bot, BarChart3, LogOut, Settings,
  FileText, Zap, UserCog, PanelLeftClose, PanelLeftOpen, Wallet, Upload, Landmark, X, Sparkles,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { useSidebarStore } from '@/store/sidebar.store';
import { useRouter } from 'next/navigation';
import { Avatar } from './avatar';
import { effectivePermissions, PermissionKey } from '@/lib/permissions';
import api from '@/lib/api';

interface NavItem { href: string; label: string; icon: typeof BarChart3; perm: PermissionKey; departmentName?: string; }

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: BarChart3, perm: 'dashboard' },
  // perm: 'dashboard' de propósito — é a única permissão que todo papel tem
  // por padrão (ADMIN/MANAGER/AGENT), então todo colaborador vê esse atalho
  // sem precisar de configuração extra de permissão.
  { href: '/meu-assistente', label: 'Meu Assistente', icon: Sparkles, perm: 'dashboard' },
  // departmentName: só aparece pra quem é daquele setor (ou Admin, ou quem
  // não tem setor definido — mesmo critério de "sem restrição" já usado em
  // getScopeDepartmentId no backend).
  { href: '/funil-habitacao', label: 'Funil de Vendas Habitação', icon: Home, perm: 'funnel_view', departmentName: 'Financiamento Habitacional' },
  { href: '/funil-consorcio', label: 'Funil de Vendas Consórcio', icon: Kanban, perm: 'funnel_view', departmentName: 'Consórcio' },
  { href: '/funil-home-equity', label: 'Funil de Vendas Home Equity', icon: Landmark, perm: 'funnel_view', departmentName: 'Home Equity' },
  { href: '/inbox', label: 'Inbox', icon: MessageSquare, perm: 'inbox_view' },
  { href: '/tarefas', label: 'Tarefas', icon: CheckSquare, perm: 'tasks' },
  { href: '/salesbot', label: 'SalesBot', icon: Bot, perm: 'salesbot' },
  { href: '/templates', label: 'Templates', icon: FileText, perm: 'templates' },
  { href: '/automacao', label: 'Automações', icon: Zap, perm: 'automations' },
  { href: '/usuarios', label: 'Usuários', icon: UserCog, perm: 'users' },
  { href: '/financeiro', label: 'Financeiro', icon: Wallet, perm: 'finance' },
  { href: '/importar', label: 'Importar', icon: Upload, perm: 'funnel_manage' },
  { href: '/configuracoes', label: 'Configurações', icon: Settings, perm: 'settings' },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const { collapsed, toggle, init, mobileOpen, closeMobile } = useSidebarStore();
  const router = useRouter();

  // Pra decidir qual "Funil de Vendas <Setor>" mostrar — só busca se tiver
  // usuário logado com setor definido (Admin/sem setor não precisa, já vê tudo).
  const { data: departments } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => { const { data } = await api.get('/api/departments'); return data as { id: string; name: string }[]; },
    enabled: !!user && user.role !== 'ADMIN' && !!user.departmentIds?.length,
  });
  const myDepartmentNames = (departments || [])
    .filter((d) => (user?.departmentIds || []).includes(d.id))
    .map((d) => d.name);

  // Mostra no menu só o que o usuário tem permissão de acessar — e, pros
  // itens de funil por setor, só os dos PRÓPRIOS setores (Admin ou quem não
  // tem setor definido continua vendo todos, igual sempre viu tudo em outras
  // áreas escopadas por departamento).
  const perms = effectivePermissions(user?.role || 'AGENT', user?.permissions ?? null);
  const isAdmin = user?.role === 'ADMIN';
  const nav = NAV.filter((item) => {
    if (!perms[item.perm]) return false;
    if (!item.departmentName) return true;
    if (isAdmin || !user?.departmentIds?.length) return true;
    return myDepartmentNames.includes(item.departmentName);
  });

  useEffect(() => {
    init();
  }, [init]);

  // Fecha o drawer mobile ao navegar (link clicado ou navegação
  // programática) — cobre os dois casos sem precisar de onClick manual em
  // cada item do menu.
  useEffect(() => {
    closeMobile();
  }, [pathname, closeMobile]);

  // Trava o scroll do body e fecha no Escape enquanto o drawer está aberto —
  // mesmo padrão do Modal (components/ui/modal.tsx).
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMobile(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
    };
  }, [mobileOpen, closeMobile]);

  function handleLogout() {
    logout();
    router.push('/login');
  }

  return (
    <>
    {/* Desktop — rail fixo, some do fluxo abaixo do breakpoint md (drawer assume). */}
    <aside className={cn('hidden md:flex flex-shrink-0 app-sidebar-surface flex-col h-full transition-all duration-200', collapsed ? 'w-16' : 'w-60')}>
      {/* Logo */}
      <div className={cn('py-5 border-b border-af-blue flex items-center', collapsed ? 'px-3 justify-center' : 'px-5 justify-between gap-3')}>
        <div className={cn('flex items-center gap-3 min-w-0', collapsed && 'gap-0')}>
          <div className="w-8 h-8 bg-af-mid rounded-lg flex items-center justify-center flex-shrink-0">
            <LayoutDashboard size={16} className="text-white" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-white font-bold text-sm leading-tight truncate">AF CRM</p>
              <p className="text-slate-400 text-xs truncate">A&F Soluções</p>
            </div>
          )}
        </div>
        {!collapsed && (
          <button
            onClick={toggle}
            className="p-1.5 rounded-lg text-slate-300 bg-af-blue hover:bg-af-mid hover:text-white transition-colors flex-shrink-0"
            title="Esconder painel"
          >
            <PanelLeftClose size={18} />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          onClick={toggle}
          className="mx-auto mt-3 p-1.5 rounded-lg text-slate-300 bg-af-blue hover:bg-af-mid hover:text-white transition-colors"
          title="Mostrar painel"
        >
          <PanelLeftOpen size={18} />
        </button>
      )}

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          // "Meu Assistente" abre numa aba própria do navegador (pedido
          // explícito do usuário) — nunca navega embora da tela em que você
          // já está no CRM, ex.: sai da Inbox no meio de um atendimento.
          const isAssistant = href === '/meu-assistente';
          return (
            <Link
              key={href}
              href={href}
              {...(isAssistant ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              title={collapsed ? label : undefined}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                collapsed && 'justify-center px-0',
                active
                  ? 'bg-af-mid text-white'
                  : 'text-slate-300 hover:bg-af-blue hover:text-white'
              )}
            >
              <Icon size={17} className="flex-shrink-0" />
              {!collapsed && label}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      {user && (
        <div className={cn('py-4 border-t border-af-blue', collapsed ? 'px-2' : 'px-3')}>
          <div className={cn('flex items-center gap-3', collapsed ? 'justify-center px-0' : 'px-2')}>
            <Avatar name={user.name} size="sm" />
            {!collapsed && (
              <>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-xs font-medium truncate">{user.name}</p>
                  <p className="text-slate-400 text-xs truncate">{user.email}</p>
                </div>
                <button onClick={handleLogout} className="text-slate-400 hover:text-red-400 transition-colors" title="Sair">
                  <LogOut size={15} />
                </button>
              </>
            )}
          </div>
          {collapsed && (
            <button onClick={handleLogout} className="mt-2 mx-auto flex text-slate-400 hover:text-red-400 transition-colors" title="Sair">
              <LogOut size={15} />
            </button>
          )}
        </div>
      )}
    </aside>

    {/* Mobile — drawer off-canvas, mesmo padrão visual do Modal (backdrop +
        Escape fecha), some acima do breakpoint md. Sempre expandido (rótulos
        visíveis) — não tem sentido colapsar um drawer que já fecha sozinho. */}
    {mobileOpen && (
      <div className="md:hidden fixed inset-0 z-50 flex">
        <div className="absolute inset-0 bg-black/50" onClick={closeMobile} />
        <aside className="relative w-72 max-w-[85vw] app-sidebar-surface flex flex-col h-full shadow-2xl">
          <div className="py-5 px-5 border-b border-af-blue flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 bg-af-mid rounded-lg flex items-center justify-center flex-shrink-0">
                <LayoutDashboard size={16} className="text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-white font-bold text-sm leading-tight truncate">AF CRM</p>
                <p className="text-slate-400 text-xs truncate">A&F Soluções</p>
              </div>
            </div>
            <button onClick={closeMobile} className="text-slate-400 hover:text-white transition-colors flex-shrink-0" title="Fechar">
              <X size={20} />
            </button>
          </div>

          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
            {nav.map(({ href, label, icon: Icon }) => {
              const active = pathname.startsWith(href);
              // "Meu Assistente" abre numa aba própria (não navega embora da
              // tela atual) — como o pathname desta aba não muda, o fecha-ao-
              // navegar do drawer (efeito [pathname] acima) não dispararia
              // sozinho aqui; fecha explícito no clique.
              const isAssistant = href === '/meu-assistente';
              return (
                <Link
                  key={href}
                  href={href}
                  {...(isAssistant ? { target: '_blank', rel: 'noopener noreferrer', onClick: closeMobile } : {})}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                    active ? 'bg-af-mid text-white' : 'text-slate-300 hover:bg-af-blue hover:text-white'
                  )}
                >
                  <Icon size={17} className="flex-shrink-0" />
                  {label}
                </Link>
              );
            })}
          </nav>

          {user && (
            <div className="py-4 px-3 border-t border-af-blue">
              <div className="flex items-center gap-3 px-2">
                <Avatar name={user.name} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-white text-xs font-medium truncate">{user.name}</p>
                  <p className="text-slate-400 text-xs truncate">{user.email}</p>
                </div>
                <button onClick={handleLogout} className="text-slate-400 hover:text-red-400 transition-colors" title="Sair">
                  <LogOut size={15} />
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    )}
    </>
  );
}

'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard, Kanban, Home, MessageSquare, CheckSquare, Bot, BarChart3, LogOut, Settings,
  FileText, Zap, UserCog, PanelLeftClose, PanelLeftOpen, Wallet, Upload, MousePointerClick,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { useSidebarStore } from '@/store/sidebar.store';
import { useRouter } from 'next/navigation';
import { Avatar } from './avatar';
import { effectivePermissions, PermissionKey } from '@/lib/permissions';

const NAV: { href: string; label: string; icon: typeof BarChart3; perm: PermissionKey }[] = [
  { href: '/dashboard', label: 'Dashboard', icon: BarChart3, perm: 'dashboard' },
  { href: '/funil-habitacao', label: 'Funil de Vendas Habitação', icon: Home, perm: 'funnel_view' },
  { href: '/funil-consorcio', label: 'Funil de Vendas Consórcio', icon: Kanban, perm: 'funnel_view' },
  { href: '/inbox', label: 'Inbox', icon: MessageSquare, perm: 'inbox_view' },
  { href: '/tarefas', label: 'Tarefas', icon: CheckSquare, perm: 'tasks' },
  { href: '/salesbot', label: 'SalesBot', icon: Bot, perm: 'salesbot' },
  { href: '/templates', label: 'Templates', icon: FileText, perm: 'templates' },
  { href: '/automacao', label: 'Automações', icon: Zap, perm: 'automations' },
  { href: '/usuarios', label: 'Usuários', icon: UserCog, perm: 'users' },
  { href: '/financeiro', label: 'Financeiro', icon: Wallet, perm: 'finance' },
  { href: '/importar', label: 'Importar', icon: Upload, perm: 'funnel_manage' },
  { href: '/agente-navegador', label: 'Agente de Navegador', icon: MousePointerClick, perm: 'browser_agent' },
  { href: '/configuracoes', label: 'Configurações', icon: Settings, perm: 'settings' },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const { collapsed, toggle, init } = useSidebarStore();
  const router = useRouter();

  // Mostra no menu só o que o usuário tem permissão de acessar.
  const perms = effectivePermissions(user?.role || 'AGENT', user?.permissions ?? null);
  const nav = NAV.filter((item) => perms[item.perm]);

  useEffect(() => {
    init();
  }, [init]);

  function handleLogout() {
    logout();
    router.push('/login');
  }

  return (
    <aside className={cn('flex-shrink-0 app-sidebar-surface flex flex-col h-full transition-all duration-200', collapsed ? 'w-16' : 'w-60')}>
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
            className="text-slate-400 hover:text-white transition-colors flex-shrink-0"
            title="Esconder painel"
          >
            <PanelLeftClose size={18} />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          onClick={toggle}
          className="mx-auto mt-3 text-slate-400 hover:text-white transition-colors"
          title="Mostrar painel"
        >
          <PanelLeftOpen size={18} />
        </button>
      )}

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
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
  );
}

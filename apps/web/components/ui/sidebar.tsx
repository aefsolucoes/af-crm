'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard, Kanban, MessageSquare, Users, Contact, CheckSquare, Bot, BarChart3, LogOut, Settings,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { useRouter } from 'next/navigation';
import { Avatar } from './avatar';

const NAV = [
  { href: '/funil', label: 'Funil de Vendas', icon: Kanban },
  { href: '/inbox', label: 'Inbox', icon: MessageSquare },
  { href: '/leads', label: 'Leads', icon: Users },
  { href: '/contatos', label: 'Contatos', icon: Contact },
  { href: '/tarefas', label: 'Tarefas', icon: CheckSquare },
  { href: '/salesbot', label: 'SalesBot', icon: Bot },
  { href: '/relatorios', label: 'Relatórios', icon: BarChart3 },
  { href: '/configuracoes', label: 'Configurações', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const router = useRouter();

  function handleLogout() {
    logout();
    router.push('/login');
  }

  return (
    <aside className="w-60 flex-shrink-0 bg-af-navy flex flex-col h-full">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-af-blue">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-af-mid rounded-lg flex items-center justify-center">
            <LayoutDashboard size={16} className="text-white" />
          </div>
          <div>
            <p className="text-white font-bold text-sm leading-tight">AF CRM</p>
            <p className="text-slate-400 text-xs">A&F Soluções</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto scrollbar-thin">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                active
                  ? 'bg-af-mid text-white'
                  : 'text-slate-300 hover:bg-af-blue hover:text-white'
              )}
            >
              <Icon size={17} />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      {user && (
        <div className="px-3 py-4 border-t border-af-blue">
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
  );
}

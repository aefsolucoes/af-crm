'use client';
import React from 'react';
import { Bell, Menu } from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { useSidebarStore } from '@/store/sidebar.store';

interface TopbarProps {
  title: string | React.ReactNode;
  subtitle?: string | React.ReactNode;
  /** Botões extras no canto direito, antes do sino (ex: atalho de Aparência na Dashboard). */
  actions?: React.ReactNode;
}

export function Topbar({ title, subtitle, actions }: TopbarProps) {
  const { user } = useAuthStore();
  const { openMobile } = useSidebarStore();

  return (
    <header className="h-14 app-topbar-surface border-b flex items-center justify-between px-3 md:px-6 flex-shrink-0 gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={openMobile}
          className="md:hidden flex-shrink-0 app-topbar-text-muted hover:text-af-mid p-1.5 rounded-lg hover:bg-white/10 transition-colors"
          title="Menu"
        >
          <Menu size={20} />
        </button>
        <div className="min-w-0">
          <h1 className="text-base font-semibold truncate" style={{ color: 'var(--app-topbar-text)' }}>{title}</h1>
          {subtitle && <p className="text-xs app-topbar-text-muted truncate">{subtitle}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {actions}
        <button className="relative app-topbar-text-muted hover:text-af-mid p-1.5 rounded-lg hover:bg-white/10 transition-colors">
          <Bell size={18} />
        </button>
        {user && (
          <div className="text-right hidden sm:block">
            <p className="text-xs font-medium" style={{ color: 'var(--app-topbar-text)' }}>{user.name}</p>
            <p className="text-xs app-topbar-text-muted">{user.role}</p>
          </div>
        )}
      </div>
    </header>
  );
}

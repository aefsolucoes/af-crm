'use client';
import React from 'react';
import { Bell } from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';

interface TopbarProps {
  title: string | React.ReactNode;
  subtitle?: string | React.ReactNode;
}

export function Topbar({ title, subtitle }: TopbarProps) {
  const { user } = useAuthStore();

  return (
    <header className="h-14 app-topbar-surface border-b flex items-center justify-between px-6 flex-shrink-0">
      <div>
        <h1 className="text-base font-semibold" style={{ color: 'var(--app-topbar-text)' }}>{title}</h1>
        {subtitle && <p className="text-xs app-topbar-text-muted">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3">
        <button className="relative app-topbar-text-muted hover:text-af-mid p-1.5 rounded-lg hover:bg-white/10 transition-colors">
          <Bell size={18} />
        </button>
        {user && (
          <div className="text-right">
            <p className="text-xs font-medium" style={{ color: 'var(--app-topbar-text)' }}>{user.name}</p>
            <p className="text-xs app-topbar-text-muted">{user.role}</p>
          </div>
        )}
      </div>
    </header>
  );
}

'use client';
import { Bell } from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';

interface TopbarProps {
  title: string;
  subtitle?: string;
}

export function Topbar({ title, subtitle }: TopbarProps) {
  const { user } = useAuthStore();

  return (
    <header className="h-14 bg-white border-b border-af-border flex items-center justify-between px-6 flex-shrink-0">
      <div>
        <h1 className="text-base font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3">
        <button className="relative text-slate-500 hover:text-af-mid p-1.5 rounded-lg hover:bg-af-light transition-colors">
          <Bell size={18} />
        </button>
        {user && (
          <div className="text-right">
            <p className="text-xs font-medium text-slate-700">{user.name}</p>
            <p className="text-xs text-slate-400">{user.role}</p>
          </div>
        )}
      </div>
    </header>
  );
}

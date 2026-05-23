'use client';
import { Bell, Search } from 'lucide-react';
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
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            placeholder="Buscar..."
            className="pl-8 pr-4 py-1.5 text-sm border border-af-border rounded-lg bg-af-light text-slate-700 focus:outline-none focus:ring-1 focus:ring-af-accent w-48"
          />
        </div>
        <button className="relative text-slate-500 hover:text-af-mid p-1.5 rounded-lg hover:bg-af-light transition-colors">
          <Bell size={18} />
          <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-red-500 rounded-full" />
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

'use client';
import { useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { User, Search, X, ChevronDown } from 'lucide-react';

type PickerLead = { id: string; name: string; contact?: { name?: string; phone?: string; whatsappPhone?: string } };

interface LeadPickerProps {
  value: string | null;
  onChange: (leadId: string | null) => void;
  disabled?: boolean;
}

/** Combobox pra vincular a tarefa do Agente de Navegador a um lead — mesma
 *  lógica de busca do modal "Encaminhar mensagem" (chat-window.tsx): busca
 *  todos os leads uma vez (não existe busca por texto no backend hoje) e
 *  filtra no cliente por nome/telefone. Selecionar um lead injeta os dados
 *  dele (extraídos dos documentos no Drive) no contexto do agente. */
export function LeadPicker({ value, onChange, disabled }: LeadPickerProps) {
  const [leads, setLeads] = useState<PickerLead[] | null>(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function handleOpen() {
    if (disabled) return;
    setOpen(true);
    if (leads === null) {
      api.get('/api/leads').then(({ data }) => setLeads(data)).catch(() => setLeads([]));
    }
  }

  const selected = (leads || []).find((l) => l.id === value);

  const matches = (leads || [])
    .filter((l) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      const phone = (l.contact?.whatsappPhone || l.contact?.phone || '').replace(/\D/g, '');
      const qDigits = q.replace(/\D/g, '');
      return l.name.toLowerCase().includes(q) || (qDigits.length >= 3 && phone.includes(qDigits));
    })
    .slice(0, 30);

  return (
    <div ref={containerRef} className="relative">
      {selected ? (
        <span className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-2 rounded-lg border border-af-accent/40 bg-af-light text-xs font-medium text-af-accent">
          <User size={13} />
          {selected.contact?.name || selected.name}
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            className="ml-0.5 text-af-accent/70 hover:text-af-accent disabled:opacity-50"
            title="Remover vínculo com o lead"
          >
            <X size={13} />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={handleOpen}
          disabled={disabled}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-af-border text-xs font-medium text-slate-500 hover:border-af-mid hover:text-slate-700 disabled:opacity-50 whitespace-nowrap"
        >
          <User size={13} />
          Vincular a um lead
          <ChevronDown size={13} />
        </button>
      )}

      {open && (
        <div className="absolute z-20 top-full left-0 mt-1 w-72 max-h-80 flex flex-col rounded-xl border border-af-border bg-white shadow-lg overflow-hidden">
          <div className="p-2 border-b border-af-border">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome ou telefone"
                className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg bg-af-light text-slate-800 border border-transparent focus:outline-none focus:border-af-accent/40"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin p-1.5">
            {leads === null ? (
              <p className="px-2 py-3 text-xs text-slate-400">Carregando leads…</p>
            ) : matches.length === 0 ? (
              <p className="px-2 py-3 text-xs text-slate-400">Nenhum lead encontrado</p>
            ) : (
              matches.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => {
                    onChange(l.id);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded-lg hover:bg-af-light transition-colors flex items-center gap-2',
                    l.id === value && 'bg-af-light'
                  )}
                >
                  <Avatar name={l.contact?.name || l.name} size="sm" />
                  <span className="text-xs text-slate-700 truncate flex-1">{l.contact?.name || l.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

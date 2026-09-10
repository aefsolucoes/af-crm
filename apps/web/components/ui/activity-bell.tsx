'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import api from '@/lib/api';

/**
 * Sineta de "registro de atividade": mostra o que a equipe fez (mexeu em card,
 * respondeu cliente, mudou status…). É SILENCIOSA — sem som, sem popup; só
 * acumula aqui. Um pontinho aparece quando tem coisa mais nova do que a última
 * vez que a sineta foi aberta (guardado no localStorage por navegador).
 * Fica no Topbar, que está em todas as telas.
 */
interface ActivityItem {
  id: string;
  userName: string;
  action: string;
  leadId: string | null;
  leadName: string | null;
  summary: string;
  channel: string | null;
  createdAt: string;
}

const SEEN_KEY = 'af:activity-seen';

function timeAgo(iso: string): string {
  const diffS = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffS < 60) return 'agora';
  const m = Math.floor(diffS / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d`;
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function ActivityBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const seenAt = () => {
    try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; }
  };

  const loadFirst = useCallback(async () => {
    try {
      const { data } = await api.get('/api/activity', { params: { limit: 40 } });
      const list: ActivityItem[] = data.items || [];
      setItems(list);
      setCursor(data.nextCursor || null);
      const newest = list[0]?.createdAt || '';
      setHasNew(!!newest && newest > seenAt());
    } catch { /* rede — tenta de novo no próximo tick */ }
  }, []);

  useEffect(() => {
    loadFirst();
    const t = setInterval(loadFirst, 60000);
    return () => clearInterval(t);
  }, [loadFirst]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* ignore */ }
      setHasNew(false);
      loadFirst();
    }
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { data } = await api.get('/api/activity', { params: { limit: 40, cursor } });
      setItems((prev) => [...prev, ...(data.items || [])]);
      setCursor(data.nextCursor || null);
    } catch { /* ignore */ } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={toggle}
        className="relative app-topbar-text-muted hover:text-af-mid p-1.5 rounded-lg hover:bg-white/10 transition-colors"
        title="Registro de atividade"
      >
        <Bell size={18} />
        {hasNew && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-af-accent" />}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white rounded-xl shadow-2xl border border-af-border z-50 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-af-border">
            <p className="text-sm font-semibold text-slate-800">Registro de atividade</p>
            <p className="text-[11px] text-slate-400">O que a equipe fez — sem alarde, só registrado</p>
          </div>
          <div className="max-h-[60vh] overflow-y-auto scrollbar-thin">
            {items.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-8">Nada registrado ainda.</p>
            ) : (
              items.map((it) => {
                const body = (
                  <div className="px-4 py-2.5 hover:bg-slate-50 border-b border-slate-100">
                    <p className="text-xs text-slate-700 leading-snug">
                      <span className="font-semibold">{it.userName}</span> {it.summary}
                      {it.leadName && (
                        <> — <span className="font-medium text-slate-900">{it.leadName}</span></>
                      )}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">{timeAgo(it.createdAt)}</p>
                  </div>
                );
                return it.leadId ? (
                  <Link key={it.id} href={`/leads/${it.leadId}`} onClick={() => setOpen(false)} className="block">
                    {body}
                  </Link>
                ) : (
                  <div key={it.id}>{body}</div>
                );
              })
            )}
            {cursor && (
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="w-full text-xs text-af-mid hover:bg-slate-50 py-2.5 disabled:opacity-50"
              >
                {loadingMore ? 'Carregando…' : 'Carregar mais'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

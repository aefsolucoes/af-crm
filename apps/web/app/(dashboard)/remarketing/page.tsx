'use client';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Topbar } from '@/components/ui/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth.store';
import { Megaphone, Pause, Play, ShieldCheck } from 'lucide-react';
import api from '@/lib/api';

/* Remarketing por WhatsApp — ver apps/api/src/services/remarketing.service.ts.
 * Rodízio de 3 templates, um a cada 7 dias; sem resposta depois da 3ª, Perdido. */

interface StageOption { id: string; name: string; department: string; eligible: number; skipped: number; }
interface Row {
  id: string; name: string; department: string; stage: string; step: number; active: boolean; paused: boolean;
  end: string | null; startedAt: string; lastAt: string | null; nextAt: string | null;
}
interface Status {
  rows: Row[];
  summary: { active: number; paused: boolean; waitingFirst: number; byStep: number[]; replied: number; lost: number; other: number; sentToday: number };
  rules: { templates: string[]; intervalDays: number; dailyFirstSends: number; window: string };
  quality: { quality: string | null; tier: string | null; phone: string | null };
}

const QUALITY: Record<string, { label: string; cls: string }> = {
  GREEN: { label: 'Alta', cls: 'bg-emerald-50 text-emerald-600' },
  YELLOW: { label: 'Média — atenção', cls: 'bg-amber-50 text-amber-600' },
  RED: { label: 'Baixa — pause o remarketing', cls: 'bg-red-50 text-red-500' },
};
const TIER: Record<string, string> = {
  TIER_250: '250 clientes/dia', TIER_1K: '1.000 clientes/dia', TIER_10K: '10.000 clientes/dia', TIER_100K: '100.000 clientes/dia', TIER_UNLIMITED: 'sem limite',
};
const END_LABEL: Record<string, string> = {
  respondeu: 'Respondeu', perdido: 'Foi pra Perdido', 'mudou de estágio': 'Mudou de estágio', saiu: 'Saiu (Perdido/arquivado)',
  ganho: 'Ganho', 'sem nome': 'Sem nome válido', 'erro no envio': 'Erro no envio',
};

function fmt(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export default function RemarketingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const { data: status, isLoading } = useQuery<Status>({
    queryKey: ['remarketing-status'],
    queryFn: async () => (await api.get('/api/remarketing/status')).data,
    refetchInterval: 60_000,
  });
  const { data: stages } = useQuery<StageOption[]>({
    queryKey: ['remarketing-stages'],
    queryFn: async () => (await api.get('/api/remarketing/stages')).data,
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'ativos' | 'todos'>('ativos');

  const total = useMemo(() => (stages || []).filter((s) => selected.includes(s.id)).reduce((n, s) => n + s.eligible, 0), [stages, selected]);
  const byDept = useMemo(() => {
    const m = new Map<string, StageOption[]>();
    for (const s of stages || []) m.set(s.department, [...(m.get(s.department) || []), s]);
    return Array.from(m.entries());
  }, [stages]);
  const rows = (status?.rows || []).filter((r) => filter === 'todos' || r.active);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['remarketing-status'] });
    queryClient.invalidateQueries({ queryKey: ['remarketing-stages'] });
  }

  async function start() {
    setBusy(true);
    try {
      const { data } = await api.post('/api/remarketing/start', { stageIds: selected });
      toast(`${data.started} cliente(s) entraram no remarketing`, 'success');
      setSelected([]);
      setConfirming(false);
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao iniciar', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    const paused = !status?.summary.paused;
    try {
      await api.post('/api/remarketing/pause', { paused });
      toast(paused ? 'Remarketing pausado' : 'Remarketing retomado', 'success');
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro', 'error');
    }
  }

  const q = status?.quality?.quality ? QUALITY[status.quality.quality] : null;
  const s = status?.summary;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Remarketing" subtitle="Rodízio de mensagens pelo WhatsApp pra quem parou de responder" />

      <div className="flex-1 overflow-auto px-4 md:px-6 py-4 space-y-4 scrollbar-thin">
        {/* Qualidade do número */}
        <div className="bg-white rounded-xl border border-af-border p-4 flex flex-wrap items-center gap-3 text-sm">
          <ShieldCheck size={18} className="text-slate-400" />
          <span className="text-slate-600">Qualidade do número {status?.quality?.phone || ''} na Meta:</span>
          {q ? <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${q.cls}`}>{q.label}</span> : <span className="text-slate-400">—</span>}
          {status?.quality?.tier && <span className="text-xs text-slate-400">limite: {TIER[status.quality.tier] || status.quality.tier}</span>}
          <span className="text-xs text-slate-400 w-full">É o mesmo número do atendimento. Se cair pra Média ou Baixa (muita gente bloqueando), pause o remarketing.</span>
        </div>

        {/* Andamento */}
        {isLoading ? <Skeleton className="h-24" /> : s && (
          <div className="bg-white rounded-xl border border-af-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold text-slate-800">Em andamento</h2>
              {isAdmin && s.active > 0 && (
                <button onClick={togglePause} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-af-border hover:bg-slate-50 text-slate-600">
                  {s.paused ? <><Play size={12} /> Retomar envios</> : <><Pause size={12} /> Pausar envios</>}
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 text-center">
              {[
                ['No rodízio', s.active], ['Aguardando 1ª', s.waitingFirst], ['Receberam 1ª', s.byStep[0]], ['Receberam 2ª', s.byStep[1]],
                ['Receberam 3ª', s.byStep[2]], ['Responderam', s.replied], ['Foram pra Perdido', s.lost],
              ].map(([label, n]) => (
                <div key={label as string} className="rounded-lg bg-slate-50 py-2">
                  <div className="text-lg font-semibold text-slate-800">{n as number}</div>
                  <div className="text-[11px] text-slate-400">{label as string}</div>
                </div>
              ))}
            </div>
            {s.paused && <p className="mt-3 text-xs text-amber-600">Envios pausados — ninguém recebe mensagem até retomar.</p>}
            <p className="mt-3 text-xs text-slate-400">
              Ordem: {status!.rules.templates.join(' → ')}, uma a cada {status!.rules.intervalDays} dias. Envia {status!.rules.window}, até {status!.rules.dailyFirstSends} primeiras mensagens por dia. Enviadas hoje: {s.sentToday}.
              Respondeu qualquer coisa, mudou de estágio ou virou Ganho/Perdido: sai do rodízio. Sem resposta 7 dias depois da 3ª: vai pra Perdido.
            </p>
          </div>
        )}

        {/* Nova rodada */}
        {isAdmin && (
          <div className="bg-white rounded-xl border border-af-border p-4">
            <h2 className="text-sm font-semibold text-slate-800 mb-1">Colocar clientes no remarketing</h2>
            <p className="text-xs text-slate-400 mb-3">Só entram cards abertos, com telefone e que nunca passaram pelo remarketing.</p>
            <div className="space-y-3">
              {byDept.map(([dept, list]) => (
                <div key={dept}>
                  <div className="text-xs font-medium text-slate-500 mb-1">{dept}</div>
                  <div className="flex flex-wrap gap-2">
                    {list.map((st) => {
                      const on = selected.includes(st.id);
                      return (
                        <button
                          key={st.id}
                          disabled={st.eligible === 0}
                          onClick={() => setSelected((p) => on ? p.filter((x) => x !== st.id) : [...p, st.id])}
                          className={`text-xs px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-40 ${on ? 'bg-af-accent text-white border-af-accent' : 'border-af-border text-slate-600 hover:bg-slate-50'}`}
                        >
                          {st.name} <span className={on ? 'text-white/80' : 'text-slate-400'}>({st.eligible})</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-end">
              <Button onClick={() => setConfirming(true)} disabled={total === 0}>
                <Megaphone size={14} /> Iniciar para {total} cliente(s)
              </Button>
            </div>
          </div>
        )}

        {/* Clientes */}
        <div className="bg-white rounded-xl border border-af-border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-af-border">
            <h2 className="text-sm font-semibold text-slate-800">Clientes</h2>
            <div className="flex gap-1 text-xs">
              {(['ativos', 'todos'] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={`px-2.5 py-1 rounded-lg ${filter === f ? 'bg-slate-100 text-slate-800 font-medium' : 'text-slate-400'}`}>
                  {f === 'ativos' ? 'No rodízio' : 'Todos'}
                </button>
              ))}
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="text-center py-10 text-slate-400 text-sm">Ninguém {filter === 'ativos' ? 'no rodízio agora' : 'passou pelo remarketing ainda'}.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="text-left text-xs text-slate-400 border-b border-af-border">
                    <th className="px-4 py-2.5 font-medium">Cliente</th>
                    <th className="px-4 py-2.5 font-medium">Estágio</th>
                    <th className="px-4 py-2.5 font-medium">Mensagens</th>
                    <th className="px-4 py-2.5 font-medium">Última</th>
                    <th className="px-4 py-2.5 font-medium">Próxima</th>
                    <th className="px-4 py-2.5 font-medium">Situação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-af-border">
                  {rows.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50 cursor-pointer transition-colors" onClick={() => router.push(`/inbox?leadId=${r.id}`)}>
                      <td className="px-4 py-2.5 font-medium text-slate-800">{r.name}</td>
                      <td className="px-4 py-2.5 text-slate-500 text-xs">{r.department} · {r.stage}</td>
                      <td className="px-4 py-2.5 text-slate-600">{r.step}/3</td>
                      <td className="px-4 py-2.5 text-slate-500 text-xs">{fmt(r.lastAt)}</td>
                      <td className="px-4 py-2.5 text-slate-500 text-xs">{r.active ? (r.step === 0 ? 'na fila' : r.step >= 3 ? `${fmt(r.nextAt)} (Perdido)` : fmt(r.nextAt)) : '—'}</td>
                      <td className="px-4 py-2.5 text-xs">
                        {r.active
                          ? <span className={r.paused ? 'text-amber-600' : 'text-emerald-600'}>{r.paused ? 'Pausado' : 'No rodízio'}</span>
                          : <span className="text-slate-500">{END_LABEL[r.end || ''] || r.end || '—'}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {confirming && (
        <Modal title="Iniciar remarketing" onClose={() => setConfirming(false)}>
          <div className="space-y-3 text-sm text-slate-600">
            <p><strong>{total} cliente(s)</strong> vão entrar no rodízio:</p>
            <ul className="list-disc pl-5 space-y-1 text-xs">
              <li>1ª mensagem: {status?.rules.templates[0]} — sai hoje (ou no próximo horário de envio), aos poucos, até {status?.rules.dailyFirstSends} por dia.</li>
              <li>2ª e 3ª ({status?.rules.templates.slice(1).join(', ')}): uma a cada {status?.rules.intervalDays} dias.</li>
              <li>Sem resposta 7 dias depois da 3ª: o card vai pra Perdido ("sem retorno no remarketing").</li>
              <li>Respondeu, tocou num botão ou mudou de estágio: sai do rodízio.</li>
            </ul>
            <p className="text-xs text-slate-400">Cada mensagem de marketing é cobrada pela Meta.</p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setConfirming(false)}>Cancelar</Button>
              <Button onClick={start} disabled={busy}>{busy ? 'Iniciando…' : 'Iniciar'}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

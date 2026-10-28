'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapPin, Loader2, Smartphone, Monitor, ExternalLink, RefreshCw } from 'lucide-react';
import api from '@/lib/api';

/* Relatório "de onde a equipe mandou cada mensagem" (Fabio 27/10). Só admin. A localização só existe quando o aparelho já tinha permitido
 * (o CRM nunca pede); sem permissão = "Não autorizou". */

interface Row {
  id: string; messageId: string; userId: string; userName: string; leadId: string; leadName: string | null;
  status: 'PENDENTE' | 'OK' | 'NAO_AUTORIZOU' | 'INDISPONIVEL' | 'ERRO';
  latitude: number | null; longitude: number | null; accuracy: number | null; detail: string | null;
  userAgent: string | null; ip: string | null; createdAt: string;
}

function aparelho(ua: string | null): { label: string; mobile: boolean } {
  const u = ua || '';
  if (/iPhone/.test(u)) return { label: 'iPhone', mobile: true };
  if (/iPad/.test(u)) return { label: 'iPad', mobile: true };
  if (/Android/.test(u)) return { label: 'Android', mobile: true };
  if (/Macintosh/.test(u)) return { label: 'Mac', mobile: false };
  if (/Windows/.test(u)) return { label: 'Windows', mobile: false };
  return { label: u ? 'Outro' : '?', mobile: false };
}

const hoje = () => new Date().toISOString().slice(0, 10);
const diasAtras = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const quando = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

function StatusCell({ r }: { r: Row }) {
  if (r.status === 'OK' && r.latitude !== null && r.longitude !== null) {
    const precisao = r.accuracy !== null ? (r.accuracy >= 1000 ? `±${(r.accuracy / 1000).toFixed(1).replace('.', ',')} km` : `±${Math.round(r.accuracy)} m`) : '';
    return (
      <a href={`https://www.google.com/maps?q=${r.latitude},${r.longitude}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-af-blue hover:underline">
        <MapPin size={12} /> Ver no mapa <span className="text-slate-400">{precisao}</span> <ExternalLink size={10} />
      </a>
    );
  }
  // PENDENTE com mais de 3 min = o aparelho nunca respondeu (app fechado logo depois ou versão antiga do app).
  const semResposta = r.status === 'PENDENTE' && Date.now() - new Date(r.createdAt).getTime() > 3 * 60_000;
  const txt = r.status === 'NAO_AUTORIZOU' ? 'Não autorizou' : r.status === 'INDISPONIVEL' ? 'Aparelho não informa' : r.status === 'ERRO' ? 'GPS falhou' : semResposta ? 'Sem resposta do aparelho' : 'Aguardando…';
  const cor = r.status === 'NAO_AUTORIZOU' ? 'text-amber-600' : r.status === 'PENDENTE' && !semResposta ? 'text-slate-400' : 'text-rose-500';
  return <span className={cor} title={r.detail || undefined}>{txt}{r.detail ? <span className="text-slate-400"> · {r.detail}</span> : null}</span>;
}

export function SendLocationReport() {
  const [from, setFrom] = useState(diasAtras(7));
  const [to, setTo] = useState(hoje());
  const [userId, setUserId] = useState('');
  const { data, isLoading, isError, refetch, isFetching } = useQuery<Row[]>({
    queryKey: ['send-locations', from, to],
    queryFn: async () => (await api.get('/api/messages/send-locations', { params: { from: `${from}T00:00:00-03:00`, to: `${to}T23:59:59-03:00` } })).data,
  });
  const pessoas = useMemo(() => Array.from(new Map((data || []).map((r) => [r.userId, r.userName])).entries()).sort((a, b) => a[1].localeCompare(b[1])), [data]);
  const rows = (data || []).filter((r) => !userId || r.userId === userId);
  const comLocal = rows.filter((r) => r.status === 'OK').length;

  return (
    <div className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-af-border bg-gradient-to-r from-af-blue to-af-mid">
        <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center"><MapPin size={22} className="text-white" /></div>
        <div>
          <h2 className="text-white font-bold text-base">Localização dos envios</h2>
          <p className="text-white/70 text-xs">De onde cada pessoa da equipe mandou mensagem pela Inbox</p>
        </div>
      </div>

      <div className="px-6 py-5 space-y-4">
        <p className="text-xs text-slate-500">
          A localização só aparece quando o aparelho já permite localização pro CRM (o CRM não pede). No iPhone: Ajustes → Apps → Safari → Localização → <strong>Permitir</strong>, e
          Privacidade e Segurança → Serviços de Localização → Sites do Safari → <strong>Durante o Uso do App</strong> com <strong>Localização Precisa</strong> ligada.
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500">De<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="block mt-1 px-2 py-1.5 border border-af-border rounded-lg text-sm text-slate-700" /></label>
          <label className="text-xs text-slate-500">Até<input type="date" value={to} min={from} max={hoje()} onChange={(e) => setTo(e.target.value)} className="block mt-1 px-2 py-1.5 border border-af-border rounded-lg text-sm text-slate-700" /></label>
          <label className="text-xs text-slate-500">Pessoa
            <select value={userId} onChange={(e) => setUserId(e.target.value)} className="block mt-1 px-2 py-1.5 border border-af-border rounded-lg text-sm text-slate-700">
              <option value="">Todas</option>
              {pessoas.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
            </select>
          </label>
          <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-af-border rounded-lg hover:bg-slate-100 text-slate-600">
            <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} /> Atualizar
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={14} className="animate-spin" /> Carregando…</div>
        ) : isError ? (
          <p className="text-sm text-rose-500">Não consegui carregar o relatório.</p>
        ) : !rows.length ? (
          <p className="text-sm text-slate-400">Nenhum envio pela Inbox nesse período.</p>
        ) : (
          <>
            <p className="text-xs text-slate-500">{rows.length} envio{rows.length > 1 ? 's' : ''} · {comLocal} com localização</p>
            <div className="overflow-x-auto -mx-6">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-af-border">
                    <th className="px-6 py-2 font-medium">Quando</th>
                    <th className="px-2 py-2 font-medium">Quem</th>
                    <th className="px-2 py-2 font-medium">Cliente</th>
                    <th className="px-2 py-2 font-medium">Aparelho</th>
                    <th className="px-2 py-2 pr-6 font-medium">Localização</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const ap = aparelho(r.userAgent);
                    return (
                      <tr key={r.id} className="border-b border-af-border/60 last:border-0 text-slate-700">
                        <td className="px-6 py-2 whitespace-nowrap">{quando(r.createdAt)}</td>
                        <td className="px-2 py-2 whitespace-nowrap">{r.userName}</td>
                        <td className="px-2 py-2"><a href={`/inbox?leadId=${r.leadId}`} className="hover:underline">{r.leadName || '—'}</a></td>
                        <td className="px-2 py-2 whitespace-nowrap" title={r.ip ? `IP ${r.ip}` : undefined}>
                          <span className="inline-flex items-center gap-1">{ap.mobile ? <Smartphone size={12} /> : <Monitor size={12} />}{ap.label}</span>
                        </td>
                        <td className="px-2 py-2 pr-6"><StatusCell r={r} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

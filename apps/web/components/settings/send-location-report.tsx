'use client';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Loader2, Smartphone, Monitor, ExternalLink, RefreshCw, Check } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { LocationMap, type MapPoint } from '@/components/settings/location-map';

/* Relatório "de onde a equipe mandou cada mensagem" (Fabio 27/10). Só admin. Sem a chave do pedido, a localização só existe quando o aparelho já
 * tinha permitido; sem permissão = "Não autorizou". Com a chave ligada (Fabio 28/10) o CRM pede a permissão; "Não Permitir" = "Negou". */

interface Row {
  id: string; kind: 'open' | 'send'; userId: string; userName: string; leadId: string | null; leadName: string | null;
  status: 'PENDENTE' | 'OK' | 'NAO_AUTORIZOU' | 'NEGOU' | 'INDISPONIVEL' | 'ERRO';
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
  if (r.status === 'NEGOU') return <span className="text-rose-600 font-semibold" title={r.detail || undefined}>Negou{r.detail ? <span className="text-slate-400 font-normal"> · {r.detail}</span> : null}</span>;
  const txt = r.status === 'NAO_AUTORIZOU' ? 'Não autorizou' : r.status === 'INDISPONIVEL' ? 'Aparelho não informa' : r.status === 'ERRO' ? 'GPS falhou' : semResposta ? 'Sem resposta do aparelho' : 'Aguardando…';
  const cor = r.status === 'NAO_AUTORIZOU' ? 'text-amber-600' : r.status === 'PENDENTE' && !semResposta ? 'text-slate-400' : 'text-rose-500';
  return <span className={cor} title={r.detail || undefined}>{txt}{r.detail ? <span className="text-slate-400"> · {r.detail}</span> : null}</span>;
}

interface PromptCfg { promptEnabled: boolean; disabledUserIds: string[]; users: { id: string; name: string; role: string }[] }
const fetchCfg = async (): Promise<PromptCfg> => (await api.get('/api/messages/send-location-settings')).data;

const chip = (on: boolean) => `inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${on ? 'bg-af-mid text-white border-af-mid' : 'border-af-border text-slate-500 hover:bg-slate-50'}`;

// Igual ao listLocationEvents da API: 1000 pontos da equipe toda, 3000 de uma pessoa só.
const limite = (userId: string) => (userId ? 3000 : 1000);

/** Chave do pedido de permissão (pop-up) + por pessoa. Chave geral desligada = ninguém vê pedido (Fabio 28/10: "só não manda o pop up ainda"). */
function PromptSettings() {
  const qc = useQueryClient();
  const { data } = useQuery<PromptCfg>({ queryKey: ['send-location-settings'], queryFn: fetchCfg });
  const [saving, setSaving] = useState(false);
  if (!data) return null;

  const save = async (patch: Partial<Pick<PromptCfg, 'promptEnabled' | 'disabledUserIds'>>) => {
    setSaving(true);
    try {
      const r = await api.put('/api/messages/send-location-settings', patch);
      qc.setQueryData<PromptCfg>(['send-location-settings'], { ...data, ...r.data });
    } catch {
      toast('Não consegui salvar', 'error');
    } finally {
      setSaving(false);
    }
  };
  const toggleGeral = () => {
    if (!data.promptEnabled && !confirm('Ligar o pedido de localização? Quem ainda não permitiu vai ver o aviso do CRM e o pedido do aparelho no próximo envio.')) return;
    save({ promptEnabled: !data.promptEnabled });
  };
  const toggleUser = (id: string) => save({ disabledUserIds: data.disabledUserIds.includes(id) ? data.disabledUserIds.filter((x) => x !== id) : [...data.disabledUserIds, id] });
  const ligada = data.promptEnabled;

  return (
    <div className="rounded-xl border border-af-border p-4 space-y-3">
      <div className="flex items-start gap-3">
        <button
          type="button" role="switch" aria-checked={ligada} onClick={toggleGeral} disabled={saving}
          className={`relative flex-shrink-0 mt-0.5 h-6 w-11 rounded-full transition-colors disabled:opacity-60 ${ligada ? 'bg-emerald-500' : 'bg-slate-300'}`}
          title={ligada ? 'Ligado — clique pra desligar' : 'Desligado — clique pra ligar'}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${ligada ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800">Pedir a localização (pop-up) <span className={`text-[11px] font-medium ${ligada ? 'text-emerald-600' : 'text-slate-400'}`}>{ligada ? 'ligado' : 'desligado'}</span></p>
          <p className="text-xs text-slate-500 mt-0.5">
            {ligada
              ? 'Quem ainda não permitiu vê, no primeiro envio, um aviso do CRM (só na 1ª vez no aparelho) e o pedido do próprio aparelho. No computador o pedido vem uma vez só; no iPhone com Localização em “Permitir” nem aparece pedido. Quem tocar em “Não Permitir” aparece como “Negou”.'
              : 'Ninguém vê pedido. Quem não permitiu a localização no aparelho sai como “Não autorizou”.'}
          </p>
        </div>
      </div>
      <div>
        <p className="text-xs text-slate-500 mb-1.5">Pedir pra estas pessoas{ligada ? ':' : ' (vale quando o pedido estiver ligado):'}</p>
        <div className={`flex flex-wrap gap-1.5 ${ligada ? '' : 'opacity-60'}`}>
          {data.users.map((u) => {
            const on = !data.disabledUserIds.includes(u.id);
            return (
              <button key={u.id} type="button" onClick={() => toggleUser(u.id)} disabled={saving} className={chip(on)}>
                {on && <Check size={11} />}{u.name}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function SendLocationReport() {
  const [from, setFrom] = useState(diasAtras(7));
  const [to, setTo] = useState(hoje());
  const [userId, setUserId] = useState('');
  const { data: cfg } = useQuery<PromptCfg>({ queryKey: ['send-location-settings'], queryFn: fetchCfg });
  // Uma pessoa escolhida = o servidor filtra por ela (Fabio 31/10). Antes filtrava aqui dentro dos 1000 pontos mais recentes da equipe toda, e com
  // 1 ponto por minuto quem não abriu o CRM nas últimas horas nem aparecia na lista.
  const { data, isLoading, isError, refetch, isFetching } = useQuery<Row[]>({
    queryKey: ['location-events', from, to, userId],
    queryFn: async () => (await api.get('/api/messages/location-events', { params: { from: `${from}T00:00:00-03:00`, to: `${to}T23:59:59-03:00`, ...(userId ? { userId } : {}) } })).data,
  });
  // A equipe toda (mesmo quem não tem ponto no período) + quem só aparece nos pontos (ex.: usuário que saiu).
  const pessoas = useMemo(() => {
    const m = new Map<string, string>((cfg?.users || []).map((u) => [u.id, u.name]));
    (data || []).forEach((r) => { if (!m.has(r.userId)) m.set(r.userId, r.userName); });
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [cfg, data]);
  const rows = useMemo(() => (data || []).filter((r) => !userId || r.userId === userId), [data, userId]);
  const comLocal = rows.filter((r) => r.status === 'OK').length;
  const nomeEscolhido = userId ? pessoas.find(([id]) => id === userId)?.[1] || 'essa pessoa' : '';
  const ultimo = userId ? rows.find((r) => r.status === 'OK' && r.latitude !== null && r.longitude !== null) : undefined; // rows vem do mais recente
  const cortado = (data || []).length >= limite(userId);
  // Mapa: só os pontos com localização. Liga os pontos (rota) quando está filtrado por uma pessoa.
  const pontos = useMemo<MapPoint[]>(() => rows
    .filter((r) => r.status === 'OK' && r.latitude !== null && r.longitude !== null)
    .map((r) => ({ id: r.id, lat: r.latitude as number, lng: r.longitude as number, label: r.userName, sub: `${quando(r.createdAt)} · ${r.kind === 'send' ? `Mensagem${r.leadName ? ` · ${r.leadName}` : ''}` : 'Abriu o CRM'}`, order: new Date(r.createdAt).getTime(), href: `https://www.google.com/maps?q=${r.latitude},${r.longitude}` })), [rows]);

  return (
    <div className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-af-border bg-gradient-to-r from-af-blue to-af-mid">
        <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center"><MapPin size={22} className="text-white" /></div>
        <div>
          <h2 className="text-white font-bold text-base">Localização da equipe</h2>
          <p className="text-white/70 text-xs">Onde cada pessoa estava ao abrir o CRM (de 1 em 1 min) e ao mandar mensagem</p>
        </div>
      </div>

      <div className="px-6 py-5 space-y-4">
        <PromptSettings />

        <p className="text-xs text-slate-500">
          O CRM marca a localização quando a pessoa <strong>abre o app</strong> e, enquanto fica aberto, <strong>de 1 em 1 minuto</strong>. Para quando o app é fechado (o celular não roda o site de fundo).
          A localização só aparece quando o aparelho já permite localização pro CRM. No iPhone: Ajustes → Apps → Safari → Localização → <strong>Permitir</strong>, e
          Privacidade e Segurança → Serviços de Localização → Sites do Safari → <strong>Durante o Uso do App</strong> com <strong>Localização Precisa</strong> ligada.
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500">De<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="block mt-1 px-2 py-1.5 border border-af-border rounded-lg text-sm text-slate-700" /></label>
          <label className="text-xs text-slate-500">Até<input type="date" value={to} min={from} max={hoje()} onChange={(e) => setTo(e.target.value)} className="block mt-1 px-2 py-1.5 border border-af-border rounded-lg text-sm text-slate-700" /></label>
          <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-af-border rounded-lg hover:bg-slate-100 text-slate-600">
            <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} /> Atualizar
          </button>
        </div>

        <div>
          <p className="text-xs text-slate-500 mb-1.5">Ver a localização de:</p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setUserId('')} className={chip(!userId)}>{!userId && <Check size={11} />}Toda a equipe</button>
            {pessoas.map(([id, nome]) => (
              <button key={id} type="button" onClick={() => setUserId(userId === id ? '' : id)} className={chip(userId === id)}>
                {userId === id && <Check size={11} />}{nome}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={14} className="animate-spin" /> Carregando…</div>
        ) : isError ? (
          <p className="text-sm text-rose-500">Não consegui carregar o relatório.</p>
        ) : !rows.length ? (
          <p className="text-sm text-slate-400">{userId ? <>Nenhuma localização de <strong>{nomeEscolhido}</strong> nesse período.</> : 'Nenhuma localização da equipe nesse período.'}</p>
        ) : (
          <>
            {userId && (
              <p className="text-sm text-slate-700">
                {ultimo
                  ? <>Última localização de <strong>{nomeEscolhido}</strong>: {quando(ultimo.createdAt)} · <a href={`https://www.google.com/maps?q=${ultimo.latitude},${ultimo.longitude}`} target="_blank" rel="noreferrer" className="text-af-blue hover:underline">Abrir no mapa do celular</a></>
                  : <>Nenhum ponto de <strong>{nomeEscolhido}</strong> com localização nesse período.</>}
              </p>
            )}
            <p className="text-xs text-slate-500">{rows.length} ponto{rows.length > 1 ? 's' : ''} · {comLocal} com localização</p>
            {cortado && (
              <p className="text-[11px] text-amber-600">Período grande: mostrando só os {limite(userId)} pontos mais recentes{userId ? '. Diminua o período para ver os mais antigos.' : ' da equipe toda. Escolha uma pessoa ou diminua o período.'}</p>
            )}
            {pontos.length > 0 && (
              <div className="space-y-1">
                <LocationMap points={pontos} route={!!userId} />
                <p className="text-[11px] text-slate-400">{userId ? 'A linha liga os pontos na ordem do dia; o ponto verde é o mais recente. Clique num ponto para ver a hora.' : 'Escolha uma pessoa acima para ver só ela no mapa e a rota (os pontos ligados na ordem do dia).'}</p>
              </div>
            )}
            <div className="overflow-x-auto -mx-6">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-af-border">
                    <th className="px-6 py-2 font-medium">Quando</th>
                    <th className="px-2 py-2 font-medium">Quem</th>
                    <th className="px-2 py-2 font-medium">O quê</th>
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
                        <td className="px-2 py-2">
                          {r.kind === 'send'
                            ? <a href={`/inbox?leadId=${r.leadId}`} className="hover:underline">Mensagem{r.leadName ? ` · ${r.leadName}` : ''}</a>
                            : <span className="text-slate-400">Abriu o CRM</span>}
                        </td>
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

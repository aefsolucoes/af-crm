'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ExternalLink, FileText, Landmark, Play, Square, Star } from 'lucide-react';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { toast } from '@/components/ui/toast';
import { pingExtensions } from '@/lib/credit-extensions';
import { NotifyClientModal } from '@/components/credit/notify-modal';
import { BANKS, Badge, STATUS, useLeadAnalyses, sameWho, overrideSummary, PropostasRodadas, propostasRodadas, type Analysis, type Bank } from '@/components/credit/shared';
import { formatCurrency } from '@/lib/utils';

/* Bloco "Análises de crédito" dentro do card (aba Financiamento). Mostra o último resultado de
 * cada banco, dispara nova análise e escolhe a proposta. Ver a aba /analise-credito. */

type SimDoc = { id: string; institution: string; status: 'REQUESTED' | 'RUNNING' | 'READY' | 'DONE' | 'FAILED'; detail: string | null; createdAt: string };

export function LeadCreditAnalysis({ leadId, onChanged }: { leadId: string; onChanged?: () => void }) {
  const queryClient = useQueryClient();
  const { data } = useLeadAnalyses(leadId);
  const [running, setRunning] = useState(false);
  const [banks, setBanks] = useState<Bank[]>(['CREDIMORAR', 'CREDITAS', 'INTER']);
  const [busy, setBusy] = useState(false);
  const [force, setForce] = useState(false);
  const [notify, setNotify] = useState(false);
  const [simBusy, setSimBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { data: simDocs } = useQuery<SimDoc[]>({
    queryKey: ['sim-docs', leadId],
    queryFn: async () => (await api.get('/api/credit-analysis/simulation-docs', { params: { leadId } })).data,
    refetchInterval: (q) => ((q.state.data as SimDoc[] | undefined)?.some((d) => d.status === 'REQUESTED' || d.status === 'RUNNING' || d.status === 'READY') ? 8000 : false),
  });

  useEffect(() => {
    const socket = getSocket();
    const on = () => { queryClient.invalidateQueries({ queryKey: ['credit-lead', leadId] }); queryClient.invalidateQueries({ queryKey: ['sim-docs', leadId] }); };
    socket.on('credit_analysis_updated', on);
    return () => { socket.off('credit_analysis_updated', on); };
  }, [leadId, queryClient]);

  if (!data || (!data.eligible && data.history.length === 0)) return null;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['credit-lead', leadId] });
    queryClient.invalidateQueries({ queryKey: ['credit-board'] });
  };
  const sentBefore = banks.filter((b) => {
    const a = data.latest[b];
    return a && ['SENT', 'APPROVED', 'CONDITIONAL', 'REJECTED', 'CHECK'].includes(a.status);
  });
  const offline = banks.filter((b) => !data.extensions?.[b]?.online);

  async function run() {
    setBusy(true);
    try {
      const { data: r } = await api.post('/api/credit-analysis/requests', { leadIds: [leadId], banks, force });
      pingExtensions(data?.extensions, banks);
      toast(r.created ? `${r.created} na fila${r.consulted?.length ? ' · onde já foi rodado, só consulta a proposta' : ''}` : 'Já estava rodando', 'success');
      setRunning(false);
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir a análise', 'error');
    } finally { setBusy(false); }
  }

  // STOP (Fabio 21/10: "um botão escrito stop, pra parar no meio caso a extensão esteja rodando"): STOP TOTAL só deste cliente — derruba a rodada em andamento (a extensão tira a aba do banco do meio do formulário)
  // e para tudo que roda sozinho, inclusive a IA. Retomar volta o automático.
  const rodandoAgora = BANKS.some((b) => ['REQUESTED', 'RUNNING'].includes(data.latest[b.key]?.status || ''));
  async function togglePause() {
    const next = !data?.autoPaused;
    if (next && !window.confirm('STOP: parar TUDO deste cliente?\n\n• A rodada em andamento nos bancos é interrompida no meio (o banco pode ficar com um rascunho/proposta incompleta).\n• Nada roda, refaz, confere nem avisa o cliente sozinho; a IA para de responder.\n• Só este cliente. Para voltar, clique em Retomar.')) return;
    try {
      const { data: r } = await api.put('/api/credit-analysis/pause', { leadId, paused: next });
      toast(next ? `PARADO${r?.interrompidas ? ` — ${r.interrompidas} rodada(s) interrompida(s)` : ''}. A extensão derruba a aba do banco no próximo passo (até ~10 s).` : 'Retomado', 'success');
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao parar o cliente', 'error');
    }
  }

  // Botão da linha REPROVADA (Fabio 21/10): roda de novo só aquele banco, daquele participante (no 2º liga a inversão só naquele banco), com proposta nova.
  const [rerunKey, setRerunKey] = useState<string | null>(null);
  async function rerunBank(bank: Bank, who: 'p1' | 'p2') {
    const short = BANKS.find((x) => x.key === bank)?.short;
    if (rerunKey || !window.confirm(`Rodar de novo no ${short}? Isso cria uma proposta nova no banco${overrideSummary(data?.overrides?.[bank]) ? ', com o ajuste que você fez' : ''}.`)) return;
    setRerunKey(`${bank}-${who}`);
    try {
      const inverted = !!data?.overrides?.[bank]?.inverter;
      if ((who === 'p2') !== inverted) await api.put('/api/credit-analysis/overrides', { leadId, banks: [bank], data: { inverter: who === 'p2' }, merge: true });
      const { data: r } = await api.post('/api/credit-analysis/requests', { leadIds: [leadId], banks: [bank], force: true });
      pingExtensions(data?.extensions, [bank]);
      toast(r.created ? `${short} na fila${r.queuedBehind ? ' — a extensão está ocupada, roda quando ela terminar' : ''}` : `${short}: já está na fila ou rodando`, r.created ? 'success' : 'error');
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir a análise', 'error');
    } finally { setRerunKey(null); }
  }

  async function choose(a: Analysis) {
    const bank = BANKS.find((b) => b.key === a.bank)?.short;
    if (!window.confirm(`Escolher a proposta ${bank}? Isso preenche os campos do Financiamento deste card com ela.`)) return;
    try {
      await api.post(`/api/credit-analysis/${a.id}/choose`);
      toast('Proposta escolhida — Financiamento preenchido', 'success');
      refresh();
      onChanged?.();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao escolher', 'error');
    }
  }

  // Santander vem pela extensão do Credimorar; Inter pela extensão do Inter (ela só lê os dados e o CRM monta o PDF no modelo da A&F).
  type SimInst = 'SANTANDER' | 'INTER' | 'CREDITAS';
  const SIM_LABEL: Record<SimInst, string> = { SANTANDER: 'Santander', INTER: 'Inter', CREDITAS: 'Creditas' };
  const SIM_BANK: Record<SimInst, Bank> = { SANTANDER: 'CREDIMORAR', INTER: 'INTER', CREDITAS: 'CREDITAS' };
  async function sendSimulation(inst: SimInst) {
    const label = SIM_LABEL[inst];
    if (!window.confirm(`Mandar ao cliente, pelo WhatsApp, o PDF da simulação do ${label} (com a logo da A&F)? A extensão lê a simulação no portal do banco e o CRM envia sozinho.`)) return;
    setSimBusy(inst);
    try {
      const { data: r } = await api.post('/api/credit-analysis/simulation-docs', { leadId, institutions: [inst] });
      pingExtensions(data?.extensions, [SIM_BANK[inst]]);
      toast(r.created?.length ? `Pedido feito: o PDF do ${label} sai em instantes` : 'Já tem um pedido desse PDF em andamento', 'success');
      queryClient.invalidateQueries({ queryKey: ['sim-docs', leadId] });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir o PDF', 'error');
    } finally { setSimBusy(null); }
  }

  const simOpen = (simDocs || []).filter((d) => d.status === 'REQUESTED' || d.status === 'RUNNING' || d.status === 'READY');
  const simRecent = (simDocs || []).slice(0, 3);

  return (
    <div className="mb-3 rounded-lg border border-af-border bg-slate-50/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600"><Landmark size={12} /> Análises de crédito</span>
        {Object.values(data.latest).some((a) => a && (a.status === 'APPROVED' || a.status === 'CONDITIONAL') && !!a.approvedValue) && (
          <button onClick={() => setNotify(true)} className="text-[11px] text-white bg-af-mid hover:bg-af-dark rounded px-2 py-0.5" title="Mandar ao cliente as opções aprovadas">Avisar cliente</button>
        )}
        {data.rejectionPending && (
          <button
            onClick={async () => {
              if (!confirm('Avisar o cliente que não foi aprovado e mandar o card para Perdidos?')) return;
              try {
                const { data: r } = await api.post('/api/credit-analysis/notify-rejection', { leadId });
                toast(r?.scheduled ? 'Fora do horário: a negativa sai às 07h e o card vai pra Perdidos em seguida' : 'Negativa enviada e card movido pra Perdidos');
                refresh(); onChanged?.();
              } catch (e: any) { toast(e?.response?.data?.error || 'Não consegui avisar a negativa', 'error'); }
            }}
            className="text-[11px] text-white bg-red-600 hover:opacity-90 rounded px-2 py-0.5"
            title="Todos os bancos disseram não e a IA deste card está desligada: manda a negativa e move o card pra Perdidos"
          >Avisar negativa</button>
        )}
        {(rodandoAgora || data.autoPaused) && (
          <button onClick={togglePause} className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded font-semibold ${data.autoPaused ? 'border border-emerald-300 text-emerald-700 hover:bg-emerald-50' : 'bg-red-600 text-white hover:opacity-90'}`} title="STOP TOTAL só deste cliente: derruba a rodada em andamento e para tudo, inclusive a IA">
            {data.autoPaused ? <><Play size={10} /> Retomar</> : <><Square size={10} className="fill-current" /> STOP</>}
          </button>
        )}
        <Link href={`/analise-credito?leadId=${leadId}`} className="flex items-center gap-1 text-[11px] text-af-mid hover:underline" title="Abrir na aba Análise de Crédito (resultado manual e histórico)">
          Ver na Análise de Crédito <ExternalLink size={10} />
        </Link>
      </div>

      {data.participants?.name2 && (
        <div className="mb-2 text-[11px] text-slate-500 leading-snug">
          Titular: <span className="font-medium text-slate-600">{data.participants.inverted ? data.participants.name2 : data.participants.name1}</span>
          {' · '}2º participante: <span className="font-medium text-slate-600">{data.participants.inverted ? data.participants.name1 : data.participants.name2}</span>
          {data.participants.inverted && <span className="text-amber-600"> (invertidos na análise)</span>}
        </div>
      )}

      {data.onlyFollowed && data.followed && (
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
          <span className="font-medium text-emerald-700">Proposta aprovada que o cliente vai seguir</span>
          <button onClick={() => setShowAll((v) => !v)} className="text-af-mid hover:underline">{showAll ? 'Mostrar só a aprovada' : 'Ver todas as análises'}</button>
        </div>
      )}
      <div className="space-y-2">
        {(data.onlyFollowed && data.followed && !showAll
          ? (() => {
              const f = data.followed as Analysis;
              const bk = BANKS.find((x) => x.key === f.bank);
              const segundo = !!(f.holderName && data.participants?.name1 && !sameWho(f.holderName, data.participants.name1));
              return bk ? [{ b: bk, a: f as Analysis | undefined, who: (segundo ? 'p2' : 'p1') as 'p1' | 'p2' }] : [];
            })()
          : BANKS.flatMap((b) => {
              const a1 = data.latestP1?.[b.key], a2 = data.latestP2?.[b.key];
              // Resultado dos dois participantes no mesmo banco: uma linha pra cada.
              const itens = a1 && a2 ? [{ a: a1, who: 'p1' as const }, { a: a2, who: 'p2' as const }] : [{ a: data.latest[b.key], who: (a2 && !a1 ? 'p2' : 'p1') as 'p1' | 'p2' }];
              return itens.map((it) => ({ b, ...it }));
            })
        ).map(({ b, a, who }) => {
          const hasP2 = Object.keys(data.latestP2 || {}).length > 0;
          const approved = a?.status === 'APPROVED' || a?.status === 'CONDITIONAL';
          const maxParcel = a ? (/parcela m[aá]xima\s*(R\$\s*[\d.]+,\d{2})/i.exec(a.detail || '') || [])[1] : '';
          const second = a?.holderName && data.participants?.name1 && !sameWho(a.holderName, data.participants.name1) ? a.holderName : '';
          // "Carta de aprovação": valor, prazo, taxa, parcelas, nº da proposta e em nome de quem saiu (substitui os campos soltos de Financiamento).
          const letter: [string, string][] = approved && a ? ([
            ['Valor aprovado', a.approvedValue ? formatCurrency(a.approvedValue) : ''],
            ['Valor líquido', a.netValue ? formatCurrency(a.netValue) : ''],
            ['Prazo', a.termMonths ? `${a.termMonths} meses` : ''],
            ['Taxa', a.rate || ''],
            ['1ª parcela', a.firstInstallment ? formatCurrency(a.firstInstallment) : ''],
            ['Última parcela', a.lastInstallment ? formatCurrency(a.lastInstallment) : ''],
            ['Parcela máxima', !a.firstInstallment && maxParcel ? maxParcel : ''],
            ['Proposta nº', a.proposalNumber || ''],
          ] as [string, string][]).filter(([, v]) => v) : [];
          return (
            <div key={`${b.key}-${who}`} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-600 font-medium">{b.short}{hasP2 && <span className="font-normal text-slate-400"> · {who === 'p2' ? '2º participante' : '1º participante'}</span>}</span>
                <div className="flex items-center gap-1.5">
                  <Badge a={a} />
                </div>
              </div>
              {second && <div className="text-[11px] text-amber-600 font-medium mt-0.5">{a && (a.status === 'APPROVED' || a.status === 'CONDITIONAL') ? 'Aprovado' : a && a.status === 'REJECTED' ? 'Reprovado' : 'Analisado'} no nome de {second} (2º participante)</div>}
              {letter.length > 0 && (
                <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] rounded-md bg-white border border-af-border px-2 py-1.5">
                  {letter.map(([k, v]) => <div key={k} className="contents"><dt className="text-slate-400">{k}</dt><dd className="text-slate-700 text-right">{v}</dd></div>)}
                </dl>
              )}
              {a && !['APPROVED', 'CONDITIONAL'].includes(a.status) && <PropostasRodadas lista={propostasRodadas(data.history, b.key, hasP2 ? who : undefined, data.participants?.name1)} />}
              {a && a.status !== 'APPROVED' && a.detail && ['CONDITIONAL', 'REJECTED', 'FAILED', 'CHECK', 'INCOMPLETE'].includes(a.status) && (
                <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-2" title={a.detail}>{a.detail}</div>
              )}
              {(a?.status === 'REJECTED' || (!!a && !!overrideSummary(data.overrides?.[b.key]))) && (
                <div className="mt-1">
                  <button onClick={() => rerunBank(b.key, who)} disabled={!!rerunKey} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-af-accent text-af-accent hover:bg-af-accent/10 disabled:opacity-50"><Play size={10} className={rerunKey === `${b.key}-${who}` ? 'animate-pulse' : ''} /> {a?.status !== 'REJECTED' ? 'Rodar de novo com o ajuste' : 'Rodar de novo'}</button>
                </div>
              )}
              {(a?.status === 'APPROVED' || a?.status === 'CONDITIONAL') && (
                <div className="mt-1">
                  {a.chosen
                    ? <span className="flex items-center gap-1 text-[11px] text-amber-600"><Star size={10} className="fill-amber-400" /> Proposta escolhida</span>
                    : <button onClick={() => choose(a)} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-af-mid text-white hover:bg-af-dark"><Star size={10} /> Escolher esta proposta</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 pt-2 border-t border-af-border">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-[11px] font-medium text-slate-600"><FileText size={11} /> Simulação em PDF pro cliente</span>
          <div className="flex gap-1.5">
            {(['SANTANDER', 'INTER', 'CREDITAS'] as const).map((inst) => (
              <button key={inst} onClick={() => sendSimulation(inst)} disabled={!!simBusy || simOpen.some((d) => d.institution === inst)} className="text-[11px] px-2 py-0.5 rounded border border-af-mid text-af-mid hover:bg-af-mid hover:text-white disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-af-mid" title={`Lê a simulação do ${SIM_LABEL[inst]} no portal do banco e manda ao cliente em PDF com a logo da A&F`}>
                {SIM_LABEL[inst]}
              </button>
            ))}
          </div>
        </div>
        {(['SANTANDER', 'INTER', 'CREDITAS'] as const).filter((inst) => !data.extensions?.[SIM_BANK[inst]]?.online).map((inst) => (
          <p key={inst} className="mt-1 text-[11px] text-amber-600">Extensão do {SIM_LABEL[inst]} sem sinal: o pedido espera até ela abrir no Chrome (falha depois de 15 min).</p>
        ))}
        {simRecent.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {simRecent.map((d) => (
              <li key={d.id} className="text-[11px] text-slate-500 flex items-start gap-1.5">
                <span className={d.status === 'DONE' ? 'text-emerald-600' : d.status === 'FAILED' ? 'text-red-500' : 'text-amber-600'}>
                  {d.status === 'DONE' ? '✓ enviado' : d.status === 'FAILED' ? '✗ não saiu' : d.status === 'RUNNING' ? '… baixando' : '… na fila'}
                </span>
                <span>{SIM_LABEL[d.institution as SimInst] || d.institution}{d.status === 'FAILED' && d.detail ? ` — ${d.detail}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-2 text-[10px] leading-snug text-slate-400">Instituição, taxa, parcelas e nº da proposta vêm daqui (as análises dos bancos): são os dados verdadeiros usados no aviso de aprovação.</p>

      <div className="mt-3 pt-2 border-t border-af-border">
        {!running ? (
          <button onClick={() => setRunning(true)} className="flex items-center gap-1 text-xs text-af-mid hover:text-af-dark"><Play size={11} /> Rodar análise</button>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {BANKS.map((b) => (
                <label key={b.key} className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer">
                  <input type="checkbox" checked={banks.includes(b.key)} onChange={() => setBanks((p) => p.includes(b.key) ? p.filter((x) => x !== b.key) : [...p, b.key])} />
                  {b.short}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">A extensão envia a proposta de verdade ao banco.</p>
            {sentBefore.length > 0 && (
              <label className="flex items-start gap-1.5 text-[11px] text-slate-500 cursor-pointer"><input type="checkbox" className="mt-0.5" checked={force} onChange={(e) => setForce(e.target.checked)} /> <span>Rodar de novo mesmo assim (cria proposta nova). Sem marcar, onde já foi rodado só consulto a proposta.</span></label>
            )}
            {sentBefore.length > 0 && (
              <p className="text-[11px] text-amber-600">Já tem análise em {sentBefore.map((b) => `${BANKS.find((x) => x.key === b)!.short} (${STATUS[data.latest[b]!.status].label.toLowerCase()})`).join(', ')} — {force ? 'vai criar proposta NOVA.' : 'só vou consultar a proposta.'}</p>
            )}
            {offline.length > 0 && (
              <p className="text-[11px] text-amber-600">Extensão sem sinal: {offline.map((b) => BANKS.find((x) => x.key === b)!.short).join(', ')}. O pedido espera na fila até ela abrir no Chrome.</p>
            )}
            <div className="flex gap-2">
              <button onClick={run} disabled={busy || !banks.length} className="text-xs bg-af-mid text-white rounded px-3 py-1 hover:bg-af-dark disabled:opacity-50">{busy ? 'Enviando…' : 'Enviar aos bancos'}</button>
              <button onClick={() => setRunning(false)} className="text-xs text-slate-500 hover:text-slate-700 px-2">Cancelar</button>
            </div>
          </div>
        )}
      </div>
      {notify && <NotifyClientModal leadId={leadId} leadName={data.participants?.name1 || 'cliente'} onClose={() => setNotify(false)} onSent={refresh} />}
    </div>
  );
}

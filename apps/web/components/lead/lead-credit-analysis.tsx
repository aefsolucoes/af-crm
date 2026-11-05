'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ExternalLink, FileText, Landmark, Play, Send, Square, Star } from 'lucide-react';
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
  const [fwdId, setFwdId] = useState<string | null>(null);
  const [buscaBusy, setBuscaBusy] = useState<string | null>(null);
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

  if (!data || (!data.eligible && data.history.length === 0 && !data.avisosSemAnalise?.length)) return null;

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
      if ((who === 'p2') !== inverted || !data?.overrides?.[bank]?.escolhaManual) await api.put('/api/credit-analysis/overrides', { leadId, banks: [bank], data: { inverter: who === 'p2', escolhaManual: true }, merge: true }); // escolha da equipe: a regra do formato da aprovação não troca (05/11)
      const { data: r } = await api.post('/api/credit-analysis/requests', { leadIds: [leadId], banks: [bank], force: true });
      pingExtensions(data?.extensions, [bank]);
      toast(r.created ? `${short} na fila${r.queuedBehind ? ' — a extensão está ocupada, roda quando ela terminar' : ''}` : `${short}: já está na fila ou rodando`, r.created ? 'success' : 'error');
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir a análise', 'error');
    } finally { setRerunKey(null); }
  }

  // "Encaminhar aprovação ao cliente" (Fabio 02/11): só os dados DESTA proposta, com o botão "Seguir com esta", + o PDF da simulação quando o banco tem.
  async function forward(a: Analysis) {
    const bank = BANKS.find((x) => x.key === a.bank)?.short || a.bank;
    const temPdf = a.bank === 'INTER' || a.bank === 'CREDIMORAR';
    if (fwdId || !window.confirm(`Encaminhar ao cliente, pelo WhatsApp, a aprovação do ${bank}${a.approvedValue ? ` (${formatCurrency(a.approvedValue)})` : ''}${temPdf ? ' e o PDF da simulação' : ''}?`)) return;
    setFwdId(a.id);
    try {
      const { data: r } = await api.post(`/api/credit-analysis/${a.id}/forward`, { leadId });
      toast(r.pdf === 'pedido' ? 'Aprovação enviada; o PDF da simulação sai em 1–2 min' : r.pdf === 'andamento' ? 'Aprovação enviada; o PDF da simulação já estava sendo gerado' : r.pdf === 'outra' ? 'Aprovação enviada (sem PDF: a extensão só baixa a proposta maior/escolhida desse banco)' : 'Aprovação enviada ao cliente', 'success');
      refresh(); onChanged?.();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui encaminhar a proposta', 'error');
    } finally { setFwdId(null); }
  }

  async function buscarPortal() {
    setBuscaBusy('buscar');
    try {
      await api.post('/api/credit-analysis/busca-portal', { leadId, bank: 'INTER' });
      pingExtensions(data?.extensions, ['INTER']);
      toast('Busca na fila: a extensão do Inter procura as propostas deste cliente no portal', 'success');
      refresh();
    } catch (err: any) { toast(err?.response?.data?.error || 'Não consegui pedir a busca', 'error'); } finally { setBuscaBusy(null); }
  }

  async function escolherPortal(numero: string) {
    setBuscaBusy(numero);
    try {
      await api.post(`/api/credit-analysis/busca-portal/${leadId}/escolher`, { bank: 'INTER', numero });
      toast(`Proposta ${numero} escolhida`, 'success');
      refresh(); onChanged?.();
    } catch (err: any) { toast(err?.response?.data?.error || 'Não consegui escolher a proposta', 'error'); } finally { setBuscaBusy(null); }
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

      {data.cardProposal && !data.latest[data.cardProposal.bank] && (
        <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          A proposta <b>{data.cardProposal.numero}</b> ({BANKS.find((b) => b.key === data.cardProposal!.bank)?.short || data.cardProposal.bank}) está só anotada no card — o CRM ainda não leu as condições dela.
          <button
            onClick={async () => {
              setBusy(true);
              try {
                const { data: r } = await api.post('/api/credit-analysis/requests', { leadIds: [leadId], banks: [data.cardProposal!.bank], kind: 'CHECK' });
                pingExtensions(data?.extensions, [data.cardProposal!.bank]);
                toast(r.created ? 'Conferência na fila: a extensão lê a proposta no portal e as condições aparecem aqui' : 'Já tem uma leitura em andamento nesse banco', 'success');
                refresh();
              } catch (err: any) { toast(err?.response?.data?.error || 'Não consegui pedir a conferência', 'error'); } finally { setBusy(false); }
            }}
            disabled={busy}
            className="ml-1 inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >Conferir no portal</button>
        </div>
      )}

      {data.participants?.name2 && (
        <div className="mb-2 text-[11px] text-slate-500 leading-snug">
          Titular: <span className="font-medium text-slate-600">{data.participants.inverted ? data.participants.name2 : data.participants.name1}</span>
          {' · '}2º participante: <span className="font-medium text-slate-600">{data.participants.inverted ? data.participants.name1 : data.participants.name2}</span>
          {data.participants.inverted && <span className="text-amber-600"> (invertidos na análise)</span>}
        </div>
      )}

      {!!data.avisosSemAnalise?.length && (
        <div className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-800">
          <div className="font-medium">Aprovação avisada ao cliente sem análise registrada no CRM (lançada à mão no card)</div>
          {data.avisosSemAnalise.map((v) => (
            <div key={`${v.inst}-${v.val}`}>{v.inst} · {v.val}{v.prazo ? ` · ${v.prazo}` : ''}{v.parcela ? ` · 1ª parcela ${v.parcela}` : ''} · avisado em {new Date(v.at).toLocaleDateString('pt-BR')}</div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {(() => {
          // Todos os bancos, sempre (Fabio 02/11: "não apenas a aprovada, igual é hoje"): aprovação, reprovação ou desqualificação de cada um. A proposta que o cliente vai seguir
          // fica marcada; se a rodada mais nova do banco dela não é ela (pediu outro valor e a nova foi recusada — caso Edson), ela aparece em cima, numa linha só dela.
          const linhas = BANKS.flatMap((b) => {
            const a1 = data.latestP1?.[b.key], a2 = data.latestP2?.[b.key];
            // Resultado dos dois participantes no mesmo banco: uma linha pra cada.
            const itens = a1 && a2 ? [{ a: a1, who: 'p1' as const }, { a: a2, who: 'p2' as const }] : [{ a: data.latest[b.key], who: (a2 && !a1 ? 'p2' : 'p1') as 'p1' | 'p2' }];
            return itens.map((it) => ({ b, ...it, seguir: false }));
          });
          const f = data.followed;
          const fb = f ? BANKS.find((x) => x.key === f.bank) : undefined;
          if (!f || !fb || linhas.some((l) => l.a?.id === f.id)) return linhas;
          const segundoF = !!(f.holderName && data.participants?.name1 && !sameWho(f.holderName, data.participants.name1));
          return [{ b: fb, a: f as Analysis | undefined, who: (segundoF ? 'p2' : 'p1') as 'p1' | 'p2', seguir: true }, ...linhas];
        })().map(({ b, a, who, seguir }) => {
          const hasP2 = Object.keys(data.latestP2 || {}).length > 0;
          const approved = a?.status === 'APPROVED' || a?.status === 'CONDITIONAL';
          const maxParcel = a ? (/parcela m[aá]xima\s*(R\$\s*[\d.]+,\d{2})/i.exec(a.detail || '') || [])[1] : '';
          const second = a?.holderName && data.participants?.name1 && !sameWho(a.holderName, data.participants.name1) ? a.holderName : '';
          // Rodada nova na fila/rodando/no banco: o último resultado do banco (aprovado, reprovado ou desqualificado) continua à vista até o novo sair (Fabio 02/11).
          const ehP1 = (h: Analysis) => !h.holderName || !data.participants?.name1 || sameWho(h.holderName, data.participants.name1);
          const anterior = a && ['REQUESTED', 'RUNNING', 'SENT'].includes(a.status)
            ? data.history.find((h) => h.bank === b.key && h.id !== a.id && !h.dryRun && h.source !== 'AI_SIM' && ['APPROVED', 'CONDITIONAL', 'REJECTED', 'FAILED'].includes(h.status) && h.createdAt < a.createdAt && (!hasP2 || (who === 'p1') === ehP1(h)))
            : undefined;
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
            <div key={`${b.key}-${who}${seguir ? '-seguir' : ''}`} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-600 font-medium">{b.short}{hasP2 && <span className="font-normal text-slate-400"> · {who === 'p2' ? '2º participante' : '1º participante'}</span>}</span>
                <div className="flex items-center gap-1.5">
                  <Badge a={a} />
                </div>
              </div>
              {a && data.followed?.id === a.id && <div className="text-[11px] text-emerald-700 font-medium mt-0.5">Proposta aprovada que o cliente vai seguir{seguir ? ' — a rodada mais nova deste banco está abaixo' : ''}</div>}
              {anterior && (
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500"><span>Resultado anterior</span><Badge a={anterior} /></div>
              )}
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
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {a.chosen
                    ? <span className="flex items-center gap-1 text-[11px] text-amber-600"><Star size={10} className="fill-amber-400" /> Proposta escolhida</span>
                    : <button onClick={() => choose(a)} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-af-mid text-white hover:bg-af-dark"><Star size={10} /> Escolher esta proposta</button>}
                  {a.approvedValue != null && (
                    <button onClick={() => forward(a)} disabled={!!fwdId} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-emerald-600 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50" title="Manda ao cliente, pelo WhatsApp, os dados desta proposta (com o botão Seguir com esta) e o PDF da simulação quando o banco tem">
                      <Send size={10} /> {fwdId === a.id ? 'Encaminhando…' : 'Encaminhar aprovação ao cliente'}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(() => {
        // Todas as aprovações (Fabio 05/11, Fernanda): as que não estão nas linhas dos bancos acima (rodadas antigas, outro participante), cada uma com "Escolher".
        const acima = new Set([...Object.values(data.latest), ...Object.values(data.latestP1 || {}), ...Object.values(data.latestP2 || {}), data.followed]
          .filter(Boolean).map((a) => `${a!.bank}|${a!.proposalNumber || a!.id}`));
        const outras = (data.aprovacoes || []).filter((a) => !acima.has(`${a.bank}|${a.proposalNumber || a.id}`));
        const sem = data.semResultado || [];
        if (!outras.length && !sem.length) return null;
        const data2 = (d: string) => new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        return (
          <div className="mt-3 pt-2 border-t border-af-border space-y-1.5">
            {outras.length > 0 && <div className="text-[11px] font-medium text-slate-600">Outras aprovações deste cliente ({outras.length})</div>}
            {outras.map((a) => (
              <div key={a.id} className="rounded-md bg-white border border-af-border px-2 py-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-600 font-medium">{BANKS.find((b) => b.key === a.bank)?.short || a.bank}{a.proposalNumber ? ` · nº ${a.proposalNumber}` : ''} <span className="font-normal text-slate-400">· {data2(a.createdAt)}{a.holderName ? ` · ${a.holderName.split(' ')[0]}` : ''}</span></span>
                  <Badge a={a} />
                </div>
                <div className="text-slate-600 mt-0.5">
                  {[a.approvedValue ? formatCurrency(a.approvedValue) : '', a.termMonths ? `${a.termMonths} meses` : '', a.rate || '', a.firstInstallment ? `1ª parcela ${formatCurrency(a.firstInstallment)}` : ''].filter(Boolean).join(' · ')}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {a.chosen
                    ? <span className="flex items-center gap-1 text-amber-600"><Star size={10} className="fill-amber-400" /> Proposta escolhida</span>
                    : <button onClick={() => choose(a)} className="flex items-center gap-1 px-2 py-0.5 rounded bg-af-mid text-white hover:bg-af-dark"><Star size={10} /> Escolher esta proposta</button>}
                  {a.approvedValue != null && (
                    <button onClick={() => forward(a)} disabled={!!fwdId} className="flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-600 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"><Send size={10} /> {fwdId === a.id ? 'Encaminhando…' : 'Encaminhar ao cliente'}</button>
                  )}
                </div>
              </div>
            ))}
            {sem.map((s) => (
              <div key={`${s.bank}-${s.proposalNumber}`} className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                {BANKS.find((b) => b.key === s.bank)?.short || s.bank} · nº {s.proposalNumber}{s.holderName ? ` · ${s.holderName.split(' ')[0]}` : ''}{s.requestedValue ? ` · pedido ${formatCurrency(s.requestedValue)}` : ''} · enviada {data2(s.enviadaEm)} — o CRM não leu o resultado desta proposta.
              </div>
            ))}
          </div>
        );
      })()}

      {(() => {
        // Buscar propostas no portal do Inter (Fabio 05/11): TODAS as do cliente, inclusive as feitas à mão fora do CRM — pra escolher com qual seguir.
        const bp = data.buscaPortal?.INTER;
        const andando = !!bp && ['FILA', 'RODANDO'].includes(bp.status);
        const escolhidaNum = (data.aprovacoes || []).find((a) => a.chosen)?.proposalNumber || data.history.find((a) => a.chosen)?.proposalNumber || null;
        const quando = (d?: string | null) => (d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
        const dataProp = (d?: string | null) => { if (!d) return ''; const t = Date.parse(d); return Number.isNaN(t) ? String(d).slice(0, 10) : new Date(t).toLocaleDateString('pt-BR'); };
        return (
          <div className="mt-3 pt-2 border-t border-af-border space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-slate-600">Propostas no portal do Inter</span>
              <button onClick={buscarPortal} disabled={andando || !!buscaBusy} className="text-[11px] px-2 py-0.5 rounded border border-af-mid text-af-mid hover:bg-af-mid hover:text-white disabled:opacity-50" title="A extensão do Inter procura no portal TODAS as propostas pelos CPFs do card (inclusive as feitas à mão) — só leitura, não cria proposta">
                {andando ? (bp!.status === 'FILA' ? 'Na fila…' : 'Buscando…') : bp ? 'Buscar de novo' : 'Buscar no portal'}
              </button>
            </div>
            {bp?.status === 'ERRO' && <p className="text-[11px] text-red-600">A busca não saiu: {bp.erro}</p>}
            {bp?.status === 'FEITO' && !(bp.propostas || []).length && <p className="text-[11px] text-slate-500">Nenhuma proposta deste cliente no portal do Inter (busca de {quando(bp.fim)}).</p>}
            {bp?.status === 'FEITO' && !!(bp.propostas || []).length && <p className="text-[10px] text-slate-400">Busca de {quando(bp.fim)}{bp.por ? ` · pedida por ${bp.por}` : ''}</p>}
            {(bp?.propostas || []).map((p) => (
              <div key={p.numero} className={`rounded-md border px-2 py-1.5 text-[11px] ${p.aprovado ? 'bg-white border-emerald-200' : 'bg-white border-af-border'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-600 font-medium">nº {p.numero}<span className="font-normal text-slate-400">{p.data ? ` · ${dataProp(p.data)}` : ''}{p.nome ? ` · ${String(p.nome).split(' ')[0]}` : ''}</span></span>
                  <span className={p.aprovado ? 'text-emerald-700 font-medium' : 'text-slate-500'}>{p.aprovado ? 'Aprovada' : ''}</span>
                </div>
                {p.status && <div className="text-slate-500 mt-0.5">{p.status}</div>}
                <div className="text-slate-600 mt-0.5">
                  {[p.valorAprovado ? `aprovado ${formatCurrency(p.valorAprovado)}` : '', p.valorPedido && p.valorPedido !== p.valorAprovado ? `pedido ${formatCurrency(p.valorPedido)}` : '', p.prazo ? `${p.prazo} meses` : '', p.taxa ? `${p.taxa}${p.indexador && !String(p.taxa).includes(p.indexador) ? ` + ${p.indexador}` : ''}` : '', p.primeira ? `1ª parcela ${formatCurrency(p.primeira)}` : ''].filter(Boolean).join(' · ')}
                </div>
                {p.aprovado && !!p.valorAprovado && (
                  <div className="mt-1">
                    {escolhidaNum === p.numero
                      ? <span className="flex items-center gap-1 text-amber-600"><Star size={10} className="fill-amber-400" /> Proposta escolhida</span>
                      : <button onClick={() => escolherPortal(p.numero)} disabled={!!buscaBusy} className="flex items-center gap-1 px-2 py-0.5 rounded bg-af-mid text-white hover:bg-af-dark disabled:opacity-50"><Star size={10} /> {buscaBusy === p.numero ? 'Escolhendo…' : 'Escolher esta proposta'}</button>}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })()}

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

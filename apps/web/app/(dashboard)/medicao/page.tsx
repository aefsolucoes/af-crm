'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Topbar } from '@/components/ui/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/* Medição da automação (Fabio 19/10): só pra NÓS medirmos o quanto o processo automático acerta e onde a equipe precisa corrigir. Só administrador. Só leitura.
 * Dados: GET /api/automation-metrics?days=N (automation-metrics.service.ts). */

interface Banco { bank: string; label: string; clientes?: number; clientesSemResultado?: number; total: number; aprovadas: number; reprovadas: number; desqualificadas: number; falhas: number; andamento: number; conclusivasPct: number | null; falhaPct: number | null; medianaMin: number | null; p90Min: number | null }
interface Metrics {
  periodoDias: number; geradoEm: string;
  comparacao?: { atual: Kpis; anterior: Kpis };
  resumo: { analises: number; cardsAnalisados: number; conclusivasPct: number | null; falhaPct: number | null; medianaPrimeiroResultadoMin: number | null; avisoAte15minPct: number | null; whatsappFalhaPct: number | null; correcoesPor100: number | null };
  atencao: { nivel: 'alto' | 'medio' | 'info'; texto: string }[];
  bancos: Banco[];
  causasFalha: { bank: string; label: string; causa: string; n: number }[];
  tempos: {
    primeiroResultado: { n: number; medianaMin: number | null; p90Min: number | null };
    aprovacaoAteAviso: { aprovadas: number; avisadas: number; ate15minPct: number | null; medianaMin: number | null; p90Min: number | null };
    semAviso: { id: string; name: string; iaLigada: boolean; horas: number | null }[];
  };
  avisos: { aprovacao: number; negativa: number; aprovacaoSegurada: number; negativaSegurada: number; duplicadosEvitados: number; negativaNaoSaiu: number; whatsapp: { total: number; falhas: number; falhaPct: number | null; erros: { motivo: string; n: number }[] } };
  ia: { respostasAutomaticas: number; perguntasAEquipe: number; humanoAssumiu: number; duvidas: { kind: string; total: number; respondidas: number; abertas: number; medianaMin: number | null }[]; uso: { feature: string; chamadas: number; erros: number; entrada: number; saida: number }[]; custo: { totalUsd: number; porDia: { day: string; usd: number; chamadas: number }[]; porFuncao: { feature: string; usd: number; chamadas: number; entradaMedia: number }[] } };
  correcoes: { feitas: number; desfeitas: number; principais: { acao: string; n: number }[]; reabertosAposFechamentoAutomatico: number; cardsComAjuste: number; resultadosManuais: number };
  extensoes: { bank: string; label: string; online: boolean; lastSeenAt: string | null; loginNeeded?: boolean }[];
}

interface Kpis { conclusivasPct: number | null; falhaPct: number | null; medianaPrimeiroResultadoMin: number | null; avisoAte15minPct: number | null; whatsappFalhaPct: number | null; correcoesPor100: number | null }

const KIND: Record<string, string> = { QUESTION: 'Dúvida de cliente', CALL_REQUEST: 'Pedido de ligação', DOC_QUESTION: 'Dúvida de documento', EMAIL_QUESTION: 'E-mail da Creditas', REJECTION_QUESTION: 'Reprovação temporária', BANK_EMAIL: 'E-mail a banco' };

const fmtMin = (m: number | null | undefined) => {
  if (m == null) return '—';
  if (m < 1) return '< 1 min';
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 60 * 36) return `${(m / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`;
  return `${(m / 1440).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dias`;
};
const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
const fmtN = (v: number) => v.toLocaleString('pt-BR');

/** good: maior é melhor (true) / menor é melhor (false). Verde/amarelo/vermelho só pra chamar a atenção, com os cortes de cada indicador. */
function tone(v: number | null | undefined, good: boolean, ok: number, bad: number): string {
  if (v == null) return 'text-slate-400';
  const pior = good ? v < bad : v > bad;
  const medio = good ? v < ok : v > ok;
  return pior ? 'text-red-600' : medio ? 'text-amber-600' : 'text-emerald-600';
}

/** Variação contra o período anterior: `melhorSeSobe` diz qual lado é bom; `unidade` 'pts' (porcentagem), 'min' ou '' (taxa). null = sem dado de um dos lados. */
function Delta({ atual, anterior, melhorSeSobe, unidade, dias }: { atual: number | null | undefined; anterior: number | null | undefined; melhorSeSobe: boolean; unidade: 'pts' | 'min' | ''; dias: number }) {
  if (atual == null || anterior == null) return <p className="text-[11px] text-slate-300 mt-0.5">sem dados nos {dias} dias anteriores</p>;
  const d = Math.round((atual - anterior) * 10) / 10;
  if (d === 0) return <p className="text-[11px] text-slate-400 mt-0.5">igual aos {dias} dias anteriores</p>;
  const bom = (d > 0) === melhorSeSobe;
  const txt = unidade === 'min' ? fmtMin(Math.abs(d)) : `${Math.abs(d).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}${unidade ? ' ' + unidade : ''}`;
  return <p className={cn('text-[11px] mt-0.5 font-medium', bom ? 'text-emerald-600' : 'text-red-600')}>{d > 0 ? '▲' : '▼'} {txt} <span className="font-normal text-slate-400">vs {dias} dias anteriores</span></p>;
}

function Kpi({ label, value, hint, cls, delta }: { label: string; value: string; hint?: string; cls?: string; delta?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-af-border p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cn('text-2xl font-bold mt-1', cls || 'text-slate-800')}>{value}</p>
      {hint && <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{hint}</p>}
      {delta}
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-af-border p-4">
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      {sub && <p className="text-[11px] text-slate-400 mb-2">{sub}</p>}
      <div className={sub ? '' : 'mt-2'}>{children}</div>
    </section>
  );
}


/** Chave de ligar/desligar (economia da IA). Vale na hora e dá pra voltar quando quiser. */
function Chave({ ligada, onChange, titulo, texto, ganho, risco }: { ligada: boolean; onChange: (v: boolean) => void; titulo: string; texto: string; ganho: string; risco: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
      <button
        type="button" role="switch" aria-checked={ligada} onClick={() => onChange(!ligada)}
        className={cn('relative flex-shrink-0 mt-0.5 h-6 w-11 rounded-full transition-colors', ligada ? 'bg-emerald-500' : 'bg-slate-300')}
        title={ligada ? 'Ligada — clique pra desligar' : 'Desligada — clique pra ligar'}
      >
        <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', ligada ? 'left-[22px]' : 'left-0.5')} />
      </button>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-800">{titulo} <span className={cn('text-[11px] font-medium', ligada ? 'text-emerald-600' : 'text-slate-400')}>{ligada ? 'ligada' : 'desligada'}</span></p>
        <p className="text-xs text-slate-500 mt-0.5">{texto}</p>
        <p className="text-[11px] text-slate-400 mt-1"><b>Ganho:</b> {ganho} · <b>Risco:</b> {risco}</p>
      </div>
    </div>
  );
}

export default function MedicaoPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(14);
  const { data: custo } = useQuery<{ kbLean: boolean; suggestHaiku: boolean }>({ queryKey: ['ai-cost'], queryFn: async () => (await api.get('/api/automation-metrics/ai-cost')).data, retry: false });
  async function mudarChave(patch: { kbLean?: boolean; suggestHaiku?: boolean }) {
    try { await api.put('/api/automation-metrics/ai-cost', patch); queryClient.invalidateQueries({ queryKey: ['ai-cost'] }); toast('Salvo — vale a partir da próxima chamada da IA'); }
    catch (e: any) { toast(e?.response?.data?.error || 'Não consegui salvar', 'error'); }
  }
  const { data, isLoading, error } = useQuery<Metrics>({
    queryKey: ['automation-metrics', days],
    queryFn: async () => (await api.get('/api/automation-metrics', { params: { days } })).data,
    refetchInterval: 60_000,
  });

  const forbidden = (error as any)?.response?.status === 403;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Medição da automação" subtitle="Quanto o processo automático acerta sozinho e onde a equipe precisa corrigir — só pra nossa medição" />
      <div className="flex-1 overflow-auto px-4 md:px-6 py-4 space-y-4 scrollbar-thin">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Período:</span>
          {[7, 14, 30, 60].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={cn('text-xs px-3 py-1 rounded-full border', days === d ? 'bg-af-mid text-white border-af-mid' : 'border-af-border text-slate-600 hover:bg-slate-50')}>{d} dias</button>
          ))}
          {data && <span className="ml-auto text-[11px] text-slate-400">atualizado às {new Date(data.geradoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>}
        </div>

        {forbidden && <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-sm">Só administradores veem a medição da automação.</div>}
        {isLoading && <div className="grid grid-cols-2 md:grid-cols-6 gap-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>}

        {data && (
          <>
            {/* Indicadores principais */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              <Kpi label="Análises conclusivas" value={fmtPct(data.resumo.conclusivasPct)} cls={tone(data.resumo.conclusivasPct, true, 85, 70)} hint="aprovou, reprovou ou o cliente não passa na regra do banco — sem erro técnico" delta={<Delta atual={data.comparacao?.atual.conclusivasPct} anterior={data.comparacao?.anterior.conclusivasPct} melhorSeSobe unidade="pts" dias={data.periodoDias} />} />
              <Kpi label="Falha técnica" value={fmtPct(data.resumo.falhaPct)} cls={tone(data.resumo.falhaPct, false, 10, 20)} hint={'extensão/portal falhou (inclui as que a automação refez depois; veja "clientes sem resultado" na tabela)'} delta={<Delta atual={data.comparacao?.atual.falhaPct} anterior={data.comparacao?.anterior.falhaPct} melhorSeSobe={false} unidade="pts" dias={data.periodoDias} />} />
              <Kpi label="Até o 1º resultado" value={fmtMin(data.resumo.medianaPrimeiroResultadoMin)} hint={`mediana, por cliente · 90% em até ${fmtMin(data.tempos.primeiroResultado.p90Min)}`} delta={<Delta atual={data.comparacao?.atual.medianaPrimeiroResultadoMin} anterior={data.comparacao?.anterior.medianaPrimeiroResultadoMin} melhorSeSobe={false} unidade="min" dias={data.periodoDias} />} />
              <Kpi label="Aprovação avisada em 15 min" value={fmtPct(data.resumo.avisoAte15minPct)} cls={tone(data.resumo.avisoAte15minPct, true, 80, 50)} hint={`mediana ${fmtMin(data.tempos.aprovacaoAteAviso.medianaMin)} · 90% em até ${fmtMin(data.tempos.aprovacaoAteAviso.p90Min)}`} delta={<Delta atual={data.comparacao?.atual.avisoAte15minPct} anterior={data.comparacao?.anterior.avisoAte15minPct} melhorSeSobe unidade="pts" dias={data.periodoDias} />} />
              <Kpi label="WhatsApp que falhou" value={fmtPct(data.resumo.whatsappFalhaPct)} cls={tone(data.resumo.whatsappFalhaPct, false, 2, 5)} hint={`${fmtN(data.avisos.whatsapp.falhas)} de ${fmtN(data.avisos.whatsapp.total)} mensagens enviadas`} delta={<Delta atual={data.comparacao?.atual.whatsappFalhaPct} anterior={data.comparacao?.anterior.whatsappFalhaPct} melhorSeSobe={false} unidade="pts" dias={data.periodoDias} />} />
              <Kpi label="Correções da equipe" value={data.resumo.correcoesPor100 == null ? '—' : `${data.resumo.correcoesPor100.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} / 100`} cls={tone(data.resumo.correcoesPor100, false, 10, 30)} hint={`por 100 cards analisados (${fmtN(data.resumo.cardsAnalisados)} cards, ${fmtN(data.resumo.analises)} análises)`} delta={<Delta atual={data.comparacao?.atual.correcoesPor100} anterior={data.comparacao?.anterior.correcoesPor100} melhorSeSobe={false} unidade="" dias={data.periodoDias} />} />
            </div>

            {/* Pontos de atenção */}
            <Card title="O que mais merece ajuste" sub="Montado automaticamente a partir dos números abaixo">
              {data.atencao.length === 0 ? <p className="text-sm text-emerald-600">Nada fora do esperado neste período.</p> : (
                <ul className="space-y-1.5">
                  {data.atencao.map((a, i) => (
                    <li key={i} className={cn('text-sm rounded-lg px-3 py-2 border', a.nivel === 'alto' ? 'bg-red-50 border-red-200 text-red-800' : a.nivel === 'medio' ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-slate-50 border-slate-200 text-slate-700')}>{a.texto}</li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Bancos */}
            <Card title="Análises por banco (extensões)" sub="Só análises de verdade (sem teste). 'Desqualificado' = o cliente não passa na regra do banco/imóvel/idade: não é erro da automação.">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase text-slate-400"><th className="py-1.5 pr-3">Banco</th><th className="pr-3">Análises</th><th className="pr-3">Aprovou</th><th className="pr-3">Reprovou</th><th className="pr-3">Desqualif.</th><th className="pr-3">Falha técnica</th><th className="pr-3">Andamento</th><th className="pr-3" title="Clientes cuja ÚLTIMA análise nesse banco terminou em falha técnica (a automação não conseguiu resultado até agora)">Clientes sem resultado</th><th className="pr-3">Conclusivas</th><th className="pr-3">Tempo (mediana / 90%)</th></tr></thead>
                  <tbody>
                    {data.bancos.map((b) => (
                      <tr key={b.bank} className="border-t border-slate-100">
                        <td className="py-2 pr-3 font-medium text-slate-700">{b.label}</td>
                        <td className="pr-3">{b.total}</td>
                        <td className="pr-3 text-emerald-700">{b.aprovadas}</td>
                        <td className="pr-3">{b.reprovadas}</td>
                        <td className="pr-3 text-slate-500">{b.desqualificadas}</td>
                        <td className={cn('pr-3 font-medium', tone(b.falhaPct, false, 10, 20))}>{b.falhas} <span className="text-[11px] font-normal">({fmtPct(b.falhaPct)})</span></td>
                        <td className="pr-3 text-slate-500">{b.andamento}</td>
                        <td className={cn('pr-3', (b.clientesSemResultado || 0) > 0 ? 'text-amber-600 font-medium' : 'text-slate-500')}>{b.clientesSemResultado ?? '—'}<span className="text-[11px] font-normal text-slate-400"> de {b.clientes ?? '—'}</span></td>
                        <td className={cn('pr-3', tone(b.conclusivasPct, true, 85, 70))}>{fmtPct(b.conclusivasPct)}</td>
                        <td className="pr-3 text-slate-600">{fmtMin(b.medianaMin)} / {fmtMin(b.p90Min)}</td>
                      </tr>
                    ))}
                    {!data.bancos.length && <tr><td colSpan={10} className="py-3 text-slate-400">Nenhuma análise no período.</td></tr>}
                  </tbody>
                </table>
              </div>
              {data.causasFalha.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs font-semibold text-slate-600 mb-1">Principais causas de falha técnica</p>
                  <ul className="space-y-1">
                    {data.causasFalha.map((c, i) => (
                      <li key={i} className="flex gap-2 text-xs text-slate-600"><span className="w-8 text-right font-semibold text-slate-800">{c.n}x</span><span className="w-20 flex-shrink-0 text-slate-400">{c.label}</span><span className="min-w-0 break-words">{c.causa}</span></li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* Tempos */}
              <Card title="Tempo do processo" sub="Do pedido de análise ao resultado, e do resultado ao aviso ao cliente">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-slate-500">Clientes com resultado</dt><dd className="font-medium">{data.tempos.primeiroResultado.n}</dd>
                  <dt className="text-slate-500">Até o 1º resultado (mediana)</dt><dd className="font-medium">{fmtMin(data.tempos.primeiroResultado.medianaMin)}</dd>
                  <dt className="text-slate-500">Até o 1º resultado (90% em até)</dt><dd className="font-medium">{fmtMin(data.tempos.primeiroResultado.p90Min)}</dd>
                  <dt className="text-slate-500">Aprovações / avisadas</dt><dd className="font-medium">{data.tempos.aprovacaoAteAviso.aprovadas} / {data.tempos.aprovacaoAteAviso.avisadas}</dd>
                  <dt className="text-slate-500">Aprovação → aviso (mediana)</dt><dd className="font-medium">{fmtMin(data.tempos.aprovacaoAteAviso.medianaMin)}</dd>
                  <dt className="text-slate-500">Aprovação → aviso (90% em até)</dt><dd className="font-medium">{fmtMin(data.tempos.aprovacaoAteAviso.p90Min)}</dd>
                </dl>
                {data.tempos.semAviso.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold text-red-700 mb-1">Aprovados há mais de 1 h sem aviso ao cliente</p>
                    <ul className="space-y-1">
                      {data.tempos.semAviso.map((s) => (
                        <li key={s.id}><button onClick={() => router.push(`/inbox?leadId=${s.id}`)} className="text-xs text-af-mid hover:underline text-left">{s.name}</button> <span className="text-[11px] text-slate-400">· há {fmtMin((s.horas || 0) * 60)} · IA {s.iaLigada ? 'ligada' : 'desligada'}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>

              {/* Avisos */}
              <Card title="Avisos ao cliente" sub="Registrados nas notas dos cards">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-slate-500">Aprovações avisadas</dt><dd className="font-medium">{data.avisos.aprovacao}</dd>
                  <dt className="text-slate-500">Negativas avisadas</dt><dd className="font-medium">{data.avisos.negativa}</dd>
                  <dt className="text-slate-500">Aprovação esperando a equipe (IA do card desligada)</dt><dd className="font-medium">{data.avisos.aprovacaoSegurada}</dd>
                  <dt className="text-slate-500">Negativa esperando a equipe</dt><dd className="font-medium">{data.avisos.negativaSegurada}</dd>
                  <dt className="text-slate-500">Avisos duplicados evitados</dt><dd className="font-medium">{data.avisos.duplicadosEvitados}</dd>
                  <dt className="text-slate-500">Negativa que não saiu</dt><dd className={cn('font-medium', data.avisos.negativaNaoSaiu > 0 && 'text-amber-600')}>{data.avisos.negativaNaoSaiu}</dd>
                </dl>
                {data.avisos.whatsapp.erros.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold text-slate-600 mb-1">Por que o WhatsApp falhou</p>
                    <ul className="space-y-1">{data.avisos.whatsapp.erros.map((e, i) => <li key={i} className="flex gap-2 text-xs text-slate-600"><span className="w-8 text-right font-semibold text-slate-800">{e.n}x</span><span className="min-w-0 break-words">{e.motivo}</span></li>)}</ul>
                  </div>
                )}
              </Card>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* IA */}
              <Card title="IA de atendimento" sub="Respostas automáticas, dúvidas levadas à equipe e uso">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-slate-500">Respostas automáticas ao cliente</dt><dd className="font-medium">{fmtN(data.ia.respostasAutomaticas)}</dd>
                  <dt className="text-slate-500">Dúvidas levadas à equipe</dt><dd className="font-medium">{data.ia.perguntasAEquipe}</dd>
                  <dt className="text-slate-500">Vezes que a equipe assumiu a conversa (IA desligou)</dt><dd className="font-medium">{data.ia.humanoAssumiu}</dd>
                </dl>
                {data.ia.duvidas.length > 0 && (
                  <table className="w-full text-xs mt-3">
                    <thead><tr className="text-left text-[11px] uppercase text-slate-400"><th className="py-1">Tipo de dúvida</th><th>Total</th><th>Respondidas</th><th>Abertas</th><th>Tempo p/ responder</th></tr></thead>
                    <tbody>{data.ia.duvidas.map((q) => <tr key={q.kind} className="border-t border-slate-100"><td className="py-1.5 text-slate-700">{KIND[q.kind] || q.kind}</td><td>{q.total}</td><td>{q.respondidas}</td><td className={q.abertas ? 'text-amber-600 font-medium' : ''}>{q.abertas}</td><td>{fmtMin(q.medianaMin)}</td></tr>)}</tbody>
                  </table>
                )}
                {data.ia.custo.porFuncao.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold text-slate-600 mb-0.5">Gasto estimado com a IA (Anthropic): US$ {data.ia.custo.totalUsd.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} no período</p>
                    <p className="text-[11px] text-slate-400 mb-1">Preço de tabela suposto — o valor real está no console da Anthropic.</p>
                    <ul className="space-y-0.5">{data.ia.custo.porFuncao.map((u) => <li key={u.feature} className="flex justify-between text-xs text-slate-600"><span className="truncate pr-2">{u.feature.split(':')[0]}</span><span className="flex-shrink-0">US$ {u.usd.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} · {fmtN(u.chamadas)} chamadas · ~{Math.round(u.entradaMedia / 1000)}k tokens cada</span></li>)}</ul>
                    <p className="text-xs font-semibold text-slate-600 mt-2 mb-0.5">Por dia</p>
                    <ul className="space-y-0.5">{data.ia.custo.porDia.map((d) => <li key={d.day} className="flex justify-between text-xs text-slate-600"><span>{d.day.slice(8)}/{d.day.slice(5, 7)}</span><span>US$ {d.usd.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} · {fmtN(d.chamadas)} chamadas</span></li>)}</ul>
                  </div>
                )}
              </Card>

              {/* Correções */}
              <Card title="Correções da equipe" sub="Cada correção é um sinal de que a automação errou ou faltou regra">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-slate-500">Cards reabertos depois de a automação mandar pra Perdidos</dt><dd className={cn('font-medium', data.correcoes.reabertosAposFechamentoAutomatico > 0 && 'text-amber-600')}>{data.correcoes.reabertosAposFechamentoAutomatico}</dd>
                  <dt className="text-slate-500">Cards com "Ajustar" (valores/prazo/titular)</dt><dd className="font-medium">{data.correcoes.cardsComAjuste}</dd>
                  <dt className="text-slate-500">Resultados digitados à mão</dt><dd className="font-medium">{data.correcoes.resultadosManuais}</dd>
                  <dt className="text-slate-500">Alterações registradas / desfeitas com "Reverter"</dt><dd className="font-medium">{data.correcoes.feitas} / {data.correcoes.desfeitas}</dd>
                </dl>
                {data.correcoes.principais.length > 0 && (
                  <ul className="mt-3 space-y-1">{data.correcoes.principais.map((p, i) => <li key={i} className="flex gap-2 text-xs text-slate-600"><span className="w-8 text-right font-semibold text-slate-800">{p.n}x</span><span className="min-w-0 break-words">{p.acao}</span></li>)}</ul>
                )}
              </Card>
            </div>

            {/* Chaves de economia da IA */}
            {custo && (
              <Card title="Economia da IA (chaves)" sub="Ligar e desligar vale na hora, sem subir código. Os valores abaixo são estimativas.">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  <Chave ligada={custo.suggestHaiku} onChange={(v) => mudarChave({ suggestHaiku: v })} titulo="Sugerir resposta no modelo menor (Haiku)" texto="O balão de sugestão usa o Haiku 4.5 em vez do Sonnet. O texto sempre passa pela revisão da equipe antes de ir ao cliente." ganho="~70% do custo das sugestões (~US$ 1/dia)" risco="tom e acabamento um pouco mais simples" />
                  <Chave ligada={custo.kbLean} onChange={(v) => mudarChave({ kbLean: v })} titulo="Base de Conhecimento enxuta" texto="A IA lê só as 24 entradas mais parecidas com a conversa (+ as criadas nos últimos 7 dias), em vez de todas as ~55 regras manuais. Vale pra resposta automática e sugestão." ganho="~7% do custo por resposta (~US$ 0,4/dia)" risco="pode deixar de fora uma regra de elegibilidade (ex.: imóvel de parente de 1º grau) — por isso vem desligada" />
                </div>
              </Card>
            )}

            {/* Extensões */}
            <Card title="Extensões do Chrome agora">
              <div className="flex flex-wrap gap-2">
                {data.extensoes.map((e) => (
                  <span key={e.bank} className={cn('text-xs px-3 py-1 rounded-full border', e.loginNeeded ? 'bg-red-50 border-red-300 text-red-700' : e.online ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-600')}>{e.label}: {e.loginNeeded ? 'deslogada — entre no portal' : e.online ? 'conectada' : 'sem sinal (parada fora de 07h–22h ou Chrome fechado)'}</span>
                ))}
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

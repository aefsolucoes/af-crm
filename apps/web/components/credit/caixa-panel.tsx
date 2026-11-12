'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { ago } from './shared';

/* Coluna CAIXA da Análise de Crédito (Fabio 31/10: "INCLUA A CAIXA NAS AVALIAÇÕES DE HE"). A CAIXA não roda só com a proposta: com a documentação, a ficha
 * vira cadastro no Caixa Aqui (extensão "Cadastro CAIXA"), a equipe CONFERE o cadastro e só então a Avaliação de Risco roda (Home Equity).
 * Dados: GET /api/caixa-cadastro/painel. Botões: "Cadastro conferido" (POST /:id/conferido) e "Fazer cadastro" quando não rodou sozinho (POST /:id/fazer-cadastro). */
interface Part { ordem: number; nome: string; semRenda: boolean; cadastro: string | null; consultado: boolean; consulta?: string | null; alerta?: string | null }
export interface CardCaixa {
  leadId: string; nome: string; produto: 'HE' | 'FH'; status: string | null;
  atual: { tipo: string; ordem: number; desde: string } | null;
  participantes: Part[];
  conferencia: { status: string; desde?: string; por?: string; em?: string } | null;
  avaliacao: { status: string; pedidoEm: string | null; fim: string | null } | null;
  resultado?: string | null;
  /** SBPE/MCMV (só Financiamento) e SAC/PRICE da operação avaliada (Fabio 12/11) — só quando o CRM sabe (gravado na avaliação ou na anotação do envio). */
  enquadramento?: string | null;
  amortizacao?: 'SAC' | 'PRICE' | null;
}
interface SemCad { leadId: string; nome: string; produto: 'HE' | 'FH'; fichaEm: string | null; participantes: string[] }
export interface PainelCaixa { cards: CardCaixa[]; semCadastro: SemCad[]; avaliacaoAposConferencia?: boolean }

export const gravado = (s: string | null) => /^GRAVADO/i.test(s || '');
export const andando = (s: string | null) => s === 'FILA' || s === 'RODANDO';
export const curto = (s: string) => s.split(/[:—]/)[0].trim();
export const ACAO: Record<string, string> = { consultar: 'consultando o nome', cadastrar: 'cadastrando', avaliar: 'Avaliação de Risco' };

/** Mesma consulta do quadro CAIXA e da coluna CAIXA da tabela do HE (uma requisição só, a cada 10 s). */
export function useCaixaPainel() {
  return useQuery<PainelCaixa>({
    queryKey: ['caixa-painel'],
    queryFn: async () => (await api.get('/api/caixa-cadastro/painel')).data,
    refetchInterval: 10_000,
  });
}

function Titulo({ children, n }: { children: React.ReactNode; n?: number }) {
  return <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{children}{n != null && <span className="ml-1 text-slate-500 normal-case font-medium">({n})</span>}</p>;
}

export function CaixaPanel() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const { data } = useCaixaPainel();
  const cards = data?.cards || [];
  const rodando = cards.filter((c) => c.atual);
  const conferir = cards.filter((c) => c.conferencia?.status === 'PENDENTE');
  const naFila = cards.filter((c) => !c.atual && (c.status === 'FILA' || c.participantes.some((p) => p.cadastro === 'FILA') || c.avaliacao?.status === 'FILA'));
  const avaliacoes = cards.filter((c) => c.avaliacao).sort((a, b) => (b.avaliacao!.fim || b.avaliacao!.pedidoEm || '').localeCompare(a.avaliacao!.fim || a.avaliacao!.pedidoEm || '')).slice(0, 8);
  // Cadastro que não saiu sozinho: participante sem GRAVADO e nada na fila — mais os cards com ficha que ainda não foram pra CAIXA.
  const parados = cards.filter((c) => !c.atual && c.status !== 'FILA' && c.participantes.some((p) => !gravado(p.cadastro) && !andando(p.cadastro)));
  const semCadastro = data?.semCadastro || [];

  const abrir = (leadId: string) => router.push(`/inbox?leadId=${leadId}`);
  const nome = (n: string, id: string) => <button onClick={() => abrir(id)} className="hover:underline text-left truncate min-w-0" title={`${n} — abrir a conversa`}>{n}</button>;
  const tag = (p: 'HE' | 'FH') => <span className={cn('text-[9px] font-semibold px-1 rounded flex-shrink-0', p === 'HE' ? 'bg-indigo-50 text-indigo-600' : 'bg-teal-50 text-teal-700')}>{p}</span>;

  async function acao(leadId: string, rota: 'conferido' | 'fazer-cadastro', ok: string) {
    setBusy(leadId);
    try {
      await api.post(`/api/caixa-cadastro/${leadId}/${rota}`);
      toast(ok, 'success');
      queryClient.invalidateQueries({ queryKey: ['caixa-painel'] });
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Não consegui agora', 'error');
    } finally { setBusy(null); }
  }
  function conferido(c: CardCaixa) {
    const avalia = c.produto === 'HE' && !!data?.avaliacaoAposConferencia;
    if (!window.confirm(`Você conferiu no Caixa Aqui o cadastro de ${c.participantes.map((p) => p.nome).join(' e ')}?\n\n${avalia ? 'A Avaliação de Risco vai pra fila da extensão em seguida.' : 'Só registra a conferência — a Avaliação de Risco não roda agora.'}`)) return;
    acao(c.leadId, 'conferido', avalia ? 'Cadastro conferido — Avaliação de Risco na fila' : 'Cadastro conferido');
  }
  function fazerCadastro(leadId: string, quem: string) {
    if (!window.confirm(`Fazer o cadastro de ${quem} na CAIXA agora?\n\nA extensão consulta o nome (se ainda não consultou) e preenche o cadastro pela ficha.`)) return;
    acao(leadId, 'fazer-cadastro', 'Cadastro na fila da extensão da CAIXA');
  }

  const estado = rodando.length ? { rotulo: naFila.length ? `Rodando · ${naFila.length} na fila` : 'Rodando', cls: 'bg-blue-50 text-blue-700', borda: 'border-l-blue-500', pulsa: true }
    : conferir.length ? { rotulo: `Conferir cadastro (${conferir.length})`, cls: 'bg-amber-50 text-amber-700', borda: 'border-l-amber-400' }
    : { rotulo: 'Livre', cls: 'bg-emerald-50 text-emerald-700', borda: 'border-l-emerald-500' };
  const botao = 'text-[11px] px-2 py-0.5 rounded-md border flex-shrink-0 disabled:opacity-50';

  return (
    <div className={cn('bg-white rounded-xl border border-af-border border-l-4 p-3 min-w-0', estado.borda)}>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white" style={{ background: '#005CA9' }}>CX</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-800 truncate">CAIXA<span className="ml-1.5 text-[11px] font-normal text-slate-400">com a documentação</span></p>
          <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full', estado.cls)}>
            {estado.pulsa && <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping" /><span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" /></span>}
            {estado.rotulo}
          </span>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-400">Documentação recebida → cadastro no Caixa Aqui → a equipe confere{data?.avaliacaoAposConferencia ? ' → Avaliação de Risco' : ' (Avaliação de Risco pausada)'}.</p>

      {rodando.length > 0 && (
        <div className="mt-2.5">
          <Titulo n={rodando.length}>Rodando agora</Titulo>
          <ul className="space-y-1.5">
            {rodando.map((c) => (
              <li key={c.leadId} className="text-xs rounded-lg bg-blue-50/60 border border-blue-100 px-2 py-1.5">
                <div className="flex items-center gap-1.5 font-semibold text-slate-800">{nome(c.nome, c.leadId)}{tag(c.produto)}</div>
                <p className="text-slate-500">{ACAO[c.atual!.tipo] || c.atual!.tipo}{c.atual!.tipo !== 'avaliar' ? ` · ${c.participantes.find((p) => p.ordem === c.atual!.ordem)?.nome || `${c.atual!.ordem}º`}` : ''}</p>
                <p className="text-[11px] text-slate-400">começou {ago(c.atual!.desde)}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {naFila.length > 0 && (
        <div className="mt-2.5">
          <Titulo n={naFila.length}>Na fila</Titulo>
          <ul className="space-y-0.5">
            {naFila.map((c, i) => (
              <li key={c.leadId} className="flex items-center gap-1.5 text-xs text-slate-700 min-w-0">
                <span className="w-4 text-right text-[10px] text-slate-400 flex-shrink-0">{i + 1}.</span>
                {nome(c.nome, c.leadId)}{tag(c.produto)}
                <span className="text-[10px] text-slate-400 truncate">{c.status === 'FILA' ? 'consulta do nome' : c.avaliacao?.status === 'FILA' ? 'Avaliação de Risco' : `cadastro de ${c.participantes.filter((p) => p.cadastro === 'FILA').map((p) => p.nome.split(' ')[0]).join(', ')}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {conferir.length > 0 && (
        <div className="mt-2.5">
          <Titulo n={conferir.length}>Conferir cadastro</Titulo>
          <ul className="space-y-1.5">
            {conferir.map((c) => (
              <li key={c.leadId} className="text-xs rounded-lg bg-amber-50/60 border border-amber-100 px-2 py-1.5">
                <div className="flex items-center gap-1.5 font-semibold text-slate-800">{nome(c.nome, c.leadId)}{tag(c.produto)}</div>
                <p className="text-[11px] text-slate-500 truncate" title={c.participantes.map((p) => p.nome).join(', ')}>{c.participantes.map((p) => p.nome.split(' ')[0]).join(', ')} · gravado {ago(c.conferencia!.desde)}</p>
                <button disabled={busy === c.leadId} onClick={() => conferido(c)} className={cn(botao, 'mt-1 border-emerald-300 text-emerald-700 hover:bg-emerald-50')}>✓ Cadastro conferido</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {avaliacoes.length > 0 && (
        <div className="mt-2.5">
          <Titulo>Avaliação de Risco</Titulo>
          <ul className="space-y-0.5">
            {avaliacoes.map((c) => (
              <li key={c.leadId} className="flex items-center gap-1.5 text-xs text-slate-700 min-w-0" title={c.avaliacao!.status}>
                {nome(c.nome, c.leadId)}{tag(c.produto)}
                <span className="text-[10px] text-slate-400 flex-shrink-0">{curto(c.avaliacao!.status).toLowerCase()} · {ago(c.avaliacao!.fim || c.avaliacao!.pedidoEm)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(parados.length > 0 || semCadastro.length > 0) && (
        <div className="mt-2.5">
          <Titulo n={parados.length + semCadastro.length}>Cadastro não saiu sozinho</Titulo>
          <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
            {parados.map((c) => {
              const faltam = c.participantes.filter((p) => !gravado(p.cadastro) && !andando(p.cadastro));
              return (
                <li key={c.leadId} className="flex items-center gap-1.5 text-xs text-slate-700 min-w-0">
                  {nome(c.nome, c.leadId)}{tag(c.produto)}
                  <span className="text-[10px] text-slate-400 truncate" title={faltam.map((p) => `${p.nome}: ${p.cadastro || (p.consultado ? 'consultado, sem cadastro' : 'sem consulta')}`).join('\n')}>{faltam.map((p) => `${p.nome.split(' ')[0]}: ${p.cadastro ? curto(p.cadastro).toLowerCase() : 'sem cadastro'}`).join(' · ')}</span>
                  <button disabled={busy === c.leadId} onClick={() => fazerCadastro(c.leadId, faltam.map((p) => p.nome).join(' e '))} className={cn(botao, 'ml-auto border-af-border text-slate-600 hover:bg-slate-50')}>Fazer cadastro</button>
                </li>
              );
            })}
            {semCadastro.map((c) => (
              <li key={c.leadId} className="flex items-center gap-1.5 text-xs text-slate-700 min-w-0">
                {nome(c.nome, c.leadId)}{tag(c.produto)}
                <span className="text-[10px] text-slate-400 truncate">ficha {c.fichaEm ? ago(c.fichaEm) : 'pronta'}, sem cadastro</span>
                <button disabled={busy === c.leadId} onClick={() => fazerCadastro(c.leadId, c.participantes.join(' e ') || c.nome)} className={cn(botao, 'ml-auto border-af-border text-slate-600 hover:bg-slate-50')}>Fazer cadastro</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data && !rodando.length && !naFila.length && !conferir.length && !avaliacoes.length && !parados.length && !semCadastro.length && <p className="mt-2 text-xs text-slate-400">Nenhum cliente na CAIXA agora.</p>}
    </div>
  );
}

/* ── Coluna CAIXA da tabela de clientes do Home Equity (Fabio 10/11, "Sim, criar coluna"), como a do Financiamento: estado de cada participante na fila do
 * Caixa Aqui (consulta → cadastro) e, embaixo, o que é do card (conferência e Avaliação de Risco). Dados do mesmo GET /painel do quadro CAIXA. ── */

const semAcento = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Cor no padrão do tom() do Financiamento. */
function tomCaixa(status: string): string {
  const s = semAcento(status);
  if (/reprov|negad|recus|cancel|nao aprovad/.test(s)) return 'bg-red-100 text-red-700';
  if (/aprovad|gravado/.test(s)) return 'bg-emerald-100 text-emerald-700';
  if (/condicion|pend|incomplet|conferir|nao saiu|segurad|falt|erro|falhou|parou/.test(s)) return 'bg-amber-100 text-amber-700';
  if (/analise|aguard|enviad|process|fila|rodando|consultando/.test(s)) return 'bg-blue-100 text-blue-700';
  return 'bg-slate-100 text-slate-500';
}

/** Resultado da Avaliação de Risco (_caixaResultado.status): "RESULTADO: Avaliação Condicionada." → "Avaliação Condicionada"; FILA/RODANDO = consulta em andamento. */
function rotuloResultado(r: string): string {
  if (/^(FILA|RODANDO)$/i.test(r.trim())) return 'Consultando resultado';
  if (/^AGUARDANDO_NOVA_AVALIACAO$/i.test(r.trim())) return 'Aguardando nova avaliação';
  const s = r.replace(/^\s*RESULTADO:\s*/i, '').replace(/aprovada e n[aã]o propagada/gi, 'Aprovada').split(/\s+—\s+|\n/)[0].replace(/[.\s]+$/, '').trim();
  return s.length > 40 ? `${s.slice(0, 38)}…` : s || curto(r);
}

type Estado = { rotulo: string; cls: string; sub?: string; pulsa?: boolean; title?: string };
function estadoParticipante(c: CardCaixa, p: Pick<Part, 'ordem' | 'cadastro' | 'consultado'>): Estado {
  if (c.atual && c.atual.tipo !== 'avaliar' && c.atual.ordem === p.ordem) return { rotulo: 'Rodando', cls: 'bg-blue-100 text-blue-700', sub: ACAO[c.atual.tipo] || c.atual.tipo, pulsa: true };
  if (gravado(p.cadastro)) return { rotulo: 'Cadastro gravado', cls: 'bg-emerald-100 text-emerald-700', title: p.cadastro || undefined };
  if (andando(p.cadastro)) return { rotulo: 'Cadastro na fila', cls: 'bg-blue-50 text-blue-600' };
  if (p.cadastro) return { rotulo: curto(p.cadastro), cls: tomCaixa(p.cadastro), title: p.cadastro };
  if (!p.consultado && c.status === 'FILA') return { rotulo: 'Na fila', cls: 'bg-blue-50 text-blue-600', sub: 'consulta do nome' };
  if (!p.consultado && c.status === 'CONSULTA_PARADA') return { rotulo: 'Consulta não saiu', cls: 'bg-amber-100 text-amber-700', sub: '"Fazer cadastro" no quadro CAIXA', title: 'A CAIXA respondeu duas vezes sem o resultado da consulta' };
  if (p.consultado) return { rotulo: 'Consultado', cls: 'bg-slate-100 text-slate-600', sub: 'cadastro ainda não feito' };
  return { rotulo: '—', cls: 'text-slate-300' };
}

function Pilula({ e }: { e: Estado }) {
  if (e.rotulo === '—') return <span className="text-xs text-slate-300">—</span>;
  return (
    <div className="space-y-0.5" title={e.title}>
      <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium', e.cls)}>
        {e.pulsa && <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" /></span>}
        {e.rotulo}
      </span>
      {e.sub && <div className="text-[10px] text-slate-400 leading-tight">{e.sub}</div>}
    </div>
  );
}

/** Célula da coluna CAIXA de um cliente. `data` = useCaixaPainel().data. */
export function CaixaColuna({ leadId, data }: { leadId: string; data?: PainelCaixa }) {
  const c = data?.cards.find((x) => x.leadId === leadId);
  if (!c) {
    if (data?.semCadastro.some((x) => x.leadId === leadId)) return <Pilula e={{ rotulo: 'Pediu a CAIXA', cls: 'bg-amber-100 text-amber-700', sub: 'ficha pronta, sem cadastro' }} />;
    return <span className="text-[11px] text-slate-400 leading-tight block">com a documentação</span>;
  }
  const ps = c.participantes.length ? c.participantes : [{ ordem: 1, nome: '', semRenda: false, cadastro: null, consultado: c.status === 'CONSULTADO' } as Part];
  const card: Estado[] = [];
  if (c.atual?.tipo === 'avaliar') card.push({ rotulo: 'Rodando', cls: 'bg-blue-100 text-blue-700', sub: 'Avaliação de Risco', pulsa: true });
  else if (c.resultado) {
    const op = [c.enquadramento, c.amortizacao].filter(Boolean).join(' · '); // "SBPE · SAC" (Fabio 12/11)
    card.push({ rotulo: rotuloResultado(c.resultado), cls: tomCaixa(rotuloResultado(c.resultado)), sub: op ? `Avaliação de Risco · ${op}` : 'Avaliação de Risco', title: c.resultado });
  }
  else if (c.avaliacao) card.push({ rotulo: c.avaliacao.status === 'FILA' ? 'Na fila' : curto(c.avaliacao.status), cls: tomCaixa(c.avaliacao.status), sub: `Avaliação de Risco${c.avaliacao.fim || c.avaliacao.pedidoEm ? ` · ${ago(c.avaliacao.fim || c.avaliacao.pedidoEm)}` : ''}`, title: c.avaliacao.status });
  if (c.conferencia?.status === 'PENDENTE') card.push({ rotulo: 'Conferir cadastro', cls: 'bg-amber-100 text-amber-700', sub: 'no quadro CAIXA, acima' });
  return (
    <div className="space-y-1.5">
      {ps.map((p) => (
        <div key={p.ordem}>
          {ps.length > 1 && <div className="text-[10px] uppercase tracking-wide text-slate-400">{p.ordem}º participante</div>}
          <Pilula e={estadoParticipante(c, p)} />
          {p.consulta && <div className={cn('text-[10px] font-medium leading-tight', p.consulta === 'Constam ocorrências' ? 'text-red-600' : p.consulta === 'Nada consta' ? 'text-emerald-600' : 'text-slate-500')}>{p.consulta}</div>}
          {p.alerta && <div className="text-[10px] text-amber-600 leading-tight">⚠ {p.alerta}</div>}
        </div>
      ))}
      {card.length > 0 && <div className="pt-1 border-t border-slate-100 space-y-1">{card.map((e, i) => <Pilula key={i} e={e} />)}</div>}
    </div>
  );
}

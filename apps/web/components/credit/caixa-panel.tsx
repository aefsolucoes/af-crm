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
interface Part { ordem: number; nome: string; semRenda: boolean; cadastro: string | null; consultado: boolean }
interface CardCaixa {
  leadId: string; nome: string; produto: 'HE' | 'FH'; status: string | null;
  atual: { tipo: string; ordem: number; desde: string } | null;
  participantes: Part[];
  conferencia: { status: string; desde?: string; por?: string; em?: string } | null;
  avaliacao: { status: string; pedidoEm: string | null; fim: string | null } | null;
}
interface SemCad { leadId: string; nome: string; produto: 'HE' | 'FH'; fichaEm: string | null; participantes: string[] }

const gravado = (s: string | null) => /^GRAVADO/i.test(s || '');
const andando = (s: string | null) => s === 'FILA' || s === 'RODANDO';
const curto = (s: string) => s.split(/[:—]/)[0].trim();
const ACAO: Record<string, string> = { consultar: 'consultando o nome', cadastrar: 'cadastrando', avaliar: 'Avaliação de Risco' };

function Titulo({ children, n }: { children: React.ReactNode; n?: number }) {
  return <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{children}{n != null && <span className="ml-1 text-slate-500 normal-case font-medium">({n})</span>}</p>;
}

export function CaixaPanel() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const { data } = useQuery<{ cards: CardCaixa[]; semCadastro: SemCad[] }>({
    queryKey: ['caixa-painel'],
    queryFn: async () => (await api.get('/api/caixa-cadastro/painel')).data,
    refetchInterval: 10_000,
  });
  const cards = data?.cards || [];
  const rodando = cards.filter((c) => c.atual);
  const conferir = cards.filter((c) => c.conferencia?.status === 'PENDENTE');
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
    if (!window.confirm(`Você conferiu no Caixa Aqui o cadastro de ${c.participantes.map((p) => p.nome).join(' e ')}?\n\n${c.produto === 'HE' ? 'A Avaliação de Risco vai pra fila da extensão em seguida.' : 'No Financiamento a Avaliação de Risco não roda sozinha.'}`)) return;
    acao(c.leadId, 'conferido', c.produto === 'HE' ? 'Cadastro conferido — Avaliação de Risco na fila' : 'Cadastro conferido');
  }
  function fazerCadastro(leadId: string, quem: string) {
    if (!window.confirm(`Fazer o cadastro de ${quem} na CAIXA agora?\n\nA extensão consulta o nome (se ainda não consultou) e preenche o cadastro pela ficha.`)) return;
    acao(leadId, 'fazer-cadastro', 'Cadastro na fila da extensão da CAIXA');
  }

  const estado = rodando.length ? { rotulo: 'Rodando', cls: 'bg-blue-50 text-blue-700', borda: 'border-l-blue-500', pulsa: true }
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
      <p className="mt-2 text-xs text-slate-400">Documentação recebida → cadastro no Caixa Aqui → a equipe confere → Avaliação de Risco.</p>

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

      {data && !rodando.length && !conferir.length && !avaliacoes.length && !parados.length && !semCadastro.length && <p className="mt-2 text-xs text-slate-400">Nenhum cliente na CAIXA agora.</p>}
    </div>
  );
}

'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/* Análise manual do Santander pelo PORTAL do Credimorar (Fabio 14/11, Lucas: "ENVIAR QUANDO RECEBER A DOCUMENTAÇÃO COMPLETA, SE A IA ESTIVER LIGADA VAI SOZINHO, SE NÃO,
 * DEIXE UM BOTÃO DE ENVIAR DOCUMENTOS NO CARD… A EXTENSÃO ABRE O SISTEMA E ENCAMINHA"). Mostra o que o banco pediu, o que falta e o envio; o botão põe na fila da extensão,
 * que anexa os documentos, escreve o comentário de defesa e clica em "Enviar". Depois o CRM avisa a Letícia por e-mail. */

type Estado = {
  produto: 'FH' | 'HE'; banco: string; proposta: string; itens: string[]; faltando: string[]; prontoAt: string | null; docs: string[];
  portal: { status: 'FILA' | 'RODANDO' | 'OK' | 'ERRO'; pedidoEm: string; fim: string | null; erro: string | null; por: string } | null;
  forwardedAt: string | null; segurado: boolean; aiOn: boolean;
};
const quando = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

export function SantanderManualEnvio({ leadId, produto, className }: { leadId: string; produto: 'FH' | 'HE'; className?: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery<{ estado: Estado | null }>({
    queryKey: ['santander-manual', leadId],
    queryFn: async () => (await api.get(`/api/credit-analysis/santander-manual/${leadId}`)).data,
    refetchInterval: 30_000,
  });
  const e = data?.estado;
  if (!e || e.produto !== produto) return null;
  const p = e.portal;
  const andando = p?.status === 'FILA' || p?.status === 'RODANDO';
  const enviado = p?.status === 'OK';

  async function enviar() {
    if (!e) return;
    const aviso = [
      `A extensão do Credimorar vai abrir a proposta ${e.banco} nº ${e.proposta}, ANEXAR na Análise manual:`,
      ...e.docs.map((d) => `• ${d}`),
      '',
      'escrever o comentário de defesa e clicar em ENVIAR (vai pro banco). Depois o CRM avisa a Letícia por e-mail com os documentos.',
      ...(e.faltando.length ? ['', `Atenção: pela leitura dos arquivos ainda falta: ${e.faltando.join('; ')}.`] : []),
      '',
      'Seguir?',
    ].join('\n');
    if (!window.confirm(aviso)) return;
    setBusy(true);
    try {
      await api.post('/api/credit-analysis/santander-manual/enviar', { leadId });
      toast('Pedido feito: a extensão do Credimorar envia em seguida', 'success');
      qc.invalidateQueries({ queryKey: ['santander-manual', leadId] });
    } catch (err: any) { toast(err?.response?.data?.error || 'Erro ao pedir o envio', 'error'); } finally { setBusy(false); }
  }

  return (
    <div className={cn('mt-1.5 rounded border px-2 py-1.5 text-[11px]', className, enviado ? 'border-emerald-200 bg-emerald-50/50' : p?.status === 'ERRO' ? 'border-amber-300 bg-amber-50/60' : 'border-indigo-200 bg-indigo-50/40')}>
      <p className="font-semibold text-slate-700">Análise manual {e.banco} · proposta {e.proposta}</p>
      {enviado ? (
        <p className="text-emerald-700">✅ Documentos anexados e enviados pelo portal em {quando(p?.fim)}{e.forwardedAt ? ' · Letícia avisada por e-mail' : ''}. Prazo do banco: até 5 dias úteis.</p>
      ) : andando ? (
        <p className="text-indigo-700">⏳ {p?.status === 'RODANDO' ? 'A extensão está enviando pelo portal…' : 'Na fila da extensão do Credimorar…'} ({p?.por})</p>
      ) : (
        <>
          {p?.status === 'ERRO' && <p className="text-amber-800">⚠️ O envio pelo portal falhou ({quando(p.fim)}): {p.erro}</p>}
          <p className="text-slate-600">
            {e.prontoAt ? `Documentação completa.${e.aiOn ? '' : ' A IA está desligada: clique em Enviar documentos ou ligue a IA do card (envia sozinho em até 5 min).'}` :e.faltando.length ? `Falta: ${e.faltando.join('; ')}.` : 'Pedido ao cliente: ' + (e.itens.join('; ') || 'comprovação de renda') + '.'}
            {e.docs.length ? ` Vai pro portal: ${e.docs.join('; ')}.` : ' Nenhum documento de renda recebido ainda.'}
          </p>
          <button onClick={enviar} disabled={busy || !e.docs.length} className="mt-1 inline-flex items-center gap-1 rounded bg-af-mid px-2 py-0.5 text-[11px] text-white hover:bg-af-dark disabled:opacity-50" title="A extensão do Credimorar anexa os documentos na Análise manual, escreve o comentário de defesa e clica em Enviar; depois o CRM avisa a Letícia">
            <Upload size={10} /> {p?.status === 'ERRO' ? 'Tentar enviar de novo' : 'Enviar documentos'}
          </button>
        </>
      )}
    </div>
  );
}

'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Home, Send } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';

/* Vistoria da CAIXA pelo SIOPI (Fabio 06/11) — dentro do bloco CAIXA do card. "Solicitar vistoria CAIXA": o CRM lê a certidão do imóvel, confere o contato da vistoria
 * (card → conversa → pergunta ao cliente) e a extensão "SIOPI (A&F)" cadastra o imóvel e prepara a OS de engenharia, PARANDO antes de criar. "Enviar OS": depois de conferir,
 * manda a extensão criar a OS (tem taxa). Estado: GET /api/vistoria-caixa/:id. */
interface Estado {
  status: string | null;
  pedidoEm: string | null; por: string | null;
  codigoImovel: string | null;
  os: { numero?: string; situacao?: string } | null;
  erro: string | null; faltas: string[];
  contato: string | null;
  campos: { rotulo: string; valor: string }[];
}

const ANDAMENTO = ['LENDO', 'FILA', 'RODANDO', 'ENVIAR', 'ENVIANDO', 'AGUARDANDO_CONTATO'];
const ROTULO: Record<string, string> = {
  LENDO: 'lendo a certidão do imóvel…',
  AGUARDANDO_CONTATO: 'esperando o contato da vistoria (nome e telefone)',
  FILA: 'na fila da extensão do SIOPI',
  RODANDO: 'extensão cadastrando o imóvel / preparando a OS…',
  OS_PRONTA: 'OS pronta — confira e clique em "Enviar OS"',
  ENVIAR: 'na fila pra criar a OS',
  ENVIANDO: 'extensão criando a OS…',
  ENVIADA: 'solicitada',
  JA_TEM_OS: 'o imóvel já tem OS no SIOPI',
  OUTRO_CCA: 'imóvel de OUTRO correspondente — pedir alteração à agência por e-mail',
  ERRO: 'parou',
};

export function VistoriaCaixaButton({ leadId, onDone }: { leadId: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [conferir, setConferir] = useState(false);
  const { data: e, refetch } = useQuery<Estado>({
    queryKey: ['vistoria-caixa', leadId],
    queryFn: async () => (await api.get(`/api/vistoria-caixa/${leadId}`)).data,
    refetchInterval: (q) => (ANDAMENTO.includes(q.state.data?.status || '') ? 20_000 : false),
  });
  if (!e) return null;

  async function chamar(acao: 'solicitar' | 'enviar') {
    setBusy(true);
    try {
      const { data } = await api.post(`/api/vistoria-caixa/${leadId}/${acao}`);
      toast(data?.mensagem || 'Pedido enviado');
      setConferir(false);
      refetch();
      onDone?.();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui pedir agora', 'error');
      refetch();
    } finally { setBusy(false); }
  }

  const st = e.status || '';
  const linha = !st ? 'não pedida'
    : st === 'ENVIADA' ? `solicitada${e.os?.numero ? ` · OS ${e.os.numero}` : ''}`
    : st === 'ERRO' ? `parou: ${e.erro || '—'}`
    : `${ROTULO[st] || st}${e.codigoImovel ? ` · imóvel ${e.codigoImovel}` : ''}`;
  const travado = ANDAMENTO.includes(st) || st === 'ENVIADA' || st === 'OS_PRONTA';

  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <p className="truncate text-xs text-slate-600" title={linha}><span className="text-slate-400">Vistoria:</span> {linha}</p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <button
          onClick={() => chamar('solicitar')}
          disabled={busy || travado}
          title="Lê a certidão do imóvel, confere o contato da vistoria e a extensão do SIOPI cadastra o imóvel e prepara a OS (sem enviar)"
          className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-medium text-[#005CA9] hover:bg-blue-100 disabled:opacity-50"
        >
          <Home className="h-3 w-3" /> {st === 'ERRO' || st === 'JA_TEM_OS' || st === 'OUTRO_CCA' ? 'Solicitar vistoria CAIXA de novo' : 'Solicitar vistoria CAIXA'}
        </button>
        {st === 'OS_PRONTA' && (
          <button onClick={() => setConferir(true)} disabled={busy} className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
            <Send className="h-3 w-3" /> Enviar OS
          </button>
        )}
      </div>

      <Modal open={conferir} onClose={() => setConferir(false)} title="Enviar a OS da vistoria na CAIXA" size="sm">
        <div className="space-y-3 text-sm text-slate-600">
          <p>A extensão vai <b>criar a ordem de serviço de engenharia</b> no SIOPI com estes dados (a OS tem taxa):</p>
          <div className="max-h-64 overflow-y-auto rounded border border-slate-200 bg-slate-50 p-2 text-xs">
            {e.campos.length ? e.campos.map((c, i) => <p key={i}><span className="text-slate-400">{c.rotulo}</span> {c.valor}</p>) : <p>—</p>}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConferir(false)} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
            <button onClick={() => chamar('enviar')} disabled={busy} className="text-sm px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">Enviar OS</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Home, Send } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';

/* Vistoria da CAIXA pelo SIOPI (Fabio 06/11) — dentro do bloco CAIXA do card. "Solicitar vistoria CAIXA": o CRM lê a certidão do imóvel, confere o contato da vistoria
 * (card → conversa → pergunta ao cliente) e a extensão "SIOPI (A&F)" cadastra o imóvel e prepara a OS de engenharia, PARANDO antes de criar. "Enviar OS": depois de conferir,
 * manda a extensão criar a OS, anexar a certidão, emitir a taxa e o CRM manda o boleto ao cliente (Fabio 11/11: "serviço completo"). Estado: GET /api/vistoria-caixa/:id. */
interface Estado {
  status: string | null;
  pedidoEm: string | null; por: string | null;
  codigoImovel: string | null;
  os: { numero?: string; situacao?: string } | null;
  erro: string | null; faltas: string[];
  contato: string | null;
  campos: { rotulo: string; valor: string }[];
}

const ANDAMENTO = ['LENDO', 'FILA', 'RODANDO', 'ENVIAR', 'ENVIANDO', 'DOCUMENTOS', 'ANEXANDO', 'TAXA', 'EMITINDO', 'BOLETO', 'BAIXANDO_BOLETO', 'AGUARDANDO_CONTATO'];
const ROTULO: Record<string, string> = {
  LENDO: 'lendo a certidão do imóvel…',
  AGUARDANDO_CONTATO: 'esperando o contato da vistoria (nome e telefone)',
  FILA: 'na fila da extensão do SIOPI',
  RODANDO: 'extensão cadastrando o imóvel / preparando a OS…',
  OS_PRONTA: 'OS pronta — confira e clique em "Enviar OS"',
  ENVIAR: 'na fila pra criar a OS',
  ENVIANDO: 'extensão criando a OS…',
  DOCUMENTOS: 'OS criada — anexando a certidão de ônus…',
  ANEXANDO: 'extensão anexando a certidão de ônus…',
  TAXA_PRONTA: 'OS criada e certidão anexada — falta emitir a taxa (boleto)',
  TAXA: 'na fila pra emitir a taxa',
  EMITINDO: 'extensão emitindo a taxa no SIOPI…',
  BOLETO: 'taxa emitida — baixando o boleto pra mandar ao cliente…',
  BAIXANDO_BOLETO: 'extensão baixando o boleto…',
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

  async function chamar(acao: 'solicitar' | 'enviar' | 'taxa', corpo?: { novoImovel: true }) {
    setBusy(true);
    try {
      const { data } = await api.post(`/api/vistoria-caixa/${leadId}/${acao}`, corpo);
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
    : st === 'TAXA_PRONTA' && e.erro ? `falta a taxa: ${e.erro}`
    : `${ROTULO[st] || st}${e.codigoImovel ? ` · imóvel ${e.codigoImovel}` : ''}`;
  const travado = ANDAMENTO.includes(st) || st === 'ENVIADA' || st === 'OS_PRONTA' || st === 'TAXA_PRONTA';

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
        {/* Fabio 11/11: "emitir taxa e encaminhar ao cliente" — normalmente sai sozinho depois do "Enviar OS"; o botão é pra quando a taxa não saiu. */}
        {st === 'TAXA_PRONTA' && (
          <button
            onClick={() => { if (window.confirm('A extensão emite a taxa de avaliação da CAIXA (R$ 750) no SIOPI e o CRM manda o boleto ao cliente pelo WhatsApp.\n\nSe a OS já tiver taxa, ela não emite outra.')) chamar('taxa'); }}
            disabled={busy}
            title="Emite a taxa da vistoria no SIOPI (nunca duas) e manda o boleto ao cliente"
            className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Send className="h-3 w-3" /> Emitir taxa e mandar boleto
          </button>
        )}
        {/* Cliente trocou de imóvel depois da vistoria pedida (Fabio 10/11): a anterior vai pro histórico e a nova sai da certidão que está na pasta IMOVEL. */}
        {['ENVIADA', 'TAXA_PRONTA', 'OS_PRONTA', 'ERRO'].includes(st) && (
          <button
            onClick={() => { if (window.confirm(`O cliente trocou de imóvel?\n\nA vistoria anterior${e.os?.numero ? ` (OS ${e.os.numero})` : ''} vai pro histórico do card e o CRM pede uma nova com a certidão que está na pasta IMOVEL do Drive. Antes, mande os documentos do imóvel antigo pra pasta DESNECESSARIO.`)) chamar('solicitar', { novoImovel: true }); }}
            disabled={busy}
            title="Cliente trocou de imóvel: guarda a vistoria anterior no histórico e pede a vistoria do imóvel novo"
            className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            <Home className="h-3 w-3" /> Imóvel trocado: nova vistoria
          </button>
        )}
      </div>

      <Modal open={conferir} onClose={() => setConferir(false)} title="Enviar a OS da vistoria na CAIXA" size="sm">
        <div className="space-y-3 text-sm text-slate-600">
          <p>A extensão vai <b>criar a ordem de serviço de engenharia</b> no SIOPI com estes dados, anexar a certidão, <b>emitir a taxa (R$ 750)</b> e o CRM manda o boleto ao cliente pelo WhatsApp:</p>
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

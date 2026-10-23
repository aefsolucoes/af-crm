'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ScrollText, Search } from 'lucide-react';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { toast } from '@/components/ui/toast';

/* Bloco "Certidões" dentro do card (aba Financiamento): pedidos de certidão de matrícula feitos pela extensão
 * "Certidão ONR". Só aparece se o card tem pedido. O botão "Confirmar pagamento" libera a busca da certidão no
 * portal quando o comprovante do cliente não foi reconhecido sozinho. O PDF mora no Drive (subpasta IMOVEL). */

type Certidao = {
  id: string; matricula: string; cartorio: string; uf: string; status: string; protocolo: string | null;
  valorCents: number | null; pixSentAt: string | null; paidAt: string | null; paidVia: string | null;
  detail: string | null; driveUrl: string | null; createdAt: string;
  files?: { name: string; driveUrl?: string | null }[] | null;
};

const STATUS: Record<string, { label: string; cls: string }> = {
  REQUESTED: { label: 'Na fila da extensão', cls: 'bg-slate-100 text-slate-600' },
  RUNNING: { label: 'Fazendo o pedido no portal', cls: 'bg-blue-100 text-blue-700' },
  AWAITING_PAYMENT: { label: 'Aguardando pagamento', cls: 'bg-amber-100 text-amber-700' },
  ISSUED: { label: 'Emitida', cls: 'bg-emerald-100 text-emerald-700' },
  FAILED: { label: 'Falhou', cls: 'bg-red-100 text-red-700' },
  CANCELLED: { label: 'Cancelado', cls: 'bg-slate-100 text-slate-500' },
};

export function LeadCertidoes({ leadId }: { leadId: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const key = ['certidoes', leadId];
  const { data } = useQuery<Certidao[]>({
    queryKey: key,
    queryFn: async () => (await api.get('/api/certidoes', { params: { leadId } })).data,
    refetchInterval: 60_000,
  });

  // Botão "Pedir certidão pelo ONR" (contratação em modo manual): só quando os documentos trazem matrícula + cidade/UF e não há pedido andando.
  const { data: pode } = useQuery<{ possible: boolean; matricula?: string; cidade?: string; uf?: string; jaTemCertidao: boolean }>({
    queryKey: ['certidao-from-docs', leadId],
    queryFn: async () => (await api.get('/api/certidoes/from-docs', { params: { leadId } })).data,
    refetchInterval: 120_000,
  });

  useEffect(() => {
    const socket = getSocket();
    const on = (e: { leadId?: string }) => { if (!e?.leadId || e.leadId === leadId) { queryClient.invalidateQueries({ queryKey: key }); queryClient.invalidateQueries({ queryKey: ['certidao-from-docs', leadId] }); } };
    socket.on('certidao_updated', on);
    return () => { socket.off('certidao_updated', on); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, queryClient]);

  const podePedir = !!pode?.possible;
  if ((!data || data.length === 0) && !podePedir) return null;

  async function pedirPeloOnr() {
    const txt = `Pedir a certidão da matrícula ${pode?.matricula} (${pode?.cidade}/${pode?.uf}) pelo ONR?\n\nA extensão faz o pedido no RI Digital e o PIX (em torno de R$ 40 a R$ 100) vai direto pro cliente. Só peça com o OK dele.${pode?.jaTemCertidao ? '\n\nATENÇÃO: o card já tem uma certidão de ônus/matrícula enviada pelo cliente.' : ''}`;
    if (!window.confirm(txt)) return;
    setBusy('pedir');
    try {
      await api.post('/api/certidoes/from-docs', { leadId });
      toast('Pedido feito — a extensão pede no RI Digital e o PIX vai ao cliente', 'success');
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ['certidao-from-docs', leadId] });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir a certidão', 'error');
    } finally { setBusy(null); }
  }

  async function confirmPaid(c: Certidao) {
    if (!window.confirm(`Confirmar que o cliente PAGOU o PIX da certidão da matrícula ${c.matricula}? A extensão passa a buscar a certidão no portal.`)) return;
    setBusy(c.id);
    try {
      await api.post(`/api/certidoes/${c.id}/paid`);
      toast('Pagamento confirmado — a extensão vai buscar a certidão', 'success');
      queryClient.invalidateQueries({ queryKey: key });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao confirmar o pagamento', 'error');
    } finally { setBusy(null); }
  }

  async function collectNow(c: Certidao) {
    setBusy(c.id);
    try {
      const { data: r } = await api.post(`/api/certidoes/${c.id}/collect-now`);
      toast(r.queuedUntilMorning ? 'Fora do horário (07h–21h): a extensão busca amanhã cedo, com o Chrome aberto' : 'A extensão vai ao portal no próximo minuto (Chrome com a extensão aberto) — se achar, já salva na pasta do cliente', 'success');
      queryClient.invalidateQueries({ queryKey: key });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir a busca', 'error');
    } finally { setBusy(null); }
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <ScrollText className="h-3.5 w-3.5" /> Certidões
      </div>
      {podePedir && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-2 py-1.5">
          <span className="text-[11px] text-slate-600">Matrícula {pode?.matricula} ({pode?.cidade}/{pode?.uf}) lida nos documentos.</span>
          <button
            onClick={pedirPeloOnr}
            disabled={busy === 'pedir'}
            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            <ScrollText className="h-3 w-3" /> Pedir certidão pelo ONR
          </button>
        </div>
      )}
      <div className="space-y-2">
        {(data || []).map((c) => {
          const st = STATUS[c.status] || { label: c.status, cls: 'bg-slate-100 text-slate-600' };
          const waitingPay = c.status === 'AWAITING_PAYMENT' && !c.paidAt;
          return (
            <div key={c.id} className="rounded-md border border-slate-100 p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-700">Matrícula {c.matricula}</span>
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${st.cls}`}>{st.label}</span>
                {c.status === 'AWAITING_PAYMENT' && c.paidAt && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">Pago — buscando a certidão</span>}
              </div>
              <div className="mt-0.5 text-slate-500">{c.cartorio}/{c.uf}{c.protocolo ? ` · protocolo ${c.protocolo}` : ''}</div>
              {c.detail && <div className="mt-0.5 text-slate-400">{c.detail}</div>}
              <div className="mt-1.5 flex flex-wrap gap-2">
                {waitingPay && (
                  <button
                    onClick={() => confirmPaid(c)}
                    disabled={busy === c.id}
                    className="rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {busy === c.id ? 'Confirmando…' : 'Confirmar pagamento'}
                  </button>
                )}
                {c.status === 'AWAITING_PAYMENT' && c.protocolo && (
                  <button
                    onClick={() => collectNow(c)}
                    disabled={busy === c.id}
                    className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    <Search className="h-3 w-3" /> Buscar certidão agora
                  </button>
                )}
                {c.status === 'ISSUED' && c.protocolo && (
                  <button
                    onClick={() => collectNow(c)}
                    disabled={busy === c.id}
                    title="A extensão baixa de novo TODOS os arquivos do pedido no ONR (matrícula e certidão de ônus). Só o que ainda não está no Drive é salvo e mandado ao cliente."
                    className="inline-flex items-center gap-1 rounded border border-blue-200 px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                  >
                    <Search className="h-3 w-3" /> Baixar todos os arquivos de novo
                  </button>
                )}
                {(c.files && c.files.length > 0 ? c.files.filter((f) => f.driveUrl) : c.driveUrl ? [{ name: 'Abrir no Drive', driveUrl: c.driveUrl }] : []).map((f, i) => (
                  <a key={i} href={f.driveUrl || '#'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50" title={f.name}>
                    <ExternalLink className="h-3 w-3" /> {c.files && c.files.length > 1 ? `Arquivo ${i + 1} no Drive` : 'Abrir no Drive'}
                  </a>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

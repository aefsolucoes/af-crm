'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';

/* "Avisar cliente": mostra o texto que vai pro cliente (todas as opções aprovadas, até 3, com o nome em que saiu quando for o
 * 2º participante) e envia. O cliente escolhe a opção respondendo no WhatsApp; a IA do CRM dá o apoio. */
interface Preview { text: string; options: number; mode: 'text' | 'template'; docs: { available: boolean; alreadySent: boolean }; move: { from: string; to: string } | null }

export function NotifyClientModal({ leadId, leadName, onClose, onSent }: { leadId: string; leadName: string; onClose: () => void; onSent: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sendDocs, setSendDocs] = useState(true);
  const [moveStage, setMoveStage] = useState(true);
  const { data, isLoading, error } = useQuery<Preview>({
    queryKey: ['credit-notify-preview', leadId],
    queryFn: async () => (await api.get('/api/credit-analysis/notify-client/preview', { params: { leadId } })).data,
    retry: false,
  });

  async function send() {
    setBusy(true);
    try {
      const { data: r } = await api.post('/api/credit-analysis/notify-client', { leadId, sendDocs, moveStage });
      toast(`${r.mode === 'text' ? 'Cliente avisado pelo WhatsApp' : 'Template enviado — o texto completo sai quando o cliente tocar em "Sim, quero saber"'}${r.docsSent ? ' · lista de documentos enviada' : ''}${r.moved ? ` · card em ${r.moved}` : ''}`, 'success');
      onSent();
      onClose();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao avisar o cliente', 'error');
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`Avisar o cliente — ${leadName}`} onClose={onClose}>
      <div className="space-y-3">
        {isLoading && <Skeleton className="h-40" />}
        {!isLoading && error && <p className="text-sm text-slate-500">Ainda não há opção aprovada com valor para avisar. Preencha o resultado da análise (botão &quot;Resultado&quot;) e tente de novo.</p>}
        {data && (
          <>
            <p className="text-xs text-slate-500">
              {data.options > 1 ? `São ${data.options} opções: o cliente escolhe respondendo no WhatsApp, e a IA do CRM dá o apoio.` : 'Uma opção aprovada.'}
              {' '}{data.mode === 'text' ? 'O cliente falou nas últimas 24 h: o texto vai direto.' : 'A janela de 24 h fechou: vai o template de aprovação e o texto abaixo sai quando ele tocar em "Sim, quero saber".'}
            </p>
            <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-3 text-sm text-slate-800 whitespace-pre-line max-h-80 overflow-y-auto">{data.text}</div>
            <div className="space-y-1.5 rounded-lg border border-af-border p-3 text-xs text-slate-600">
              <label className={`flex items-start gap-2 ${data.mode !== 'text' || !data.docs.available || data.docs.alreadySent ? 'opacity-50' : 'cursor-pointer'}`}>
                <input type="checkbox" className="mt-0.5" checked={sendDocs && data.mode === 'text' && data.docs.available && !data.docs.alreadySent} disabled={data.mode !== 'text' || !data.docs.available || data.docs.alreadySent} onChange={(e) => setSendDocs(e.target.checked)} />
                <span>Enviar também a <strong>lista de documentos</strong> (Resposta rápida &quot;Documentos Home Equity&quot;){data.docs.alreadySent ? ' — já foi enviada pra esse cliente' : !data.docs.available ? ' — não encontrei essa resposta rápida' : data.mode !== 'text' ? ' — só dentro da janela de 24 h' : ''}</span>
              </label>
              <label className={`flex items-start gap-2 ${data.move ? 'cursor-pointer' : 'opacity-50'}`}>
                <input type="checkbox" className="mt-0.5" checked={moveStage && !!data.move} disabled={!data.move} onChange={(e) => setMoveStage(e.target.checked)} />
                <span>Mover o card para <strong>Aguardando Documentação</strong> (liga a IA e manda o e-mail &quot;pré-análise aprovada&quot;){data.move ? ` — hoje em ${data.move.from}` : ' — o card já está nessa etapa ou depois dela'}</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={onClose}>Cancelar</Button>
              <Button onClick={send} disabled={busy}>{busy ? 'Enviando…' : 'Enviar ao cliente'}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

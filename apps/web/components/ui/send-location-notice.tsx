'use client';
import { MapPin } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { useSendLocationNoticeStore } from '@/store/send-location-notice.store';

/* Aviso do CRM logo antes do pedido de localização do aparelho (Fabio 28/10). Só aparece com a chave do pop-up ligada (Configurações → Localização),
 * na 1ª vez em cada aparelho. O envio não espera por ele; fechar também segue pro pedido do aparelho. */
export function SendLocationNotice() {
  const { open, done } = useSendLocationNoticeStore();
  if (!open) return null;
  return (
    <Modal open onClose={done} title="Localização dos envios" size="sm">
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-af-light flex items-center justify-center flex-shrink-0"><MapPin size={18} className="text-af-blue" /></div>
          <p className="text-sm text-slate-600">
            Sua mensagem segue normal. O CRM registra de onde cada mensagem é enviada. Se o aparelho perguntar, toque em <b>Permitir</b>.
          </p>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={done}>Entendi</Button>
        </div>
      </div>
    </Modal>
  );
}

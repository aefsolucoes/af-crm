'use client';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { askVendaFuturaDate, isVendaFuturaStage, useVendaFuturaStore } from '@/store/venda-futura.store';

/* Venda Futura com data marcada À MÃO (Fabio 22/10). A janela abre sozinha quando alguém move um card pra Venda Futura e fica disponível no card ("alterar").
 * No dia escolhido o CRM manda a mensagem de retomada ao cliente (IA do card ligada) ou avisa a equipe (IA desligada / STOP TOTAL). Salva em PUT /api/leads/:id/venda-futura. */

const hojeBrt = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const somaDias = (dias: number) => new Date(Date.now() - 3 * 3600_000 + dias * 86_400_000).toISOString().slice(0, 10);
function proximaSegunda(): string {
  const d = new Date(Date.now() - 3 * 3600_000);
  const add = ((8 - d.getUTCDay()) % 7) || 7; // 1 = segunda
  return new Date(d.getTime() + add * 86_400_000).toISOString().slice(0, 10);
}
const br = (iso: string) => iso.split('-').reverse().join('/');
const diaSemana = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' });

export function VendaFuturaPrompt() {
  const { request, close } = useVendaFuturaStore();
  const queryClient = useQueryClient();
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (request) setDate(request.current && request.current >= hojeBrt() ? request.current : ''); }, [request]);
  if (!request) return null;

  async function save(value: string | null) {
    if (!request) return;
    setSaving(true);
    try {
      await api.put(`/api/leads/${request.leadId}/venda-futura`, { date: value });
      toast(value ? `Retomada marcada para ${br(value)}` : 'Sem data: a retomada segue de 30 em 30 dias', 'success');
      ['lead', 'leads', 'leads-all', 'conversations'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
      close();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Não consegui salvar a data', 'error');
    } finally {
      setSaving(false);
    }
  }

  const atalhos: [string, string][] = [['Segunda que vem', proximaSegunda()], ['15 dias', somaDias(15)], ['30 dias', somaDias(30)], ['60 dias', somaDias(60)], ['90 dias', somaDias(90)]];
  return (
    <Modal open onClose={close} title="Venda Futura — quando retomar o contato?" size="sm">
      <div className="space-y-3">
        <p className="text-sm text-slate-600"><b>{request.leadName}</b> foi pra Venda Futura. Marque o dia em que o CRM deve retomar o contato com ele.</p>
        <div className="flex flex-wrap gap-1.5">
          {atalhos.map(([label, v]) => (
            <button key={label} type="button" onClick={() => setDate(v)} className={`text-xs px-2.5 py-1 rounded-full border ${date === v ? 'bg-af-mid text-white border-af-mid' : 'border-af-border text-slate-600 hover:bg-af-light'}`}>{label} <span className="opacity-70">({br(v).slice(0, 5)})</span></button>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Data
          <input type="date" min={hojeBrt()} value={date} onChange={(e) => setDate(e.target.value)} className="border border-af-border rounded-lg px-2.5 py-2 text-sm text-slate-800" />
        </label>
        {date && <p className="text-xs text-slate-500">Retomada em <b>{diaSemana(date)}, {br(date)}</b>, a partir das 7h.</p>}
        <p className={`text-xs rounded-lg px-3 py-2 border ${request.aiOn === false ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-slate-500 bg-slate-50 border-slate-200'}`}>
          {request.aiOn === false
            ? 'A IA deste card está desligada: no dia você recebe só um aviso (nota + notificação) e a mensagem NÃO vai sozinha. Ligue a IA se quiser que ela mande.'
            : 'No dia o CRM manda a mensagem de retomada pro cliente sozinho (texto livre se a conversa estiver aberta, senão o template de retomada).'}
        </p>
        <div className="flex items-center justify-between gap-2 pt-1">
          <button type="button" onClick={() => save(null)} disabled={saving} className="text-xs text-slate-400 hover:text-slate-600 underline">Sem data (30 em 30 dias)</button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={close} disabled={saving}>Depois</Button>
            <Button size="sm" onClick={() => date && save(date)} loading={saving} disabled={!date}>Salvar data</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Linha fixa no card (Setor/Funil/Estágio): mostra a data de retomada marcada e deixa mudar. Só aparece em Venda Futura. */
export function VendaFuturaDateRow({ leadId, leadName, stageName, customFields, aiOn }: { leadId: string; leadName: string; stageName?: string | null; customFields?: Record<string, unknown> | null; aiOn?: boolean }) {
  if (!isVendaFuturaStage(stageName)) return null;
  const at = String((customFields || {})._vendaFuturaAt || '');
  const marcada = /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : null;
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-af-border bg-af-light/40 px-2.5 py-1.5">
      <span className="text-xs text-slate-600 min-w-0 truncate">📅 {marcada ? <>Retomar contato: <b>{br(marcada)}</b></> : 'Sem data de retomada (30 em 30 dias)'}</span>
      <button type="button" onClick={() => askVendaFuturaDate({ leadId, leadName, current: marcada, aiOn })} className="text-[11px] font-medium text-af-mid hover:underline flex-shrink-0">{marcada ? 'alterar' : 'marcar data'}</button>
    </div>
  );
}

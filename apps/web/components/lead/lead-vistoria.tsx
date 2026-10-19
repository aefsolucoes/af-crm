'use client';
import { useState } from 'react';
import { ClipboardCheck, X } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';

/* Botão "Solicitar vistoria" do card (aba Financiamento, propostas do Inter). A vistoria segue por e-mail: depois do e-mail do Inter
 * ("Engajamento Automático" / "PRÓXIMO PASSO: VISTORIA DO IMÓVEL") o consultor pede o contato do responsável e o telefone. O CRM monta a resposta,
 * mostra aqui pra revisar e só envia quando alguém clica em "Enviar ao Inter" (resposta na mesma conversa, pela caixa comercial). */

type Preview = {
  to: string; cc: string; subject: string; body: string; replyToId: string | null;
  attachment: { name: string; certidaoId: string } | null;
  engajamentoRecebido: boolean; consultor: string | null; jaSolicitadaEm: string | null; avisos: string[];
};

export function LeadVistoria({ leadId, proposta, instituicao, solicitadaEm }: { leadId: string; proposta?: unknown; instituicao?: unknown; solicitadaEm?: unknown }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [p, setP] = useState<Preview | null>(null);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attach, setAttach] = useState(true);
  const [sentAt, setSentAt] = useState<string | null>(solicitadaEm ? String(solicitadaEm) : null);

  const ehInter = /inter/i.test(String(instituicao || '')) || !!String(proposta || '').trim();
  if (!ehInter) return null;

  async function abrir() {
    setLoading(true);
    try {
      const { data } = await api.get<Preview>('/api/vistorias/preview', { params: { leadId } });
      setP(data); setTo(data.to); setCc(data.cc); setSubject(data.subject); setBody(data.body); setAttach(!!data.attachment);
      setOpen(true);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao montar o e-mail da vistoria', 'error');
    } finally { setLoading(false); }
  }

  async function enviar() {
    if (!p) return;
    if (!window.confirm(`Enviar o pedido de vistoria ao Inter (${to})?`)) return;
    setSending(true);
    try {
      await api.post('/api/vistorias/request', { leadId, to, cc, subject, body, replyToId: p.replyToId, attachCertidaoId: attach && p.attachment ? p.attachment.certidaoId : null });
      toast('Vistoria solicitada ao Inter', 'success');
      setSentAt(new Date().toISOString());
      setOpen(false);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao enviar ao Inter', 'error');
    } finally { setSending(false); }
  }

  const quando = sentAt ? new Date(sentAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <ClipboardCheck className="h-3.5 w-3.5" /> Vistoria do imóvel (Inter)
      </div>
      {quando && <div className="mb-2 text-xs text-emerald-700">Vistoria solicitada em {quando}. O engenheiro entra em contato em até 2 dias úteis.</div>}
      <button
        onClick={abrir}
        disabled={loading}
        className="rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50"
      >
        {loading ? 'Montando o e-mail…' : quando ? 'Solicitar de novo' : 'Solicitar vistoria'}
      </button>

      {open && p && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !sending && setOpen(false)}>
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Solicitar vistoria ao Inter</h3>
              <button onClick={() => !sending && setOpen(false)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
            </div>
            {p.avisos.length > 0 && (
              <ul className="mb-3 space-y-1 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                {p.avisos.map((a, i) => <li key={i}>• {a}</li>)}
              </ul>
            )}
            <label className="mb-2 block text-xs text-slate-600">Para
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="consultor@inter.co" className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="mb-2 block text-xs text-slate-600">Cópia (opcional)
              <input value={cc} onChange={(e) => setCc(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="mb-2 block text-xs text-slate-600">Assunto
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="mb-2 block text-xs text-slate-600">Mensagem
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={13} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            {p.attachment && (
              <label className="mb-3 flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Anexar {p.attachment.name}
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setOpen(false)} disabled={sending} className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">Cancelar</button>
              <button onClick={enviar} disabled={sending || !to.trim() || !body.trim()} className="rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50">
                {sending ? 'Enviando…' : 'Enviar ao Inter'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

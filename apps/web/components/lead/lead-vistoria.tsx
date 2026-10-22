'use client';
import { useEffect, useState } from 'react';
import { ClipboardCheck, X } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';

/* Botão "Solicitar vistoria" do card (aba Financiamento, propostas do Inter). A vistoria segue por e-mail: depois do e-mail do Inter
 * ("Engajamento Automático" / "PRÓXIMO PASSO: VISTORIA DO IMÓVEL") o consultor pede o contato do responsável e o telefone. O CRM monta a resposta,
 * mostra aqui pra revisar e só envia quando alguém clica em "Enviar ao Inter" (resposta na mesma conversa, pela caixa comercial). */

type Preview = {
  to: string; cc: string; subject: string; body: string; replyToId: string | null;
  attachment: { name: string; certidaoId: string } | null;
  anexos: { id: string; name: string; path: string; size: number; checked: boolean }[];
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
  const [sel, setSel] = useState<string[]>([]);
  const [sentAt, setSentAt] = useState<string | null>(solicitadaEm ? String(solicitadaEm) : null);

  type Laudo = { job: unknown | null; faltando: string[]; status: string; requestedAt: string | null; filledAt: string | null; link: string | null };
  const [laudo, setLaudo] = useState<Laudo | null>(null);
  const [laudoBusy, setLaudoBusy] = useState(false);
  const ehInter = /inter/i.test(String(instituicao || '')) || !!String(proposta || '').trim();
  // "Seguir com proposta" no portal do Inter (Fabio 22/10): a extensão abre a proposta, vai em Detalhes e clica em "Seguir com proposta"; PARA no aviso de confirmação (o último clique é da equipe).
  type Seguir = { proposta: string | null; status: string; requestedAt: string | null; readyAt: string | null; erro: string | null };
  const [seguir, setSeguir] = useState<Seguir | null>(null);
  const [seguirBusy, setSeguirBusy] = useState(false);
  const [gate, setGate] = useState(false);
  const carregarSeguir = () => api.get<Seguir>('/api/vistorias/seguir/preview', { params: { leadId } }).then((r) => setSeguir(r.data)).catch(() => {});
  const carregarLaudo = () => { carregarSeguir(); return api.get<Laudo>('/api/vistorias/laudo/preview', { params: { leadId } }).then((r) => setLaudo(r.data)).catch(() => {}); };
  useEffect(() => { if (ehInter) { carregarLaudo(); const t = setInterval(carregarLaudo, 20_000); return () => clearInterval(t); } }, [leadId, ehInter]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ehInter) return null;

  async function pedirLaudo() {
    if (!laudo) return;
    if (laudo.faltando.length) { toast(`Faltam no card: ${laudo.faltando.join(', ')}`, 'error'); return; }
    if (!window.confirm('A extensão "Vistoria Inter" vai preencher o laudo digital do apartamento no site do Inter e PARAR na tela de conferência. Você confere e envia. Pedir agora?')) return;
    setLaudoBusy(true);
    try { await api.post('/api/vistorias/laudo/request', { leadId }); toast('Na fila: a extensão preenche em até 1 minuto (Chrome aberto, 07h–22h)', 'success'); await carregarLaudo(); }
    catch (err: any) { toast(err?.response?.data?.error || 'Erro ao pedir o laudo', 'error'); }
    finally { setLaudoBusy(false); }
  }
  const stTxt: Record<string, string> = { REQUESTED: 'Na fila da extensão…', RUNNING: 'A extensão está preenchendo…', FILLED: 'Preenchido — falta conferir e ENVIAR no site do Inter', FAILED: 'A extensão não conseguiu preencher (veja a nota do card)' };

  async function pedirSeguir() {
    if (!window.confirm('A extensão "Vistoria Inter" vai, SOZINHA, abrir a proposta no portal do Inter, ir em Detalhes, clicar em "Seguir com proposta" e CONFIRMAR o aceite ("Aprovar").\n\nIsso é o aceite do cliente no Inter e NÃO dá pra desfazer. Confirme que o cliente quer seguir com o Inter.\n\nSe algo estiver ambíguo na tela do portal, ela para e avisa a equipe. Pedir agora?')) return;
    setSeguirBusy(true);
    try { await api.post('/api/vistorias/seguir/request', { leadId, confirm: true }); toast('Na fila: a extensão segue com a proposta em até 1 minuto (Chrome aberto e logado no Inter, 07h–22h)', 'success'); setGate(false); await carregarSeguir(); }
    catch (err: any) { toast(err?.response?.data?.error || 'Erro ao pedir a abertura da proposta', 'error'); }
    finally { setSeguirBusy(false); }
  }

  async function abrir() {
    setLoading(true);
    try {
      const { data } = await api.get<Preview>('/api/vistorias/preview', { params: { leadId } });
      // Sem o e-mail de engajamento o Inter ainda não liberou a vistoria: a proposta ainda precisa ser SEGUIDA no portal (Detalhes → "Seguir com proposta"). O e-mail só faz sentido depois.
      if (!data.engajamentoRecebido && !data.jaSolicitadaEm && seguir?.proposta) { setP(data); setGate(true); return; }
      setP(data); setTo(data.to); setCc(data.cc); setSubject(data.subject); setBody(data.body); setSel(data.anexos.filter((a) => a.checked).map((a) => a.id));
      setOpen(true);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao montar o e-mail da vistoria', 'error');
    } finally { setLoading(false); }
  }

  function montarEmail() {
    if (!p) return;
    setTo(p.to); setCc(p.cc); setSubject(p.subject); setBody(p.body); setSel(p.anexos.filter((a) => a.checked).map((a) => a.id));
    setGate(false); setOpen(true);
  }
  const seguirTxt: Record<string, string> = {
    REQUESTED: 'Na fila da extensão…',
    RUNNING: 'A extensão está abrindo a proposta no Inter…',
    READY: 'Proposta aberta no Inter, mas a extensão parou: falta o último clique ("Aprovar", aceite do cliente) na janela do Inter',
    DONE: 'Proposta SEGUIDA no Inter (aceite feito). Agora é aguardar o e-mail de engajamento (1–2 dias) e solicitar a vistoria',
    FAILED: 'A extensão não conseguiu abrir/seguir a proposta',
  };

  async function enviar() {
    if (!p) return;
    if (!window.confirm(`Enviar o pedido de vistoria ao Inter (${to})?`)) return;
    setSending(true);
    try {
      await api.post('/api/vistorias/request', { leadId, to, cc, subject, body, replyToId: p.replyToId, attachDriveFileIds: sel });
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
      {seguir?.status && (
        <div className={`mb-2 text-xs ${seguir.status === 'DONE' ? 'text-emerald-700' : seguir.status === 'READY' ? 'text-amber-700' : seguir.status === 'FAILED' ? 'text-red-600' : 'text-slate-500'}`}>
          🤝 {seguirTxt[seguir.status] || seguir.status}{seguir.status === 'FAILED' && seguir.erro ? ` — ${seguir.erro}` : ''}
        </div>
      )}
      <button
        onClick={abrir}
        disabled={loading}
        className="rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50"
      >
        {loading ? 'Montando o e-mail…' : quando ? 'Solicitar de novo' : 'Solicitar vistoria'}
      </button>
      {seguir?.proposta && !quando && (
        <button
          onClick={pedirSeguir}
          disabled={seguirBusy || seguir.status === 'REQUESTED' || seguir.status === 'RUNNING' || seguir.status === 'DONE'}
          title="A extensão abre a proposta no portal do Inter, vai em Detalhes, clica em Seguir com proposta e confirma o aceite"
          className="ml-2 rounded border border-orange-300 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-50 disabled:opacity-50"
        >
          {seguir.status === 'READY' || seguir.status === 'FAILED' ? 'Seguir com proposta de novo' : 'Seguir com proposta no Inter'}
        </button>
      )}

      {laudo && (laudo.job || laudo.faltando.length > 0) && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <div className="mb-1 text-xs font-medium text-slate-600">Laudo digital do apartamento (formulário do Inter)</div>
          {laudo.status && <div className={`mb-1 text-xs ${laudo.status === 'FILLED' ? 'text-emerald-700' : laudo.status === 'FAILED' ? 'text-red-600' : 'text-slate-500'}`}>{stTxt[laudo.status] || laudo.status}</div>}
          {laudo.faltando.length > 0 && <div className="mb-1 text-xs text-amber-700">Faltam no card: {laudo.faltando.join(', ')}</div>}
          <div className="flex flex-wrap gap-2">
            <button onClick={pedirLaudo} disabled={laudoBusy || laudo.status === 'REQUESTED' || laudo.status === 'RUNNING'} className="rounded bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              {laudo.status === 'FILLED' || laudo.status === 'FAILED' ? 'Preencher de novo' : 'Preencher laudo (extensão)'}
            </button>
            {laudo.link && <a href={laudo.link} target="_blank" rel="noreferrer" className="rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">Abrir formulário do Inter</a>}
          </div>
        </div>
      )}

      {gate && p && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setGate(false)}>
          <div className="w-full max-w-md rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Antes da vistoria: seguir com a proposta</h3>
              <button onClick={() => setGate(false)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
            </div>
            <p className="text-sm text-slate-600">O Inter ainda não mandou o e-mail de engajamento: a vistoria só é liberada depois que a proposta é <b>seguida no portal</b> (Detalhes da proposta → "Seguir com proposta").</p>
            <p className="mt-2 text-xs text-slate-500">A extensão abre a proposta <b>{seguir?.proposta}</b> no portal, clica em "Seguir com proposta" e confirma o aceite ("Aprovar" — aceite do cliente, sem volta). Se algo ficar ambíguo na tela, ela para e avisa.</p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button onClick={montarEmail} className="rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">Montar o e-mail mesmo assim</button>
              <button onClick={pedirSeguir} disabled={seguirBusy} className="rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50">{seguirBusy ? 'Pedindo…' : 'Seguir com proposta no Inter'}</button>
            </div>
          </div>
        </div>
      )}

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
            <div className="mb-3 rounded border border-slate-200 p-2">
              <div className="mb-1 text-xs font-medium text-slate-600">Anexos (pasta IMOVEL do cliente) — o pedido vai sempre com anexo</div>
              {p.anexos.length === 0 && <div className="text-xs text-red-600">Nenhum arquivo na pasta IMOVEL deste cliente.</div>}
              {p.anexos.map((a) => (
                <label key={a.id} className="flex items-center gap-2 py-0.5 text-xs text-slate-600">
                  <input type="checkbox" checked={sel.includes(a.id)} onChange={(e) => setSel((cur) => (e.target.checked ? [...cur, a.id] : cur.filter((x) => x !== a.id)))} />
                  <span>{a.name} <span className="text-slate-400">({Math.max(1, Math.round(a.size / 1024))} KB)</span></span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setOpen(false)} disabled={sending} className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">Cancelar</button>
              <button onClick={enviar} disabled={sending || !to.trim() || !body.trim() || sel.length === 0} className="rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50">
                {sending ? 'Enviando…' : 'Enviar ao Inter'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

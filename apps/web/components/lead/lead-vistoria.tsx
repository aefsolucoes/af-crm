'use client';
import { useEffect, useState } from 'react';
import { ClipboardCheck, Copy, X } from 'lucide-react';
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
    // Faltando dado (Fabio 03/11): o CRM lê a matrícula (ano de construção) e pergunta ao cliente só o que faltar — template se a conversa estiver fechada.
    const msg = laudo.faltando.length
      ? `Faltam no card: ${laudo.faltando.join(', ')}.\n\nO CRM vai ler os documentos do imóvel (o ano de construção sai da matrícula) e perguntar ao cliente só o que ainda faltar — se a conversa estiver fechada, manda antes o template "Olá, tudo bem?". Com a resposta, o laudo entra sozinho na fila da extensão. Seguir?`
      : 'A extensão "Vistoria Inter" vai preencher o laudo digital do apartamento no site do Inter e PARAR na tela de conferência. Você confere e envia. Pedir agora?';
    if (!window.confirm(msg)) return;
    setLaudoBusy(true);
    try {
      const { data } = await api.post<{ queued: boolean; asked: 'mensagem' | 'template' | 'aguardando' | null; faltando: string[] }>('/api/vistorias/laudo/request', { leadId }, { timeout: 120_000 });
      if (data.queued) toast('Na fila: a extensão preenche em até 1 minuto (Chrome aberto, 07h–22h)', 'success');
      else if (data.asked === 'mensagem') toast('Perguntei ao cliente o que faltava. Com a resposta, o laudo entra na fila sozinho.', 'success');
      else if (data.asked === 'template') toast('Conversa fechada: mandei o template "Olá, tudo bem?". A pergunta sai quando o cliente responder.', 'success');
      else if (data.asked === 'aguardando') toast('A pergunta já está esperando o cliente responder ao template.', 'success');
      await carregarLaudo();
    }
    catch (err: any) { toast(err?.response?.data?.error || 'Erro ao pedir o laudo', 'error'); }
    finally { setLaudoBusy(false); }
  }
  const stTxt: Record<string, string> = { REQUESTED: 'Na fila da extensão…', RUNNING: 'A extensão está preenchendo…', FILLED: 'Preenchido — enviando ao Inter…', SENT: 'Laudo enviado ao Inter ✅', FAILED: 'A extensão não conseguiu preencher (veja a nota do card)' };

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
          {laudo.link && (
            <div className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
              <span className="shrink-0">Link do engajamento:</span>
              <a href={laudo.link} target="_blank" rel="noreferrer" className="break-all text-blue-600 hover:underline">{laudo.link}</a>
              <button onClick={() => { navigator.clipboard.writeText(laudo.link!).then(() => toast('Link copiado', 'success')).catch(() => {}); }} title="Copiar o link" className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><Copy className="h-3 w-3" /></button>
            </div>
          )}
          {laudo.status && <div className={`mb-1 text-xs ${laudo.status === 'FILLED' || laudo.status === 'SENT' ? 'text-emerald-700' : laudo.status === 'FAILED' ? 'text-red-600' : 'text-slate-500'}`}>{stTxt[laudo.status] || laudo.status}</div>}
          {laudo.faltando.length > 0 && <div className="mb-1 text-xs text-amber-700">Faltam no card: {laudo.faltando.join(', ')}</div>}
          <div className="flex flex-wrap gap-2">
            <button onClick={pedirLaudo} disabled={laudoBusy || laudo.status === 'REQUESTED' || laudo.status === 'RUNNING'} className="rounded bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              {laudo.status === 'FILLED' || laudo.status === 'FAILED' || laudo.status === 'SENT' ? 'Preencher de novo' : 'Preencher laudo (extensão)'}
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
                  <AbrirArquivo a={a} />
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

/* Vistoria do Santander (Fabio 29/10: "coloca dentro do card igual é do Inter"). Não tem extensão: é um e-mail à Letícia. O botão avança o fluxo do CRM
 * (autorização USECASA ao cliente → assinatura no gov.br → documentos da pasta + cadastro WEB CASAS → e-mail à Letícia). Ver vistoria-santander.service.ts. */
type SantanderPreview =
  | { aplicavel: false }
  | { aplicavel: true; financiamento?: boolean; status: string; statusTexto: string; askedAt: string | null; signedAt: string | null; sentAt: string | null; to: string; docs: { key: string; label: string; ok: boolean }[]; temLinkPasta: boolean };

export function LeadVistoriaSantander({ leadId }: { leadId: string }) {
  const [p, setP] = useState<SantanderPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const carregar = () => api.get<SantanderPreview>('/api/vistorias/santander/preview', { params: { leadId } }).then((r) => setP(r.data)).catch(() => {});
  useEffect(() => { carregar(); }, [leadId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p || !p.aplicavel) return null;

  const enviada = p.status === 'ENVIADA';
  const pronta = p.status === 'PRONTA';
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null);

  async function avancar() {
    const fh = !!(p && p.aplicavel && p.financiamento);
    const msg = !p || !p.aplicavel ? '' : pronta || p.signedAt
      ? `Conferir tudo e ENVIAR o pedido de vistoria à Letícia (${p.to}), com ${fh ? 'a autorização e a declaração de saúde assinadas, a ficha de cadastro' : 'a autorização assinada, o cadastro WEB CASAS'} e os documentos da pasta?`
      : p.askedAt
        ? `Conferir agora se o cliente já devolveu ${fh ? 'a autorização e a declaração de saúde assinadas' : 'a autorização assinada'} e se os documentos estão na pasta?`
        : fh
          ? 'Mandar ao cliente, pelo WhatsApp, a autorização do Santander (assinar pelo gov.br), a lista da declaração de saúde (ele confirma) e o pedido do contato do corretor/vendedor e da conta do vendedor?'
          : 'Mandar ao cliente, pelo WhatsApp, a autorização USECASA já preenchida para ele assinar pelo gov.br?';
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      const { data } = await api.post<SantanderPreview>('/api/vistorias/santander/run', { leadId });
      setP(data);
      toast(data.aplicavel && data.status === 'ENVIADA' ? 'Vistoria solicitada à Letícia' : 'Fluxo avançado — veja o andamento e as notas do card', 'success');
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao avançar a vistoria do Santander', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <ClipboardCheck className="h-3.5 w-3.5" /> Vistoria do imóvel (Santander)
      </div>
      {enviada && <div className="mb-2 text-xs text-emerald-700">Pedido enviado à Letícia{p.sentAt ? ` em ${fmt(p.sentAt)}` : ''}.</div>}
      {!enviada && p.statusTexto && <div className={`mb-2 text-xs ${pronta ? 'text-amber-700' : p.status === 'ERRO' ? 'text-red-600' : 'text-slate-500'}`}>🏦 {p.statusTexto}</div>}
      {!p.status && <div className="mb-2 text-xs text-slate-500">{p.financiamento
        ? 'Ainda não iniciada. Financiamento: o CRM manda ao cliente a autorização e a declaração de saúde (assinar pelo gov.br), pede o contato do corretor/vendedor e a conta do vendedor, preenche a ficha de cadastro e junta os documentos da pasta; tudo vai por e-mail à Letícia.'
        : 'Ainda não iniciada. A vistoria do Santander sai por e-mail à Letícia: o CRM manda a autorização USECASA ao cliente (assinar pelo gov.br), junta o cadastro WEB CASAS e os documentos da pasta.'}</div>}
      <ul className="mb-2 space-y-0.5 text-xs">
        {p.docs.map((d) => <li key={d.key} className={d.ok ? 'text-emerald-700' : 'text-amber-700'}>{d.ok ? '✓' : '•'} {d.label}{d.ok ? '' : d.key === 'conta' || d.key === 'contato' || d.key === 'contaComprador' ? ' — falta (o CRM pede ao cliente)' : ' — falta na pasta do Drive'}</li>)}
      </ul>
      {!p.temLinkPasta && <div className="mb-2 text-xs text-red-600">Este card não tem pasta do Drive vinculada.</div>}
      {!enviada && (
        <button onClick={avancar} disabled={busy} className="rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50">
          {busy ? 'Trabalhando…' : pronta || p.signedAt ? 'Enviar à Letícia' : p.askedAt ? 'Conferir assinatura e documentos' : 'Iniciar: mandar autorização ao cliente'}
        </button>
      )}
    </div>
  );
}

/* Vistoria da Creditas (Fabio 03/11: "já temos base que é por e-mail para o Jonatas"). Aparece quando o card tem aprovação da Creditas. O clique monta o e-mail ao Jonatas
 * (nome e telefone do cliente + certidão de ônus e capa do IPTU da pasta IMOVEL) pra revisar; só sai quando alguém clica em "Enviar à Creditas". Ver vistoria-creditas.service.ts. */
type CreditasPreview = {
  to: string; cc: string; subject: string; body: string; replyToId: string | null;
  anexos: { id: string; name: string; path: string; size: number; checked: boolean }[];
  jaSolicitadaEm: string | null; temCreditas: boolean; contatoVazio: boolean; avisos: string[];
};
type CreditasStatus = { aplicavel: boolean; jaSolicitadaEm: string | null; contatoVazio: boolean; contatoPerguntadoEm: string | null };

export function LeadVistoriaCreditas({ leadId }: { leadId: string }) {
  const [st, setSt] = useState<CreditasStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [p, setP] = useState<CreditasPreview | null>(null);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  useEffect(() => { api.get<CreditasStatus>('/api/vistorias/creditas/status', { params: { leadId } }).then((r) => setSt(r.data)).catch(() => {}); }, [leadId]);
  if (!st || !st.aplicavel) return null;

  async function abrir() {
    setLoading(true);
    try {
      // Sem "Contato vistoria" no card (Fabio 03/11): o CRM pergunta ao cliente quem acompanha a vistoria — sem citar o banco. Conversa fechada: template "Olá, tudo bem?" antes.
      const perguntadoHa = st?.contatoPerguntadoEm ? Date.now() - new Date(st.contatoPerguntadoEm).getTime() : Infinity;
      if (st?.contatoVazio && perguntadoHa > 3 * 86_400_000 && window.confirm('O card não tem o "Contato vistoria".\n\nO CRM vai perguntar ao cliente quem acompanha a vistoria do imóvel (nome e telefone) — se a conversa estiver fechada, manda antes o template "Olá, tudo bem?". A resposta vai pro card.\n\nPerguntar agora? (Cancelar = só abrir o e-mail)')) {
        try {
          const { data } = await api.post<{ asked: string }>('/api/vistorias/creditas/ask-contato', { leadId });
          toast(data.asked === 'template' ? 'Conversa fechada: mandei o template "Olá, tudo bem?". A pergunta do contato sai quando o cliente responder.' : data.asked === 'mensagem' ? 'Perguntei ao cliente o contato da vistoria.' : data.asked === 'aguardando' ? 'A pergunta do contato já está esperando o cliente.' : 'O card já tem o contato da vistoria.', 'success');
          setSt((cur) => (cur ? { ...cur, contatoPerguntadoEm: new Date().toISOString() } : cur));
        } catch (err: any) { toast(err?.response?.data?.error || 'Erro ao perguntar o contato da vistoria', 'error'); }
      }
      const { data } = await api.get<CreditasPreview>('/api/vistorias/creditas/preview', { params: { leadId } });
      setP(data); setTo(data.to); setCc(data.cc); setSubject(data.subject); setBody(data.body); setSel(data.anexos.filter((a) => a.checked).map((a) => a.id));
      setOpen(true);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao montar o e-mail da vistoria', 'error');
    } finally { setLoading(false); }
  }

  async function enviar() {
    if (!p) return;
    if (!window.confirm(`Enviar o pedido de vistoria à Creditas (${to})?`)) return;
    setSending(true);
    try {
      await api.post('/api/vistorias/creditas/request', { leadId, to, cc, subject, body, replyToId: p.replyToId, attachDriveFileIds: sel });
      toast('Vistoria solicitada à Creditas', 'success');
      setSt((cur) => (cur ? { ...cur, jaSolicitadaEm: new Date().toISOString() } : cur));
      setOpen(false);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao enviar à Creditas', 'error');
    } finally { setSending(false); }
  }

  const quando = st.jaSolicitadaEm ? new Date(st.jaSolicitadaEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <ClipboardCheck className="h-3.5 w-3.5" /> Vistoria do imóvel (Creditas)
      </div>
      {quando
        ? <div className="mb-2 text-xs text-emerald-700">Vistoria solicitada em {quando}.</div>
        : <div className="mb-2 text-xs text-slate-500">A vistoria da Creditas sai por e-mail ao Jonatas: nome e telefone do cliente, certidão de ônus e capa do IPTU da pasta do cliente.</div>}
      <button onClick={abrir} disabled={loading} className="rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50">
        {loading ? 'Montando o e-mail…' : quando ? 'Solicitar de novo' : 'Solicitar vistoria Creditas'}
      </button>

      {open && p && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !sending && setOpen(false)}>
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Solicitar vistoria à Creditas</h3>
              <button onClick={() => !sending && setOpen(false)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
            </div>
            {p.avisos.length > 0 && (
              <ul className="mb-3 space-y-1 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                {p.avisos.map((a, i) => <li key={i}>• {a}</li>)}
              </ul>
            )}
            <label className="mb-2 block text-xs text-slate-600">Para
              <input value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="mb-2 block text-xs text-slate-600">Cópia (opcional)
              <input value={cc} onChange={(e) => setCc(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="mb-2 block text-xs text-slate-600">Assunto
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="mb-2 block text-xs text-slate-600">Mensagem
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <div className="mb-3 rounded border border-slate-200 p-2">
              <div className="mb-1 text-xs font-medium text-slate-600">Anexos (documentos do imóvel do cliente)</div>
              {p.anexos.length === 0 && <div className="text-xs text-red-600">Nenhum documento do imóvel encontrado para este cliente.</div>}
              {p.anexos.map((a) => (
                <label key={a.id} className="flex items-center gap-2 py-0.5 text-xs text-slate-600">
                  <input type="checkbox" checked={sel.includes(a.id)} onChange={(e) => setSel((cur) => (e.target.checked ? [...cur, a.id] : cur.filter((x) => x !== a.id)))} />
                  <span>{a.name}{a.size ? <span className="text-slate-400"> ({Math.max(1, Math.round(a.size / 1024))} KB)</span> : null}</span>
                  <AbrirArquivo a={a} />
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setOpen(false)} disabled={sending} className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">Cancelar</button>
              <button onClick={enviar} disabled={sending || !to.trim() || !body.trim()} className="rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50">
                {sending ? 'Enviando…' : 'Enviar à Creditas'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** "abrir" ao lado de cada anexo (Fabio 05/11: "não consigo visualizar o documento para saber o que é") — arquivo do Drive abre numa aba nova. */
function AbrirArquivo({ a }: { a: { id: string; path: string } }) {
  if (a.path === 'conversa') return null; // anexo da conversa: está na própria Inbox
  return (
    <a href={`https://drive.google.com/file/d/${a.id}/view`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="ml-auto shrink-0 text-af-mid hover:underline" title="Abrir o arquivo no Drive">abrir</a>
  );
}

/* Vistoria do Itaú (Fabio 11/11). No portal Itaú Imóveis a vistoria não se pede por e-mail: depois da aprovação a proposta fica em "Formulários Digitais"
 * (compradores, vendedor, imóvel com o contato da vistoria, seguro). O clique põe na fila da extensão "Financiamento Itaú", que preenche e salva no portal;
 * o que faltar vem numa nota. Ver vistoria-itau.service.ts. */
type ItauStatus = { aplicavel: boolean; proposta: string | null; st: { status?: string; requestedAt?: string; at?: string; faltando?: string[]; erro?: string | null; etapa?: string } | null };

export function LeadVistoriaItau({ leadId }: { leadId: string }) {
  const [st, setSt] = useState<ItauStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const carregar = () => api.get<ItauStatus>('/api/vistorias/itau/status', { params: { leadId } }).then((r) => setSt(r.data)).catch(() => {});
  useEffect(() => { carregar(); }, [leadId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st || !st.aplicavel) return null;
  const s = st.st || {};
  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  const naFila = s.status === 'REQUESTED' || s.status === 'RUNNING';
  const texto = s.status === 'REQUESTED' ? `Na fila da extensão desde ${fmt(s.requestedAt)}.`
    : s.status === 'RUNNING' ? `A extensão está preenchendo${s.etapa ? ` (${s.etapa})` : ''}.`
    : s.status === 'SAVED' ? `Formulários completos e salvos em ${fmt(s.at)}. Próximo: envio dos documentos (Mesa de entrada).`
    : s.status === 'PARTIAL' ? `Salvos em parte em ${fmt(s.at)}.`
    : s.status === 'FAILED' ? `Não preencheu: ${s.erro || 'erro'}.`
    : 'Ainda não preenchidos. A extensão preenche compradores, vendedor, imóvel (com o contato da vistoria) e o seguro no portal do Itaú.';

  async function pedir() {
    if (!window.confirm(`Pedir à extensão "Financiamento Itaú" que preencha e salve os formulários digitais da proposta ${st?.proposta || ''} no portal do Itaú?`)) return;
    setBusy(true);
    try {
      await api.post('/api/vistorias/itau/request', { leadId });
      toast('Formulários do Itaú na fila da extensão', 'success');
      carregar();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir os formulários do Itaú', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <ClipboardCheck className="h-3.5 w-3.5" /> Vistoria do imóvel (Itaú{st.proposta ? ` — proposta ${st.proposta}` : ''})
      </div>
      <div className={`mb-2 text-xs ${s.status === 'FAILED' ? 'text-red-600' : s.status === 'SAVED' ? 'text-emerald-700' : s.status === 'PARTIAL' ? 'text-amber-700' : 'text-slate-500'}`}>{texto}</div>
      {s.status === 'PARTIAL' && !!s.faltando?.length && (
        <ul className="mb-2 space-y-0.5 text-xs text-amber-700">{s.faltando.slice(0, 12).map((f) => <li key={f}>• {f}</li>)}</ul>
      )}
      <button onClick={pedir} disabled={busy || naFila} className="rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50">
        {busy ? 'Pedindo…' : naFila ? 'Na fila da extensão' : s.status ? 'Preencher de novo' : 'Preencher formulários do Itaú'}
      </button>
    </div>
  );
}

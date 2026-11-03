'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { AttachmentPreviewModal } from '@/components/inbox/message-attachment';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { RefreshCw, Eye, Pencil, Loader2, CheckCircle2, AlertTriangle, HelpCircle, XCircle, Lock, FileQuestion } from 'lucide-react';

/* Painel de documentos do card (Fabio 03/11: "preciso de um botão para verificar qual documento falta do cliente e a IA também listar quais documentos já foram
 * recebidos e a gente corrigir eles, caso esteja errado"). Abre sem chamar a IA (GET /api/leads/:id/docs-panel): RECEBIDOS = a leitura que a IA guardou de cada arquivo;
 * FALTANDO = a mesma regra da conferência + o que a última conferência achou faltando da lista do banco. "Conferir de novo" = o botão antigo (sem mensagem ao cliente,
 * sem mover o card). "Corrigir" grava só a leitura daquele arquivo e a conferência passa a usar a correção. */

type Situacao = 'OK' | 'PROBLEMA' | 'DUVIDA' | 'NAO_DOCUMENTO' | 'PROTEGIDO' | 'SO_CLASSIFICADO' | 'SEM_LEITURA';
interface Leitura {
  tipo: string; titular: string; resultado: 'OK' | 'PROBLEMA' | 'NAO_DOCUMENTO' | 'DUVIDA'; problemas: string[]; lado?: string; emissao?: string; observacao?: string;
  dono?: string; donoSituacao?: string; duvida?: string; ressalva?: string; outros?: string[]; corrigidoPor?: string; corrigidoEm?: string;
  antesDaCorrecao?: { tipo?: string; titular?: string; resultado?: string };
}
interface Recebido { id: string; fileName: string; mimeType: string; createdAt: string; situacao: Situacao; tipo: string; titular: string; leitura: Leitura | null }
interface Painel {
  emAndamento: boolean;
  recebidos: Recebido[];
  conferencia: { em: string | null; listaUsada: string; completo: boolean; faltando: string[]; emitir: string[]; emitirPendente: string[] } | null;
  problemas: { doc: string; texto: string[] }[];
  duvidas: { attachmentId: string; arquivo: string; doc: string; pergunta: string }[];
  donoPendente: { attachmentId: string; doc: string; dono: string; empresa?: boolean; perguntado?: boolean }[];
}
interface Form { tipo: string; titular: string; resultado: string; problemas: string; lado: string; dono: string; donoSituacao: string }

const TIPOS = ['RG', 'CNH', 'CPF', 'CERTIDAO DE NASCIMENTO', 'CERTIDAO DE CASAMENTO', 'COMPROVANTE DE RESIDENCIA', 'CONTRACHEQUE', 'EXTRATO BANCARIO', 'IMPOSTO DE RENDA',
  'AUTORIZACAO SCR BACEN', 'MATRICULA', 'CERTIDAO DE ONUS REAIS', 'ESCRITURA', 'CAPA IPTU', 'GUIA IPTU', 'CND IPTU', 'CERTIDAO DE CADASTRO IMOBILIARIO', 'SALDO DEVEDOR', 'DESCRITIVO DA PARCELA'];
const SITUACAO: Record<Situacao, { rotulo: string; cls: string; Icon: typeof CheckCircle2 }> = {
  OK: { rotulo: 'OK', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: CheckCircle2 },
  PROBLEMA: { rotulo: 'Com problema', cls: 'bg-amber-50 text-amber-700 border-amber-200', Icon: AlertTriangle },
  DUVIDA: { rotulo: 'Em dúvida (equipe)', cls: 'bg-violet-50 text-violet-700 border-violet-200', Icon: HelpCircle },
  NAO_DOCUMENTO: { rotulo: 'Não é documento', cls: 'bg-slate-50 text-slate-500 border-slate-200', Icon: XCircle },
  PROTEGIDO: { rotulo: 'Protegido por senha', cls: 'bg-slate-50 text-slate-600 border-slate-200', Icon: Lock },
  SO_CLASSIFICADO: { rotulo: 'Só identificado', cls: 'bg-sky-50 text-sky-700 border-sky-200', Icon: FileQuestion },
  SEM_LEITURA: { rotulo: 'Sem leitura', cls: 'bg-slate-50 text-slate-600 border-slate-200', Icon: FileQuestion },
};
const DONO: Record<string, string> = { PARTICIPANTE: 'participante', PARENTE_1GRAU: 'parente de 1º grau', OUTRO_SEM_RELACAO: 'outra pessoa (sem vínculo explicado)', EMPRESA: 'empresa' };

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const ehIdentidade = (tipo: string) => /^(RG|CNH)\b/.test(semAcento(tipo.trim()));
const ehDocDoImovel = (tipo: string) => /IMOVEL|MATRICULA|ONUS|IPTU|ESCRITURA|CADASTRO IMOBILIARIO|HABITE|COMPRA E VENDA|INTEIRO TEOR|AVERBACAO|PROMESSA/.test(semAcento(tipo));
const data = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

export function LeadDocsPanel({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const [painel, setPainel] = useState<Painel | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [pedindo, setPedindo] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [form, setForm] = useState<Form>({ tipo: '', titular: '', resultado: 'OK', problemas: '', lado: '', dono: '', donoSituacao: '' });
  const [salvando, setSalvando] = useState(false);
  const [abrindo, setAbrindo] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; fileName: string; isPdf: boolean } | null>(null);
  const [verIgnorados, setVerIgnorados] = useState(false);
  const esperandoConferencia = useRef(false);

  const carregar = useCallback(async () => {
    try {
      const { data: p } = await api.get<Painel>(`/api/leads/${leadId}/docs-panel`);
      setPainel(p);
      if (esperandoConferencia.current && !p.emAndamento) { esperandoConferencia.current = false; toast('Conferência concluída — painel atualizado'); }
    } catch {
      toast('Erro ao carregar os documentos', 'error');
    } finally {
      setCarregando(false);
    }
  }, [leadId]);

  useEffect(() => { carregar(); }, [carregar]);
  // Conferência rodando no servidor (12 PDFs levam minutos): atualiza sozinho até terminar.
  useEffect(() => {
    if (!painel?.emAndamento) return;
    const t = setTimeout(carregar, 4000);
    return () => clearTimeout(t);
  }, [painel, carregar]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  // "Conferir de novo" = o botão antigo "Conferir documentos" (Fabio 28/10): lê os arquivos novos e confere com a lista do banco, sem mensagem ao cliente e sem mover o card.
  async function conferir() {
    setPedindo(true);
    try {
      const { data: r } = await api.post(`/api/leads/${leadId}/docs-check`);
      esperandoConferencia.current = true;
      toast(r?.jaRodando ? 'A conferência deste card já está rodando' : 'Conferindo os documentos — o painel atualiza sozinho quando terminar');
      await carregar();
    } catch {
      toast('Erro ao conferir os documentos', 'error');
    } finally {
      setPedindo(false);
    }
  }

  async function abrir(r: Recebido) {
    setAbrindo(r.id);
    try {
      const res = await api.get(`/api/messages/attachment/${r.id}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const isPdf = r.mimeType === 'application/pdf';
      if (isPdf || r.mimeType.startsWith('image/')) { setPreview({ url, fileName: r.fileName, isPdf }); return; }
      baixar(url, r.fileName);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast(err?.response?.status === 410 ? 'O arquivo está no Google Drive e não abriu aqui — abra pela pasta do cliente' : 'Não consegui abrir o arquivo', 'error');
    } finally {
      setAbrindo(null);
    }
  }
  function baixar(url: string, fileName: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function comecarCorrecao(r: Recebido) {
    const l = r.leitura;
    setEditando(r.id);
    setForm({
      tipo: l?.tipo || (r.tipo === 'PROTEGIDO' ? '' : r.tipo) || '',
      titular: l?.titular || r.titular || '',
      resultado: l?.resultado === 'PROBLEMA' || l?.resultado === 'NAO_DOCUMENTO' ? l.resultado : r.situacao === 'NAO_DOCUMENTO' ? 'NAO_DOCUMENTO' : 'OK',
      problemas: (l?.problemas || []).join('\n'),
      lado: l?.lado || '',
      dono: l?.dono || '',
      donoSituacao: l?.donoSituacao || '',
    });
  }

  async function salvar(id: string) {
    setSalvando(true);
    try {
      await api.patch(`/api/leads/${leadId}/docs/${id}`, {
        tipo: form.tipo, titular: form.titular, resultado: form.resultado,
        ...(form.resultado === 'PROBLEMA' ? { problemas: form.problemas.split('\n') } : {}),
        ...(ehIdentidade(form.tipo) ? { lado: form.lado } : {}),
        ...(ehDocDoImovel(form.tipo) ? { dono: form.dono, donoSituacao: form.donoSituacao || null } : {}),
      });
      toast('Correção salva — a conferência passa a usar a sua leitura');
      setEditando(null);
      await carregar();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao salvar a correção', 'error');
    } finally {
      setSalvando(false);
    }
  }

  const recebidos = [...(painel?.recebidos || [])].reverse(); // mais recente primeiro
  const docs = recebidos.filter((r) => r.situacao !== 'NAO_DOCUMENTO');
  const ignorados = recebidos.filter((r) => r.situacao === 'NAO_DOCUMENTO');
  const conf = painel?.conferencia || null;
  const desatualizada = !!conf?.em && (painel?.recebidos || []).some((r) => r.createdAt > conf.em! || (r.leitura?.corrigidoEm || '') > conf.em!);
  const nadaPendente = !!painel && !!conf?.completo && !conf.faltando.length && !painel.problemas.length && !painel.duvidas.length && !painel.donoPendente.length;
  const input = 'w-full text-xs px-2 py-1 border border-af-border rounded-md focus:outline-none focus:border-af-mid bg-white';

  function linha(r: Recebido) {
    const s = SITUACAO[r.situacao];
    const l = r.leitura;
    const aberto = editando === r.id;
    return (
      <li key={r.id} className="border border-af-border rounded-lg p-2.5">
        <div className="flex items-start gap-2">
          <s.Icon size={15} className={`mt-0.5 flex-shrink-0 ${s.cls.split(' ').find((c) => c.startsWith('text-'))}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-semibold text-slate-800">{r.tipo || 'Documento'}</span>
              {r.titular && <span className="text-xs text-slate-600">· {r.titular}</span>}
              {l?.lado && ehIdentidade(r.tipo) && <span className="text-[11px] text-slate-500">({l.lado})</span>}
              <span className={`text-[10px] font-medium px-1.5 py-0.5 border rounded ${s.cls}`}>{s.rotulo}</span>
              {l?.corrigidoPor && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200" title={l.antesDaCorrecao ? `A IA tinha lido: ${l.antesDaCorrecao.tipo || '—'} ${l.antesDaCorrecao.titular ? `· ${l.antesDaCorrecao.titular}` : ''} (${l.antesDaCorrecao.resultado || '—'})` : undefined}>corrigido por {l.corrigidoPor} {data(l.corrigidoEm)}</span>}
            </div>
            <p className="text-[11px] text-slate-400 truncate" title={r.fileName}>{r.fileName} · {data(r.createdAt)}</p>
            {l?.problemas?.length ? <ul className="mt-1 space-y-0.5">{l.problemas.map((p, i) => <li key={i} className="text-xs text-amber-700">⚠️ {p}</li>)}</ul> : null}
            {l?.resultado === 'DUVIDA' && l.duvida && <p className="mt-1 text-xs text-violet-700">❓ {l.duvida}</p>}
            {l?.dono && <p className="mt-1 text-xs text-slate-600">Dono do imóvel: {l.dono}{l.donoSituacao ? ` — ${DONO[l.donoSituacao] || l.donoSituacao}` : ''}</p>}
            {l?.outros?.length ? <p className="mt-0.5 text-[11px] text-slate-500">No mesmo arquivo: {l.outros.join('; ')}</p> : null}
            {l?.observacao && <p className="mt-0.5 text-[11px] text-slate-500 italic">{l.observacao}</p>}
          </div>
          <div className="flex flex-col gap-1 flex-shrink-0">
            <button onClick={() => abrir(r)} disabled={abrindo === r.id} className="flex items-center gap-1 text-[11px] px-2 py-0.5 border border-slate-200 rounded-md text-slate-600 hover:bg-slate-50 disabled:opacity-50">
              {abrindo === r.id ? <Loader2 size={11} className="animate-spin" /> : <Eye size={11} />} Ver
            </button>
            <button onClick={() => (aberto ? setEditando(null) : comecarCorrecao(r))} className="flex items-center gap-1 text-[11px] px-2 py-0.5 border border-sky-200 rounded-md text-sky-700 bg-sky-50 hover:bg-sky-100">
              <Pencil size={11} /> Corrigir
            </button>
          </div>
        </div>
        {aberto && (
          <div className="mt-2 pt-2 border-t border-af-border space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[11px] font-medium text-slate-600">Documento</span>
                <input list="lead-docs-tipos" value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })} placeholder="Ex.: RG, MATRICULA, CAPA IPTU" className={input} />
              </label>
              <label className="block">
                <span className="text-[11px] font-medium text-slate-600">Titular</span>
                <input value={form.titular} onChange={(e) => setForm({ ...form, titular: e.target.value })} placeholder="Nome como está no documento" className={input} />
              </label>
              <label className="block">
                <span className="text-[11px] font-medium text-slate-600">Situação</span>
                <select value={form.resultado} onChange={(e) => setForm({ ...form, resultado: e.target.value })} className={input}>
                  <option value="OK">OK</option>
                  <option value="PROBLEMA">Com problema</option>
                  <option value="NAO_DOCUMENTO">Não é documento</option>
                </select>
              </label>
              {ehIdentidade(form.tipo) && (
                <label className="block">
                  <span className="text-[11px] font-medium text-slate-600">Lado da foto</span>
                  <select value={form.lado} onChange={(e) => setForm({ ...form, lado: e.target.value })} className={input}>
                    <option value="">—</option>
                    <option value="frente">Frente</option>
                    <option value="verso">Verso</option>
                    <option value="ambos">Frente e verso</option>
                  </select>
                </label>
              )}
              {ehDocDoImovel(form.tipo) && form.resultado !== 'NAO_DOCUMENTO' && (
                <>
                  <label className="block">
                    <span className="text-[11px] font-medium text-slate-600">Dono do imóvel</span>
                    <input value={form.dono} onChange={(e) => setForm({ ...form, dono: e.target.value })} placeholder="Proprietário atual" className={input} />
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-medium text-slate-600">O dono é</span>
                    <select value={form.donoSituacao} onChange={(e) => setForm({ ...form, donoSituacao: e.target.value })} className={input}>
                      <option value="">—</option>
                      <option value="PARTICIPANTE">Participante da proposta</option>
                      <option value="PARENTE_1GRAU">Parente de 1º grau</option>
                      <option value="OUTRO_SEM_RELACAO">Outra pessoa (sem vínculo)</option>
                      <option value="EMPRESA">Empresa</option>
                    </select>
                  </label>
                </>
              )}
            </div>
            {form.resultado === 'PROBLEMA' && (
              <label className="block">
                <span className="text-[11px] font-medium text-slate-600">O que está errado (um por linha, escrito pro cliente — a conferência automática pode avisá-lo)</span>
                <textarea value={form.problemas} onChange={(e) => setForm({ ...form, problemas: e.target.value })} rows={2} placeholder="Ex.: Manda uma foto mais nítida, a data não dá pra ler." className={`${input} resize-none`} />
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditando(null)} className="text-xs px-3 py-1 rounded-md text-slate-500 hover:bg-slate-100">Cancelar</button>
              <button onClick={() => salvar(r.id)} disabled={salvando} className="text-xs px-3 py-1 rounded-md bg-af-mid text-white hover:bg-af-dark disabled:opacity-50">
                {salvando ? 'Salvando...' : 'Salvar correção'}
              </button>
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <>
      <Modal open onClose={() => { if (!preview) onClose(); }} title="Documentos do cliente" size="lg">
        <datalist id="lead-docs-tipos">{TIPOS.map((t) => <option key={t} value={t} />)}</datalist>
        {carregando && !painel ? (
          <div className="flex items-center justify-center py-10 text-slate-400"><Loader2 size={18} className="animate-spin" /></div>
        ) : !painel ? (
          <p className="text-sm text-slate-500">Não consegui carregar os documentos.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-xs text-slate-500">
                {painel.emAndamento ? 'Conferindo agora — o painel atualiza sozinho.' : conf?.em ? `Última conferência: ${data(conf.em)}${conf.listaUsada ? ` · lista "${conf.listaUsada}"` : ''}` : 'Ainda sem conferência com a lista do banco.'}
              </p>
              <button
                onClick={conferir}
                disabled={pedindo || painel.emAndamento}
                title="Lê os arquivos novos e confere com a lista do banco. Não manda mensagem ao cliente nem move o card: o resultado também vira anotação."
                className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 border rounded-md bg-sky-50 text-sky-700 hover:bg-sky-100 border-sky-200 disabled:opacity-60"
              >
                {pedindo || painel.emAndamento ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {conf ? 'Conferir de novo' : 'Conferir agora'}
              </button>
            </div>

            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">Faltando</h3>
              {nadaPendente ? (
                <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">✅ Documentação completa pela última conferência.</p>
              ) : (
                <div className="space-y-2 text-sm">
                  {!conf ? (
                    <p className="text-xs text-slate-500">A lista do banco ainda não foi conferida neste card — clique em <strong>Conferir agora</strong>.</p>
                  ) : conf.faltando.length ? (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <p className="text-[11px] font-semibold text-amber-800 mb-1">Pela lista do banco</p>
                      <ul className="list-disc pl-4 space-y-0.5 text-xs text-amber-900">{conf.faltando.map((f, i) => <li key={i}>{f}</li>)}</ul>
                    </div>
                  ) : (
                    <p className="text-xs text-emerald-700">Da lista do banco, nada falta.</p>
                  )}
                  {desatualizada && <p className="text-[11px] text-slate-500">Chegou arquivo novo ou teve correção depois dessa conferência — clique em <strong>Conferir de novo</strong> pra atualizar a lista.</p>}
                  {!!conf?.emitir.length && <p className="text-xs text-slate-600">🏛️ A&F vai emitir: {conf.emitir.join('; ')}</p>}
                  {!!conf?.emitirPendente.length && <p className="text-xs text-slate-600">🏛️ A&F pode emitir (falta o OK do cliente): {conf.emitirPendente.join('; ')}</p>}
                  {!!painel.problemas.length && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <p className="text-[11px] font-semibold text-amber-800 mb-1">Para o cliente corrigir</p>
                      <ul className="space-y-0.5 text-xs text-amber-900">{painel.problemas.map((p, i) => <li key={i}>⚠️ <strong>{p.doc}</strong> — {p.texto.join('; ')}</li>)}</ul>
                    </div>
                  )}
                  {!!painel.duvidas.length && (
                    <div className="bg-violet-50 border border-violet-200 rounded-lg px-3 py-2">
                      <p className="text-[11px] font-semibold text-violet-800 mb-1">Em dúvida com a equipe (balão Dúvidas da IA)</p>
                      <ul className="space-y-0.5 text-xs text-violet-900">{painel.duvidas.map((d) => <li key={d.attachmentId}>❓ <strong>{d.doc}</strong> ({d.arquivo}){d.pergunta ? ` — ${d.pergunta}` : ''}</li>)}</ul>
                    </div>
                  )}
                  {!!painel.donoPendente.length && (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                      <p className="text-[11px] font-semibold text-slate-700 mb-1">De quem é o imóvel</p>
                      <ul className="space-y-0.5 text-xs text-slate-700">{painel.donoPendente.map((d) => <li key={d.attachmentId}>🏠 {d.doc} em nome de <strong>{d.dono}</strong>{d.empresa ? ' (empresa)' : ''}{d.perguntado ? ' — já perguntado ao cliente' : ''}</li>)}</ul>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">Recebidos ({docs.length})</h3>
              {!docs.length ? (
                <p className="text-xs text-slate-500">O cliente ainda não mandou documento.</p>
              ) : (
                <ul className="space-y-2">{docs.map(linha)}</ul>
              )}
              {!!ignorados.length && (
                <div className="mt-2">
                  <button onClick={() => setVerIgnorados(!verIgnorados)} className="text-[11px] text-slate-500 hover:text-af-mid underline">
                    {verIgnorados ? 'Esconder' : 'Mostrar'} {ignorados.length} arquivo{ignorados.length > 1 ? 's' : ''} que a IA achou que não {ignorados.length > 1 ? 'são documentos' : 'é documento'}
                  </button>
                  {verIgnorados && <ul className="space-y-2 mt-2">{ignorados.map(linha)}</ul>}
                </div>
              )}
            </section>
          </div>
        )}
      </Modal>
      {preview && (
        <AttachmentPreviewModal url={preview.url} fileName={preview.fileName} isPdf={preview.isPdf} onClose={() => setPreview(null)} onDownload={() => baixar(preview.url, preview.fileName)} />
      )}
    </>
  );
}

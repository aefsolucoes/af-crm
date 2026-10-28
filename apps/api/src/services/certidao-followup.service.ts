import { PrismaClient } from '@prisma/client';
import { reviewAttachment, participantsContext, learnedDocRules, ehPessoaJuridica, type DocReview } from './doc-review.service';
import { sendOutboundWhatsApp, sendOutboundWhatsAppTemplate, sendOutboundMedia } from './message.service';

type Db = PrismaClient;
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

/**
 * Depois que a certidão de ônus é salva no Drive (certidao.service.finishCertidao), a IA LÊ o PDF e confere de quem é o imóvel (Fabio 19/10:
 * "isso é essencial": se não estiver no nome do cliente, avisar o cliente; janela de 24 h fechada = template "Olá, tudo bem?"; e encaminhar a ônus ao cliente).
 *  - no nome de um participante do card → texto curto + PDF ao cliente;
 *  - no nome de outra pessoa (ou parente sem vínculo explicado) → o mesmo, mas avisando que está em outro nome e perguntando a relação;
 *  - matrícula encerrada ou PDF ilegível → NÃO manda ao cliente: nota + push pra equipe decidir;
 *  - janela de 24 h do WhatsApp fechada → manda o template aprovado "ola_tudo_bem" e deixa o aviso+PDF guardados (_certidaoPending) pra sair quando o cliente responder.
 * O PDF nunca fica no CRM: na entrega tardia ele é baixado do Drive (ou, se o Drive falhou, dos bytes de passagem do pedido).
 */

const GREETING_TEMPLATE = 'ola_tudo_bem';
const WINDOW_MS = 23 * 3_600_000; // janela de 24 h do WhatsApp, com folga

export type CertidaoVerdict =
  | { kind: 'OK'; dono: string; matricula: string; gravame: string }
  | { kind: 'OUTRO_NOME'; dono: string; matricula: string; gravame: string; parente: boolean; empresa?: boolean }
  | { kind: 'NEUTRO'; dono: string; matricula: string; gravame: string } // setor sem regra de dono (ex.: o imóvel é do vendedor)
  | { kind: 'ENCERRADA'; matricula: string; detalhe: string }
  | { kind: 'ILEGIVEL' };

const pushAll = (accountId: string, title: string, body: string, leadId: string) => {
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* push é só aviso */ }
};
const note = (db: Db, leadId: string, content: string) => db.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});

function firstName(full: string | null | undefined): string {
  const w = String(full || '').trim().split(/\s+/)[0] || '';
  return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : 'Olá';
}
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());

/** Traduz a leitura da IA num veredito. Pura (testável). */
export function certidaoVerdict(rev: DocReview | undefined, opts: { homeEquity: boolean }): CertidaoVerdict {
  if (!rev || rev.resultado === 'NAO_DOCUMENTO') return { kind: 'ILEGIVEL' };
  const matricula = rev.matricula || '';
  if (rev.encerrada) return { kind: 'ENCERRADA', matricula, detalhe: (rev.problemas || []).join(' ') };
  const dono = rev.dono || '';
  const gravame = rev.gravame || '';
  if (!opts.homeEquity) return { kind: 'NEUTRO', dono, matricula, gravame };
  if (!dono || !rev.donoSituacao) return { kind: 'ILEGIVEL' };
  if (rev.donoSituacao === 'PARTICIPANTE') return { kind: 'OK', dono, matricula, gravame };
  const empresa = rev.donoSituacao === 'EMPRESA' || ehPessoaJuridica(dono);
  return { kind: 'OUTRO_NOME', dono, matricula, gravame, parente: !empresa && rev.donoSituacao === 'PARENTE_1GRAU', ...(empresa ? { empresa: true } : {}) };
}

/** Texto ao cliente (sem emoji). Pura (testável). */
function certidaoClientTextBase(nome: string, v: CertidaoVerdict): string | null {
  const mat = 'matricula' in v && v.matricula ? ` (matrícula ${v.matricula})` : '';
  if (v.kind === 'OK') return `${nome}, saiu a certidão de ônus do seu imóvel${mat} e ela está no seu nome. Segue o documento em anexo.`;
  if (v.kind === 'NEUTRO') return `${nome}, saiu a certidão de ônus do imóvel${mat}. Segue o documento em anexo.`;
  if (v.kind === 'OUTRO_NOME') {
    const quem = v.dono ? titleCase(v.dono) : 'outra pessoa';
    // Empresa (loteadora/construtora) não é "relação" com o cliente (Fabio 27/10): pergunta se o imóvel já foi passado pro nome dele.
    if (v.empresa) return `${nome}, saiu a certidão de ônus do imóvel${mat}, mas ela ainda está no nome da empresa ${quem}, e não no seu. Para o banco, o imóvel precisa estar no nome de quem vai contratar o crédito. Segue o documento em anexo. O imóvel já foi passado pro seu nome em outra matrícula, ou ainda está no nome da empresa?`;
    return `${nome}, saiu a certidão de ônus do imóvel${mat}, mas ela está no nome de ${quem}, e não no seu. Para o banco, o imóvel precisa estar no nome de quem vai contratar o crédito. Segue o documento em anexo. Me explica por favor: esse imóvel é de ${quem}? Qual é a relação de vocês?`;
  }
  return null; // ENCERRADA / ILEGIVEL: a equipe decide antes de falar com o cliente
}

export function certidaoClientText(nome: string, v: CertidaoVerdict, qtd = 1): string | null {
  const t = certidaoClientTextBase(nome, v);
  return t && qtd > 1 ? t.replace('Segue o documento em anexo.', 'Seguem os documentos em anexo (a matrícula e a certidão de ônus).') : t;
}

async function windowOpen(db: Db, leadId: string): Promise<boolean> {
  const last = await db.message.findFirst({ where: { leadId, direction: 'INBOUND' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return !!last && Date.now() - last.createdAt.getTime() < WINDOW_MS;
}

async function pdfBytesOf(db: Db, requestId: string): Promise<{ buffer: Buffer; fileName: string } | null> {
  const r = await db.certidaoRequest.findUnique({ where: { id: requestId }, select: { accountId: true, pdf: true, driveFileId: true, pdfName: true, matricula: true } });
  if (!r) return null;
  const fileName = `Certidao de onus - matricula ${r.matricula}.pdf`;
  if (r.pdf && r.pdf.length) return { buffer: Buffer.from(r.pdf), fileName };
  if (r.driveFileId) {
    const { downloadDriveFile } = await import('./google.service');
    return { buffer: await downloadDriveFile(r.accountId, r.driveFileId, 'application/pdf'), fileName };
  }
  return null;
}

async function sendTextAndPdf(db: Db, p: { accountId: string; leadId: string; requestId: string; text: string; io?: Io; /** só estes (nomes em `files` do pedido); sem isso vai o(s) de passagem/o primeiro */ names?: string[]; /** arquivos já em memória (acabaram de baixar) */ buffers?: { buffer: Buffer; fileName: string }[] }): Promise<{ ok: boolean; error?: string }> {
  let pdfs = p.buffers || [];
  if (!pdfs.length) pdfs = await pdfsOf(db, p.requestId, p.names);
  if (!pdfs.length) return { ok: false, error: 'não achei o PDF (nem no Drive nem de passagem no CRM)' };
  const a = await sendOutboundWhatsApp({ accountId: p.accountId, leadId: p.leadId, content: p.text, io: p.io });
  if (!a.success) return { ok: false, error: a.error };
  for (const f of pdfs) {
    const b = await sendOutboundMedia({ accountId: p.accountId, leadId: p.leadId, buffer: f.buffer, fileName: f.fileName, mimeType: 'application/pdf', io: p.io });
    if (!b.success) return { ok: false, error: b.error };
  }
  return { ok: true };
}

/** Arquivos do pedido (todos os de `files`, ou só os `names`) baixados do Drive; sem lista, cai no PDF único de sempre. */
async function pdfsOf(db: Db, requestId: string, names?: string[]): Promise<{ buffer: Buffer; fileName: string }[]> {
  const r = await db.certidaoRequest.findUnique({ where: { id: requestId }, select: { accountId: true, files: true } });
  const lista = (Array.isArray(r?.files) ? (r!.files as unknown as { name: string; driveFileId?: string }[]) : []).filter((f) => f.driveFileId && (!names || names.includes(f.name)));
  const out: { buffer: Buffer; fileName: string }[] = [];
  if (r && lista.length) {
    const { downloadDriveFile } = await import('./google.service');
    for (const f of lista) { try { out.push({ buffer: await downloadDriveFile(r.accountId, f.driveFileId!, 'application/pdf'), fileName: f.name }); } catch { /* o que não baixar fica de fora */ } }
    if (out.length) return out;
  }
  const um = await pdfBytesOf(db, requestId);
  return um ? [um] : [];
}

export type FollowupResult = { verdict: CertidaoVerdict; clientText: string | null; action: 'ENVIOU' | 'TEMPLATE_E_PENDENTE' | 'EQUIPE_DECIDE' | 'FALHOU'; dryRun: boolean; detail?: string };

/**
 * Lê a certidão, decide e (a menos que seja dryRun) avisa a equipe e o cliente. `pdf` = bytes do PDF recém-baixado.
 * dryRun = só mostra o veredito e o texto, sem mandar nada (teste).
 */
export async function afterCertidaoSaved(db: Db, p: { accountId: string; requestId: string; leadId: string; matricula: string; pdf: Buffer; /** os outros arquivos que o ONR devolveu junto (matrícula + certidão de ônus): vão todos ao cliente */ extras?: { buffer: Buffer; name: string }[]; primaryName?: string; io?: Io; dryRun?: boolean }): Promise<FollowupResult> {
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  const setor = lead.pipeline?.department?.name || '';
  const homeEquity = /home equity/i.test(setor);
  const nome = firstName(cf.falando_com || cf.participante_1 || lead.name);

  const context = `${participantsContext(cf, lead.name, setor)}\n\nEste arquivo é a CERTIDÃO DE ÔNUS / matrícula do imóvel que a A&F pediu ao cartório. Leia o proprietário ATUAL (campo "dono"), diga se ele é um dos participantes do card (donoSituacao) e confira se a matrícula foi encerrada.`;
  const learned = await learnedDocRules(p.accountId).catch(() => '');
  let rev = await reviewAttachment(p.accountId, { id: `certidao-${p.requestId}`, data: p.pdf, mimeType: 'application/pdf', driveFileId: null, fileName: `certidao-${p.matricula}.pdf` }, context, { learned });
  let verdict = certidaoVerdict(rev, { homeEquity });
  // O ONR devolve mais de um arquivo: se o 1º não deu pra ler (ex.: a matrícula em imagem), o veredito vem do outro (a certidão de ônus).
  for (const [i, ex] of (p.extras || []).entries()) {
    if (verdict.kind !== 'ILEGIVEL') break;
    rev = await reviewAttachment(p.accountId, { id: `certidao-${p.requestId}-${i + 2}`, data: ex.buffer, mimeType: 'application/pdf', driveFileId: null, fileName: ex.name || `certidao-${p.matricula}-${i + 2}.pdf` }, context, { learned });
    verdict = certidaoVerdict(rev, { homeEquity });
  }
  // todos os arquivos novos vão ao cliente (o cliente recebe a matrícula e a certidão de ônus)
  const enviar = [{ buffer: p.pdf, fileName: p.primaryName || `Certidao de onus - matricula ${p.matricula}.pdf` }, ...(p.extras || []).map((x) => ({ buffer: x.buffer, fileName: x.name }))];
  const clientText = certidaoClientText(nome, verdict, enviar.length);
  const gravameTxt = 'gravame' in verdict && verdict.gravame ? ` Constam ônus vigentes: ${verdict.gravame}.` : '';
  const ressalvaTxt = rev?.ressalva ? ` Atenção: ${rev.ressalva === 'CONSULTA' ? 'é certidão "para simples consulta"' : 'a emissão tem mais de 30 dias'} — o banco pode não aceitar.` : '';

  if (p.dryRun) return { verdict, clientText, action: clientText ? 'ENVIOU' : 'EQUIPE_DECIDE', dryRun: true, detail: `${gravameTxt}${ressalvaTxt}`.trim() };

  // ── equipe decide (encerrada / ilegível) ────────────────────────────────────────────────────
  if (!clientText) {
    const motivo = verdict.kind === 'ENCERRADA'
      ? `a matrícula${verdict.matricula ? ` ${verdict.matricula}` : ''} foi ENCERRADA${verdict.detalhe ? ` — ${verdict.detalhe}` : ''}; precisa de nova certidão com o número novo`
      : 'a IA não conseguiu ler o proprietário/a matrícula neste PDF';
    await note(db, p.leadId, `⚠️ Certidão de ônus salva no Drive, mas NÃO foi enviada ao cliente: ${motivo}. Confira o PDF antes de falar com ele.`);
    pushAll(p.accountId, '⚠️ Certidão de ônus precisa de conferência', `${lead.name} — ${verdict.kind === 'ENCERRADA' ? 'matrícula encerrada' : 'não consegui ler o proprietário'}`, p.leadId);
    return { verdict, clientText, action: 'EQUIPE_DECIDE', dryRun: false };
  }

  // ── nota + push pra equipe ────────────────────────────────────────────────────────────────────
  const quem = 'dono' in verdict && verdict.dono ? verdict.dono : 'não identificado';
  if (verdict.kind === 'OUTRO_NOME') {
    await note(db, p.leadId, `⚠️ ATENÇÃO: a certidão de ônus da matrícula ${p.matricula} está no nome de ${verdict.empresa ? 'uma EMPRESA, ' : ''}${quem}${verdict.parente ? ' (parente de 1º grau?)' : ''}, e NÃO no de um participante do card. O cliente será avisado.${gravameTxt}${ressalvaTxt}`);
    pushAll(p.accountId, '⚠️ Certidão de ônus em outro nome', `${lead.name} — imóvel no nome de ${titleCase(quem)}`, p.leadId);
  } else {
    await note(db, p.leadId, `✅ Certidão de ônus da matrícula ${p.matricula} conferida pela IA: proprietário ${quem}${verdict.kind === 'OK' ? ' (participante do card)' : ''}.${gravameTxt}${ressalvaTxt}`);
  }

  // ── cliente: janela aberta = texto + PDF; fechada = template "Olá, tudo bem?" e o resto sai quando ele responder ─────────
  if (await windowOpen(db, p.leadId)) {
    const s = await sendTextAndPdf(db, { accountId: p.accountId, leadId: p.leadId, requestId: p.requestId, text: clientText, io: p.io, buffers: enviar });
    if (s.ok) { await note(db, p.leadId, '📨 Certidão de ônus encaminhada ao cliente pelo WhatsApp.'); return { verdict, clientText, action: 'ENVIOU', dryRun: false }; }
    await note(db, p.leadId, `⚠️ Não consegui encaminhar a certidão de ônus ao cliente: ${s.error}. Mande o PDF da pasta IMOVEL à mão.`);
    pushAll(p.accountId, '⚠️ Certidão não foi enviada ao cliente', `${lead.name}: ${String(s.error).slice(0, 80)}`, p.leadId);
    return { verdict, clientText, action: 'FALHOU', dryRun: false, detail: s.error };
  }
  const t = await sendOutboundWhatsAppTemplate({ accountId: p.accountId, leadId: p.leadId, templateName: GREETING_TEMPLATE, language: 'pt_BR', bodyParams: [], previewText: 'Olá, tudo bem?', io: p.io });
  if (!t.success) {
    await note(db, p.leadId, `⚠️ A janela de 24 h do WhatsApp está fechada e o template "Olá, tudo bem?" falhou (${t.error}). A certidão de ônus NÃO foi enviada ao cliente.`);
    pushAll(p.accountId, '⚠️ Certidão não foi enviada ao cliente', `${lead.name}: janela fechada e o template falhou`, p.leadId);
    return { verdict, clientText, action: 'FALHOU', dryRun: false, detail: t.error };
  }
  const fresh = await db.lead.findUnique({ where: { id: p.leadId }, select: { customFields: true } });
  await db.lead.update({ where: { id: p.leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _certidaoPending: { requestId: p.requestId, text: clientText, names: enviar.map((x) => x.fileName), at: new Date().toISOString() } } } });
  await note(db, p.leadId, '📨 Janela de 24 h fechada: mandei o template "Olá, tudo bem?". Quando o cliente responder, o CRM envia o aviso e a certidão de ônus.');
  return { verdict, clientText, action: 'TEMPLATE_E_PENDENTE', dryRun: false };
}

/** O cliente respondeu: se havia aviso + certidão esperando a janela abrir, envia agora (uma vez só). */
export async function releaseCertidaoPending(db: Db, p: { accountId: string; leadId: string; io?: Io }): Promise<boolean> {
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const pend = cf._certidaoPending as { requestId: string; text: string; names?: string[] } | undefined;
  if (!pend?.requestId || !pend.text) return false;
  const { _certidaoPending, ...rest } = cf; // tira a marca ANTES de mandar: duas respostas seguidas não duplicam
  await db.lead.update({ where: { id: p.leadId }, data: { customFields: rest as any } });
  const s = await sendTextAndPdf(db, { accountId: p.accountId, leadId: p.leadId, requestId: pend.requestId, text: pend.text, io: p.io, names: pend.names });
  if (s.ok) await note(db, p.leadId, '📨 O cliente respondeu: certidão de ônus encaminhada pelo WhatsApp.');
  else {
    await db.lead.update({ where: { id: p.leadId }, data: { customFields: { ...rest, _certidaoPending: pend } as any } }); // tenta de novo na próxima resposta
    await note(db, p.leadId, `⚠️ O cliente respondeu, mas não consegui enviar a certidão de ônus: ${s.error}.`);
    pushAll(p.accountId, '⚠️ Certidão não foi enviada ao cliente', String(s.error).slice(0, 90), p.leadId);
  }
  return s.ok;
}

/** Roda a conferência de novo numa certidão JÁ emitida (lê o PDF do Drive). Padrão dryRun: mostra o veredito e o texto sem mandar nada ao cliente. */
export async function reviewIssuedCertidao(db: Db, p: { accountId: string; id: string; dryRun?: boolean; io?: Io }): Promise<FollowupResult> {
  const r = await db.certidaoRequest.findFirst({ where: { id: p.id, accountId: p.accountId }, select: { id: true, leadId: true, matricula: true, status: true } });
  if (!r) throw new Error('Pedido de certidão não encontrado');
  if (r.status !== 'ISSUED') throw new Error('Esse pedido ainda não foi emitido');
  const pdf = await pdfBytesOf(db, r.id);
  if (!pdf) throw new Error('Não achei o PDF da certidão (Drive/CRM)');
  return afterCertidaoSaved(db, { accountId: p.accountId, requestId: r.id, leadId: r.leadId, matricula: r.matricula, pdf: pdf.buffer, io: p.io, dryRun: p.dryRun !== false });
}

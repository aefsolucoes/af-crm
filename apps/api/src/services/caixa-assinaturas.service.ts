import { prisma } from '../lib/prisma';

/* ── Formulários da contratação CAIXA pro cliente ASSINAR PELO GOV.BR (Fabio 23/11: "pode mandar todos, MO, FC e formulários de cartão, veja onde consta as
 * assinaturas" + "pede para assinar pelo gov nos locais onde consta as assinaturas"). Da pasta FORMULARIOS do card: fichas cadastrais dos compradores (nunca as
 * de VENDEDOR), proposta de abertura de conta, proposta do cartão e MO30844. O CRM lê cada PDF e acha a(s) página(s) da assinatura do cliente ("Assinatura do
 * Cliente", "Nome cliente:", "(1º participante/CPF)"…) — a legenda de cada arquivo diz QUEM assina e EM QUE PÁGINA. Só com a conversa aberta (24 h). */

type Cf = Record<string, any>;
type Doc = { id: string; nome: string; titulo: string; quem: string; onde: string; paginas: number[]; total: number; ordem: number; buf: Buffer; chave: string };

const so = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const COMPOSTOS = new Set(['JOAO', 'JOSE', 'MARIA', 'ANA', 'LUIZ', 'LUIS', 'CARLOS', 'PAULO', 'PEDRO', 'ANTONIO', 'JOAQUIM']);
/** "JOÃO PEDRO GOMES CORRÊA" → "João Pedro"; "FERNANDA OLIVEIRA…" → "Fernanda". Pura. */
export function chamar(nome: string): string {
  const p = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '';
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const doisNomes = p.length >= 3 && COMPOSTOS.has(norm(p[0])) && !/^(DE|DA|DO|DOS|DAS|E)$/.test(norm(p[1]));
  return doisNomes ? `${cap(p[0])} ${cap(p[1])}` : cap(p[0]);
}

/** Texto de cada página do PDF (pdf-parse, página a página). */
async function paginasDoPdf(buf: Buffer): Promise<string[]> {
  const pdfParse = require('pdf-parse') as (b: Buffer, o?: any) => Promise<{ text: string }>;
  const pags: string[] = [];
  await pdfParse(buf, { pagerender: async (pd: any) => { const tc = await pd.getTextContent(); const t = tc.items.map((i: any) => i.str).join(' '); pags.push(t); return t; } });
  return pags;
}
/** Páginas (1…) onde o CLIENTE assina — nunca as do correspondente/gerente. Pura. */
export function paginasDeAssinatura(pags: string[]): number[] {
  const re = /assinatura do cliente|nome cliente\s*:|participante\s*\/\s*cpf/i;
  return pags.map((t, i) => (re.test(t) ? i + 1 : 0)).filter(Boolean);
}
const ela = (nome: string) => /a$/i.test(String(nome || '').split(' ')[0]); // "Fernanda" → pela/da; "João Pedro" → pelo/do
const listaPaginas = (ps: number[]) => (ps.length <= 1 ? `na página ${ps[0]}` : `nas páginas ${ps.slice(0, -1).join(', ')} e ${ps[ps.length - 1]}`);

/** Manda ao cliente (WhatsApp) os formulários pra assinar pelo gov.br. Erro em texto. */
export async function pedirAssinaturasCaixa(accountId: string, leadId: string, por: string, userId?: string, io?: any, previa?: (texto: string) => void): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) return 'O card não tem a pasta do Drive';
  // Janela de 24 h do WhatsApp fechada: template de atualização agora e os formulários saem sozinhos quando o cliente responder (processAssinaturasAoAbrir).
  const an = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!previa && !(await an.whatsappWindowOpen(leadId))) return aoAbrir(accountId, leadId, l.name, cf, por, io);

  const cc = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  const prod = require('./caixa-produtos.service') as typeof import('./caixa-produtos.service');
  const ps = (cc.participantesDa(cf) as any[]).filter((p) => so(p.cpf).length === 11);
  const t = prod.titularDosProdutos(cf, (cf._caixaProdutos || {}).ordem);
  const titular = 'erro' in t ? '' : chamar(t.nome);

  const google = await import('./google.service');
  const pasta = await google.createFolder(accountId, 'FORMULARIOS', google.extractFolderId(link));
  const arquivos = (await google.listFolderContents(accountId, pasta.id)).filter((f) => !f.isFolder && /pdf/i.test(f.mimeType) && !/VENDEDOR/i.test(f.name));
  const docs: Doc[] = [];
  for (const f of arquivos) {
    const n = norm(f.name);
    let titulo = '', quem = '', onde = '', ordem = 9, chave = '';
    if (/^FICHA CADASTRAL CAIXA - /.test(n)) {
      const p = ps.find((x) => norm(f.name).includes(norm(String(x.nome || '')))) as any;
      if (!p) continue;
      titulo = `Ficha cadastral ${ela(chamar(p.nome)) ? 'da' : 'do'} ${chamar(p.nome)}`; quem = chamar(p.nome); onde = 'na linha "Assinatura do Cliente"'; ordem = Number(p.ordem) || 1; chave = `ficha:${ordem}`;
    } else if (/^PROPOSTA ABERTURA DE CONTA CAIXA/.test(n)) { titulo = 'Proposta de abertura de conta'; quem = titular; onde = 'na linha "Assinatura do cliente"'; ordem = 10; chave = 'conta'; }
    else if (/^PROPOSTA CARTAO DE CREDITO CAIXA/.test(n)) { titulo = 'Proposta do cartão de crédito'; quem = titular; onde = 'na linha logo acima de "Nome cliente"'; ordem = 11; chave = 'cartao'; }
    else if (/^MO30844/.test(n)) { titulo = 'Autorização da forma de pagamento (MO30844)'; quem = ps.map((p) => chamar(p.nome)).join(' e '); ordem = 12; chave = 'mo30844'; }
    else continue;
    const buf = await google.downloadDriveFile(accountId, f.id, 'application/pdf');
    const pags = await paginasDoPdf(buf).catch(() => [] as string[]);
    const paginas = paginasDeAssinatura(pags);
    if (!paginas.length) return `não achei onde o cliente assina em "${f.name}" — não mandei nada`;
    docs.push({ id: f.id, nome: f.name, titulo, quem, onde, paginas, total: pags.length, ordem, buf, chave });
  }
  if (!docs.length) return 'a pasta FORMULARIOS não tem fichas, propostas da conta/cartão nem o MO30844';
  docs.sort((a, b) => a.ordem - b.ordem);

  const nomes = ps.map((p) => chamar(p.nome));
  const chamada = nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}` : nomes[0] || '';
  const doisOuMais = ps.length > 1;
  const intro = [
    `${chamada ? `${chamada}, esses` : 'Esses'} são os ${docs.length} formulários da contratação do financiamento na CAIXA. Pra seguir, a gente precisa que ${doisOuMais ? 'vocês assinem' : 'você assine'} todos pelo gov.br:`,
    '',
    `1. ${doisOuMais ? 'Acessem' : 'Acesse'} assinador.iti.br (ou o app gov.br, em "Assinatura digital")`,
    `2. ${doisOuMais ? 'Enviem' : 'Envie'} o PDF e ${doisOuMais ? 'entrem' : 'entre'} com a conta gov.br`,
    `3. Na hora de posicionar a assinatura, ${doisOuMais ? 'escolham' : 'escolha'} a página indicada na legenda do arquivo e ${doisOuMais ? 'coloquem' : 'coloque'} em cima da linha de assinatura`,
    `4. ${doisOuMais ? 'Baixem' : 'Baixe'} o arquivo assinado e ${doisOuMais ? 'mandem' : 'mande'} por aqui`,
    '',
    `Na legenda de cada arquivo está quem assina e em que página.${doisOuMais ? ' Onde os dois assinam, um assina primeiro e o outro assina o arquivo que já saiu assinado.' : ''}`,
    '',
    'Qualquer dúvida na hora de assinar, é só chamar.',
  ].join('\n');
  const legenda = (d: Doc) => (d.ordem === 12 && ps.length > 1
    ? `${d.titulo} — ${listaPaginas(d.paginas)}, assinam os dois: ${ps.map((p, i) => `${chamar(p.nome)} na linha do ${i + 1}º participante`).join(' e ')}.`
    : `${d.titulo} — ${d.quem ? `assinada ${ela(d.quem) ? 'pela' : 'pelo'} ${d.quem}` : 'assinatura do cliente'} ${listaPaginas(d.paginas)}${d.paginas.length === 1 && d.paginas[0] === d.total ? ' (a última)' : ''}, ${d.onde}${d.paginas.length > 1 ? ` — no gov.br, assine ${d.paginas.length === 2 ? 'duas' : d.paginas.length} vezes, uma em cada página (a 1ª página também precisa)` : ''}.`);
  if (previa) { previa(`${docs.map((d) => `[${d.nome} — ${d.total} pág.] ${legenda(d)}`).join('\n')}\n\n${intro}`); return null; } // só mostra o que sairia (nada é enviado)
  const { sendOutboundWhatsApp, sendOutboundMedia } = await import('./message.service');
  // Fabio 23/11: "tem que ir todos os formulários de uma vez e depois a msg informando que precisa assinar pelo gov" — os PDFs primeiro, a instrução no fim.
  const enviados: string[] = [];
  for (const d of docs) {
    const caption = legenda(d);
    const r = await sendOutboundMedia({ accountId, leadId, buffer: d.buf, fileName: d.nome, mimeType: 'application/pdf', caption, userId, io });
    if (!r.success) { await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ Assinaturas CAIXA: não consegui mandar "${d.nome}" (${r.error}). Mandados antes: ${enviados.join(', ') || 'nenhum'}.` } }).catch(() => {}); return `não consegui mandar "${d.nome}": ${r.error}`; }
    enviados.push(`${d.titulo} (${d.quem || 'cliente'}, ${listaPaginas(d.paginas)})`);
  }
  const r0 = await sendOutboundWhatsApp({ accountId, leadId, content: intro, userId } as any);
  if (!(r0 as any)?.success) await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ Assinaturas CAIXA: os formulários foram, mas a mensagem pedindo a assinatura pelo gov.br não saiu (${(r0 as any)?.error || 'erro'}). Mande à mão:\n\n${intro}` } }).catch(() => {});
  const estado = JSON.stringify({ status: 'ENVIADO', pedidoEm: new Date().toISOString(), por, docs: docs.map((d) => ({ chave: d.chave, id: d.id, nome: d.nome, titulo: d.titulo, quem: d.quem, paginas: d.paginas })) });
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaAssinaturas}', ${estado}::jsonb, true) WHERE id = ${leadId}`;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `✍️ Formulários da CAIXA mandados ao cliente pra assinar pelo gov.br (pedido de ${por}):\n${enviados.map((x) => `• ${x}`).join('\n')}` } }).catch(() => {});
  return null;
}

const VALIDADE_MS = 7 * 86_400_000;
const ESPERA_IA_MS = 2 * 60_000;
const nota = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
async function salvaEstado(leadId: string, v: Cf) {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaAssinaturas}', ${JSON.stringify(v)}::jsonb, true) WHERE id = ${leadId}`;
}
/** Conversa fechada: guarda o pedido e chama o cliente pelo template de atualização (07h–21h; fora disso o poller manda). Devolve null = pedido aceito. */
async function aoAbrir(accountId: string, leadId: string, leadName: string, cf: Cf, por: string, io?: any): Promise<string | null> {
  const st: Cf = { status: 'AO_ABRIR', por, at: new Date().toISOString() };
  await salvaEstado(leadId, st);
  const t = await mandaTemplate(accountId, leadId, leadName, cf, io);
  if (t === 'ok') { st.templateAt = new Date().toISOString(); await salvaEstado(leadId, st); }
  await nota(leadId, `✍️ Formulários da CAIXA pra assinar pelo gov.br (pedido de ${por}): a conversa está fechada — ${t === 'ok' ? 'mandei o template de atualização' : t === 'horario' ? 'o template de atualização sai às 07h' : `o template de atualização não saiu (${t})`}. Os formulários (fichas, conta, cartão e MO30844) saem sozinhos quando o cliente responder.`);
  return t === 'ok' || t === 'horario' ? null : `a conversa está fechada e o template de atualização não saiu (${t}) — os formulários ficaram guardados pra quando o cliente responder`;
}
async function mandaTemplate(accountId: string, leadId: string, leadName: string, cf: Cf, io?: any): Promise<string> {
  const an = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!an.inNoticeWindow()) return 'horario';
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, leadName) || 'cliente';
  const { templateAtualizacaoDoLead } = require('./template-atualizacao') as typeof import('./template-atualizacao');
  const msg = require('./message.service') as typeof import('./message.service');
  const t = await msg.sendOutboundWhatsAppTemplate({ accountId, leadId, ...(await templateAtualizacaoDoLead(leadId, nome)), io });
  return t.success ? 'ok' : String((t as any).error || 'erro');
}

/** Poller (credit-auto, 1 min): formulários esperando a conversa abrir. O cliente respondeu → 2 min (a IA responde primeiro) → manda tudo, uma vez. */
export async function processAssinaturasAoAbrir(accountId: string, io: any): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false AND "customFields"->'_caixaAssinaturas'->>'status' = 'AO_ABRIR' LIMIT 20`;
  const an = require('./approval-notice.service') as typeof import('./approval-notice.service');
  for (const { id } of ids) {
    try {
      const l = await prisma.lead.findUnique({ where: { id }, select: { name: true, status: true, customFields: true } });
      const cf = (l?.customFields || {}) as Cf;
      const st = (cf._caixaAssinaturas || {}) as Cf;
      if (!l || st.status !== 'AO_ABRIR' || !st.at) continue;
      if (l.status !== 'OPEN' || Date.now() - Date.parse(st.at) > VALIDADE_MS) {
        await salvaEstado(id, { ...st, status: 'SEM_RESPOSTA', fim: new Date().toISOString() });
        await nota(id, `⚠️ Os formulários da CAIXA pra assinar não saíram: ${l.status !== 'OPEN' ? 'o card não está mais aberto' : 'o cliente não respondeu em 7 dias'}. Peça de novo quando ele voltar.`);
        try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `✍️ ${l.name}: formulários não saíram`, body: 'O cliente não respondeu ao template em 7 dias.', leadId: id }).catch(() => {}); } catch { /* só aviso */ }
        continue;
      }
      if (!st.templateAt) { const t = await mandaTemplate(accountId, id, l.name, cf, io); if (t === 'ok') await salvaEstado(id, { ...st, templateAt: new Date().toISOString() }); continue; }
      const resp = await prisma.message.findFirst({ where: { leadId: id, direction: 'INBOUND', createdAt: { gt: new Date(st.at) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      if (!resp || Date.now() - resp.createdAt.getTime() < ESPERA_IA_MS) continue;
      if (!an.inNoticeWindow() || !(await an.whatsappWindowOpen(id))) continue;
      await salvaEstado(id, { ...st, status: 'ENVIANDO' }); // antes de mandar: nunca sai duas vezes
      const erro = await pedirAssinaturasCaixa(accountId, id, st.por || 'equipe', undefined, io);
      if (erro) { await salvaEstado(id, { ...st, status: 'ERRO', erro, fim: new Date().toISOString() }); await nota(id, `⚠️ O cliente respondeu, mas os formulários da CAIXA não saíram: ${erro}`); }
      io?.to?.(`lead:${id}`).emit('lead_updated', { leadId: id });
    } catch (e: any) { console.warn('[Assinaturas CAIXA]', e?.message); }
  }
}

// ── RETORNO ASSINADO (Fabio 23/11: "faz o CRM ler os PDFs assinados que voltarem e colocar na pasta dentro dos formulários escrito: FORMULARIOS ASSINADOS").
// O cliente devolve pelo WhatsApp. O CRM reconhece o formulário pelo TEXTO (ficha — pelo "CPF do Cliente" —, conta, cartão, MO30844) e confere a assinatura
// digital: cada assinatura é um /ByteRange com o certificado no /Contents; o do gov.br (AC Final do Governo Federal) traz o NOME e o CPF de quem assinou.
// Assinado por quem precisa → FORMULARIOS/FORMULARIOS ASSINADOS (" - ASSINADO"); faltando alguém (MO30844 dos dois) ou sem assinatura → nota uma vez.

/** Assinaturas digitais do PDF: texto do certificado de cada uma (latin1) e se é do gov.br. Pura. */
export function assinaturasDoPdf(bytes: Buffer): { cert: string; govbr: boolean }[] {
  const s = bytes.toString('latin1');
  if (!s.includes('/ByteRange')) return [];
  return [...s.matchAll(/\/Contents\s*<([0-9A-Fa-f]{400,})>/g)].map((m) => {
    const cert = Buffer.from(m[1], 'hex').toString('latin1');
    return { cert, govbr: /Governo Federal do Brasil|Gov-Br/i.test(cert) };
  });
}
/** Essa pessoa assinou? CPF no certificado (ICP-Brasil/gov.br guarda nascimento+CPF juntos) ou o nome completo. Pura. */
export function assinou(assin: { cert: string }[], p: { nome?: string; cpf?: string }, vezes = 1): boolean {
  const cpf = so(p.cpf);
  const nome = norm(String(p.nome || '')).replace(/[^A-Z ]/g, '');
  return assin.filter((a) => (cpf.length === 11 && a.cert.includes(cpf)) || (nome.length > 8 && norm(a.cert).includes(nome))).length >= vezes;
}
/** Qual formulário é, pelo texto (sem espaços — o gov.br às vezes quebra as palavras). Pura. */
export function qualFormulario(texto: string): { chave: string; cpf?: string } | null {
  const t = norm(texto).replace(/\s+/g, '');
  if (/AUTORIZACAODAFORMADEPAGAMENTO|30\.844/.test(t)) return { chave: 'mo30844' };
  if (/PROPOSTADEABERTURADECONTA/.test(t)) return { chave: 'conta' };
  if (/PROPOSTADECONTRATACAODECARTAODECREDITO/.test(t)) return { chave: 'cartao' };
  const cpf = (/CPFDOCLIENTE:?(\d{11})/.exec(t) || [])[1];
  if (/DADOSCADASTRAIS/.test(t) && cpf) return { chave: 'ficha', cpf };
  return null;
}

async function bytesDoAnexo(accountId: string, a: { data: Uint8Array | Buffer | null; driveFileId: string | null; mimeType: string }): Promise<Buffer | null> {
  if (a.data && a.data.length) return Buffer.from(a.data);
  if (!a.driveFileId) return null;
  try { const { downloadDriveFile } = await import('./google.service'); return await downloadDriveFile(accountId, a.driveFileId, a.mimeType); } catch { return null; }
}

/** Poller (credit-auto, 1 min): PDFs que o cliente mandou depois do pedido de assinatura. */
export async function processAssinaturasRetorno(accountId: string, io: any): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false AND "customFields"->'_caixaAssinaturas'->>'status' IN ('ENVIADO', 'PARCIAL') LIMIT 30`;
  for (const { id } of ids) {
    try { await retornoDoCard(accountId, id, io); } catch (e: any) { console.warn('[Assinaturas CAIXA retorno]', e?.message); }
  }
}

async function retornoDoCard(accountId: string, leadId: string, io: any): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const st = (cf._caixaAssinaturas || {}) as Cf;
  if (!l || !st.pedidoEm || !Array.isArray(st.docs)) return;
  const vistos = new Set<string>(st.vistos || []);
  const atts = await prisma.messageAttachment.findMany({ where: { leadId, createdAt: { gt: new Date(st.pedidoEm) }, message: { direction: 'INBOUND' }, OR: [{ mimeType: 'application/pdf' }, { fileName: { endsWith: '.pdf', mode: 'insensitive' } }] }, orderBy: { createdAt: 'asc' }, take: 40, select: { id: true, fileName: true, mimeType: true, data: true, driveFileId: true, createdAt: true } });
  const novos = atts.filter((a) => !vistos.has(a.id));
  if (!novos.length) return;
  const cc = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  const prod = require('./caixa-produtos.service') as typeof import('./caixa-produtos.service');
  const ps = (cc.participantesDa(cf) as any[]).filter((p) => so(p.cpf).length === 11);
  const t = prod.titularDosProdutos(cf, (cf._caixaProdutos || {}).ordem);
  const titular = 'erro' in t ? null : ps.find((p) => Number(p.ordem) === t.ordem) || { nome: t.nome, cpf: t.cpf };
  // Envio antigo (antes de 23/11 13h) não guardou a chave/título de cada formulário: tira do nome do arquivo.
  st.docs = (st.docs as Cf[]).map((d) => {
    if (d.chave && d.titulo) return d;
    const n = norm(String(d.nome || ''));
    const pf = /^FICHA CADASTRAL CAIXA - /.test(n) ? ps.find((x) => n.includes(norm(String(x.nome || '')))) : null;
    const chave = d.chave || (pf ? `ficha:${pf.ordem}` : /^PROPOSTA ABERTURA DE CONTA/.test(n) ? 'conta' : /^PROPOSTA CARTAO DE CREDITO/.test(n) ? 'cartao' : /^MO30844/.test(n) ? 'mo30844' : '');
    const titulo = d.titulo || (pf ? `Ficha cadastral ${ela(chamar(pf.nome)) ? 'da' : 'do'} ${chamar(pf.nome)}` : chave === 'conta' ? 'Proposta de abertura de conta' : chave === 'cartao' ? 'Proposta do cartão de crédito' : chave === 'mo30844' ? 'Autorização da forma de pagamento (MO30844)' : String(d.nome || ''));
    return { ...d, chave, titulo };
  });
  const assinados: Cf = { ...(st.assinados || {}) };
  const avisos: Cf = { ...(st.avisos || {}) };
  const linhas: string[] = [];
  const google = await import('./google.service');
  for (const a of novos) {
    // auto-upload do anexo pro Drive ainda não rodou: espera até 10 min (move o arquivo dele em vez de criar cópia)
    if (!a.driveFileId && Date.now() - a.createdAt.getTime() < 10 * 60_000) continue;
    vistos.add(a.id);
    const bytes = await bytesDoAnexo(accountId, a);
    if (!bytes || bytes.subarray(0, 4).toString('latin1') !== '%PDF') continue;
    const texto = (await paginasDoPdf(bytes).catch(() => [] as string[])).join(' ');
    const q = qualFormulario(texto);
    if (!q) continue; // não é formulário da CAIXA (documento qualquer)
    const p = q.chave === 'ficha' ? ps.find((x) => so(x.cpf) === q.cpf) : null;
    const chave = q.chave === 'ficha' ? (p ? `ficha:${p.ordem}` : '') : q.chave;
    const doc = (st.docs as Cf[]).find((d) => d.chave === chave);
    if (!doc) continue; // formulário que não foi pedido neste envio
    const precisam: any[] = q.chave === 'mo30844' ? ps : q.chave === 'ficha' ? [p] : titular ? [titular] : [];
    const assin = assinaturasDoPdf(bytes);
    // Assinatura em mais de uma página (proposta da conta: páginas 1 e 4 — Fabio 23/11 "o cliente também precisa assinar na primeira folha"): uma assinatura do
    // gov.br por página. O MO30844 tem uma página só pros dois: uma de cada.
    const vezes = q.chave === 'mo30844' ? 1 : Math.max(1, (doc.paginas || []).length);
    const faltam = precisam.filter((x) => !assinou(assin, x, vezes));
    if (!assin.length || faltam.length) {
      const k = `${chave}:${assin.length ? `falta${assin.length}` : 'sem'}`;
      if (!avisos[k]) { avisos[k] = new Date().toISOString(); linhas.push(`⚠️ ${doc.titulo} voltou ${assin.length ? `assinado só em parte — falta a assinatura de ${faltam.map((x) => chamar(x.nome)).join(' e ')}${vezes > 1 ? ` (são ${vezes}: uma em cada página — ${listaPaginas(doc.paginas)})` : ''}` : 'SEM a assinatura digital do gov.br'} (${a.fileName}).`); }
      continue;
    }
    if (assinados[chave]) continue; // já guardado
    const link = String(cf.link_pasta_drive || '').trim();
    if (!link) { linhas.push(`⚠️ ${doc.titulo} voltou assinado, mas o card não tem a pasta do Drive.`); continue; }
    const pastaF = await google.createFolder(accountId, 'FORMULARIOS', google.extractFolderId(link));
    const pastaA = await google.createFolder(accountId, 'FORMULARIOS ASSINADOS', pastaF.id);
    const nome = `${String(doc.nome).replace(/\.pdf$/i, '')} - ASSINADO.pdf`;
    await google.arquivarFormulariosAntigos(accountId, pastaA.id, nome).catch(() => 0);
    let fileId = '';
    if (a.driveFileId && (await google.putFileInFolder(accountId, a.driveFileId, pastaA.id, nome).then(() => true).catch(() => false))) fileId = a.driveFileId;
    else fileId = (await google.uploadFile(accountId, { name: nome, mimeType: 'application/pdf', parentId: pastaA.id, data: bytes })).id;
    assinados[chave] = { nome, arquivoId: fileId, attId: a.id, em: new Date().toISOString(), por: precisam.map((x) => chamar(x.nome)) };
    linhas.push(`✅ ${doc.titulo} assinado pelo gov.br (${precisam.map((x) => chamar(x.nome)).join(' e ')}) — salvo em FORMULARIOS/FORMULARIOS ASSINADOS (${nome}).`);
  }
  const faltando = (st.docs as Cf[]).filter((d) => !assinados[d.chave]);
  const status = !faltando.length ? 'ASSINADO' : Object.keys(assinados).length ? 'PARCIAL' : st.status;
  await salvaEstado(leadId, { ...st, status, assinados, avisos, vistos: [...vistos].slice(-200), ...(status === 'ASSINADO' ? { assinadoEm: new Date().toISOString() } : {}) });
  if (linhas.length) {
    await nota(leadId, `✍️ Formulários da CAIXA que voltaram:\n${linhas.join('\n')}${faltando.length ? `\n\nAinda faltam: ${faltando.map((d) => d.titulo).join(', ')}.` : '\n\n🎉 Todos os formulários estão assinados.'}`);
    io?.to?.(`lead:${leadId}`).emit('lead_updated', { leadId });
  }
  if (status === 'ASSINADO' && st.status !== 'ASSINADO') {
    try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `✍️ ${l.name}: formulários CAIXA assinados`, body: 'Todos voltaram assinados pelo gov.br — estão em FORMULARIOS ASSINADOS.', leadId }).catch(() => {}); } catch { /* só aviso */ }
  }
}

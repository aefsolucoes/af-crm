import { prisma } from '../lib/prisma';

/* ── Formulários da contratação CAIXA pro cliente ASSINAR PELO GOV.BR (Fabio 23/11: "pode mandar todos, MO, FC e formulários de cartão, veja onde consta as
 * assinaturas" + "pede para assinar pelo gov nos locais onde consta as assinaturas"). Da pasta FORMULARIOS do card: fichas cadastrais dos compradores (nunca as
 * de VENDEDOR), proposta de abertura de conta, proposta do cartão e MO30844. O CRM lê cada PDF e acha a(s) página(s) da assinatura do cliente ("Assinatura do
 * Cliente", "Nome cliente:", "(1º participante/CPF)"…) — a legenda de cada arquivo diz QUEM assina e EM QUE PÁGINA. Só com a conversa aberta (24 h). */

type Cf = Record<string, any>;
type Doc = { id: string; nome: string; titulo: string; quem: string; onde: string; paginas: number[]; total: number; ordem: number; buf: Buffer };

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
    let titulo = '', quem = '', onde = '', ordem = 9;
    if (/^FICHA CADASTRAL CAIXA - /.test(n)) {
      const p = ps.find((x) => norm(f.name).includes(norm(String(x.nome || '')))) as any;
      if (!p) continue;
      titulo = `Ficha cadastral ${ela(chamar(p.nome)) ? 'da' : 'do'} ${chamar(p.nome)}`; quem = chamar(p.nome); onde = 'na linha "Assinatura do Cliente"'; ordem = Number(p.ordem) || 1;
    } else if (/^PROPOSTA ABERTURA DE CONTA CAIXA/.test(n)) { titulo = 'Proposta de abertura de conta'; quem = titular; onde = 'na linha "Assinatura do cliente"'; ordem = 10; }
    else if (/^PROPOSTA CARTAO DE CREDITO CAIXA/.test(n)) { titulo = 'Proposta do cartão de crédito'; quem = titular; onde = 'na linha logo acima de "Nome cliente"'; ordem = 11; }
    else if (/^MO30844/.test(n)) { titulo = 'Autorização da forma de pagamento (MO30844)'; quem = ps.map((p) => chamar(p.nome)).join(' e '); ordem = 12; }
    else continue;
    const buf = await google.downloadDriveFile(accountId, f.id, 'application/pdf');
    const pags = await paginasDoPdf(buf).catch(() => [] as string[]);
    const paginas = paginasDeAssinatura(pags);
    if (!paginas.length) return `não achei onde o cliente assina em "${f.name}" — não mandei nada`;
    docs.push({ id: f.id, nome: f.name, titulo, quem, onde, paginas, total: pags.length, ordem, buf });
  }
  if (!docs.length) return 'a pasta FORMULARIOS não tem fichas, propostas da conta/cartão nem o MO30844';
  docs.sort((a, b) => a.ordem - b.ordem);

  const nomes = ps.map((p) => chamar(p.nome));
  const chamada = nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}` : nomes[0] || '';
  const doisOuMais = ps.length > 1;
  const intro = [
    `${chamada ? `${chamada}, p` : 'P'}ra seguir com a contratação do financiamento na CAIXA, a gente precisa que ${doisOuMais ? 'vocês assinem' : 'você assine'} estes ${docs.length} formulários pelo gov.br:`,
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
    : `${d.titulo} — ${d.quem ? `assinada ${ela(d.quem) ? 'pela' : 'pelo'} ${d.quem}` : 'assinatura do cliente'} ${listaPaginas(d.paginas)}${d.paginas.length === 1 && d.paginas[0] === d.total ? ' (a última)' : ''}, ${d.onde}.`);
  if (previa) { previa(`${intro}\n\n${docs.map((d) => `[${d.nome} — ${d.total} pág.] ${legenda(d)}`).join('\n')}`); return null; } // só mostra o que sairia (nada é enviado)
  const { sendOutboundWhatsApp, sendOutboundMedia } = await import('./message.service');
  const r0 = await sendOutboundWhatsApp({ accountId, leadId, content: intro, userId } as any);
  if (!(r0 as any)?.success) return `não consegui mandar a mensagem: ${(r0 as any)?.error || 'erro'}`;
  const enviados: string[] = [];
  for (const d of docs) {
    const caption = legenda(d);
    const r = await sendOutboundMedia({ accountId, leadId, buffer: d.buf, fileName: d.nome, mimeType: 'application/pdf', caption, userId, io });
    if (!r.success) { await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ Assinaturas CAIXA: não consegui mandar "${d.nome}" (${r.error}). Mandados antes: ${enviados.join(', ') || 'nenhum'}.` } }).catch(() => {}); return `não consegui mandar "${d.nome}": ${r.error}`; }
    enviados.push(`${d.titulo} (${d.quem || 'cliente'}, ${listaPaginas(d.paginas)})`);
  }
  const estado = JSON.stringify({ status: 'ENVIADO', pedidoEm: new Date().toISOString(), por, docs: docs.map((d) => ({ id: d.id, nome: d.nome, quem: d.quem, paginas: d.paginas })) });
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

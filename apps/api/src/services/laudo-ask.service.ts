import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';
import { contractingAutoOn, manualStep } from './contracting-auto.service';
import { buildLaudoJob, requestLaudo, arquivosDoImovel } from './vistoria-inter.service';
import { downloadDriveFileForVision } from './google.service';
import { isPropertyDocType } from './received-docs.service';

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'];

/**
 * APARTAMENTO + VISTORIA DO INTER → PERGUNTAR AO CLIENTE AS "REGRINHAS" (Fabio 21/10: "sempre perguntar ao cliente, quando for apartamento e vistoria do Inter, aquelas regrinhas da vistoria pra conseguir
 * preencher sem precisar do cliente"; caso Digmar Rosolini: o Inter mandou o formulário do laudo digital e o card não tinha nenhum dado do apartamento).
 * Antes dependia da IA da conversa lembrar de perguntar. Agora é determinístico: card com vistoria do Inter em andamento (link do laudo, vistoria solicitada ou aguardando o engajamento) e imóvel APARTAMENTO
 * (campo do card ou "Tipo do imóvel" da proposta) sem as 4 informações → o CRM manda UMA mensagem com a lista; a IA da conversa registra a resposta (APARTMENT_APPRAISAL_RULES) nos campos
 * imovel_dormitorios / imovel_banheiros / imovel_suites / imovel_vagas_exclusivas. Com o card completo (e o link do laudo), o laudo entra sozinho na fila da extensão "Vistoria Inter"
 * (ela preenche e PARA na tela de conferência — quem envia é a equipe).
 */

/** Só cards que entraram no funil de contratação a partir daqui: os que já estavam em "Vistoria do Imóvel" (Digmar, Rosana…) ficam como estão (Fabio 21/10: "deixa esses como estão"). */
export const LAUDO_ASK_FROM = new Date('2026-10-21T13:00:00Z');
const asked = (cf: Record<string, any>) => !!cf._laudoAsk;
const vazio = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
const CAMPOS_REGRINHAS = ['imovel_dormitorios', 'imovel_banheiros', 'imovel_suites', 'imovel_vagas_exclusivas'];

export const laudoAskText = (): string => [
  'Pra adiantar a avaliação do seu apartamento (o laudo é digital, preenchido por nós junto ao banco), preciso de 4 informações:',
  '',
  '1. Dormitórios: quantos no total (quartos + suítes), sem contar o quarto de empregada',
  '2. Banheiros: quantos no total (suítes + sociais + lavabo, e o de empregada se houver)',
  '3. Suítes: quantas — só suíte de verdade (semisuíte não conta)',
  '4. Vagas de garagem: só as de uso exclusivo — quantas e o documento/matrícula da vaga (0 se não tiver)',
  '',
  'Com isso a gente preenche tudo por você, sem precisar te incomodar de novo.',
].join('\n');

/** "Tipo do imóvel: Residencial — Apartamento" na proposta do site. Pura (testável). */
export function tipoDaProposta(texto: string): 'Apartamento' | 'Casa' | null {
  const m = /Tipo do im[oó]vel:\s*([^\n]+)/i.exec(String(texto || ''));
  if (!m) return null;
  if (/apart/i.test(m[1])) return 'Apartamento';
  if (/casa|sobrado/i.test(m[1])) return 'Casa';
  return null;
}

/** Número da proposta do Inter a partir do link do laudo (https://avaliacaoimovel.bancointer.com.br/005686174). Pura (testável). */
export function propostaDoLink(link: string): string | null {
  const m = /bancointer\.com\.br\/(\d{6,10})\b/i.exec(String(link || ''));
  return m ? m[1] : null;
}

const semAcento = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Resposta do cliente às regrinhas ("Dormitórios: 3 • Banheiros: 2 • Suítes: 1 • Vagas de garagem: 1"), lida pelo CRM com ou sem a IA da conversa
 *  ligada (Fabio 27/10, Luiz Fernando: respondeu à equipe e nada foi pro card). Também pega área útil e ano de construção se ele mandar. Pura (testável). */
export function dadosDoApartamentoNaMensagem(texto: string): Record<string, string> {
  const t = semAcento(texto);
  const um = (...res: RegExp[]) => { for (const re of res) { const m = re.exec(t); if (m) return m[1]; } return null; };
  const zero = (v: string | null) => (v === null ? null : /^(nenhum|nao|sem|zero)/.test(v) ? '0' : v);
  const out: Record<string, string> = {};
  const q = um(/(?:dormitorios?|quartos?)\s*[:=\-–]?\s*(\d{1,2})\b/, /\b(\d{1,2})\s*(?:dormitorios?|quartos?)\b/);
  const b = um(/banheiros?\s*[:=\-–]?\s*(\d{1,2})\b/, /\b(\d{1,2})\s*banheiros?\b/);
  const s = zero(um(/suites?\s*[:=\-–]?\s*(\d{1,2}\b|nenhuma|nao|sem|zero)/, /\b(\d{1,2}|nenhuma|sem|zero)\s*suites?\b/));
  const v = zero(um(/vagas?(?:\s+de\s+garagem)?\s*[:=\-–]?\s*(\d{1,2}\b|nenhuma|nao|sem|zero)/, /\b(\d{1,2}|nenhuma|sem|zero)\s*vagas?\b/));
  const a = um(/area(?:\s+(?:util|privativa))?\s*(?:de\s*)?[:=\-–]?\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m2|m²|metros)/, /\b(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m2\b|m²)/);
  const ano = um(/(?:ano\s+de\s+construcao|construid[oa]\s+em|construcao)\s*[:=\-–]?\s*((?:19|20)\d{2})\b/);
  if (q) out.imovel_dormitorios = q;
  if (b) out.imovel_banheiros = b;
  if (s) out.imovel_suites = s;
  if (v) out.imovel_vagas_exclusivas = v;
  if (a) out.imovel_area_util = a;
  if (ano) out.imovel_ano_construcao = ano;
  return out;
}

/** CEP, número, complemento e "é apartamento?" da proposta do site ("CEP do imóvel: 88220-000", "Endereço do imóvel: Rua 294, 135 APTO 201 — Meia Praia"). Pura (testável). */
export function imovelDaProposta(texto: string): { cep?: string; numero?: string; complemento?: string; apartamento?: boolean } {
  const out: { cep?: string; numero?: string; complemento?: string; apartamento?: boolean } = {};
  const cep = /CEP do im[oó]vel:\s*(\d{5})-?(\d{3})/i.exec(String(texto || ''));
  if (cep) out.cep = `${cep[1]}-${cep[2]}`;
  const end = /Endere[cç]o do im[oó]vel:\s*([^\n—–]+)/i.exec(String(texto || ''));
  // Endereço de Brasília (SQN 210 Bloco B, 305): o número depois da vírgula é o do apartamento, não do prédio — fica pra documentos/equipe.
  const quadra = end && /\b(SQN|SQS|SQNW|SQSW|SHIN|SHIS|SHCES|CLN|CLS|QI|QL|QE|QN|QS|QR|QNM|QUADRA|CONJUNTO|BLOCO)\b/i.test(end[1]);
  const m = end && !quadra ? /,\s*(\d{1,6}[A-Za-z]?)\b\s*[-,]?\s*(.*)$/.exec(end[1].trim()) : null;
  if (m) {
    out.numero = m[1];
    const comp = m[2].replace(/[\s,;-]+$/, '').trim();
    if (comp) out.complemento = comp;
  }
  if (end && /\b(apto|apt|ap|apartamento)\b\.?/i.test(end[1])) out.apartamento = true;
  return out;
}

const DOC_IMOVEL_SYSTEM = `Você lê um documento de IMÓVEL (matrícula/certidão de ônus, IPTU, cadastro imobiliário, escritura, habite-se) pra preencher o laudo digital de um APARTAMENTO no banco. Responda SOMENTE com JSON:
{"cep":"<CEP do imóvel, 8 dígitos; vazio se não aparecer>","numero":"<número do prédio no logradouro; vazio se não aparecer>","complemento":"<apto/bloco/torre da unidade, ex.: APTO 201 BLOCO B; vazio se não aparecer>","areaPrivativa":"<área PRIVATIVA (ou útil) da UNIDADE em m², só o número com vírgula, ex.: 98,45; vazio se não aparecer>","anoConstrucao":"<AAAA: ano de construção do IPTU/cadastro, ou do habite-se/averbação da construção/conclusão da obra; vazio se não aparecer>","tipo":"APARTAMENTO|CASA|OUTRO|"}
Regras: área privativa NÃO é a área total, a área comum, a área do terreno nem a fração ideal — se só houver essas, deixe vazio. Não invente nada: o que não estiver escrito no documento fica vazio.`;

/** Lê UM documento do imóvel (PDF/imagem do Drive) e devolve os campos do laudo que achou. undefined = não deu pra ler. */
async function lerDocumentoDoImovel(accountId: string, driveFileId: string, mimeType: string): Promise<Record<string, string> | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  let buffer: Buffer;
  let mt = mimeType;
  try { ({ buffer, mimeType: mt } = await downloadDriveFileForVision(accountId, driveFileId, mimeType)); } catch { return undefined; }
  if (buffer.length > 10_000_000) return undefined;
  const isPdf = mt === 'application/pdf';
  if (!isPdf && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mt)) return undefined;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096, // o raciocínio conta nesse limite (matrícula longa saía cortada com limite baixo)
      system: DOC_IMOVEL_SYSTEM,
      messages: [{ role: 'user', content: [{ type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: mt, data: buffer.toString('base64') } }, { type: 'text', text: 'Leia os dados do imóvel deste documento.' }] }],
    }),
  }).catch(() => null);
  if (!res || !res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[] } | null;
  try {
    const j = JSON.parse((data?.content?.find((c) => c.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
    const out: Record<string, string> = {};
    const cep = String(j.cep || '').replace(/\D/g, '');
    if (cep.length === 8) out.imovel_cep = `${cep.slice(0, 5)}-${cep.slice(5)}`;
    if (/^\d{1,6}[A-Za-z]?$/.test(String(j.numero || '').trim())) out.imovel_numero = String(j.numero).trim();
    if (String(j.complemento || '').trim()) out.imovel_complemento = String(j.complemento).trim().slice(0, 60);
    const area = parseFloat(String(j.areaPrivativa || '').replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(area) && area >= 15 && area <= 2000) out.imovel_area_util = String(j.areaPrivativa).trim();
    const ano = parseInt(String(j.anoConstrucao || ''), 10);
    if (ano >= 1900 && ano <= new Date().getFullYear()) out.imovel_ano_construcao = String(ano);
    if (j.tipo === 'APARTAMENTO') out.imovel_tipo = 'Apartamento';
    return out;
  } catch { return undefined; }
}

const ROTULO: Record<string, string> = {
  imovel_tipo: 'Tipo do imóvel', imovel_cep: 'CEP', imovel_numero: 'Número', imovel_complemento: 'Complemento', imovel_dormitorios: 'Dormitórios', imovel_banheiros: 'Banheiros',
  imovel_suites: 'Suítes', imovel_vagas_exclusivas: 'Vagas de garagem', imovel_area_util: 'Área útil (m²)', imovel_ano_construcao: 'Ano de construção',
};
const CAMPOS_LAUDO = [...CAMPOS_REGRINHAS, 'imovel_cep', 'imovel_numero', 'imovel_area_util', 'imovel_ano_construcao'];

/** Preenche sozinho os dados do apartamento pro laudo do Inter com o que o CRM já tem (Fabio 27/10: "precisa preencher automaticamente no card do cliente as informações"):
 *  proposta do site (CEP/número/complemento), e-mail de engajamento (é apartamento), resposta do cliente às regrinhas e os documentos do imóvel (área privativa, ano de construção).
 *  Só preenche campo VAZIO; cada arquivo do imóvel é lido uma vez (_laudoDocsLidos). */
async function preencherDadosDoLaudo(accountId: string, leadId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused || /casa|sobrado/i.test(String(cf.imovel_tipo || ''))) return;
  const patch: Record<string, string> = {};
  const fonte: Record<string, string> = {};
  const falta = (k: string) => vazio(cf[k]) && vazio(patch[k]);
  const poe = (k: string, v: string | undefined, de: string) => { if (v && falta(k)) { patch[k] = v; fonte[k] = de; } };
  if (!falta('imovel_tipo') && CAMPOS_LAUDO.every((k) => !falta(k))) return;

  const prop = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Endereço do imóvel' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  if (prop) {
    const p = imovelDaProposta(prop.content);
    poe('imovel_cep', p.cep, 'proposta do site'); poe('imovel_numero', p.numero, 'proposta do site'); poe('imovel_complemento', p.complemento, 'proposta do site');
    if (p.apartamento) poe('imovel_tipo', 'Apartamento', 'endereço da proposta do site');
  }
  if (falta('imovel_tipo')) {
    const { engajamentoDizApartamento } = require('./inter-email.service') as typeof import('./inter-email.service');
    const emails = await prisma.emailMessage.findMany({ where: { leadId, subject: { contains: 'Engajamento', mode: 'insensitive' } }, orderBy: { date: 'desc' }, take: 5, select: { textBody: true, htmlBody: true } });
    if (emails.some((e) => engajamentoDizApartamento(`${e.textBody || ''} ${e.htmlBody || ''}`))) poe('imovel_tipo', 'Apartamento', 'e-mail de engajamento do Inter');
  }
  if ([...CAMPOS_REGRINHAS, 'imovel_area_util', 'imovel_ano_construcao'].some(falta)) {
    const msgs = await prisma.message.findMany({ where: { leadId, direction: 'INBOUND', createdAt: { gte: new Date(Date.now() - 20 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 80, select: { content: true } });
    for (const m of msgs) {
      if (/^(📧|📋)/u.test(m.content || '')) continue; // e-mail do banco (traz as regrinhas em texto) e proposta do site
      for (const [k, v] of Object.entries(dadosDoApartamentoNaMensagem(m.content || ''))) poe(k, v, 'mensagem do cliente');
    }
  }
  // Documentos do imóvel: só pra apartamento e só arquivo ainda não lido.
  const lidos: string[] = Array.isArray(cf._laudoDocsLidos) ? cf._laudoDocsLidos : [];
  const novosLidos: string[] = [];
  if (/apart/i.test(String(patch.imovel_tipo || cf.imovel_tipo || '')) && ['imovel_cep', 'imovel_numero', 'imovel_area_util', 'imovel_ano_construcao'].some(falta)) {
    const arquivos = new Map<string, { mimeType: string; nome: string }>();
    for (const f of await arquivosDoImovel(accountId, cf)) arquivos.set(f.id, { mimeType: f.mimeType, nome: f.name });
    const tipos = (cf._docInfo || {}) as Record<string, string>;
    const atts = await prisma.messageAttachment.findMany({ where: { leadId, driveFileId: { not: null }, id: { in: Object.keys(tipos) } }, select: { id: true, driveFileId: true, mimeType: true, fileName: true } });
    for (const a of atts) if (tipos[a.id] && tipos[a.id] !== 'IGNORAR' && isPropertyDocType(tipos[a.id].split('|')[0])) arquivos.set(a.driveFileId!, { mimeType: a.mimeType, nome: a.fileName });
    for (const [id, f] of [...arquivos.entries()].filter(([id]) => !lidos.includes(id)).slice(0, 3)) {
      const r = await lerDocumentoDoImovel(accountId, id, f.mimeType);
      if (r === undefined) continue; // erro de leitura: tenta no próximo ciclo
      novosLidos.push(id);
      for (const [k, v] of Object.entries(r)) poe(k, v, `documento "${f.nome}"`);
    }
  }
  if (!Object.keys(patch).length) {
    if (novosLidos.length) await marca(leadId, { _laudoDocsLidos: [...lidos, ...novosLidos] });
    return;
  }
  await marca(leadId, { ...patch, ...(novosLidos.length ? { _laudoDocsLidos: [...lidos, ...novosLidos] } : {}) });
  const depois = { ...cf, ...patch };
  const ainda = CAMPOS_LAUDO.filter((k) => vazio(depois[k])).map((k) => ROTULO[k].toLowerCase());
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: [
    '🏢 Dados do imóvel pro laudo digital do Inter preenchidos sozinhos no card:',
    ...Object.keys(patch).map((k) => `• ${ROTULO[k] || k}: ${patch[k]} (${fonte[k]})`),
    ainda.length ? `Ainda faltam: ${ainda.join(', ')}.` : 'Card completo pro laudo.',
  ].join('\n') } }).catch(() => {});
}

async function marca(leadId: string, patch: Record<string, unknown>) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, any>), ...patch } as any } });
}

export async function processLaudoAsk(accountId: string, io: Io): Promise<void> {
  // 0) preencher sozinho com o que já chegou (proposta, e-mail do Inter, resposta do cliente, documentos do imóvel)
  const preencher = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND l."stageEnteredAt" >= ${LAUDO_ASK_FROM}
      AND jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), 'link_laudo_inter')
      AND COALESCE(l."customFields"->>'_laudoStatus', '') = ''
    LIMIT 20`;
  for (const { id } of preencher) {
    try { await preencherDadosDoLaudo(accountId, id); } catch (e: any) { console.warn('[Laudo] preencher:', e?.message); }
  }
  // 1) perguntar as regrinhas (IA do card desligada: só avisa a equipe — Fabio 27/10)
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND l."stageEnteredAt" >= ${LAUDO_ASK_FROM}
      AND NOT jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_laudoAsk')
      AND (jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), 'link_laudo_inter') OR jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_vistoriaRequestedAt')
           OR COALESCE(l."customFields"->'_vistoriaAi'->>'status', '') IN ('AGUARDA_ENGAJAMENTO', 'ENVIADA'))
    LIMIT 20`;
  for (const { id } of ids) {
    try { await askOne(accountId, id, io); } catch (e: any) { console.warn('[Laudo] pergunta:', e?.message); }
  }
  // 2) card completo + link do laudo → entra na fila da extensão
  const prontos = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND l."stageEnteredAt" >= ${LAUDO_ASK_FROM}
      AND jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), 'link_laudo_inter')
      AND COALESCE(l."customFields"->>'_laudoStatus', '') = '' AND NOT jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_laudoAutoQueuedAt')
    LIMIT 20`;
  for (const { id } of prontos) {
    try { await queueIfReady(accountId, id); } catch (e: any) { console.warn('[Laudo] fila:', e?.message); }
  }
}

async function askOne(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused || asked(cf)) return;
  // tipo do imóvel: card, senão a proposta do site
  let tipo: string | null = /apart/i.test(String(cf.imovel_tipo || '')) ? 'Apartamento' : /casa|sobrado/i.test(String(cf.imovel_tipo || '')) ? 'Casa' : null;
  if (!tipo) {
    const prop = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Tipo do imóvel' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
    tipo = prop ? tipoDaProposta(prop.content) : null;
    if (tipo) { await marca(leadId, { imovel_tipo: tipo }); cf.imovel_tipo = tipo; }
  }
  if (!tipo) return; // sem saber se é casa ou apartamento: a IA da conversa descobre (regra APARTMENT_APPRAISAL_RULES)
  if (tipo === 'Casa') { await marca(leadId, { _laudoAsk: { skip: 'casa: a avaliação é com visita do engenheiro', at: new Date().toISOString() } }); return; }
  if (CAMPOS_REGRINHAS.every((k) => !vazio(cf[k]))) { await marca(leadId, { _laudoAsk: { skip: 'campos já preenchidos', at: new Date().toISOString() } }); return; }
  // a IA da conversa (ou a equipe) já fez essas perguntas
  const jaPerguntou = await prisma.message.count({ where: { leadId, direction: 'OUTBOUND', AND: [{ content: { contains: 'suíte', mode: 'insensitive' } }, { content: { contains: 'dormit', mode: 'insensitive' } }] } });
  if (jaPerguntou > 0) { await marca(leadId, { _laudoAsk: { skip: 'já perguntado na conversa', at: new Date().toISOString() } }); return; }
  // IA do card desligada (Fabio 27/10: "só avisa a equipe"): nota + push com o texto pronto. A resposta do cliente o CRM lê sozinho (preencherDadosDoLaudo).
  if (!lead.aiAutoReplyActive) {
    const faltam = CAMPOS_REGRINHAS.filter((k) => vazio(cf[k])).map((k) => ROTULO[k].toLowerCase()).join(', ');
    await manualStep({ accountId, leadId, leadName: lead.name, step: 'laudo-pergunta', pushTitle: '🏢 Laudo do apartamento', pushBody: `${lead.name}: perguntar ${faltam} (IA do card desligada)`,
      note: `🏢 Apartamento + vistoria do Inter: faltam no card ${faltam}. A IA deste card está desligada, então quem pergunta é a equipe. Texto pronto:\n“${laudoAskText().replace(/\n+/g, ' ')}”\nQuando o cliente responder, o CRM lê a resposta e preenche o card sozinho.` });
    await marca(leadId, { _laudoAsk: { teamAt: new Date().toISOString(), por: 'equipe (IA do card desligada)' } });
    return;
  }
  // Chave geral desligada (Fabio 22/10): a equipe pergunta à mão; o texto vai pronto na nota. Ligando depois, esse card não é perguntado de novo (já foi registrado como da equipe).
  if (!(await contractingAutoOn(accountId))) {
    await manualStep({ accountId, leadId, leadName: lead.name, step: 'laudo-pergunta', pushTitle: '🏢 Laudo do apartamento', pushBody: `${lead.name}: perguntar dormitórios/banheiros/suítes/vagas`,
      note: `🏢 Apartamento + vistoria do Inter: pergunte ao cliente dormitórios, banheiros, suítes e vagas com uso exclusivo (laudo digital). Passo manual (automação da contratação desligada). Texto pronto:\n“${laudoAskText().replace(/\n+/g, ' ')}”` });
    await marca(leadId, { _laudoAsk: { teamAt: new Date().toISOString(), por: 'equipe (automação da contratação desligada)' } });
    return;
  }
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return; // fora das 07h–21h: tenta de novo no próximo minuto
  if (!(await whatsappWindowOpen(leadId))) {
    // Janela de 24 h fechada (sem resposta do cliente): sem template aprovado pra isso, avisa a equipe UMA vez e manda sozinho quando o cliente falar.
    if (!cf._laudoAskWait) {
      await marca(leadId, { _laudoAskWait: new Date().toISOString() });
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '🏢 Apartamento + vistoria do Inter: preciso perguntar ao cliente dormitórios, banheiros, suítes e vagas com uso exclusivo (laudo digital), mas a janela de 24 h do WhatsApp está fechada. A IA manda a pergunta assim que ele responder qualquer mensagem; se preferir, peça por um template/ligação.' } }).catch(() => {});
      try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '🏢 Laudo do apartamento', body: `${lead.name}: preciso perguntar dormitórios/banheiros/suítes/vagas (janela fechada)`, leadId }).catch(() => {}); } catch { /* aviso */ }
    }
    return;
  }
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: laudoAskText(), io: io as any });
  if (!r.success) return;
  await marca(leadId, { _laudoAsk: { askedAt: new Date().toISOString() } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '🏢 Apartamento + vistoria do Inter: perguntei ao cliente as 4 informações do laudo digital (dormitórios, banheiros, suítes, vagas com uso exclusivo). A IA registra a resposta nos campos do card; com o card completo e o link do laudo, o laudo entra sozinho na fila da extensão "Vistoria Inter".' } }).catch(() => {});
}

/** Card com o link do laudo e todos os dados: coloca na fila da extensão (ela preenche e para na conferência). Também completa o número da proposta a partir do link. */
async function queueIfReady(accountId: string, leadId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, customFields: true } });
  if (!lead) return;
  let cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused) return;
  if (vazio(cf.num_proposta)) {
    const n = propostaDoLink(String(cf.link_laudo_inter || ''));
    if (n) { await marca(leadId, { num_proposta: n }); cf = { ...cf, num_proposta: n }; }
  }
  const { job } = buildLaudoJob(leadId, lead.name, cf);
  if (!job) return;
  // Chave geral desligada: a equipe aciona o preenchimento do laudo no botão do card (uma nota avisa que já está pronto).
  if (!(await contractingAutoOn(accountId))) {
    await manualStep({ accountId, leadId, leadName: lead.name, step: 'laudo-fila', pushTitle: '🏢 Laudo pronto pra preencher', pushBody: `${lead.name}: card completo, falta acionar o laudo`,
      note: '🏢 O card já tem o link do laudo e todos os dados: clique em preencher o laudo (a extensão preenche e para na conferência). Passo manual (automação da contratação desligada).' });
    return;
  }
  const dono = await prisma.user.findFirst({ where: { accountId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!dono) return;
  await marca(leadId, { _laudoAutoQueuedAt: new Date().toISOString() });
  await requestLaudo(accountId, leadId, dono.id);
}

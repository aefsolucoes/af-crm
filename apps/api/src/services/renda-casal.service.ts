import { prisma } from '../lib/prisma';

/* Renda do casal (Fabio 01/11): "quando for casal e encaminhar a renda apenas de 1 proponente, perguntar se é apenas esse proponente que irá compor renda."
 * A ficha de cadastro (lida dos documentos) mostra um casal com comprovante de renda de só um dos dois → o CRM pergunta ao cliente (07h–21h; conversa fechada →
 * template de atualização e a pergunta sai quando ele responder) e a IA trata a resposta pelo bloco aiRendaCasalContext ("renda_composicao": so_um | os_dois).
 * Só fichas lidas a partir desta regra (sem pergunta retroativa); uma vez por casal. Estado em _rendaCasal. */

type Cf = Record<string, any>;
type Rc = { status: 'PENDING' | 'TEMPLATE' | 'ASKED' | 'SO_UM' | 'OS_DOIS' | 'RENDA_RECEBIDA' | 'EXPIRADO' | 'EQUIPE' | 'NA'; fichaAt?: string; comRenda?: string; semRenda?: string; titularComRenda?: boolean; at?: string; templateAt?: string; askedAt?: string; respondidoAt?: string };
const DESDE = '2026-11-01T16:00:00.000Z';
const TEMPLATE = 'atualizacao_processo_credito';
const WAIT_MAX_MS = 48 * 3600_000;

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };

async function salva(leadId: string, patch: Partial<Rc>): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const rc = { ...(((l?.customFields || {}) as Cf)._rendaCasal || {}), ...patch };
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_rendaCasal}', ${JSON.stringify(rc)}::jsonb, true) WHERE id = ${leadId}`;
}

const sem = (s: unknown) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const primeiro = (s: unknown) => sem(s).split(/\s+/)[0] || '';
const bonito = (s: string) => { const n = String(s || '').trim().split(/\s+/)[0] || ''; return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase(); };

/** Casal (um é o cônjuge do outro na ficha) em que só um tem comprovante de renda. Pura. */
export function casalComRendaDeUm(cf: Cf): { comRenda: any; semRenda: any } | null {
  const ps: any[] = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  if (ps.length < 2) return null;
  const comRenda = ps.filter((p) => p && p.semRenda !== true);
  if (comRenda.length !== 1) return null;
  const a = comRenda[0];
  const conjuges = (x: any, y: any) => !!primeiro(y?.nome) && (primeiro(x?.conjuge?.nome) === primeiro(y.nome) || primeiro(y?.conjuge?.nome) === primeiro(x?.nome));
  const b = ps.find((p) => p !== a && p.semRenda === true && conjuges(a, p));
  return b ? { comRenda: a, semRenda: b } : null;
}

export function textoPergunta(saudacao: string, rc: Rc, quemFalaEOTitular: boolean): string {
  const a = bonito(rc.comRenda || ''), b = bonito(rc.semRenda || '');
  const proprio = !!rc.titularComRenda && quemFalaEOTitular;
  const outro = primeiro(saudacao) && primeiro(saudacao) === primeiro(rc.semRenda) ? 'você' : b; // quem fala é quem está sem renda
  return proprio
    ? `${saudacao ? `${saudacao}, r` : 'R'}ecebi a comprovação de renda só sua. Vai ser apenas você a compor a renda, ou ${b} também vai compor?`
    : `${saudacao ? `${saudacao}, r` : 'R'}ecebi a comprovação de renda só de ${a}. Vai ser apenas ${a} a compor a renda, ou ${outro} também vai compor?`;
}

/** Manda a pergunta (07h–21h). Conversa fechada: template de atualização; quando ele responder, a pergunta sai no próximo minuto. */
async function perguntar(accountId: string, leadId: string, io?: any): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, aiAutoReplyActive: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const rc = cf._rendaCasal as Rc | undefined;
  if (!lead || !rc || (rc.status !== 'PENDING' && rc.status !== 'TEMPLATE') || cf._autoPaused) return;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const saudacao = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || '';
  const texto = textoPergunta(saudacao, rc, !String(cf.falando_com || '').trim());
  if (!lead.aiAutoReplyActive) {
    await salva(leadId, { status: 'EQUIPE', at: new Date().toISOString(), porIa: true } as any); // ligou a IA → volta a PENDING (ia-pendencias)
    await note(leadId, `👥 Casal com renda de só um (${rc.comRenda}) e IA do card desligada: pergunte você se é apenas ${bonito(rc.comRenda || '')} que vai compor a renda. Texto pronto:\n“${texto}”`);
    push(accountId, `👥 ${lead.name}: renda de só um do casal`, 'IA desligada: pergunte se só um vai compor a renda (texto na anotação).', leadId);
    return;
  }
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  const msg = require('./message.service') as typeof import('./message.service');
  if (await whatsappWindowOpen(leadId)) {
    const env = await msg.sendOutboundWhatsApp({ accountId, leadId, content: texto, io });
    if (!env.success) return;
    await salva(leadId, { status: 'ASKED', askedAt: new Date().toISOString() });
    await note(leadId, `👥 Casal com comprovante de renda só de ${rc.comRenda}: perguntei ao cliente se é apenas essa pessoa que vai compor a renda (Fabio 01/11). A IA cuida da resposta.`);
    return;
  }
  if (rc.status === 'PENDING') {
    const t = await msg.sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: TEMPLATE, language: 'pt_BR', bodyParams: [saudacao || 'cliente'], previewText: `Oi ${saudacao || 'cliente'}, tudo bem? Temos uma atualização sobre o seu processo de crédito com garantia de imóvel. Responda esta mensagem para que a gente possa te passar os detalhes.`, io });
    if (!t.success) {
      await salva(leadId, { status: 'EQUIPE', at: new Date().toISOString() });
      await note(leadId, `👥 Renda do casal: a conversa está fechada e o template de atualização não saiu (${t.error}). Pergunte você. Texto pronto:\n“${texto}”`);
      push(accountId, `👥 ${lead.name}: renda de só um do casal`, 'Conversa fechada e o template não saiu: texto pronto na anotação.', leadId);
      return;
    }
    await salva(leadId, { status: 'TEMPLATE', templateAt: new Date().toISOString() });
    await note(leadId, '👥 Renda do casal: conversa fechada — mandei o template de atualização. A pergunta sai quando o cliente responder.');
    return;
  }
  if (rc.templateAt && Date.now() - Date.parse(rc.templateAt) > WAIT_MAX_MS) {
    await salva(leadId, { status: 'EQUIPE', at: new Date().toISOString() });
    await note(leadId, `👥 Renda do casal: o cliente não respondeu ao template em 48 h. Pergunte você. Texto pronto:\n“${texto}”`);
    push(accountId, `👥 ${lead.name}: renda do casal sem resposta`, 'Sem resposta em 48 h: texto pronto na anotação.', leadId);
  }
}

/** "Os dois compõem": a ficha foi relida (a releitura da ficha pega o anexo novo enquanto o status é OS_DOIS — sessão da CAIXA, 58b5144). Renda do outro na
 *  ficha → sai de OS_DOIS (senão cada anexo relê a ficha de novo); cônjuge já GRAVADO na CAIXA como SEM RENDA não é recadastrado sozinho (relançar renda
 *  pode dar "Renda Alterada") → nota + push pra equipe decidir. 10 dias sem a renda chegar → para de esperar. */
const OS_DOIS_MAX_MS = 10 * 86_400_000;
async function esperandoRendaDoOutro(accountId: string, leadId: string, leadName: string, cf: Cf, rc: Rc): Promise<void> {
  const ps: any[] = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  const idx = ps.findIndex((p) => primeiro(p?.nome) && primeiro(p.nome) === primeiro(rc.semRenda));
  const p = idx >= 0 ? ps[idx] : null;
  const fichaAt = String(cf._fichaCadastral?.at || '');
  if (p && p.semRenda !== true) {
    await salva(leadId, { status: 'RENDA_RECEBIDA', fichaAt });
    const ordem = Number(p.ordem) || idx + 1;
    const gravado = /^GRAVADO/i.test(String(cf._caixaCadastro?.cadastros?.[ordem]?.status || ''));
    await note(leadId, `👥 A renda de ${rc.semRenda} entrou na ficha de cadastro (os dois compõem a renda).${gravado ? ` Na CAIXA, ${bonito(rc.semRenda || '')} já está GRAVADO como SEM RENDA: o CRM não relança sozinho (trocar renda pode dar "Renda Alterada"). Se for pra lançar, peça o cadastro dele(a) de novo.` : ''}`);
    push(accountId, `👥 ${leadName}: renda do casal completa`, gravado ? `${bonito(rc.semRenda || '')} está GRAVADO na CAIXA como sem renda: decidir se relança.` : `A renda de ${bonito(rc.semRenda || '')} entrou na ficha.`, leadId);
    return;
  }
  if (rc.respondidoAt && Date.now() - Date.parse(rc.respondidoAt) > OS_DOIS_MAX_MS) {
    await salva(leadId, { status: 'EXPIRADO', fichaAt });
    await note(leadId, `👥 Renda do casal: o comprovante de renda de ${rc.semRenda} não chegou em 10 dias. Parei de esperar; confira com o cliente.`);
    return;
  }
  await salva(leadId, { fichaAt }); // ficha relida sem a renda dele(a): segue esperando
}

/** Poller (a cada minuto, junto das ocorrências): ficha nova de casal com renda de só um → pergunta; pergunta que ficou pra depois → tenta de novo. */
export async function processRendaCasal(accountId: string, io?: any): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_fichaCadastral'->>'at' > ${DESDE}
      AND ("customFields"->'_rendaCasal' IS NULL
        OR "customFields"->'_rendaCasal'->>'status' IN ('PENDING', 'TEMPLATE')
        OR ("customFields"->'_rendaCasal'->>'status' IN ('NA', 'OS_DOIS') AND "customFields"->'_rendaCasal'->>'fichaAt' IS DISTINCT FROM "customFields"->'_fichaCadastral'->>'at')
        OR ("customFields"->'_rendaCasal'->>'status' = 'OS_DOIS' AND "customFields"->'_rendaCasal'->>'respondidoAt' < ${new Date(Date.now() - OS_DOIS_MAX_MS).toISOString()}))
    LIMIT 20`;
  for (const { id } of ids) {
    try {
      const l = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true } });
      const cf = (l?.customFields || {}) as Cf;
      const rc = cf._rendaCasal as Rc | undefined;
      if (rc && (rc.status === 'PENDING' || rc.status === 'TEMPLATE')) { await perguntar(accountId, id, io); continue; }
      if (rc?.status === 'OS_DOIS') { await esperandoRendaDoOutro(accountId, id, l!.name, cf, rc); continue; }
      const fichaAt = String(cf._fichaCadastral?.at || '');
      const c = casalComRendaDeUm(cf);
      if (!c) { await salva(id, { status: 'NA', fichaAt }); continue; }
      const ps: any[] = cf._fichaCadastral.participantes;
      const titularComRenda = (Number(c.comRenda?.ordem) || ps.indexOf(c.comRenda) + 1) === 1;
      await salva(id, { status: 'PENDING', fichaAt, comRenda: String(c.comRenda.nome || ''), semRenda: String(c.semRenda.nome || ''), titularComRenda, at: new Date().toISOString() });
      await perguntar(accountId, id, io);
    } catch (e: any) { console.error('[Renda do casal]', e?.message); }
  }
}

/** Bloco pro prompt da IA enquanto a pergunta está em aberto. '' se não houver. Pura. */
export function aiRendaCasalContext(cf: Cf): string {
  const rc = cf._rendaCasal as Rc | undefined;
  if (!rc || (rc.status !== 'TEMPLATE' && rc.status !== 'ASKED')) return '';
  const a = bonito(rc.comRenda || ''), b = bonito(rc.semRenda || '');
  if (rc.status === 'TEMPLATE') {
    return `--- RENDA DO CASAL (pergunta ainda não enviada) ---
A conversa estava fechada e o CRM chamou o cliente pelo template de atualização: assim que ele responder, o CRM manda SOZINHO, logo em seguida, a pergunta sobre quem vai compor a renda. Agora responda só UMA frase curta de retorno (ex.: "Oi, tudo bem? Já te explico aqui embaixo."), sem falar de renda.`;
  }
  return `--- RENDA DO CASAL (pergunta já feita ao cliente; Fabio 01/11) ---
É um casal e só chegou comprovante de renda de ${a}; de ${b}, nenhum. O CRM perguntou se é apenas ${a} que vai compor a renda.
Quando o cliente responder:
- Só ${a} compõe a renda: confirme em 1 frase e marque "extractedFields": {"renda_composicao": "so_um"}. Não peça documento de renda de ${b}.
- ${b} também vai compor: marque "extractedFields": {"renda_composicao": "os_dois"} e peça, na mesma mensagem, o comprovante de renda de ${b} (último contracheque; aposentado ou pensionista: extrato do benefício; sócio de empresa: declaração do imposto de renda).
- Dúvida sobre o que é "compor renda": explique em 1 frase que é somar a renda das duas pessoas na análise do banco, e que quem compõe precisa comprovar a renda; depois refaça a pergunta.`;
}

/** A IA gravou "renda_composicao": registra e avisa a equipe. */
export async function rendaCasalRespondida(accountId: string, leadId: string, patch: Record<string, unknown>): Promise<void> {
  const v = sem(patch.renda_composicao);
  if (v !== 'so_um' && v !== 'os_dois') return;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const rc = ((l?.customFields || {}) as Cf)._rendaCasal as Rc | undefined;
  if (!l || !rc || !['ASKED', 'TEMPLATE', 'EQUIPE'].includes(rc.status)) return;
  await salva(leadId, { status: v === 'so_um' ? 'SO_UM' : 'OS_DOIS', respondidoAt: new Date().toISOString() });
  if (v === 'so_um') {
    await note(leadId, `👥 O cliente confirmou: só ${rc.comRenda} vai compor a renda. ${rc.semRenda} fica sem renda.`);
  } else {
    await note(leadId, `👥 O cliente disse que ${rc.semRenda} também vai compor a renda: a IA pediu o comprovante de renda dele(a). Quando chegar, a ficha é lida de novo.`);
    push(accountId, `👥 ${l.name}: o casal vai compor renda junto`, `A IA pediu o comprovante de renda de ${bonito(rc.semRenda || '')}.`, leadId);
  }
}

import { prisma } from '../lib/prisma';

/* SANTANDER E CREDITAS SÓ FAZEM HOME EQUITY PARA IMÓVEIS COM HABITE-SE (Fabio 06/11).
 * "Como conferir, na certidão de ônus: caso o cliente encaminhe a certidão de ônus onde consta TERRENO, LOTE ou algo parecido e o cliente tenha informado que é CASA RESIDENCIAL,
 *  pergunte se tem HABITE-SE da casa. Verificar também se a certidão de ônus for muito antiga: pode ser que tenha ocorrido o habite-se nesse período."
 *
 * Como funciona (só Home Equity):
 *  1. Na conferência dos documentos, cada matrícula/certidão de ônus do card ganha UMA leitura curta (`_habiteSeLeitura[anexo]`): o imóvel descrito é só TERRENO/LOTE sem construção
 *     averbada (SO_TERRENO), tem a construção (AVERBADA) ou não dá pra saber (NAO_SEI — folhas faltando etc.). Só lê quando o cliente disse que é CASA/residencial.
 *  2. Terreno na certidão × casa na proposta → o CRM pergunta ao cliente, UMA vez e curto, se a casa tem habite-se (certidão com mais de 1 ano: avisa que o habite-se pode ter saído
 *     depois). Nota + push pro responsável. Pedir certidão atualizada fica com a EQUIPE (nota sugere; nada vai pro cliente).
 *  3. A resposta do cliente (texto depois da pergunta) é lida por uma IA barata → `_habiteSe.status` TEM | NAO_TEM | NAO_SABE + nota + push.
 *  4. Sem habite-se (o cliente disse, ou marcou "Não tem Habite-se" na proposta de imóvel quitado): nenhuma rodada AUTOMÁTICA no Santander (CREDIMORAR) nem na Creditas
 *     (credit-analysis.createRequests grava "NÃO RODEI"; o clique de uma pessoa roda), a IA da conversa não oferece esses dois, e a documentação completa NÃO leva o card pra
 *     contratação enquanto a proposta em jogo for de um deles — a equipe decide.
 */

type Cf = Record<string, any>;
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/** Bancos do Home Equity que exigem habite-se: Santander (pelo Credimorar) e Creditas. */
export const BANCOS_HABITE = ['CREDIMORAR', 'CREDITAS'];
const ANTIGA_DIAS = 365;

const sem = (t: unknown) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ehMat = (tipo: unknown) => /^(matricula|certidao de onus)/.test(sem(tipo));

export type StatusHabite = 'A_PERGUNTAR' | 'PERGUNTADO' | 'TEM' | 'NAO_TEM' | 'NAO_SABE' | 'AVERBADA';
export type LeituraConstrucao = { construcao: 'SO_TERRENO' | 'AVERBADA' | 'NAO_SEI'; descricao: string; averbacao: string; emissao: string; at: string };

// ─── Funções puras (testáveis) ─────────────────────────────────────────────────────────────────────────────

/** Tipo do imóvel dito pelo cliente → CASA | OUTRO | null (não disse). "Residencial", "Residencial — Casa Residencial", "Casa Condomínio", "Casa" = CASA. */
function tipoDito(valor: unknown): 'CASA' | 'OUTRO' | null {
  const n = sem(valor);
  if (!n.trim()) return null;
  if (/apart|\b(ap|apt|apto)\b|cobertura|kitnet|flat|terreno|\blotes?\b|gleba|comerc|\bsala\b|\bloja\b|galp|rural|chacara|sitio|fazenda|constru/.test(n)) return 'OUTRO';
  if (/\bcasa\b|sobrado|residen|moradia/.test(n)) return 'CASA';
  return null;
}

/** O cliente disse que o imóvel é CASA residencial? Pela linha "Tipo do imóvel" da proposta e pelos campos do card. Qualquer fonte dizendo apartamento/terreno/comercial = não. */
export function clienteDisseCasa(proposta: string, cf: Cf = {}): boolean {
  const ditos: ('CASA' | 'OUTRO' | null)[] = [];
  for (const linha of String(proposta || '').replace(/[*_]/g, '').split('\n')) {
    const m = /^\W*\s*tipo d[oe] im[oó]vel\s*:\s*(.+)$/i.exec(linha.trim());
    if (m) ditos.push(tipoDito(m[1]));
  }
  ditos.push(tipoDito(cf.imovel_tipo), tipoDito(cf.tipo_imovel), tipoDito(cf.finalidade));
  return ditos.includes('CASA') && !ditos.includes('OUTRO');
}

/** "Habite-se: Sim, tem Habite-se | Não tem Habite-se | Não sei se tem Habite-se" da proposta do site. */
export function habiteDaProposta(proposta: string): 'TEM' | 'NAO_TEM' | 'NAO_SABE' | null {
  const m = /habite-?se\s*:\s*([^\n]+)/i.exec(String(proposta || '').replace(/[*_]/g, ''));
  if (!m) return null;
  const v = sem(m[1]);
  if (/nao sei/.test(v)) return 'NAO_SABE';
  if (/^\s*(nao|sem)\b/.test(v)) return 'NAO_TEM';
  if (/^\s*sim\b|\btem habite/.test(v)) return 'TEM';
  return null;
}

/** Imóvel ainda financiado (proposta "Imóvel quitado: Não" ou saldo devedor no card): a maioria já tem habite-se (regra de 21/10) — o "Não tem" da proposta não vale sozinho. */
function comSaldoDevedor(proposta: string, cf: Cf): boolean {
  const q = /im[oó]vel quitado\s*:\s*([^\n]+)/i.exec(String(proposta || '').replace(/[*_]/g, ''));
  return (!!q && /^\s*n[aã]o/i.test(q[1])) || Number(String(cf.saldo_devedor ?? '').replace(/[^\d.,]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.')) > 0;
}

/** Dias desde a emissão (AAAA-MM-DD ou DD/MM/AAAA). null = sem data. */
export function diasDesde(emissao: string, agora = new Date()): number | null {
  const s = String(emissao || '').trim();
  let d: Date | null = null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s), br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (iso) d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00Z`);
  else if (br) d = new Date(`${br[3]}-${br[2]}-${br[1]}T12:00:00Z`);
  if (!d || isNaN(d.getTime())) return null;
  return Math.floor((agora.getTime() - d.getTime()) / 86_400_000);
}
const mesAno = (emissao: string) => { const iso = /^(\d{4})-(\d{2})/.exec(emissao); const br = /^\d{2}\/(\d{2})\/(\d{4})/.exec(emissao); return iso ? `${iso[2]}/${iso[1]}` : br ? `${br[1]}/${br[2]}` : emissao; };

export type Terreno = { anexos: string[]; descricao: string; emissao: string; antiga: boolean; anos: number | null };

/** A certidão de ônus/matrícula do card mostra o imóvel só como TERRENO/LOTE (sem construção averbada)? Uma leitura AVERBADA em qualquer certidão (ex.: o cliente mandou uma
 *  atualizada) desfaz. Considera só os anexos que a conferência tratou como matrícula/ônus. */
export function terrenoNaCertidao(cf: Cf, agora = new Date()): Terreno | null {
  const rev = (cf._docReview || {}) as Record<string, any>;
  const leit = (cf._habiteSeLeitura || {}) as Record<string, LeituraConstrucao>;
  const ids = Object.keys(rev).filter((id) => rev[id] && ehMat(rev[id].tipo) && rev[id].resultado !== 'NAO_DOCUMENTO' && leit[id]);
  if (ids.some((id) => leit[id].construcao === 'AVERBADA')) return null;
  const terr = ids.filter((id) => leit[id].construcao === 'SO_TERRENO');
  if (!terr.length) return null;
  // a certidão mais nova (a que vale)
  const comData = terr.map((id) => ({ id, emissao: leit[id].emissao || String(rev[id].emissao || ''), descricao: leit[id].descricao })).sort((a, b) => (diasDesde(a.emissao, agora) ?? 1e9) - (diasDesde(b.emissao, agora) ?? 1e9));
  const dias = diasDesde(comData[0].emissao, agora);
  return { anexos: terr, descricao: comData[0].descricao, emissao: comData[0].emissao, antiga: dias !== null && dias > ANTIGA_DIAS, anos: dias === null ? null : Math.floor(dias / 365) };
}

/** Pergunta ao cliente (curta, sem nome de banco). */
export function perguntaHabite(t: Terreno): string {
  return t.antiga && t.emissao
    ? `Vi na certidão do imóvel, emitida em ${mesAno(t.emissao)}, que ele está registrado como terreno (lote), sem a construção da casa. A casa tem *habite-se*? Se ele saiu depois dessa data, pode não aparecer nessa certidão. 🙏`
    : 'Vi na certidão do imóvel que ele está registrado como terreno (lote), sem a construção da casa. A casa tem *habite-se*? 🙏';
}

export type SemHabite = { fonte: 'cliente' | 'proposta'; texto: string };

/** Imóvel SEM habite-se: o cliente respondeu que não tem, ou marcou "Não tem Habite-se" na proposta (imóvel quitado; o cliente não disse depois que tem). */
export function semHabite(cf: Cf, proposta: string): SemHabite | null {
  const st: StatusHabite | undefined = cf._habiteSe?.status;
  if (st === 'NAO_TEM') return { fonte: 'cliente', texto: 'o cliente disse que a casa não tem habite-se' };
  if (st === 'TEM' || st === 'AVERBADA') return null;
  if (habiteDaProposta(proposta) === 'NAO_TEM' && !comSaldoDevedor(proposta, cf)) return { fonte: 'proposta', texto: 'na proposta o cliente marcou "Não tem Habite-se"' };
  return null;
}

/** Texto do "NÃO RODEI" do Santander/Creditas. */
export const textoNaoRodeiHabite = (bank: string, s: SemHabite) => `${bank === 'CREDITAS' ? 'a Creditas' : 'o Santander'} só faz Home Equity com imóvel com habite-se — ${s.texto} (Fabio 06/11).`;

/** Linha pro bloco "DOCUMENTOS DESTE CLIENTE" da IA da conversa (como tratar a pergunta/resposta do habite-se). Vazio quando não se aplica. */
export function aiHabiteDocsLinha(cf: Cf): string {
  const h = cf._habiteSe;
  const st: StatusHabite | undefined = h?.status;
  const naoPede = 'NÃO peça o habite-se, certidão atualizada nem outro documento por causa disso (só com o OK da equipe) e NÃO diga que algum banco aceita ou recusa.';
  if (st === 'PERGUNTADO') return `\nHABITE-SE EM ABERTO (Fabio 06/11): a certidão de ônus/matrícula mostra o imóvel como TERRENO/LOTE, sem a construção da casa, e o CRM perguntou ao cliente se a casa tem habite-se${h.antiga && h.emissao ? ` (a certidão é de ${mesAno(h.emissao)}: se o habite-se saiu depois, não aparece nela)` : ''}. Quando ele responder: agradeça em 1 frase curta e siga — o CRM registra a resposta e a equipe decide o caminho. ${naoPede} Se ele perguntar por quê: alguns bancos só aceitam a casa com a construção registrada (habite-se); a equipe vai ver o melhor caminho.`;
  if (st === 'NAO_TEM') return `\nHABITE-SE: o cliente disse que a casa NÃO tem habite-se (a certidão mostra só o terreno). ${naoPede} A equipe decide com qual banco seguir.`;
  if (st === 'TEM') return `\nHABITE-SE: o cliente disse que a casa TEM habite-se, mas a certidão que ele mandou mostra só o terreno — a equipe vai conferir. ${naoPede}`;
  if (st === 'NAO_SABE') return `\nHABITE-SE: o cliente não sabe se a casa tem habite-se (a certidão mostra só o terreno) — a equipe vai conferir. ${naoPede}`;
  return '';
}

/** Linha pro bloco da ANÁLISE DE CRÉDITO da IA da conversa. Vazio quando não se aplica. */
export function aiHabiteBancosLinha(cf: Cf, proposta: string): string {
  const s = semHabite(cf, proposta);
  if (s) return `- SANTANDER E CREDITAS FORA (Fabio 06/11): ${s.texto}, e esses dois bancos só fazem Home Equity com imóvel com habite-se. NÃO ofereça, não prometa e não confirme seguir pelo Santander nem pela Creditas; fale só dos outros bancos, sem explicar ao cliente regra de banco por nome. Se ele insistir num deles, diga que vai confirmar com a equipe (askTeam).`;
  const st: StatusHabite | undefined = cf._habiteSe?.status;
  if (st === 'PERGUNTADO' || st === 'A_PERGUNTAR' || st === 'NAO_SABE') return '- HABITE-SE EM ABERTO (Fabio 06/11): a certidão mostra o imóvel como terreno e ainda não se sabe se a casa tem habite-se — Santander e Creditas só fazem Home Equity com habite-se. Até a equipe confirmar, não prometa nem confirme seguir pelo Santander ou pela Creditas.';
  return '';
}

// ─── Banco / IA ────────────────────────────────────────────────────────────────────────────────────────────

const PROPOSTA_RX = /Tipo d[oe] im[oó]vel:|Habite-?se:/i;
const ehProposta = (t: string) => /Tipo d[oe] im[oó]vel:|Proposta preenchida|\[PROPOSTA/i.test(t);

/** A última proposta da conversa (texto). */
export async function propostaDoLead(leadId: string): Promise<string> {
  const m = await prisma.message.findFirst({
    where: { leadId, direction: 'INBOUND', OR: [{ content: { contains: 'Tipo do im' } }, { content: { contains: 'Habite-se:' } }] },
    orderBy: { createdAt: 'desc' }, select: { content: true },
  });
  return m && PROPOSTA_RX.test(m.content || '') ? String(m.content) : '';
}

/** Pra fila da análise (createRequests): o imóvel deste card está sem habite-se? */
export async function semHabiteDoCard(leadId: string, cf: Cf): Promise<SemHabite | null> {
  if (cf._habiteSe?.status === 'NAO_TEM') return semHabite(cf, '');
  return semHabite(cf, await propostaDoLead(leadId));
}

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
async function gravarHabite(leadId: string, valor: Cf): Promise<void> {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_habiteSe}', ${JSON.stringify(valor)}::jsonb, true) WHERE id = ${leadId}`;
}
async function gravarLeitura(leadId: string, attId: string, l: LeituraConstrucao): Promise<void> {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_habiteSeLeitura}', COALESCE("customFields"->'_habiteSeLeitura', '{}'::jsonb) || ${JSON.stringify({ [attId]: l })}::jsonb, true) WHERE id = ${leadId}`;
}
async function cfAtual(leadId: string): Promise<Cf> {
  return ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
}
/** Push ao colaborador responsável pelo card (Lead.userId); sem aparelho cadastrado, vai pra equipe toda. */
async function pushResponsavel(accountId: string, leadId: string, title: string, body: string): Promise<void> {
  try {
    const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { userId: true } });
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    const tem = l?.userId ? await prisma.pushSubscription.count({ where: { userId: l.userId } }) : 0;
    sendPushToAccount(accountId, { title, body: body.slice(0, 140), leadId }, tem && l?.userId ? [l.userId] : undefined).catch(() => {});
  } catch { /* aviso */ }
}
function jsonDe(d: any): any {
  try { return JSON.parse(String(d?.content?.find((b: any) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || 'null'); } catch { return null; }
}

const LEITURA_SYSTEM = `Você lê uma CERTIDÃO DE MATRÍCULA / CERTIDÃO DE ÔNUS REAIS de um imóvel (cartório de Registro de Imóveis) e diz se a CONSTRUÇÃO está no registro. Leia TODAS as páginas: a descrição do imóvel (abertura da matrícula) e cada registro (R-) e averbação (AV-). Responda SOMENTE com JSON:
{"construcao":"SO_TERRENO|AVERBADA|NAO_SEI","descricao":"<como a matrícula descreve o imóvel, curto (até 120 caracteres), ex.: LOTE 12 DA QUADRA 5, 360 m²>","averbacao":"<se AVERBADA: qual averbação/descrição mostra a construção, curto, ex.: AV-3 de 12/05/2015 — casa residencial de 120 m²; senão vazio>","emissao":"<AAAA-MM-DD da EMISSÃO da certidão (carimbo/linha 'certidão emitida em', em geral no topo ou no fim — NÃO a data dos registros); vazio se não aparecer>"}
- SO_TERRENO: a descrição é de TERRENO, LOTE, gleba, área, chão ou fração de terreno E nenhuma averbação/registro posterior traz a CONSTRUÇÃO (averbação de construção/edificação, casa, residência, sobrado, prédio, benfeitoria, área construída, habite-se, CND do INSS da obra).
- AVERBADA: há averbação/registro da construção, OU a própria descrição já é de imóvel construído (casa, residência, sobrado, apartamento, unidade autônoma, prédio, "com a casa de morada", área construída).
- NAO_SEI: não dá pra ver a descrição do imóvel, o documento está incompleto (folhas/verso faltando, termina no meio, "continua") e a construção pode estar nas folhas que faltam, ou não é uma matrícula/certidão de ônus. Na dúvida, NAO_SEI.`;

/** Leitura curta de UMA certidão (só construção + emissão). undefined = não deu pra ler (tenta de novo na próxima conferência). */
async function lerConstrucao(accountId: string, att: { id: string; driveFileId: string | null; data?: Uint8Array | null; mimeType: string }): Promise<LeituraConstrucao | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  const isPdf = att.mimeType === 'application/pdf';
  if (!isPdf && !/^image\//.test(att.mimeType)) return undefined;
  let buffer: Buffer, mimeType = att.mimeType;
  try {
    if (att.data && att.data.length) buffer = Buffer.from(att.data);
    else if (att.driveFileId) ({ buffer, mimeType } = await (require('./google.service') as typeof import('./google.service')).downloadDriveFileForVision(accountId, att.driveFileId, att.mimeType));
    else return undefined;
  } catch { return undefined; }
  if (buffer.length > 10_000_000) return undefined;
  const mediaType = isPdf ? 'application/pdf' : mimeType;
  if (!isPdf && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) return undefined;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 4096, // o raciocínio conta no limite (matrícula longa saía cortada com limite baixo)
      system: LEITURA_SYSTEM,
      messages: [{ role: 'user', content: [{ type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } }, { type: 'text', text: 'Leia a certidão e responda o JSON.' }] }],
    }),
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null);
  if (!res?.ok) { if (res) console.error('[Habite-se] leitura:', res.status, (await res.text()).slice(0, 200)); return undefined; }
  const j = jsonDe(await res.json().catch(() => null));
  if (!j || !['SO_TERRENO', 'AVERBADA', 'NAO_SEI'].includes(j.construcao)) return undefined;
  const curto = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  return { construcao: j.construcao, descricao: curto(j.descricao, 140), averbacao: curto(j.averbacao, 160), emissao: curto(j.emissao, 10), at: new Date().toISOString() };
}

const RESPOSTA_SYSTEM = `Você lê a resposta de um cliente de crédito com garantia de imóvel (Home Equity). Nós perguntamos se a CASA dele tem HABITE-SE (a certidão do imóvel mostra só o terreno). Diga o que ele respondeu. Responda SÓ JSON:
{"resposta":"TEM|NAO_TEM|NAO_SABE|SEM_RESPOSTA","trecho":"<a frase do cliente que decide, curta>"}
- TEM: disse que tem habite-se (ou a carta/certidão de habite-se, ou que a construção já foi averbada/regularizada com habite-se).
- NAO_TEM: disse que não tem, que nunca tirou, que a casa não é regularizada/averbada, ou que ainda vai tirar / está em andamento (ainda não tem).
- NAO_SABE: não sabe, acha que sim/não sem certeza, vai verificar ou perguntar a alguém.
- SEM_RESPOSTA: não falou do habite-se (outro assunto, cumprimento, só arquivo).`;

/** Lê o que o cliente disse sobre o habite-se nas mensagens dadas. null = erro (tenta de novo depois). */
async function lerResposta(pergunta: string, falas: string[]): Promise<{ resposta: 'TEM' | 'NAO_TEM' | 'NAO_SABE' | 'SEM_RESPOSTA'; trecho: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !falas.length) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens: 300, system: RESPOSTA_SYSTEM,
      messages: [{ role: 'user', content: `PERGUNTA NOSSA: ${pergunta}\n\nO QUE O CLIENTE ESCREVEU DEPOIS:\n${falas.map((f) => `- ${f}`).join('\n')}` }],
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const j = jsonDe(await res.json().catch(() => null));
  if (!j || !['TEM', 'NAO_TEM', 'NAO_SABE', 'SEM_RESPOSTA'].includes(j.resposta)) return null;
  return { resposta: j.resposta, trecho: String(j.trecho || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
}

/** Falas do cliente (texto/transcrição) depois de `desde`, sem a proposta. */
async function falasDoCliente(leadId: string, desde: Date, so?: RegExp): Promise<{ textos: string[]; ultima: Date | null }> {
  const msgs = await prisma.message.findMany({
    where: { leadId, direction: 'INBOUND', createdAt: { gt: desde }, content: { not: '' } },
    orderBy: { createdAt: 'asc' }, take: 30, select: { content: true, createdAt: true },
  });
  const ok = msgs.filter((m) => !ehProposta(m.content || '') && (!so || so.test(m.content || '')));
  return { textos: ok.map((m) => String(m.content).replace(/\s+/g, ' ').slice(0, 400)), ultima: msgs.length ? msgs[msgs.length - 1].createdAt : null };
}

/** Santander/Creditas que ainda vão rodar sozinhos viram "NÃO RODEI"; aprovação deles que já saiu → nota (1x). */
async function tirarBancos(accountId: string, leadId: string, s: SemHabite): Promise<string> {
  for (const bank of BANCOS_HABITE) {
    await prisma.creditAnalysis.updateMany({ where: { leadId, bank, kind: 'RUN', status: 'REQUESTED', dryRun: false, requestedById: null }, data: { status: 'FAILED', finishedAt: new Date(), detail: `NÃO RODEI: ${textoNaoRodeiHabite(bank, s)}` } });
  }
  const aps = await prisma.creditAnalysis.findMany({ where: { leadId, bank: { in: BANCOS_HABITE }, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] } }, orderBy: { createdAt: 'desc' }, select: { bank: true, chosen: true, proposalNumber: true } });
  const vistos = new Set<string>();
  const nomes = aps.filter((a) => !vistos.has(a.bank) && vistos.add(a.bank)).map((a) => `${a.bank === 'CREDITAS' ? 'Creditas' : 'Santander'}${a.proposalNumber ? ` (proposta nº ${a.proposalNumber})` : ''}${a.chosen ? ' — o cliente tinha escolhido esta' : ''}`);
  return nomes.length ? ` A aprovação ${nomes.length > 1 ? 'do ' + nomes.join(' e do ') : 'do ' + nomes[0]} não serve como está.` : '';
}

/** Grava a resposta do cliente, anota e avisa. */
async function registrarResposta(accountId: string, leadId: string, leadName: string, status: 'TEM' | 'NAO_TEM' | 'NAO_SABE', trecho: string, fonte: string): Promise<void> {
  const cf = await cfAtual(leadId);
  const h = { ...(cf._habiteSe || {}), status, respondidoAt: new Date().toISOString(), resposta: trecho, fonteResposta: fonte };
  await gravarHabite(leadId, h);
  const cert = h.emissao ? `A certidão (emitida em ${mesAno(h.emissao)}${h.antiga ? `, há mais de ${Math.max(1, h.anos || 1)} ano${(h.anos || 1) > 1 ? 's' : ''}` : ''}) mostra só o terreno${h.descricao ? ` (${h.descricao})` : ''}` : `A certidão mostra só o terreno${h.descricao ? ` (${h.descricao})` : ''}`;
  const atualizada = 'se quiser, autorize a emissão de uma certidão atualizada (ONR) — não pedi nada ao cliente';
  const dito = trecho ? ` ("${trecho}")` : '';
  if (status === 'NAO_TEM') {
    const extra = await tirarBancos(accountId, leadId, { fonte: 'cliente', texto: 'o cliente disse que a casa não tem habite-se' });
    await note(leadId, `🚫 Habite-se: ${fonte === 'documento' ? 'pelos documentos' : 'o cliente disse'} que a casa NÃO tem habite-se${dito}. Santander e Creditas não fazem Home Equity sem habite-se (Fabio 06/11): rodadas automáticas nesses bancos param e a IA não oferece esses dois.${extra} Siga pelos outros bancos (Inter). ${cert}.`);
    await pushResponsavel(accountId, leadId, `🚫 ${leadName}: casa sem habite-se`, 'Santander e Creditas não fazem HE sem habite-se — seguir pelo Inter');
  } else if (status === 'TEM') {
    await note(leadId, `🏠 Habite-se: ${fonte === 'documento' ? 'o cliente mandou o habite-se' : 'o cliente disse que a casa TEM habite-se'}${dito}. ${cert}: ${h.antiga ? `o habite-se pode ter sido averbado depois dela — ${atualizada}.` : `a construção ainda não aparece averbada na matrícula, e Santander e Creditas precisam da casa averbada — confira com o cliente antes de seguir por eles (não pedi documento).`}`);
    await pushResponsavel(accountId, leadId, `🏠 ${leadName}: diz que tem habite-se`, h.antiga ? 'Certidão antiga mostra só terreno — avaliar certidão atualizada' : 'Certidão mostra só terreno — conferir a averbação da casa');
  } else {
    await note(leadId, `❓ Habite-se: o cliente não sabe se a casa tem habite-se${dito}. ${cert}${h.antiga ? ` — ${atualizada}` : ''}. Até a equipe confirmar, a IA não promete Santander nem Creditas (só fazem HE com habite-se).`);
    await pushResponsavel(accountId, leadId, `❓ ${leadName}: habite-se incerto`, 'Cliente não sabe se a casa tem habite-se — a equipe confere');
  }
}

const lendoResposta = new Set<string>();
const lerDeNovo = new Set<string>();

/** Uma leitura: o que o cliente escreveu depois da pergunta (ou da última leitura). */
async function lerRespostaUmaVez(accountId: string, leadId: string): Promise<StatusHabite | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const h = cf._habiteSe;
  if (!lead || !h || !['PERGUNTADO', 'NAO_SABE'].includes(h.status) || !h.askedAt) return h?.status || null;
  // Não fica lendo pra sempre: pergunta de mais de 30 dias, ou "não sei" de mais de 10, é com a equipe (a nota já foi feita).
  const idade = (iso: string | undefined) => (iso ? Date.now() - new Date(iso).getTime() : 0) / 86_400_000;
  if (idade(h.askedAt) > 30 || (h.status === 'NAO_SABE' && idade(h.respondidoAt) > 10)) return h.status;
  const desde = new Date(Math.max(new Date(h.askedAt).getTime(), h.lidoAte ? new Date(h.lidoAte).getTime() : 0));
  const { textos, ultima } = await falasDoCliente(leadId, desde);
  if (!textos.length) return h.status;
  const r = await lerResposta(h.pergunta || 'A casa tem habite-se?', textos);
  if (!r) return h.status;
  await gravarHabite(leadId, { ...h, lidoAte: (ultima || new Date()).toISOString() });
  if (r.resposta === 'SEM_RESPOSTA' || (r.resposta === 'NAO_SABE' && h.status === 'NAO_SABE')) return h.status;
  await registrarResposta(accountId, leadId, lead.name, r.resposta, r.trecho, 'conversa');
  return r.resposta;
}

/** Hook do WhatsApp (texto do cliente) e da conferência: com a pergunta do habite-se em aberto, lê o que ele respondeu. Mensagem que chega durante a leitura
 *  ("oi" e logo depois "não tem") é lida na volta seguinte. */
export async function lerRespostaHabite(accountId: string, leadId: string): Promise<StatusHabite | null> {
  if (lendoResposta.has(leadId)) { lerDeNovo.add(leadId); return null; }
  lendoResposta.add(leadId);
  try {
    let st: StatusHabite | null = null;
    for (let i = 0; i < 3; i++) {
      lerDeNovo.delete(leadId);
      st = await lerRespostaUmaVez(accountId, leadId);
      if (!lerDeNovo.has(leadId) || (st !== 'PERGUNTADO' && st !== 'NAO_SABE')) break;
    }
    return st;
  } finally {
    lendoResposta.delete(leadId);
    lerDeNovo.delete(leadId);
  }
}

export type PassoHabite = 'PERGUNTOU' | 'AGUARDA' | StatusHabite | null;

/** Passo da conferência de documentos (docs-checker). `podeFalar` = a conferência automática (o botão "Conferir documentos" não fala com o cliente).
 *  PERGUNTOU = mandou a pergunta agora (a conferência para aqui, como na pergunta do dono do imóvel). AGUARDA = pergunta em aberto/por fazer. */
export async function habiteNaConferencia(accountId: string, leadId: string, io: Io, opts: { podeFalar: boolean }): Promise<PassoHabite> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, aiAutoReplyActive: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || !/home equity/i.test(lead.pipeline?.department?.name || '')) return null;
  let cf = (lead.customFields || {}) as Cf;
  if (cf._caixaRota) return null; // pediu a CAIXA: já confirmou nome limpo e Habite-se na triagem da CAIXA
  const proposta = await propostaDoLead(leadId);
  if (!clienteDisseCasa(proposta, cf)) return cf._habiteSe?.status || null;

  // 1. Leitura curta de cada matrícula/ônus ainda não lida (no máximo 3 por conferência).
  const rev = (cf._docReview || {}) as Record<string, any>;
  const faltam = Object.keys(rev).filter((id) => rev[id] && ehMat(rev[id].tipo) && rev[id].resultado !== 'NAO_DOCUMENTO' && !(cf._habiteSeLeitura || {})[id]).slice(0, 3);
  if (faltam.length) {
    const atts = await prisma.messageAttachment.findMany({ where: { id: { in: faltam }, leadId }, select: { id: true, driveFileId: true, data: true, mimeType: true } });
    for (const a of atts) {
      const l = await lerConstrucao(accountId, a).catch(() => undefined);
      if (l) await gravarLeitura(leadId, a.id, l);
    }
    cf = await cfAtual(leadId);
  }
  const h = cf._habiteSe as Cf | undefined;
  const st: StatusHabite | undefined = h?.status;

  // 2. O cliente mandou o próprio habite-se (a conferência leu um documento "HABITE-SE"): vale como TEM.
  const docHabite = Object.values(rev).find((r: any) => r && /habite/.test(sem(r.tipo)) && r.resultado !== 'NAO_DOCUMENTO');
  const t = terrenoNaCertidao(cf);
  if (docHabite && t && (!st || st === 'PERGUNTADO' || st === 'A_PERGUNTAR' || st === 'NAO_SABE')) {
    if (!h) await gravarHabite(leadId, { status: 'A_PERGUNTAR', anexos: t.anexos, descricao: t.descricao, emissao: t.emissao, antiga: t.antiga, anos: t.anos, detectadoAt: new Date().toISOString() });
    await registrarResposta(accountId, leadId, lead.name, 'TEM', '', 'documento');
    return 'TEM';
  }
  // 3. Certidão sem terreno (ou uma nova, com a casa averbada): nada a perguntar; pergunta em aberto se resolve.
  if (!t) {
    if (st === 'PERGUNTADO' || st === 'A_PERGUNTAR') {
      await gravarHabite(leadId, { ...h, status: 'AVERBADA', resolvidoAt: new Date().toISOString() });
      await note(leadId, '🏠 Habite-se: a certidão mais nova do imóvel já mostra a construção da casa averbada — a pergunta do habite-se não vale mais.');
      return 'AVERBADA';
    }
    return st || null;
  }
  // 4. Já respondeu: lê de novo só quem ficou em dúvida.
  if (st === 'TEM' || st === 'NAO_TEM' || st === 'AVERBADA') return st;
  if (st === 'PERGUNTADO' || st === 'NAO_SABE') { const r = await lerRespostaHabite(accountId, leadId); return r === 'PERGUNTADO' ? 'AGUARDA' : r; }

  // 5. Primeira vez (ou ficou pra perguntar com a IA desligada).
  const base = { anexos: t.anexos, descricao: t.descricao, emissao: t.emissao, antiga: t.antiga, anos: t.anos, detectadoAt: h?.detectadoAt || new Date().toISOString() };
  const resumo = `A certidão de ônus/matrícula descreve o imóvel como TERRENO/LOTE${t.descricao ? ` (${t.descricao})` : ''}, sem a construção averbada, mas o cliente informou CASA residencial. Santander e Creditas só fazem Home Equity com habite-se (Fabio 06/11).`;
  const velha = t.antiga ? ` A certidão é de ${mesAno(t.emissao)} (há mais de ${Math.max(1, t.anos || 1)} ano${(t.anos || 1) > 1 ? 's' : ''}): o habite-se pode ter sido averbado depois — se quiser, autorize a emissão de uma certidão atualizada (ONR); não pedi nada ao cliente.` : '';
  // O cliente já falou de habite-se na conversa (fora da proposta)? Então lê o que ele disse em vez de perguntar.
  const antes = await falasDoCliente(leadId, new Date(Date.now() - 90 * 86_400_000), /habite/i);
  if (antes.textos.length) {
    const r = await lerResposta('A casa tem habite-se?', antes.textos);
    if (r && r.resposta !== 'SEM_RESPOSTA') {
      await gravarHabite(leadId, { ...base, status: 'A_PERGUNTAR', askedAt: null });
      await note(leadId, `🏗️ ${resumo}${velha} O cliente já tinha falado do habite-se na conversa — não perguntei de novo.`);
      await registrarResposta(accountId, leadId, lead.name, r.resposta, r.trecho, 'conversa');
      return r.resposta;
    }
  }
  // A equipe já perguntou enquanto a IA estava desligada: espera a resposta em vez de perguntar de novo.
  if (st === 'A_PERGUNTAR' && h?.avisadoAt) {
    const nossa = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', createdAt: { gt: new Date(h.avisadoAt) }, content: { contains: 'habite', mode: 'insensitive' } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true, content: true } });
    if (nossa) {
      await gravarHabite(leadId, { ...h, ...base, status: 'PERGUNTADO', askedAt: nossa.createdAt.toISOString(), pergunta: String(nossa.content).slice(0, 400) });
      const r = await lerRespostaHabite(accountId, leadId);
      return r === 'PERGUNTADO' ? 'AGUARDA' : r;
    }
  }
  const pergunta = perguntaHabite(t);
  if (opts.podeFalar && lead.aiAutoReplyActive && !cf._autoPaused) {
    const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
    const sent = await sendOutboundWhatsApp({ accountId, leadId, content: pergunta, io: io || undefined });
    if (sent.success) {
      await gravarHabite(leadId, { ...base, status: 'PERGUNTADO', askedAt: new Date().toISOString(), pergunta });
      await note(leadId, `🏗️ ${resumo}${velha} Perguntei ao cliente se a casa tem habite-se; a resposta fica registrada aqui no card.`);
      await pushResponsavel(accountId, leadId, `🏗️ ${lead.name}: certidão mostra só terreno`, 'Perguntei ao cliente se a casa tem habite-se (Santander/Creditas exigem)');
      return 'PERGUNTOU';
    }
    console.warn(`[Habite-se] ${lead.name} (${leadId}): pergunta não saiu — ${sent.error}`);
  }
  if (!h?.avisadoAt) {
    await gravarHabite(leadId, { ...base, status: 'A_PERGUNTAR', avisadoAt: new Date().toISOString() });
    const porque = !opts.podeFalar ? 'conferência pelo botão (sem mensagem ao cliente)' : !lead.aiAutoReplyActive ? 'IA desligada no card' : cf._autoPaused ? 'cliente em Stop total' : 'a mensagem não saiu';
    await note(leadId, `🏗️ ${resumo}${velha} Ainda NÃO perguntei ao cliente (${porque}): pergunte se a casa tem habite-se — ou, com a IA ligada, a próxima conferência pergunta. Sugestão: "${pergunta}"`);
    await pushResponsavel(accountId, leadId, `🏗️ ${lead.name}: certidão mostra só terreno`, 'Perguntar ao cliente se a casa tem habite-se (Santander/Creditas exigem)');
  }
  return 'AGUARDA';
}

/** Antes de a documentação completa levar o card pra contratação: segura (devolve o motivo) se o habite-se está em aberto, ou se o imóvel está sem habite-se e a proposta em
 *  jogo é do Santander/Creditas. Nota + push uma vez por motivo. null = pode seguir. */
export async function segurarContratacaoHabite(accountId: string, leadId: string): Promise<string | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || !/home equity/i.test(lead.pipeline?.department?.name || '')) return null;
  const cf = (lead.customFields || {}) as Cf;
  if (cf._caixaRota) return null;
  const st: StatusHabite | undefined = cf._habiteSe?.status;
  let motivo: string | null = null;
  if (st === 'PERGUNTADO' || st === 'A_PERGUNTAR') motivo = 'o cliente ainda não respondeu se a casa tem habite-se (a certidão mostra só o terreno)';
  else {
    const s = await semHabiteDoCard(leadId, cf);
    if (s) {
      const aps = await prisma.creditAnalysis.findMany({ where: { leadId, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] } }, select: { bank: true, chosen: true } });
      const escolhida = aps.find((a) => a.chosen);
      const escolhidaServe = !!escolhida && !BANCOS_HABITE.includes(escolhida.bank);
      if (!escolhidaServe && aps.some((a) => BANCOS_HABITE.includes(a.bank))) {
        motivo = `${s.texto} e ${escolhida ? `a proposta escolhida é do ${escolhida.bank === 'CREDITAS' ? 'Creditas' : 'Santander'}` : 'há aprovação do Santander/Creditas sem proposta escolhida'} — esses dois só fazem Home Equity com habite-se`;
      }
    }
  }
  if (!motivo) return null;
  if (cf._habiteSeSegurado !== motivo) {
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_habiteSeSegurado}', ${JSON.stringify(motivo)}::jsonb, true) WHERE id = ${leadId}`;
    await note(leadId, `⏸️ Documentação completa, mas o card NÃO foi pra contratação: ${motivo} (Fabio 06/11). Decida com qual banco seguir (Inter) e mova o card quando estiver certo. Não mandei nada ao cliente.`);
    await pushResponsavel(accountId, leadId, `⏸️ ${lead.name}: contratação segurada`, `Habite-se: ${motivo}`);
  }
  return motivo;
}

import { cachedSystem } from '../lib/anthropic-usage';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { fixedRule } from './fixed-rules.service';
import { getDocInfo, isStickerAttachment, isScreenshotAttachment } from './received-docs.service';
import { moveLeadToContracting } from './contracting.service';
import { sendOutboundWhatsApp } from './message.service';
import { logActivity } from './activity.service';
import { todayContextLine } from './ai-shared.service';
import { reviewReceivedDocs, buildDocProblemsMessage } from './doc-review.service';


/* A IA confere se a documentação chegou completa (pedido do Fabio: a skill só
 * roda o crédito; documentação é da IA do CRM). Card em "Aguardando
 * Documentação" (IA ligada ou não): a cada DOCUMENTO que o cliente manda
 * (foto/arquivo — não roda de tempos em tempos, pra não gastar crédito),
 * espera ele parar de mandar arquivo, lê o que chegou (cache em customFields._docInfo, o
 * mesmo do organizador de pasta), compara com a lista de documentos certa
 * (Respostas Rápidas "Documentos ...") e, se estiver completo, leva o card pra
 * "Documentação Recebida" e avisa o cliente. Incompleto: não faz nada — a IA
 * de conversa continua atendendo normalmente. */

/** Fabio 15/10: cliente mandando documento → ESPERA 10 min sem arquivo novo (cada arquivo reinicia a contagem) pra ele mandar tudo; se não mandou tudo, confere o que chegou e COBRA o que falta.
 *  O horário da conferência fica gravado no card (`_docsCheckDue`) e um poller (processDocsChecks, 1 min) executa — o setTimeout antigo se perdia a cada deploy. */
/** Anotação que registra o OK do cliente pra A&F emitir a certidão (Fabio 15/10: sem campo — o CRM anota e lê). */
export const AUTORIZOU_EMISSAO = '🏛️ CLIENTE AUTORIZOU A EMISSÃO DA CERTIDÃO';
const CHECK_DELAY_MS = 5 * 60_000; // Fabio 15/10: 10 min → 5 min

export const DOCS_COMPLETE_MESSAGE = 'Recebi toda a documentação, obrigada! Já vou seguir com a análise. Se o banco achar necessário, pode pedir algum documento a mais, aí te aviso por aqui.';

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

type Io = Parameters<typeof moveLeadToContracting>[2];

export async function scheduleDocsCheck(accountId: string, leadId: string, io: Io): Promise<void> {
  // Roda com a IA ligada OU desligada (Fabio 29/09: o Ângelo mandou os
  // documentos depois que ele respondeu pela Inbox — a IA estava desligada,
  // ninguém conferiu, o card não andou e a pasta no Drive não foi criada).
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, stage: { select: { name: true } } } });
  if (!lead || !norm(lead.stage.name).includes('aguardando documentacao')) return;
  const cf: Record<string, unknown> = { ...((lead.customFields || {}) as Record<string, unknown>), _docsCheckDue: new Date(Date.now() + CHECK_DELAY_MS).toISOString() };
  delete cf._docsLater; // mandou documento: a cobrança do "te mando depois" não é mais necessária
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}

/** Poller (1 min, junto com a análise automática): confere os cards cujo prazo de 10 min sem documento novo venceu. */
export async function processDocsChecks(accountId: string, io: Io): Promise<void> {
  const due = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND ("customFields"->>'_docsCheckDue') IS NOT NULL AND ("customFields"->>'_docsCheckDue')::timestamptz <= now() LIMIT 10`;
  for (const { id } of due) {
    const fresh = await prisma.lead.findUnique({ where: { id }, select: { customFields: true } });
    const cf = { ...((fresh?.customFields || {}) as Record<string, unknown>) };
    delete cf._docsCheckDue;
    await prisma.lead.update({ where: { id }, data: { customFields: cf as any } });
    await checkDocsComplete(accountId, id, io).catch((err) => console.error(`[Docs] Falha ao conferir documentação do lead ${id}:`, err?.message || err));
  }
}

// ─── "Te mando mais tarde / amanhã": a IA cobra ANTES da janela de 24 h fechar (Fabio 15/10, Francisco Nascimento) ───────────────────────────────
// Card em "Aguardando Documentação" (crédito aprovado) e o cliente avisa que manda depois: o card FICA na etapa (nada de Follow Up/Venda Futura) e o CRM agenda uma cobrança curta
// ("conseguiu separar a documentação?") pro horário que ele prometeu, mas nunca depois de (fim da janela de 24 h − 90 min) — fora da janela só com template, e a conversa abre de novo se ele responder.

const WINDOW_MS = 23 * 3_600_000;
const BRT = -3 * 3_600_000; // Brasília = UTC−3 (sem horário de verão)
export const TIME_RX = /(\bdia \d{1,2}\b|\b\d{1,2}\/\d{1,2}\b|fim d[oa] m[êe]s|final d[oa] m[êe]s|amanh[ãa]|mais tarde|\bdepois\b|hoje (à|a) noite|[àa] noite|daqui (a )?(pouco|uns?|\d+)|logo mais|\bsegunda\b|\bter[çc]a\b|\bquarta\b|\bquinta\b|\bsexta\b|s[áa]bado|domingo|semana que vem|fim de semana|quando (chegar|sair|puder|conseguir|tiver)|assim que (puder|conseguir|chegar|sair|tiver)|estou no trabalho|n[ãa]o (tenho como|consigo|posso) (enviar|mandar|encaminhar)( agora)?|agora n[ãa]o|depois do (trabalho|expediente)|quando eu (chegar|sair|puder))/i;
const SEND_RX = /(mand|envi|encaminh|pass(o|ar)|trag|junt|separ|entreg|forne|te dou|consigo|tir(o|ar)|escane|fotograf)/i;
const NEGATIVE_RX = /(n[ãa]o (tenho|quero|vou) (mais )?(interesse|seguir|continuar)|desist|cancel)/i;

/** Quando o cliente prometeu mandar, em horário de Brasília → Date (UTC). */
export function promisedAt(text: string, now: Date): Date {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const local = new Date(now.getTime() + BRT); // "relógio de parede" de Brasília lido com getUTC*
  const at = (days: number, hour: number) => { const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour, 0, 0)); return new Date(d.getTime() - BRT); };
  const wd = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'].findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
  // Data dita pelo cliente (Fabio 28/10: o CRM pergunta o prazo e espera até essa data): "dia 5", "05/11", "fim do mês".
  const dm = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  if (dm) { const d = new Date(Date.UTC(local.getUTCFullYear(), Number(dm[2]) - 1, Number(dm[1]), 11) - BRT); return d.getTime() > now.getTime() ? d : new Date(Date.UTC(local.getUTCFullYear() + 1, Number(dm[2]) - 1, Number(dm[1]), 11) - BRT); }
  const dia = /\bdia (\d{1,2})\b/.exec(t);
  if (dia) { const n = Number(dia[1]); const mes = n > local.getUTCDate() ? local.getUTCMonth() : local.getUTCMonth() + 1; return new Date(Date.UTC(local.getUTCFullYear(), mes, n, 11) - BRT); }
  if (/(fim|final) d[oa] mes/.test(t)) return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0, 11) - BRT);
  if (/depois de amanha/.test(t)) return at(2, 11);
  if (/amanha/.test(t)) return at(1, 11);
  if (wd >= 0) { const diff = ((wd - local.getUTCDay()) + 7) % 7 || 7; return at(diff, 11); }
  if (/semana que vem|proxima semana/.test(t)) return at(5, 11);
  if (/hoje a noite|a noite/.test(t)) return at(local.getUTCHours() >= 18 ? 1 : 0, local.getUTCHours() >= 18 ? 11 : 19);
  // "estou no trabalho", "não tenho como enviar agora", "assim que puder" (Vicente Paulo 21/10): à noite do mesmo dia (19h); depois das 17h, amanhã de manhã.
  if (/trabalho|expediente|servico|agora nao|assim que (puder|conseguir|chegar|sair|tiver)|nao (tenho como|consigo|posso)/.test(t)) return at(local.getUTCHours() >= 17 ? 1 : 0, local.getUTCHours() >= 17 ? 11 : 19);
  if (/mais tarde|logo mais|daqui/.test(t)) return new Date(now.getTime() + 3 * 3_600_000);
  return at(1, 11); // "depois", "quando conseguir…": amanhã de manhã
}

/** Hook do WhatsApp: o cliente respondeu (texto) depois de perguntarmos de quem é o imóvel → reabre a conferência dos documentos. */
export async function maybeRecheckOwnerAnswer(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId, status: 'OPEN' }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  if (!cf._donoAskedAt || cf._donoResolvedAt) return;
  await scheduleDocsCheck(accountId, leadId, io);
}

/** Hook do WhatsApp: texto do cliente num card em Aguardando Documentação. */
export async function maybeScheduleDocsFollowUp(accountId: string, leadId: string, text: string): Promise<void> {
  const t = (text || '').trim();
  if (!t || t.length > 220 || NEGATIVE_RX.test(t) || !TIME_RX.test(t) || !SEND_RX.test(t)) return;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId, status: 'OPEN' }, select: { customFields: true, stage: { select: { name: true } } } });
  if (!lead || !norm(lead.stage.name).includes('aguardando documentacao')) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused) return;
  const now = new Date();
  const lastIn = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const windowEnd = (lastIn?.createdAt.getTime() || now.getTime()) + WINDOW_MS;
  const promised = promisedAt(t, now);
  let due = Math.min(promised.getTime(), windowEnd - 90 * 60_000);
  due = Math.max(due, now.getTime() + 30 * 60_000);
  // Só entre 07h e 21h de Brasília: fora disso vai pras 08h seguintes (se couber na janela) ou volta pras 20h30.
  const dl = new Date(due + BRT);
  const hh = dl.getUTCHours();
  if (hh < 7 || hh >= 21) {
    const next8 = Date.UTC(dl.getUTCFullYear(), dl.getUTCMonth(), dl.getUTCDate() + (hh >= 21 ? 1 : 0), 8, 0, 0) - BRT;
    due = next8 <= windowEnd - 90 * 60_000 ? next8 : Math.max(now.getTime() + 30 * 60_000, Date.UTC(dl.getUTCFullYear(), dl.getUTCMonth(), dl.getUTCDate() + (hh >= 21 ? 0 : -1), 20, 30, 0) - BRT);
  }
  const beyond = promised.getTime() > due + 60 * 60_000; // prometeu algo além do que a janela permite
  // _docsPrazo: a data que o cliente deu — o loop de lembretes (docs-loop.service) espera até ela.
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _docsLater: { at: new Date(due).toISOString(), said: t.slice(0, 120), setAt: now.toISOString(), beyond }, _docsPrazo: promised.toISOString() } as any } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⏰ Cliente avisou que manda os documentos depois ("${t.slice(0, 120)}"). O card fica em Aguardando Documentação; a IA cobra ${new Date(due).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })} — antes da janela de 24 h do WhatsApp fechar.` } }).catch(() => {});
}

/** Poller (1 min): manda a cobrança combinada. */
export async function processDocsFollowUps(accountId: string, io: Io): Promise<void> {
  const due = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND ("customFields"->'_docsLater'->>'at') IS NOT NULL AND ("customFields"->'_docsLater'->>'at')::timestamptz <= now() LIMIT 10`;
  for (const { id } of due) {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, stage: { select: { name: true } } } });
    if (!lead) continue;
    const cf = { ...((lead.customFields || {}) as Record<string, any>) };
    const st = cf._docsLater as { at: string; said: string; setAt: string; beyond?: boolean } | undefined;
    if (!st) continue;
    const limpa = async () => { const f = await prisma.lead.findUnique({ where: { id }, select: { customFields: true } }); const c = { ...((f?.customFields || {}) as Record<string, any>) }; delete c._docsLater; await prisma.lead.update({ where: { id }, data: { customFields: c as any } }); };
    if (!norm(lead.stage.name).includes('aguardando documentacao') || cf._autoPaused) { await limpa(); continue; }
    const docs = await prisma.messageAttachment.count({ where: { leadId: id, message: { direction: 'INBOUND' }, createdAt: { gt: new Date(st.setAt) } } });
    if (docs) { await limpa(); continue; } // já mandou
    const hh = new Date(Date.now() + BRT).getUTCHours();
    if (hh < 7 || hh >= 21) continue; // fora do horário: tenta na próxima rodada dentro do horário
    const lastIn = await prisma.message.findFirst({ where: { leadId: id, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const aberta = !!lastIn && Date.now() - lastIn.createdAt.getTime() < WINDOW_MS;
    if (!lead.aiAutoReplyActive || !aberta) {
      await limpa();
      await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: `⏰ Hora de cobrar os documentos que o cliente prometeu ("${st.said}") — ${!lead.aiAutoReplyActive ? 'a IA está desligada neste card, então NÃO mandei' : 'a janela de 24 h do WhatsApp já fechou, então NÃO mandei'}. Chame o cliente.` } }).catch(() => {});
      try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(accountId, { title: lead.name, body: 'Cobrar os documentos que ele prometeu mandar', leadId: id }).catch(() => {}); } catch { /* push opcional */ }
      continue;
    }
    const { conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
    const nome = String(cf.participante_1 || lead.name || '').trim().split(/\s+/)[0] || '';
    const oi = (await conversationActive(id)) ? '' : `Oi${nome ? `, ${nome}` : ''}! `;
    const texto = st.beyond
      ? `${oi}Só pra manter nossa conversa aberta: continua tudo certo pra você me mandar a documentação? Me responde por aqui.`
      : `${oi}Conseguiu separar a documentação? Se já tiver, pode mandar por aqui mesmo.`;
    const sent = await sendOutboundWhatsApp({ accountId, leadId: id, content: texto, io: io || undefined });
    await limpa();
    await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: `⏰ A IA cobrou os documentos que o cliente tinha prometido ("${st.said}")${sent.success ? '' : ' — mas o envio falhou'}. O card continua em Aguardando Documentação.` } }).catch(() => {});
  }
}

const RULES = `Você confere se um cliente de crédito imobiliário já mandou TODA a documentação pedida. Responda SOMENTE com JSON:
{"complete": <true ou false>, "listaUsada": "<nome da lista>", "faltando": ["<item que falta>", ...], "emitir": ["<documento do imóvel que a A&F vai emitir>", ...], "autorizouEmissao": <true se na CONVERSA o atendente ofereceu emitir a certidão (custo de R$ 40 a R$ 100) e o cliente ACEITOU; senão false>}

Como decidir:
0. Se a CONVERSA já tem uma lista de documentos enviada pela equipe pra esse cliente, ELA é a referência (vale mais que as listas abaixo).
1. Senão, escolha a lista certa entre as listas abaixo: Home Equity pessoa física → "Documentos Home Equity"; crédito no nome de empresa (PJ) → "Documentos comprador PJ"; Financiamento Habitacional → a lista do perfil de renda (empresário/autônomo/profissional liberal → empresário; assalariado/CLT → setor privado; servidor público → servidor público).
2. Documentos pessoais e de renda valem pra CADA participante listado.
3. Itens marcados "se usar" ou "se houver" não são obrigatórios.
4. RG ou CNH servem como documento de identificação; certidão de nascimento ou de casamento servem como comprovante de estado civil. HOME EQUITY (Fabio 27/10): de cada participante só se pedem RG/CNH e comprovante de residência (+ os documentos do imóvel) — NUNCA ponha certidão de nascimento/casamento, CPF ou renda em "faltando" na lista "Documentos Home Equity", mesmo que uma versão antiga da lista cite. A documentação completa é só da CAIXA (e das listas do Financiamento Habitacional).
5. Cônjuges/companheiros: um comprovante de residência e uma certidão de casamento servem para os dois (moram juntos), a não ser que a conversa diga que moram em endereços diferentes.
6. Se o cliente disse na conversa que algo não se aplica a ele, considere.
7. CERTIDÃO DE ÔNUS REAIS e MATRÍCULA do imóvel é ITEM ESSENCIAL (sem ela a contratação não conclui). A "Certidão de Cadastro Imobiliário" da PREFEITURA (inscrição imobiliária, proprietários, endereço) NÃO é certidão de ônus nem matrícula: não conta como recebida pra este item (ela só ajuda com a "Inscrição Imobiliária"). Qualquer arquivo de matrícula/ônus do CARTÓRIO recebido (mesmo consulta, antigo ou parcial) conta como recebido; se o cliente JÁ trouxe a certidão/matrícula, ela basta — a A&F NÃO emite outra. Escritura pública ou contrato de compra e venda NÃO substituem a certidão, mas trazem o número da matrícula (normalmente a escritura pública) e permitem à A&F emiti-la, SE o cliente autorizar. Se NÃO chegou, ponha em "faltando" ("Certidão de ônus/matrícula — ou escritura/documento com o número da matrícula") — a menos que a linha "Cliente autorizou a A&F a emitir a certidão" seja Sim: aí vai em "emitir" e não em "faltando". O que sobra do imóvel (o item do IPTU: inscrição imobiliária OU capa do IPTU) continua obrigatório.
8c. "autorizouEmissao": true SÓ se na CONVERSA RECENTE o atendente ofereceu emitir a certidão de ônus/matrícula (o custo só é dito se o cliente perguntar) e o cliente aceitou/autorizou; caso contrário false.
8d. Se a linha "A matrícula da certidão que o cliente enviou foi ENCERRADA" aparecer, a certidão recebida NÃO vale (o imóvel ganhou matrícula nova): trate como não recebida e coloque a certidão da MATRÍCULA NOVA em "emitir" (a A&F emite pelo número novo) — NÃO em "faltando" e NUNCA peça ao cliente que tire outra no cartório.
8b. Se a linha "O banco NÃO aceitou a certidão que o cliente enviou" aparecer (a equipe anotou isso no card), a certidão recebida NÃO vale (muito antiga ou só consulta): trate como não recebida — "faltando" (ou "emitir", se o cliente autorizou a emissão).
8a. O cliente respondeu no formulário se POSSUI certidão de ônus/matrícula (linha "Cliente informou…" abaixo): é só contexto. "Não possui"/"Não sei" NÃO tira a certidão de "faltando" (a conversa vai apurar o que ele tem); "Sim, possui" e nenhum arquivo: falta mesmo.
8. IPTU (Fabio 27/10 — inscrição e capa viraram UM item só: "Inscrição Imobiliária/IPTU ou Capa do IPTU com as metragens"): QUALQUER documento da PREFEITURA com a inscrição imobiliária atende — capa, carnê ou guia do IPTU, CND de IPTU, certidão de cadastro imobiliário, declaração/certidão de isenção de IPTU (imóvel isento manda a inscrição). As metragens NÃO são obrigatórias pra esse item: sem a capa, a inscrição basta. Se a lista usada ainda trouxer os dois itens separados ("Inscrição Imobiliária/IPTU" e "Capa do IPTU com as metragens"), o MESMO documento da prefeitura atende os dois — nunca cobre a capa de quem já mandou a inscrição.
8e. Matrícula, escritura e outros documentos de cartório NÃO contam como o item do IPTU (não são da prefeitura).
8f. RENDA (Fabio 20/10 e 27/10 — renda SÓ quando o banco pede): a linha "Comprovação de renda" diz se ela é necessária. Se disser que NÃO é necessária, NÃO coloque nenhum item de renda em "faltando" e considere-os atendidos, mesmo que não tenham chegado.
8g. OPERADORA (Fabio 20/10): documento de operadora/concessionária (Claro, Vivo, TIM, Oi, energia, água, gás, internet) vale como COMPROVANTE DE RESIDÊNCIA, inclusive o protegido por senha que não pôde ser lido: conte como recebido.
8i. PROTEGIDO (Fabio 21/10): arquivo do tipo PROTEGIDO (senha) não conta como nenhum item da lista e NÃO impede de completar se o resto chegou — a IA pergunta ao cliente o que é e a equipe confere depois (fica na pasta como "VERIFICAR").
8h. ESCRITURA (Fabio 20/10): se só chegou a escritura (com o número da matrícula), a certidão de ônus/matrícula NÃO é pedida ao cliente: ponha em "emitir" (a A&F pede pelo ONR com o OK dele), nunca em "faltando".
9. Seja rigoroso: "complete": true só se tiver certeza de que todos os itens obrigatórios chegaram. Se houver arquivos que não puderam ser lidos e algum item obrigatório puder estar entre eles, responda false.`;

/** Só avalia (não move nem manda nada). null = nada pra avaliar. */
export async function evaluateDocs(accountId: string, leadId: string): Promise<{ leadName: string; complete: boolean; listaUsada?: string; faltando: string[]; emitir: string[]; emitirPendente: string[]; receivedText: string } | null> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { stage: true, pipeline: { include: { department: true } } },
  });
  if (!lead) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const atts = (await prisma.messageAttachment.findMany({
    where: { leadId, message: { direction: 'INBOUND' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, driveFileId: true, data: true, mimeType: true, fileName: true },
  })).filter((a) => !/^(audio|video)\//.test(a.mimeType) && !isStickerAttachment(a) && !isScreenshotAttachment(a));
  if (!atts.length) return null;

  const info = await getDocInfo(accountId, leadId, atts);
  const received = atts.map((a) => info[a.id]).filter((d): d is NonNullable<typeof d> => !!d);
  if (!received.length) return null;
  // 28/10 (Wagner): um PDF com os RGs do casal e outro com escritura + matrícula — a classificação rápida guarda UM tipo e UM titular por arquivo ("RG|MARIA CRISTINA",
  // "ESCRITURA") e o cliente foi cobrado do RG dele e da matrícula que já tinham chegado. Soma o que a leitura completa (_docReview) achou no mesmo arquivo: cada titular e os "outros".
  const revAll = ((((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as any)._docReview || {}) as Record<string, { tipo?: string; titular?: string; outros?: string[]; resultado?: string }>;
  const counts: Record<string, number> = {};
  for (const a of atts) {
    const d = info[a.id];
    if (!d) continue;
    const doArquivo = new Map<string, string>(); // chave normalizada → como aparece
    const add = (tipo: string, quem?: string) => { const t = quem ? `${tipo} — de ${quem}` : tipo; doArquivo.set(t.toUpperCase(), doArquivo.get(t.toUpperCase()) || t); };
    const nomes = (x?: string) => String(x || '').split(/\s*;\s*/).filter(Boolean);
    if (nomes(d.holder).length) nomes(d.holder).forEach((h) => add(d.type, h)); else add(d.type);
    const r = revAll[a.id];
    if (r && r.tipo && r.resultado !== 'NAO_DOCUMENTO') {
      nomes(r.titular).forEach((h) => add(r.tipo!, h));
      if (!nomes(r.titular).length && r.tipo.toUpperCase() !== d.type.toUpperCase()) add(r.tipo);
      (r.outros || []).forEach((o) => add(o));
    }
    for (const k of doArquivo.values()) counts[k] = (counts[k] || 0) + 1;
  }
  const receivedText = Object.entries(counts).map(([t, n]) => (n > 1 ? `${t} (${n} arquivos)` : t)).join('\n');
  const unread = atts.filter((a) => info[a.id] === undefined).map((a) => a.fileName);

  const lists = await prisma.messageTemplate.findMany({
    where: {
      accountId,
      name: { startsWith: 'Documentos', mode: 'insensitive' },
      OR: [{ departmentId: lead.pipeline.departmentId }, { departmentId: null }],
    },
    select: { name: true, body: true },
  });
  const cf = (lead.customFields || {}) as Record<string, string>;
  const cfAll = cf as Record<string, any>;
  // Financiamento Habitacional tem fluxo de documentos PRÓPRIO (Fabio 29/10, Taynara: a conferência cobrou matrícula/ônus e IPTU, que são do Home Equity).
  // Sem banco privado escolhido (ou optou pela CAIXA/BRB): a documentação do comprador — RG, CPF, comprovante de endereço, último contracheque e certidão de estado civil.
  const ehFh = /habitacional/i.test(lead.pipeline.department?.name || '');
  const fhSoComprador = ehFh && (!!cfAll._optouCaixa?.banco || !cfAll._fhChosen);
  const listas = ehFh ? lists.filter((l) => !/home equity/i.test(l.name)) : lists;
  if (!listas.length && !fhSoComprador) return null;
  const blocoFh = !ehFh ? '' : fhSoComprador
    ? `FINANCIAMENTO HABITACIONAL — LISTA QUE VALE (acima de TODAS as listas abaixo; Fabio 29/10): de cada comprador: RG, CPF (a CNH vale pelos dois), comprovante de endereço, último contracheque e certidão de estado civil (nascimento; casamento; casamento com averbação do divórcio/viuvez). Se for casado, RG e CPF do cônjuge. NÃO cobre NADA do imóvel (certidão de ônus/matrícula, escritura, IPTU) nem do vendedor nesta fase: "emitir" vazio e "autorizouEmissao" false. Na "listaUsada" escreva "Financiamento Habitacional — comprador".\n\n`
    : `FINANCIAMENTO HABITACIONAL (banco ${cfAll._fhChosen?.bank || 'escolhido'}): a referência é a lista que o CRM mandou na conversa depois da escolha do banco. NUNCA use a lista "Documentos Home Equity".\n\n`;
  // Autorização da emissão da certidão: SEM campo (Fabio 15/10) — fica registrada numa ANOTAÇÃO do card (marcador abaixo) e o CRM mesmo lê.
  const jaAutorizou = !!(await prisma.note.findFirst({ where: { leadId, content: { startsWith: AUTORIZOU_EMISSAO } }, select: { id: true } }));
  const bancoRecusou = await (require('./doc-review.service') as typeof import('./doc-review.service')).bancoRecusouCertidao(leadId).catch(() => false); // anotação da equipe no card
  const matriculaEncerrada = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }).then((l) => { const m = ((l?.customFields || {}) as any)._matriculaEncerrada; return m ? ((m.novas || []).join('; ') || 'número novo') : ''; }).catch(() => '');
  const { bancosEmJogo } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const jogo = await bancosEmJogo(prisma, leadId).catch(() => ({ emJogo: [] as string[], rendaNecessaria: true, texto: 'sem leitura' }));
  const bancosTxt = jogo.texto || 'sem leitura';
  const rendaNecessaria = fhSoComprador || jogo.rendaNecessaria; // FH: o último contracheque faz parte da lista do comprador
  const comMetragens = Array.from(new Set(Object.values((cfAll._docReview || {}) as Record<string, any>).filter((r: any) => r && r.metragens === true).map((r: any) => String(r.tipo)))) as string[];
  const participants = [
    cf.participante_1 && `1) ${cf.participante_1}${cf.vinculo_1 ? ` — ${cf.vinculo_1}` : ''}`,
    cf.participante_2 && `2) ${cf.participante_2}${cf.vinculo_2 ? ` — ${cf.vinculo_2}` : ''}`,
  ].filter(Boolean).join('\n') || `1) ${lead.name}`;
  const history = (await prisma.message.findMany({
    where: { leadId, callWaCallId: null }, orderBy: { createdAt: 'desc' }, take: 25, select: { content: true, direction: true },
  })).reverse().map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Atendente'}: ${(m.content || '').replace(/\s+/g, ' ').slice(0, 200).replace(/[\ud800-\udbff]$/, '')}`).join('\n');

  const estadoCrm = await (require('./ai-shared.service') as typeof import('./ai-shared.service')).aiCardState(leadId).catch(() => '');
  const prompt = `${todayContextLine()}
Setor/produto: ${lead.pipeline.department?.name || '?'}
Participantes:
${participants}

BANCOS EM JOGO: ${bancosTxt}
Comprovação de renda: ${rendaNecessaria ? 'necessária (o banco pediu documento de renda)' : 'NÃO é necessária (nenhum banco pediu renda — Fabio 27/10: renda só quando o banco pede — ou a equipe dispensou)'}
Documentos da PREFEITURA recebidos que MOSTRAM as metragens do imóvel: ${comMetragens.length ? comMetragens.join(', ') : 'nenhum'}

${blocoFh}LISTAS DE DOCUMENTOS:
${listas.map((l) => `--- ${l.name} ---\n${l.body}`).join('\n\n')}

${bancoRecusou ? 'O banco NÃO aceitou a certidão que o cliente enviou (muito antiga ou só consulta): Sim\n\n' : ''}${matriculaEncerrada ? `A matrícula da certidão que o cliente enviou foi ENCERRADA (matrícula nova: ${matriculaEncerrada}): Sim\n\n` : ''}${jaAutorizou ? 'Cliente autorizou a A&F a emitir a certidão de ônus/matrícula (custo de R$ 40 a R$ 100 pro cliente): Sim\n\n' : ''}${String(cfAll.possui_certidao || '').trim() ? `Cliente informou no formulário que possui certidão de ônus/matrícula: ${String(cfAll.possui_certidao).trim()}\n\n` : ''}DOCUMENTOS RECEBIDOS (lidos dos arquivos que o cliente mandou; "de FULANO" = titular do documento):
${receivedText}
${unread.length ? `\nArquivos que não puderam ser lidos: ${unread.length}` : ''}

${estadoCrm ? `\nESTADO DO CARD NO CRM (fatos reais do sistema — análise de crédito, contratação e agenda; não contradiga):\n${estadoCrm}\n` : ''}
CONVERSA RECENTE:
${history}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4000, system: cachedSystem(await fixedRule(accountId, 'DOCS_CHECKER_RULES', RULES)), messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    console.error('[Docs] Erro Anthropic:', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const raw = data.content?.find((b) => b.type === 'text')?.text || '';
  let verdict: { complete?: boolean; listaUsada?: string; faltando?: string[]; emitir?: string[]; autorizouEmissao?: boolean } = {};
  try { verdict = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return null; }
  let autorizou = jaAutorizou;
  if (!autorizou && verdict.autorizouEmissao === true) {
    autorizou = true;
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `${AUTORIZOU_EMISSAO} — o cliente aceitou na conversa que a A&F emita a certidão de ônus/matrícula pelo ONR (custo de R$ 40 a R$ 100 pra ele).` } }).catch(() => {});
  }
  const emitirBruto = fhSoComprador ? [] : Array.isArray(verdict.emitir) ? verdict.emitir.map((x) => String(x).slice(0, 120)) : [];
  if (fhSoComprador) verdict.faltando = (verdict.faltando || []).filter((f) => !/[ôo]nus|matr[ií]cula|escritura|iptu|inscri[cç][aã]o imobili|vendedor/i.test(String(f)));
  // Sem a permissão do cliente a A&F NÃO emite (custo de R$ 40 a R$ 100 pra ele): o que o modelo pôs em "emitir" volta pra "faltando" e a certidão trava a conclusão.
  // Escritura com a matrícula identificada (Fabio 20/10): a certidão NÃO é cobrada do cliente — a IA se OFERECE pra emitir pelo ONR (certidao-offer.service) e só emite quando ele aceita.
  const { certidaoFromDocs } = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
  const ofertavel = !autorizou && emitirBruto.length > 0 && !!certidaoFromDocs(cfAll);
  const faltandoFinal = [...(verdict.faltando || []), ...(autorizou || ofertavel ? [] : emitirBruto)];
  return { leadName: lead.name, complete: verdict.complete === true && (autorizou || !emitirBruto.length), listaUsada: verdict.listaUsada, faltando: faltandoFinal, emitir: autorizou ? emitirBruto : [], emitirPendente: ofertavel ? emitirBruto : [], receivedText };
}

/** O cliente AVISOU que já mandou os documentos (botão "Já enviei os documentos" do lembrete, ou texto equivalente)? */
export function isDocsSentClaim(text: string): boolean {
  const t = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\b(ja\s+)?(enviei|mandei|encaminhei|anexei)\b.{0,40}\b(document|tudo|papeis|arquivos|certidoes)/.test(t) || /\bja\s+(foi|foram|esta|estao)\s+(tudo\s+)?(enviad|mandad|encaminhad)/.test(t);
}

/** `force` = o cliente disse "já enviei": confere AGORA e responde com a situação atual (o que falta / o que está com problema), mesmo que já tenha avisado o mesmo antes. Devolve true se falou com o cliente (ou concluiu a documentação). */
/** Arquivos que não abrem (senha): UMA mensagem ao cliente perguntando o que são (Fabio 21/10). Só com IA do card ligada, 07h–21h e janela de 24 h aberta; senão tenta de novo na próxima conferência. */
async function perguntarProtegidos(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { aiAutoReplyActive: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const prot = (cf._docsProtegidos || {}) as Record<string, { fileName?: string; guess?: string; askedAt?: string }>;
  const pend = Object.entries(prot).filter(([, v]) => !v.askedAt);
  if (!lead || !lead.aiAutoReplyActive || cf._autoPaused || !pend.length) return;
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow() || !(await whatsappWindowOpen(leadId))) return;
  const nomes = pend.map(([, v]) => `• ${v.fileName}`).join('\n');
  const texto = `${pend.length > 1 ? 'Os arquivos abaixo estão protegidos' : 'O arquivo abaixo está protegido'} por senha e eu não consigo abrir:\n${nomes}\n\nPode me dizer que documento ${pend.length > 1 ? 'é cada um' : 'é esse'}? Se der, manda de novo sem senha.`;
  const sent = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined });
  if (!sent.success) return;
  const next: Record<string, any> = {};
  for (const [id, v] of Object.entries(prot)) next[id] = v.askedAt ? v : { ...v, askedAt: new Date().toISOString() };
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _docsProtegidos: next } as any } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔒 Perguntei ao cliente o que são os arquivos protegidos por senha (${pend.map(([, v]) => v.fileName).join('; ')}). Eles ficam na pasta do Drive como "VERIFICAR - …" pra você conferir depois.` } }).catch(() => {});
}

export async function checkDocsComplete(accountId: string, leadId: string, io: Io, opts: { force?: boolean } = {}): Promise<boolean> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, aiAutoReplyActive: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || !norm(lead.stage.name).includes('aguardando documentacao')) return false;
  const cfLead = (lead.customFields || {}) as Record<string, any>;
  const fhSoComprador = /habitacional/i.test(lead.pipeline?.department?.name || '') && (!!cfLead._optouCaixa?.banco || !cfLead._fhChosen);
  if ((lead.customFields as any)?._autoPaused) return false; // Stop total do cliente: não confere, não move, não avisa

  // Conferência de CONTEÚDO (Fabio 14/10): a IA LÊ cada arquivo e vê se está legível, atualizado e no nome certo (RG/CNH com frente e verso). Documento com
  // problema NÃO deixa o card avançar, mesmo que "chegou tudo": o cliente é avisado do que corrigir (uma vez por conjunto de problemas).
  const review = await reviewReceivedDocs(accountId, leadId).catch((err) => { console.error(`[Docs] leitura dos documentos falhou (${leadId}):`, err?.message || err); return null; });
  // Renda dispensada PELA EQUIPE neste card (marca _rendaDispensada; Fabio 20/10, caso Luiz): problema/dúvida em documento de RENDA não segura o card nem gera cobrança.
  if (review) {
    const { bancosEmJogo } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
    const jogo = await bancosEmJogo(prisma, leadId).catch(() => null);
    if (jogo && !jogo.rendaNecessaria && !fhSoComprador) {
      const RENDA_RX = /EXTRATO BANCARIO|CONTRACHEQUE|HOLERITE|IMPOSTO DE RENDA|DECLARACAO DE RENDA|COMPROVANTE DE RENDA|PRO.?LABORE|DECORE/;
      review.problemas = review.problemas.filter((p) => !RENDA_RX.test(String(p.doc).toUpperCase()));
      review.duvidas = review.duvidas.filter((d) => !RENDA_RX.test(String(d.doc).toUpperCase()));
    }
  }
  if (review?.novas.length) {
    const linhas = review.novas.map(({ arquivo, r }) => `${r.resultado === 'OK' ? '✅' : r.resultado === 'PROBLEMA' ? '⚠️' : r.resultado === 'DUVIDA' ? '❓' : '•'} ${r.tipo}${r.titular ? ` (${r.titular})` : ''}${r.resultado === 'PROBLEMA' ? ` — ${r.problemas.join('; ')}` : ''}${r.observacao ? ` [${r.observacao}]` : ''} — ${arquivo}`);
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 A IA leu ${review.novas.length > 1 ? 'os documentos novos' : 'o documento novo'}:\n${linhas.join('\n')}` } }).catch(() => {});
  }
  if (review?.atendidos?.length) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 Conferindo a documentação inteira, NÃO pedi de novo:\n${review.atendidos.map((a) => `• ${a.doc}: "${a.texto}" — já atendido por ${a.por}`).join('\n')}` } }).catch(() => {});
  }
  await perguntarProtegidos(accountId, leadId, io).catch((e: any) => console.error('[Docs] arquivos protegidos:', e?.message || e));
  // Documento em DÚVIDA (a pergunta está com a equipe no balão): não avança o card nem cobra nada até a equipe responder.
  if (review?.duvidas.length && !review.problemas.length) {
    console.log(`[Docs] ${lead.name} (${leadId}): ${review.duvidas.length} documento(s) em dúvida com a equipe — conferência pausada`);
    return false;
  }

  // Documento do imóvel em nome de OUTRA pessoa (Fabio 15/10): a IA pergunta ao cliente de quem é o imóvel (uma vez por proprietário) e o card espera a resposta; com a resposta a conferência reabre.
  if (review?.donoPendente.length) {
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const cfd = { ...((fresh?.customFields || {}) as Record<string, any>) };
    const ja = new Set<string>(((cfd._donoAskedFor as string[]) || []).map((x) => String(x).toUpperCase()));
    const novos = review.donoPendente.filter((d) => !ja.has(d.dono.toUpperCase()));
    if (novos.length) {
      // Empresa (loteadora/construtora, matrícula-mãe) ≠ pessoa (Fabio 27/10, Diego: a IA perguntou se a "JARDIM DO MARQUES EMPREENDIMENTOS LTDA" era pai/mãe dele).
      const pessoas = novos.filter((d) => !d.empresa), empresas = novos.filter((d) => d.empresa);
      const docNome = (tipo: string) => /^IPTU|IPTU$|CADASTRO/.test(tipo) ? 'esse IPTU' : /^ESCRITURA/.test(tipo) ? 'essa escritura' : 'essa matrícula';
      const partes = [
        pessoas.length && `Vi na matrícula que o imóvel está no nome de ${pessoas.map((d) => `*${d.dono}*`).join(' e ')}. Quem é essa pessoa pra você (pai, mãe, cônjuge, filho…)? Preciso saber pra seguir com a documentação. 🙏`,
        empresas.length && `Vi que ${docNome(empresas[0].doc)} ainda está no nome da empresa ${empresas.map((d) => `*${d.dono}*`).join(' e ')}, e não no seu. Você tem a matrícula individual do seu imóvel, já no seu nome? 🙏`,
      ].filter(Boolean) as string[];
      const texto = partes.join('\n\n');
      const sent = lead.aiAutoReplyActive ? await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined }) : { success: false, error: 'IA desligada no card' };
      await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cfd, _donoAskedFor: [...ja, ...novos.map((d) => d.dono.toUpperCase())], _donoAskedAt: new Date().toISOString(), _donoResolvedAt: null } as any } });
      if (pessoas.length) await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏠 O imóvel está em nome de ${pessoas.map((d) => d.dono).join(' e ')}, que não é participante. ${sent.success ? 'Perguntei ao cliente quem é essa pessoa pra ele (precisa ser parente de 1º grau ou participante); o card espera a resposta.' : lead.aiAutoReplyActive ? 'A pergunta ao cliente não saiu — pergunte de quem é o imóvel.' : 'IA desligada: pergunte ao cliente de quem é o imóvel (precisa ser parente de 1º grau ou participante).'}` } }).catch(() => {});
      if (empresas.length) await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏢 O documento do imóvel está no nome da EMPRESA ${empresas.map((d) => d.dono).join(' e ')} (pessoa jurídica — em geral a loteadora/construtora, venda ainda não registrada, ou a matrícula-mãe do empreendimento). ${sent.success ? 'Perguntei ao cliente se ele tem a matrícula individual já no nome dele; o card espera. Se ele disser que o imóvel ainda não está no nome dele ou que a empresa é dele, a pergunta vai pro balão Dúvidas da IA.' : lead.aiAutoReplyActive ? 'A pergunta ao cliente não saiu — pergunte se ele tem a matrícula individual no nome dele.' : 'IA desligada: pergunte ao cliente se ele tem a matrícula individual no nome dele.'}` } }).catch(() => {});
    }
    return true; // card espera o dono do imóvel ser esclarecido (a pergunta ao cliente já foi feita)
  }
  if ((lead.customFields as any)?._donoAskedAt && !(lead.customFields as any)?._donoResolvedAt) {
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _donoResolvedAt: new Date().toISOString() } as any } });
  }

  // Imóvel com financiamento ativo (gravame vigente na matrícula + proposta com saldo): pede o print do saldo devedor (1 vez). Se pediu, o "recebi tudo" vai junto nessa mensagem.
  const pediuSaldo = await (require('./saldo-devedor.service') as typeof import('./saldo-devedor.service')).maybeAskSaldoDevedor(accountId, leadId, io, { docsReceived: true }).catch((e: any) => { console.error('[Saldo] pedido:', e?.message || e); return false; });

  // Sem matrícula e sem cartório nos documentos: o CRM acha o cartório pelo endereço (Mapa do ONR) e grava no card (Fabio 29/10).
  void (require('./cartorio-regiao.service') as typeof import('./cartorio-regiao.service')).ensureCartorioPorEndereco(accountId, leadId);

  const verdict = await evaluateDocs(accountId, leadId);
  // Certidão pelo ONR: autorizada → aciona a extensão (cria o pedido, 1 vez por matrícula); só escritura e ainda sem OK → a IA oferece (1 vez por matrícula).
  if (verdict) {
    const offer = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
    if (verdict.emitir.length) await offer.ensureCertidaoRequest(accountId, leadId).catch((e: any) => console.error('[Certidão] pedido ONR:', e?.message || e));
    else if (verdict.emitirPendente.length) await offer.maybeOfferCertidao(accountId, leadId, io).catch((e: any) => console.error('[Certidão] oferta:', e?.message || e));
  }
  const faltando = verdict && !verdict.complete ? verdict.faltando : [];
  const faltaTxt = faltando.length ? `\n\nAinda falta mandar:\n${faltando.map((f) => `• ${f}`).join('\n')}` : '';

  if (review?.problemas.length) {
    // Um aviso só, e CADA problema é dito UMA vez (Fabio 21/10, Luiz: a IA repetiu "me mande a matrícula e a capa do IPTU" 3 vezes — texto velho de um documento que não serve — depois de ele já ter mandado). O que já foi dito
    // não volta; o card continua parado esperando o cliente (ou o que ainda falta é cobrado pelo caminho normal abaixo).
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const cf = (fresh?.customFields || {}) as Record<string, any>;
    const chave = (p: { doc: string; texto: string[] }) => `${p.doc}:${p.texto.join('/')}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ');
    const ditos = new Set<string>(Array.isArray(cf._docProblemsTold) ? cf._docProblemsTold : []);
    const novos = review.problemas.filter((p) => !ditos.has(chave(p)));
    if (novos.length || opts.force) {
      const alvo = novos.length ? novos : review.problemas;
      await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _docProblemsTold: Array.from(new Set([...ditos, ...alvo.map(chave)])) } as any } });
      const texto = `${buildDocProblemsMessage({ ...review, problemas: alvo }).replace(/\n\nAssim que você reenviar, eu confiro de novo!$/, '')}${faltaTxt}\n\nAssim que você mandar, eu confiro de novo!`;
      const sent = lead.aiAutoReplyActive ? await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined }) : { success: false, error: 'IA desligada no card' };
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 A IA achou problema em documento: ${alvo.map((p) => `${p.doc} — ${p.texto.join('; ')}`).join(' | ')}.${faltando.length ? ` Ainda falta: ${faltando.join('; ')}.` : ''} ${sent.success ? 'Cliente avisado do que corrigir.' : lead.aiAutoReplyActive ? 'O aviso ao cliente não saiu.' : 'IA desligada: avise o cliente.'}` } }).catch(() => {});
    }
    return !!lead.aiAutoReplyActive;
  }

  if (!verdict) return false;
  const { receivedText } = verdict;
  if (!verdict.complete) {
    console.log(`[Docs] ${lead.name} (${leadId}): ainda falta — ${verdict.faltando.join('; ') || 'sem detalhe'}`);
    let falouFalta = false;
    if (verdict.faltando.length) {
      const resumo = verdict.faltando.join('; ');
      const cf = (lead.customFields || {}) as Record<string, unknown>;
      if (cf._docsFaltando !== resumo || opts.force) {
        await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _docsFaltando: resumo } as any } });
        // IA ligada: cobra o que falta (uma vez por lista); desligada: quem conversa é a equipe — só nota no card.
        let cobrou = false;
        if (lead.aiAutoReplyActive) {
          // Fabio 15/10: não lista o que chegou — só o que falta (depois da espera de 10 min sem arquivo novo).
          const texto = `Pra fechar a documentação ainda falta:${faltaTxt.replace(/^\n\nAinda falta mandar:/, '')}\n\nPode mandar por aqui mesmo que eu confiro!`;
          const sent = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined });
          cobrou = !!sent.success;
          falouFalta = cobrou;
        }
        await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 A IA conferiu os documentos recebidos (lista "${verdict.listaUsada || '?'}"). Ainda falta:\n- ${verdict.faltando.join('\n- ')}\n${cobrou ? 'Cliente avisado do que falta.' : lead.aiAutoReplyActive ? 'O aviso ao cliente não saiu.' : 'IA desligada: cobre o cliente.'}` } }).catch(() => {});
      }
    }
    return falouFalta;
  }

  // Financiamento Habitacional só com a documentação do COMPRADOR (CAIXA/BRB ou sem banco escolhido): ainda não é contratação — é a vez da análise da CAIXA/BRB.
  // O card fica onde está; o cliente é avisado e a equipe roda a análise (Fabio 29/10, Taynara).
  if (fhSoComprador) {
    if (cfLead._fhDocsCompradorAt) return false;
    const banco = cfLead._optouCaixa?.banco || 'CAIXA';
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cfLead, _fhDocsCompradorAt: new Date().toISOString() } as any } });
    const sentFh = lead.aiAutoReplyActive
      ? await sendOutboundWhatsApp({ accountId, leadId, content: `Recebi toda a documentação, obrigada! Já vou dar entrada na análise da ${banco} e te aviso por aqui assim que sair o resultado.`, io: io || undefined })
      : { success: false };
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 Documentação do comprador COMPLETA (Financiamento Habitacional — ${banco}):\n${verdict.receivedText}\n\n👉 Rodar a análise na ${banco} com esses documentos.${sentFh.success ? ' Cliente avisado.' : ' Cliente NÃO avisado (IA desligada).'}` } }).catch(() => {});
    (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `🏦 ${lead.name}: documentação completa`, body: `Rodar a análise na ${banco}`, leadId }).catch(() => {});
    return true;
  }
  const moved = await moveLeadToContracting(accountId, leadId, io, 'a IA conferiu que a documentação chegou completa');
  if (!moved) {
    console.warn(`[Docs] ${lead.name} (${leadId}): documentação completa, mas o funil de contratação do setor não foi encontrado`);
    return false;
  }
  // Com a IA desligada a equipe está conversando com o cliente — não manda
  // o aviso automático por cima dela.
  // Matrícula/ônus aceita COM RESSALVA (só consulta ou antiga): a A&F aceita, mas deixa a observação ao cliente (Fabio 15/10) — o banco decide e pode pedir uma nova.
  const freshR = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cfR = (freshR?.customFields || {}) as Record<string, any>;
  const ressalvas = Object.values((cfR._docReview || {}) as Record<string, any>).map((r: any) => r?.ressalva).filter(Boolean) as string[];
  const obsCertidao = ressalvas.length && !cfR._ressalvaCertidaoAt
    ? `\n\nSobre a matrícula/certidão do imóvel que você enviou: ela veio ${ressalvas.includes('CONSULTA') ? 'como "consulta" (não é a certidão oficial)' : 'com mais de 30 dias'}. A gente aceita, mas quem decide é o banco: se ele não aceitar essa versão, a gente emite uma nova pra você pelo cartório digital. Se isso acontecer, eu te aviso. 🙂`
    : '';
  if (obsCertidao) await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cfR, _ressalvaCertidaoAt: new Date().toISOString() } as any } });
  // Mais de um banco aprovado e nenhuma proposta escolhida: o "recebi tudo" vai junto da pergunta de com qual proposta seguir (Fabio 28/10).
  const perguntouEscolha = !pediuSaldo && lead.aiAutoReplyActive
    ? await (require('./approval-notice.service') as typeof import('./approval-notice.service')).askProposalChoice(accountId, leadId, io, `Recebi toda a documentação, obrigada!${obsCertidao ? obsCertidao.replace(/^\n\n/, ' ') : ''}`).catch((e: any) => { console.error('[Docs] escolha da proposta:', e?.message); return false; })
    : false;
  const sent = pediuSaldo || perguntouEscolha
    ? { success: true } // a mensagem do saldo devedor (ou a da escolha da proposta) já disse que a documentação chegou
    : lead.aiAutoReplyActive
    ? await sendOutboundWhatsApp({ accountId, leadId, content: `${DOCS_COMPLETE_MESSAGE}${obsCertidao}`, io: io || undefined })
    : { success: false, error: 'IA desligada no card (a equipe avisa o cliente)' };
  if (!sent.success && lead.aiAutoReplyActive) console.error(`[Docs] ${lead.name}: aviso ao cliente não foi enviado:`, sent.error);

  await prisma.note.create({
    data: {
      leadId,
      type: 'COMMENT',
      content: [
        `🤖 A IA conferiu a documentação (lista "${verdict.listaUsada || '?'}") e considerou completa:`,
        receivedText,
        '',
        ...(verdict.emitir.length ? ['', `⚠️ A&F precisa EMITIR (o cliente autorizou; custo de R$ 40 a R$ 100 pra ele): ${verdict.emitir.join('; ')} — pelo endereço completo com CEP (conferir com o da proposta) ou pelo número da matrícula.`] : []),
        '',
        `Card movido para "${moved.pipelineName}" (${moved.stageName}).${sent.success ? ' Cliente avisado de que o banco pode pedir algum documento a mais.' : lead.aiAutoReplyActive ? '' : ' Cliente NÃO foi avisado automaticamente (IA desligada no card) — avise pela conversa.'}`,
      ].join('\n'),
    },
  });
  logActivity({
    accountId, userId: null, userName: 'Assistente IA', action: 'lead_stage_changed', leadId, leadName: lead.name,
    summary: `conferiu a documentação completa e moveu pra "${moved.stageName}" (${moved.pipelineName})`,
  });
  console.log(`[Docs] ${lead.name} (${leadId}): documentação completa → ${moved.pipelineName} / ${moved.stageName}`);
  return true;
}


// ─── "Conferir documentos" (botão do card, Fabio 28/10) ───────────────────────────────────────────────────────────────────────────────────
// A conferência automática só roda em "Aguardando Documentação" e só quando chega arquivo novo: o Alexandre mandou 12 arquivos em 14/10 que nunca foram lidos, e o
// Wagner foi movido pra contratação com a lista velha do que faltava. O botão roda a MESMA leitura e conferência no servidor, em QUALQUER etapa, SEM mensagem ao cliente
// e SEM mover o card: o resultado vira anotação no card (e atualiza o "o que falta" que a IA da conversa usa). Roda em segundo plano (12 PDFs levam minutos).
const conferindoAgora = new Set<string>();
export const conferenciaEmAndamento = (leadId: string) => conferindoAgora.has(leadId);

export async function conferirDocumentosAgora(accountId: string, leadId: string, userName: string, io?: Io): Promise<{ completo: boolean; faltando: string[] } | null> {
  if (conferindoAgora.has(leadId)) return null;
  conferindoAgora.add(leadId);
  try {
    const review = await reviewReceivedDocs(accountId, leadId).catch((e) => { console.error(`[Docs] botão — leitura falhou (${leadId}):`, e?.message || e); return null; });
    const verdict = await evaluateDocs(accountId, leadId).catch((e) => { console.error(`[Docs] botão — conferência falhou (${leadId}):`, e?.message || e); return null; });
    // Arquivos que continuam sem leitura (protegido, grande demais, erro): ficam listados pra alguém olhar.
    const atts = (await prisma.messageAttachment.findMany({ where: { leadId, message: { direction: 'INBOUND' } }, select: { id: true, fileName: true, mimeType: true, driveFileId: true, data: true } }))
      .filter((a) => !/^(audio|video)\//.test(a.mimeType) && !isStickerAttachment(a) && !isScreenshotAttachment(a));
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
    const naoLidos = atts.filter((a) => !(cf._docInfo || {})[a.id]).map((a) => a.fileName || a.id);
    const quem = userName ? `, por ${userName}` : '';
    if (!verdict) {
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📄 Conferência de documentos (botão${quem}): ${atts.length ? 'não consegui conferir — nenhum arquivo foi lido ou não há lista "Documentos …" pro setor do card.' : 'o cliente não mandou nenhum arquivo.'}${naoLidos.length ? `\nSem leitura: ${naoLidos.join('; ')}` : ''}` } }).catch(() => {});
      return null;
    }
    if (verdict.complete) delete cf._docsFaltando;
    else if (verdict.faltando.length) cf._docsFaltando = verdict.faltando.join('; ');
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
    const problemas = (review?.problemas || []).map((p) => `${p.doc} — ${p.texto.join('; ')}`);
    const duvidas = (review?.duvidas || []).map((d) => `${d.doc} (${d.arquivo})`);
    await prisma.note.create({
      data: {
        leadId, type: 'COMMENT',
        content: [
          `📄 Conferência de documentos (botão${quem}) — lista "${verdict.listaUsada || '?'}": ${verdict.complete && !problemas.length ? 'COMPLETA ✅' : verdict.complete ? 'chegou tudo, mas tem documento com problema ⚠️' : 'INCOMPLETA'}`,
          `Recebido:\n${verdict.receivedText}`,
          ...(verdict.faltando.length ? [`Falta:\n- ${verdict.faltando.join('\n- ')}`] : []),
          ...(problemas.length ? [`Com problema:\n- ${problemas.join('\n- ')}`] : []),
          ...(duvidas.length ? [`Em dúvida (balão Dúvidas da IA): ${duvidas.join('; ')}`] : []),
          ...(verdict.emitir.length ? [`A&F precisa emitir: ${verdict.emitir.join('; ')}`] : []),
          ...(naoLidos.length ? [`Sem leitura (confira à mão): ${naoLidos.join('; ')}`] : []),
          'Nenhuma mensagem foi enviada ao cliente e o card não foi movido.',
        ].join('\n\n'),
      },
    }).catch(() => {});
    if (io) io.to(`lead:${leadId}`).emit('lead_updated', { leadId });
    return { completo: verdict.complete, faltando: verdict.faltando };
  } finally {
    conferindoAgora.delete(leadId);
  }
}

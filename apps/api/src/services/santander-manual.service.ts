import { prisma } from '../lib/prisma';

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

/**
 * SANTANDER EM ANÁLISE MANUAL (Fabio 13/11, Claudemir: "SOLICITA A LISTA DE DOCUMENTOS PARA O CLIENTE E QUANDO ELE ENCAMINHAR TUDO, ENCAMINHA TODOS OS DOCUMENTOS PARA A
 * LETICIA PEDINDO PARA QUE ELA ATUE NO PROCESSO"). A proposta não passou na análise automática do Santander e o portal liberou a análise manual (o fluxo que detecta isso é o
 * `santanderManualFlow`, em credit-analysis.service). Aqui:
 *  1) PEDIDO AO CLIENTE: com a conversa aberta, manda a lista de documentos; com a janela de 24 h FECHADA, manda o template de atualização da área do card e guarda o pedido
 *     pra sair quando ele responder (reply-pending) — antes ficava só uma nota "chame o cliente" e ninguém chamava (Claudemir, 10/11 → 13/11);
 *  2) ENCAMINHAMENTO À LETÍCIA: quando o cliente manda tudo o que o Santander pediu (conferido pela classificação dos arquivos, `_docInfo`), 10 min depois do último arquivo,
 *     o CRM manda e-mail à Letícia (Credimorar) com TODOS os documentos do cliente anexados, o nº da proposta e o pedido pra ela atuar no processo. Uma vez por proposta.
 * Estado em customFields._santanderManual (gravado só nessa chave, por SQL).
 */

export type SantManual = {
  proposta?: string; teamAt?: string; askedAt?: string; heldNoteFor?: string; itens?: string[]; via?: 'texto' | 'template';
  /** Financiamento (CREDIMORAR_FH, Fabio 14/11: mesmo fluxo do HE, agora também com o Bradesco): produto e banco(s) em análise manual. Sem isso = Home Equity, Santander. */
  produto?: 'FH'; banco?: string;
  /** Lembrete da janela de 24 h (Fabio 14/11): a última mensagem do cliente (ISO) em cuja janela o CRM já perguntou "até quando manda" — uma vez por janela. */
  janela?: string;
  templateFalhou?: string; forwardedAt?: string; forwardDe?: string; forwardFalhou?: string; forwardSkip?: string; incompletoSig?: string; confiraNoteAt?: string;
  /** Documentação completa (Fabio 14/11, Lucas): com a IA ligada o envio pelo portal sai sozinho; com ela desligada fica o botão "Enviar documentos" no card. */
  prontoAt?: string;
  /** Envio da análise manual pelo PORTAL do Credimorar (a extensão anexa os documentos, escreve o comentário de defesa e clica em "Enviar"). */
  portal?: PortalEnvio;
};
export type PortalEnvio = { status: 'FILA' | 'RODANDO' | 'OK' | 'ERRO'; pedidoEm: string; por: string; inicio?: string; fim?: string; erro?: string; enviados?: string[]; comentario?: string; docIds?: string[]; avisoFila?: string };

const ESPERA_ULTIMO_ARQUIVO_MS = 10 * 60_000; // o cliente costuma mandar os arquivos em sequência
const ESPERA_CLASSIFICAR_MS = 6 * 3600_000; // arquivo que a leitura não classificou em 6 h: não segura mais o pedido de conferência à equipe
const RELAXA_QTD_MS = 24 * 3600_000; // "3 últimos holerites" num PDF só: depois de 24 h sem arquivo novo, 1 contracheque basta
const PEDIDO_PENDENTE_MAX_MS = 15 * 86_400_000;
const MAX_ANEXOS_POR_EMAIL = 10; // limites do sendEmailFrom (10 anexos, 15 MB)
const MAX_BYTES_POR_EMAIL = 14 * 1024 * 1024;
const MAX_EMAILS = 3;

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});

/** Grava só as chaves de `_santanderManual` (nunca o card inteiro — customfields-write-race). */
async function salvar(leadId: string, patch: Partial<SantManual>): Promise<void> {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_santanderManual}', COALESCE("customFields"->'_santanderManual', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, true) WHERE id = ${leadId}`;
}

/** Push ao colaborador responsável pelo card; sem aparelho cadastrado, vai pra equipe toda. */
async function pushDono(accountId: string, leadId: string, title: string, body: string): Promise<void> {
  try {
    const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { userId: true } });
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    const tem = l?.userId ? await prisma.pushSubscription.count({ where: { userId: l.userId } }) : 0;
    sendPushToAccount(accountId, { title, body, leadId }, tem && l?.userId ? [l.userId] : undefined).catch(() => {});
  } catch { /* aviso */ }
}

const ITENS_PADRAO = ['Os documentos de comprovação de renda'];
const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
/** FGTS e CTPS NÃO entram na análise manual do Santander (Fabio 14/11, Lucas: "FGTS NÃO PRECISA SER SOLICITADO, SEMPRE QUE HOUVER ANÁLISE MANUAL NO SANTANDER SERÃO OS
 *  DOCUMENTOS MENOS O FGTS, CTPS TAMBÉM NÃO PRECISA") — nem no pedido ao cliente, nem na conferência, nem no e-mail. Pura. */
const FORA_DO_SANTANDER = /\bFGTS\b|\bCTPS\b|CARTEIRA DE TRABALHO/;
export const semFgtsCtps = (itens: string[]): string[] => itens.filter((i) => !FORA_DO_SANTANDER.test(norm(i)));
/** "Santander" / "Bradesco (Financiamento)" — rótulo das notas. */
const rotulo = (s: { banco?: string; produto?: string }) => `${s.banco || 'Santander'}${s.produto === 'FH' ? ' (Financiamento)' : ''}`;
const bankDe = (s: { produto?: string }) => (s.produto === 'FH' ? 'CREDIMORAR_FH' : 'CREDIMORAR');

/** Financiamento sem a lista do portal: a RENDA do perfil do comprador, das Respostas rápidas "Documentos comprador …" (a equipe edita lá) — "💼 Renda: 3 últimos contracheques,
 *  IR + recibo (se houver), CTPS digital, …" vira um item por documento. Sem a resposta rápida, a lista genérica. */
export async function itensRendaPerfilFh(accountId: string, cf: Record<string, any>): Promise<string[]> {
  try {
    const { perfilTemplate } = require('./fh-approval.service') as typeof import('./fh-approval.service');
    const t = await prisma.messageTemplate.findFirst({ where: { accountId, name: { equals: perfilTemplate(cf), mode: 'insensitive' } }, select: { body: true } });
    const linha = (String(t?.body || '').split('\n').find((l) => /renda/i.test(l)) || '').replace(/^[^A-Za-zÀ-ú0-9]*renda[^:]*:\s*/i, '').trim();
    const itens = semFgtsCtps(linha.split(/\s*,\s*|\s+e\s+(?=[A-ZÀ-Ú0-9])/).map((x) => x.replace(/\.$/, '').trim()).filter((x) => x.length > 1));
    return itens.length ? itens : ITENS_PADRAO;
  } catch { return ITENS_PADRAO; }
}

/** 1) Pede os documentos ao cliente. Devolve como saiu ('texto' | 'template'), 'nota' (segurado, só a nota pra equipe) ou null (nada a fazer / falhou). */
export async function pedirDocumentosSantanderManual(p: { accountId: string; leadId: string; numero: string; itens: string[]; io?: Io; produto?: 'FH'; banco?: string }): Promise<'texto' | 'template' | 'nota' | null> {
  const lead = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { id: true, name: true, status: true, aiAutoReplyActive: true, customFields: true } });
  if (!lead || lead.status !== 'OPEN') return null;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const st = (cf._santanderManual || {}) as SantManual;
  if (st.proposta === p.numero && st.askedAt) return null; // já pedi os documentos desta proposta
  const itens = semFgtsCtps(p.itens).length ? semFgtsCtps(p.itens) : ITENS_PADRAO;
  const extra: Partial<SantManual> = p.produto ? { produto: p.produto, banco: p.banco } : {};
  const rot = rotulo(p.produto ? p : st);
  const { santanderManualClientText: textoBase } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const santanderManualClientText = (n: string | null, saudar: boolean, its: string[]) => textoBase(n, saudar, its, { banco: p.banco || st.banco, fh: (p.produto || st.produto) === 'FH' });
  const { inNoticeWindow, whatsappWindowOpen, conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name) || null;
  // Só com a IA do card ligada, sem STOP TOTAL e dentro das 07h–21h; senão fica o texto pronto na nota (uma vez por proposta).
  const motivo = cf._autoPaused ? 'o card está em STOP TOTAL' : !lead.aiAutoReplyActive ? 'a IA deste card está desligada' : !inNoticeWindow() ? 'fora do horário dos avisos (07h–21h)' : '';
  if (motivo) {
    if (st.heldNoteFor !== p.numero) {
      const texto = santanderManualClientText(nome, true, itens);
      await note(lead.id, `⏳ ${rot} (análise manual): NÃO pedi os documentos ao cliente agora — ${motivo}. ${motivo.includes('IA') || motivo.includes('STOP') ? 'Chame o cliente e mande:' : 'Tento de novo dentro do horário; se preferir, mande você:'}\n\n${texto}`);
      await salvar(lead.id, { ...extra, proposta: p.numero, heldNoteFor: p.numero });
    }
    return 'nota';
  }
  const msg = require('./message.service') as typeof import('./message.service');
  if (await whatsappWindowOpen(lead.id)) {
    const texto = santanderManualClientText(nome, !(await conversationActive(lead.id)), itens);
    const r = await msg.sendOutboundWhatsApp({ accountId: p.accountId, leadId: lead.id, content: texto, io: p.io as any });
    if (!r.success) { console.warn(`[Santander manual] ${lead.name}: pedido de documentos não saiu — ${(r as any).error}`); return null; }
    await salvar(lead.id, { ...extra, proposta: p.numero, askedAt: new Date().toISOString(), itens, via: 'texto' });
    await note(lead.id, `📨 ${rot} (análise manual): pedi os documentos ao cliente explicando que a proposta não passou na análise automática. Pedido: ${itens.join('; ')}. Quando ele mandar tudo, encaminho à Letícia (Credimorar) pra ela atuar no processo.`);
    return 'texto';
  }
  // Janela de 24 h fechada (Fabio 13/11, Claudemir): template de atualização da área do card + o pedido guardado pra sair quando ele responder.
  if (st.proposta === p.numero && st.templateFalhou) return null; // já falhou uma vez: a equipe foi avisada, não insiste em laço
  const { templateAtualizacaoDoLead } = require('./template-atualizacao') as typeof import('./template-atualizacao');
  const t = await msg.sendOutboundWhatsAppTemplate({ accountId: p.accountId, leadId: lead.id, ...(await templateAtualizacaoDoLead(lead.id, nome || 'cliente')), io: p.io });
  if (!t.success) {
    await salvar(lead.id, { ...extra, proposta: p.numero, templateFalhou: new Date().toISOString() });
    await note(lead.id, `⚠️ ${rot} (análise manual): a conversa está fechada e o template de atualização não saiu (${t.error}). Chame o cliente e mande:\n\n${santanderManualClientText(nome, true, itens)}`);
    await pushDono(p.accountId, lead.id, `⚠️ ${rot}: pedido de documentos não saiu`, `${lead.name}: a conversa está fechada e o template falhou — chame o cliente`);
    return null;
  }
  const { queueOnReply } = require('./reply-pending.service') as typeof import('./reply-pending.service');
  await queueOnReply(prisma as any, {
    leadId: lead.id, label: `santander manual ${p.numero}`, text: santanderManualClientText(nome, true, itens),
    noteText: `📨 ${rot} (análise manual): a conversa estava fechada — mandei o template de atualização. O pedido dos documentos (${itens.join('; ')}) sai quando o cliente responder; quando ele mandar tudo, encaminho à Letícia.`,
  });
  await salvar(lead.id, { ...extra, proposta: p.numero, askedAt: new Date().toISOString(), itens, via: 'template' });
  return 'template';
}

const RENDA = /^(CONTRACHEQUE|IMPOSTO DE RENDA|RECIBO IMPOSTO DE RENDA|EXTRATO BANCARIO|HISTORICO INSS|DECORE|PGDAS|DEFIS|CTPS)\b/;
/** O que ainda falta do que o Santander pediu, pelos TIPOS dos arquivos do cliente (classificação "TIPO|TITULAR"). `relaxar`: "3 últimos holerites" aceita 1 arquivo
 *  (vários meses num PDF só). Item que não dá pra conferir pelo tipo (ou opcional) vai em `naoConferidos` e não segura. Pura (testável). */
export function faltandoParaSantanderManual(itens: string[], tipos: string[], relaxar = false): { faltando: string[]; naoConferidos: string[] } {
  const t = tipos.map(norm);
  const conta = (rx: RegExp) => t.filter((x) => rx.test(x)).length;
  const faltando: string[] = [], naoConferidos: string[] = [];
  for (const item of itens.length ? itens : ITENS_PADRAO) {
    const n = norm(item);
    if (/OPCIONAL|DEMAIS DOCUMENTOS/.test(n) || FORA_DO_SANTANDER.test(n)) continue; // FGTS/CTPS: o Santander não pede (Fabio 14/11)
    let ok: boolean | null = null;
    if (/HOLERITE|CONTRACHEQUE/.test(n)) ok = conta(/^CONTRACHEQUE\b/) >= (relaxar ? 1 : /\b3\b|TRES|ULTIMOS/.test(n) ? 3 : 1);
    else if (/IRPF|IMPOSTO DE RENDA|\bIR\b/.test(n) && /EXTRATO/.test(n)) ok = conta(/^(RECIBO )?IMPOSTO DE RENDA\b/) >= 1 && conta(/^EXTRATO BANCARIO\b/) >= 1;
    else if (/IRPF|IMPOSTO DE RENDA|\bIR\b/.test(n)) ok = conta(/^(RECIBO )?IMPOSTO DE RENDA\b/) >= 1;
    else if (/EXTRATO/.test(n)) ok = conta(/^EXTRATO BANCARIO\b/) >= 1;
    else if (/RENDA/.test(n)) ok = conta(RENDA) >= 1;
    else if (/IDENTIDADE|\bRG\b|\bCNH\b/.test(n)) ok = conta(/^(RG|CNH)\b/) >= 1;
    else if (/RESIDENCIA/.test(n)) ok = conta(/^COMPROVANTE DE RESIDENCIA\b/) >= 1;
    else if (/MATRICULA|ONUS/.test(n)) ok = conta(/^(CERTIDAO DE ONUS|MATRICULA DO IMOVEL)\b/) >= 1;
    else if (/IPTU/.test(n)) ok = conta(/^(CND IPTU|CAPA IPTU|GUIA IPTU|CERTIDAO DE CADASTRO IMOBILIARIO)\b/) >= 1;
    else if (/CASAMENTO|NASCIMENTO|ESTADO CIVIL/.test(n)) ok = conta(/^CERTIDAO DE (CASAMENTO|NASCIMENTO|OBITO|UNIAO)\b/) >= 1;
    if (ok === null) naoConferidos.push(item);
    else if (!ok && /SE HOUVER|SE TIVER|SE USAR/.test(n)) naoConferidos.push(item); // "IR + recibo (se houver)": não segura o envio
    else if (!ok) faltando.push(item);
  }
  return { faltando, naoConferidos };
}

type Anexo = { id: string; fileName: string; mimeType: string; createdAt: Date; driveFileId: string | null; data: Uint8Array | null };
const filtroArquivo = (a: { mimeType: string; fileName?: string | null }) => !/^(audio|video)\//.test(a.mimeType);

/** Tick (a cada 5 min): pedidos segurados (fora do horário / janela fechada de antes desta regra) e encaminhamento à Letícia. */
export async function processSantanderManual(io?: Io): Promise<void> {
  const { inNoticeWindow } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  // 1) Pedido segurado (nota "chame o cliente" sem pedido) com o card ainda na Pré-Análise e a análise manual de até 15 dias: pede agora (Claudemir, 10/11).
  if (inNoticeWindow()) {
    const pend = await prisma.$queryRaw<{ id: string; accountId: string }[]>`SELECT id, "accountId" FROM "Lead" WHERE status = 'OPEN' AND archived = false AND "customFields"->'_santanderManual'->>'heldNoteFor' IS NOT NULL AND "customFields"->'_santanderManual'->>'askedAt' IS NULL AND "customFields"->'_santanderManual'->>'templateFalhou' IS NULL AND COALESCE(("customFields"->>'_autoPaused'), '') = ''`;
    for (const l of pend) {
      try {
        const lead = await prisma.lead.findUnique({ where: { id: l.id }, select: { customFields: true, aiAutoReplyActive: true, stage: { select: { name: true } } } });
        const cf = (lead?.customFields || {}) as Record<string, any>;
        const st = (cf._santanderManual || {}) as SantManual;
        if (!lead || !lead.aiAutoReplyActive || !/^pr[eé]-an/i.test(lead.stage?.name || '') || !st.heldNoteFor) continue;
        if (st.teamAt && Date.now() - Date.parse(st.teamAt) > PEDIDO_PENDENTE_MAX_MS) continue;
        // A proposta ainda está em análise manual (nada decidido depois)?
        const { parseDocumentosExigidos, docDoPortal, parseBancosFinanciamento } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
        if (st.produto === 'FH') {
          // Financiamento: a situação do banco na lista do Credimorar (_fhResumo) ainda é "Enviar Documentos"?
          const bancos = String(st.banco || 'Santander').split(' e ');
          if (!bancos.some((b) => /enviar documentos/i.test(parseBancosFinanciamento(cf._fhResumo)[b]?.status || ''))) continue;
          const lida = await prisma.creditAnalysis.findFirst({ where: { leadId: l.id, bank: 'CREDIMORAR_FH', dryRun: false, detail: { contains: 'MANUAL ABERTA' } }, orderBy: { createdAt: 'desc' }, select: { detail: true } });
          let itens = (parseDocumentosExigidos(lida?.detail)?.itens || []).map(docDoPortal);
          if (!itens.length) itens = await itensRendaPerfilFh(l.accountId, cf);
          await pedirDocumentosSantanderManual({ accountId: l.accountId, leadId: l.id, numero: st.heldNoteFor, itens, io, produto: 'FH', banco: st.banco });
          continue;
        }
        const ult = await prisma.creditAnalysis.findFirst({ where: { leadId: l.id, bank: 'CREDIMORAR', dryRun: false }, orderBy: { createdAt: 'desc' }, select: { status: true, detail: true, proposalNumber: true } });
        if (!ult || ['APPROVED', 'CONDITIONAL', 'REJECTED'].includes(ult.status) || !/AN[ÁA]LISE MANUAL ABERTA/i.test(ult.detail || '')) continue;
        const itens = (parseDocumentosExigidos(ult.detail)?.itens || []).map(docDoPortal);
        await pedirDocumentosSantanderManual({ accountId: l.accountId, leadId: l.id, numero: st.heldNoteFor, itens, io });
      } catch (e: any) { console.error('[Santander manual] pedido segurado:', e?.message || e); }
    }
  }
  // Envio pelo portal sem retorno da extensão (fora do horário também).
  await envioPortalParado().catch((e: any) => console.error('[Santander manual] portal parado:', e?.message || e));
  // 2) Documentação completa → envio pelo portal (no horário comercial dos avisos).
  if (!inNoticeWindow()) return;
  const ids = await prisma.$queryRaw<{ id: string; accountId: string }[]>`SELECT id, "accountId" FROM "Lead" WHERE status = 'OPEN' AND archived = false AND "customFields"->'_santanderManual'->>'askedAt' IS NOT NULL AND "customFields"->'_santanderManual'->>'prontoAt' IS NULL AND "customFields"->'_santanderManual'->'portal' IS NULL AND "customFields"->'_santanderManual'->>'forwardedAt' IS NULL AND "customFields"->'_santanderManual'->>'forwardFalhou' IS NULL AND "customFields"->'_santanderManual'->>'forwardSkip' IS NULL`;
  for (const l of ids) await encaminharSeCompleto(l.accountId, l.id, io).catch((e: any) => console.error('[Santander manual] encaminhar:', e?.message || e));
  // 3) Lembrete antes de a janela de 24 h fechar, com o pedido ainda em aberto (Fabio 14/11).
  for (const l of ids) await janelaSantanderManual(l.accountId, l.id, io).catch((e: any) => console.error('[Santander manual] janela:', e?.message || e));
  // 4) Documentação completa esperando o botão e a IA do card foi ligada depois: o envio sai sozinho (Fabio 14/11: "SE A IA ESTIVER LIGADA VAI SOZINHO").
  const prontos = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE status = 'OPEN' AND archived = false AND "aiAutoReplyActive" = true AND COALESCE(("customFields"->>'_autoPaused'), '') = '' AND "customFields"->'_santanderManual'->>'prontoAt' IS NOT NULL AND "customFields"->'_santanderManual'->'portal' IS NULL AND "customFields"->'_santanderManual'->>'forwardSkip' IS NULL`;
  for (const l of prontos) await pedirEnvioPortal(l.id, 'automático (IA ligada)').catch((e: any) => console.error('[Santander manual] envio automático:', e?.message || e));
}

/** Itens que o banco pediu: os gravados no pedido; pedido antigo (sem `itens`, ex.: jorge 13/11) → a leitura do portal ("ANÁLISE MANUAL ABERTA … DOCUMENTOS"); sem nada, a lista genérica. */
async function itensDoPedido(accountId: string, leadId: string, cf: Record<string, any>, st: SantManual): Promise<string[]> {
  if (semFgtsCtps(st.itens || []).length) return semFgtsCtps(st.itens || []);
  const lida = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: bankDe(st), dryRun: false, detail: { contains: 'MANUAL ABERTA' } }, orderBy: { createdAt: 'desc' }, select: { detail: true } });
  const { parseDocumentosExigidos, docDoPortal } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const itens = semFgtsCtps((parseDocumentosExigidos(lida?.detail)?.itens || []).map(docDoPortal));
  if (itens.length) return itens;
  return st.produto === 'FH' ? itensRendaPerfilFh(accountId, cf) : ITENS_PADRAO;
}

/** 3) JANELA DE 24 H FECHANDO com o pedido do banco em aberto (Fabio 14/11, jorge: "sempre que pedir documentos para encaminhar à Letícia, veja se já não tem a regra de solicitar
 *  novamente antes da janela fechar"). O lembrete da documentação (docs-loop, processJanelaDocs) só olha "Aguardando Documentação" e a lista do HE — o Claudemir (Pré-Análise) ficava
 *  de fora e o jorge podia ouvir "chegou tudo" com a renda do Santander faltando. Aqui: qualquer etapa, pela lista que o banco pediu, uma vez por janela, IA ligada, sem STOP. */
async function janelaSantanderManual(accountId: string, leadId: string, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, tags: true } });
  if (!lead || !lead.aiAutoReplyActive) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const st = (cf._santanderManual || {}) as SantManual;
  if (!st.askedAt || st.forwardedAt || st.forwardSkip || st.prontoAt || st.portal || cf._autoPaused || (lead.tags || []).includes('Pediu pra parar lembretes')) return;
  const ultimaIn = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP', deleted: false }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (!ultimaIn) return;
  const { podePerguntarDocs, clienteEsperandoResposta } = require('./docs-loop.service') as typeof import('./docs-loop.service');
  if (!podePerguntarDocs(ultimaIn.createdAt, Date.now())) return; // a pergunta cai perto do fim da janela, das 07h às 21h
  const marca = ultimaIn.createdAt.toISOString();
  if (st.janela === marca) return; // já perguntei nesta janela
  if (await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', channel: 'WHATSAPP', createdAt: { gt: new Date(Date.now() - 60 * 60_000) } }, select: { id: true } })) return; // conversa andando
  if (await clienteEsperandoResposta(leadId)) return; // ele espera resposta nossa: não cobra por cima
  // O que já chegou depois do pedido (pela leitura guardada em _docInfo — sem ler de novo aqui).
  const { isStickerAttachment, isScreenshotAttachment } = require('./received-docs.service') as typeof import('./received-docs.service');
  const novos = (await prisma.messageAttachment.findMany({ where: { leadId, message: { direction: 'INBOUND' }, createdAt: { gt: new Date(st.askedAt) } }, select: { id: true, fileName: true, mimeType: true, createdAt: true } }))
    .filter((a) => !/^(audio|video)\//.test(a.mimeType) && !isStickerAttachment(a as any) && !isScreenshotAttachment(a as any));
  const info = (cf._docInfo || {}) as Record<string, string>;
  const tipos = novos.map((a) => info[a.id]).filter((t) => t && t !== 'IGNORAR').map((t) => String(t).split('|')[0]);
  const { faltando } = faltandoParaSantanderManual(await itensDoPedido(accountId, leadId, cf, st), tipos, false);
  if (novos.length && !faltando.length) return; // mandou tudo: o encaminhamento à Letícia cuida
  await salvar(leadId, { janela: marca });
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name);
  const banco = st.banco || 'Santander';
  const texto = novos.length
    ? `${nome ? `${nome}, r` : 'R'}ecebi parte dos documentos, obrigada! 😊 Até quando você consegue me mandar o restante que o ${banco} pediu?`
    : `${nome ? `${nome}, a` : 'A'}té quando você consegue me mandar os documentos que o ${banco} pediu pra análise manual? Assim que chegarem, eu já encaminho pro banco. 😊`;
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io as any });
  const hora = new Date(ultimaIn.createdAt.getTime() + 24 * 3_600_000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  await note(leadId, r.success
    ? `⏳ ${rotulo(st)} (análise manual): a janela de 24 h do WhatsApp fecha ${hora} e ainda falta ${faltando.length ? faltando.join('; ') : 'a documentação pedida'} — perguntei ao cliente até quando ele manda.`
    : `⏳ ${rotulo(st)} (análise manual): a janela de 24 h fecha ${hora} e a pergunta "até quando manda" não saiu (${(r as any).error || 'erro'}). Chame o cliente.`);
}

async function encaminharSeCompleto(accountId: string, leadId: string, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const st = (cf._santanderManual || {}) as SantManual;
  if (!st.askedAt || !st.proposta) return;
  // A proposta já foi decidida pelo banco (aprovou/reprovou depois do pedido): não encaminha. Financiamento: pela situação do banco na lista do Credimorar (_fhResumo) — a linha
  // CREDIMORAR_FH junta Bradesco e Santander, então o status dela não diz qual banco decidiu.
  const rot = rotulo(st);
  let ult: { status: string } | null = null;
  if (st.produto === 'FH') {
    const { parseBancosFinanciamento } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
    const sit = String(st.banco || 'Santander').split(' e ').map((b) => parseBancosFinanciamento(cf._fhResumo)[b]?.status || '');
    if (sit.length && sit.every((s) => /aprovad|rejeit|reprov|negad|recus|cancel/i.test(s))) ult = { status: sit.some((s) => /aprovad/i.test(s)) ? 'APPROVED' : 'REJECTED' };
  } else ult = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: 'CREDIMORAR', dryRun: false, createdAt: { gt: new Date(st.askedAt) }, status: { in: ['APPROVED', 'CONDITIONAL', 'REJECTED'] } }, orderBy: { createdAt: 'desc' }, select: { status: true } });
  if (ult) { await salvar(leadId, { forwardSkip: `${ult.status} ${new Date().toISOString()}` }); await note(leadId, `ℹ️ ${rot} (análise manual): o banco já respondeu a proposta (${ult.status === 'REJECTED' ? 'reprovada' : 'aprovada'}) — não encaminhei os documentos à Letícia.`); return; }
  const atts: Anexo[] = (await prisma.messageAttachment.findMany({ where: { leadId, message: { direction: 'INBOUND' } }, orderBy: { createdAt: 'asc' }, select: { id: true, fileName: true, mimeType: true, createdAt: true, driveFileId: true, data: true } })).filter(filtroArquivo);
  const askedAt = Date.parse(st.askedAt);
  const novos = atts.filter((a) => a.createdAt.getTime() > askedAt);
  if (!novos.length) return; // ainda não mandou nada depois do pedido
  const ultimo = Math.max(...novos.map((a) => a.createdAt.getTime()));
  if (Date.now() - ultimo < ESPERA_ULTIMO_ARQUIVO_MS) return;
  // Classifica os arquivos novos (na Pré-Análise a conferência de documentos não roda — a leitura fica guardada em _docInfo e vale pra depois).
  const { getDocInfo, isStickerAttachment, isScreenshotAttachment } = require('./received-docs.service') as typeof import('./received-docs.service');
  const validos = atts.filter((a) => !isStickerAttachment(a) && !isScreenshotAttachment(a));
  const info = await getDocInfo(accountId, leadId, validos);
  const fresh = (await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields as Record<string, any> | undefined;
  const tiposPorId = { ...((fresh?._docInfo || {}) as Record<string, string>) };
  for (const [id, d] of Object.entries(info)) if (!tiposPorId[id]) tiposPorId[id] = d ? `${d.type}|${d.holder || ''}` : 'IGNORAR';
  const docs = validos.filter((a) => tiposPorId[a.id] !== 'IGNORAR');
  const semLeitura = novos.filter((a) => !tiposPorId[a.id]);
  const tipos = docs.map((a) => String(tiposPorId[a.id] || '').split('|')[0]).filter(Boolean);
  // Pedido feito antes de 13/11 (sem `itens` gravado — ex.: jorge anastacio): os itens vêm da leitura do portal ("ANÁLISE MANUAL ABERTA … DOCUMENTOS"); sem nada, a lista genérica.
  const itens = await itensDoPedido(accountId, leadId, cf, st);
  const { faltando, naoConferidos } = faltandoParaSantanderManual(itens, tipos, Date.now() - ultimo > RELAXA_QTD_MS);
  if (faltando.length || (semLeitura.length && Date.now() - ultimo < ESPERA_CLASSIFICAR_MS)) {
    const sig = `${faltando.join(';')}|${novos.length}`;
    if (faltando.length && st.incompletoSig !== sig) {
      await salvar(leadId, { incompletoSig: sig });
      await note(leadId, `📎 ${rot} (análise manual): o cliente mandou ${novos.length} arquivo(s) depois do pedido, mas ainda falta: ${faltando.join('; ')}. Encaminho à Letícia quando chegar tudo.`);
    }
    // Um dia sem arquivo novo e ainda faltando: a equipe confere (uma vez) — pode ser leitura errada do arquivo.
    if (faltando.length && Date.now() - ultimo > RELAXA_QTD_MS && !st.confiraNoteAt) {
      await salvar(leadId, { confiraNoteAt: new Date().toISOString() });
      await note(leadId, `⚠️ ${rot} (análise manual): faz 1 dia que o cliente não manda arquivo e, pela leitura, ainda falta: ${faltando.join('; ')}. Confira os arquivos (aba Documentos) e, se estiver tudo, encaminhe à Letícia à mão.`);
      await pushDono(accountId, leadId, `📎 ${rot} manual: confira os documentos`, `${lead.name}: pela leitura ainda falta ${faltando.join('; ')}`.slice(0, 160));
    }
    return;
  }
  // DOCUMENTAÇÃO COMPLETA (Fabio 14/11, Lucas: "ENVIAR QUANDO RECEBER A DOCUMENTAÇÃO COMPLETA, SE A IA ESTIVER LIGADA VAI SOZINHO, SE NÃO, DEIXE UM BOTÃO DE ENVIAR DOCUMENTOS NO
  // CARD… A EXTENSÃO ABRE O SISTEMA E ENCAMINHA"): a extensão do Credimorar anexa os documentos na Análise manual do portal, escreve o comentário de defesa e clica em "Enviar";
  // depois o CRM avisa a Letícia por e-mail, com os documentos. Antes ia só o e-mail, pedindo que ELA anexasse e enviasse.
  await salvar(leadId, { prontoAt: new Date().toISOString() });
  const ia = await prisma.lead.findUnique({ where: { id: leadId }, select: { aiAutoReplyActive: true } });
  if (ia?.aiAutoReplyActive && !cf._autoPaused) {
    await pedirEnvioPortal(leadId, 'automático (IA ligada)');
    return;
  }
  const ondeBotao = st.produto === 'FH' ? 'aba Financiamento, linha do Santander' : 'aba Financiamento, bloco Análises de crédito';
  await note(leadId, `📎 ${rot} (análise manual): o cliente mandou a documentação completa (${tipos.length ? Array.from(new Set(tipos)).join('; ') : `${docs.length} arquivo(s)`}). A IA deste card está DESLIGADA, então não enviei sozinho: clique em "📤 Enviar documentos" no card (${ondeBotao}) — a extensão do Credimorar anexa no portal, escreve o comentário de defesa e envia pra análise manual; depois aviso a Letícia.`);
  await pushDono(accountId, leadId, `📎 ${rot} manual: documentação completa`, `${lead.name}: clique em "Enviar documentos" no card`);
}

// ─── ENVIO PELO PORTAL (Fabio 14/11) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type DocPortal = { id: string; fileName: string; mimeType: string; tipo: string; slot: 'HOLERITE' | 'IRPF' | 'EXTRATO' | 'OUTROS' };
/** Quais arquivos do cliente vão pro portal e em que vaga: os 3 contracheques mais novos, a declaração e o recibo do IR mais novos, até 3 extratos e outros comprovantes de renda
 *  (DECORE, pró-labore, extrato do INSS…). Nunca FGTS/CTPS nem documento pessoal/do imóvel — a análise manual é de RENDA. Mesmo nome de arquivo mandado duas vezes vai uma vez. Pura. */
export function escolherDocsPortal(arqs: { id: string; fileName: string | null; mimeType: string; createdAt: Date | string; tipo: string }[]): DocPortal[] {
  const novos = [...arqs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const vistos = new Set<string>();
  const out: DocPortal[] = [];
  const pega = (rx: RegExp, slot: DocPortal['slot'], max: number) => {
    let n = 0;
    for (const a of novos) {
      const t = norm(a.tipo);
      if (n >= max || !rx.test(t)) continue;
      const chave = norm(a.fileName || a.id);
      if (vistos.has(chave) || out.some((o) => o.id === a.id)) continue;
      vistos.add(chave);
      out.push({ id: a.id, fileName: a.fileName || a.id, mimeType: a.mimeType, tipo: a.tipo, slot });
      n++;
    }
  };
  pega(/^CONTRACHEQUE\b/, 'HOLERITE', 3);
  pega(/^IMPOSTO DE RENDA\b/, 'IRPF', 1);
  pega(/^RECIBO IMPOSTO DE RENDA\b/, 'IRPF', 1);
  pega(/^EXTRATO BANCARIO\b/, 'EXTRATO', 3);
  pega(/^(DECORE|PGDAS|DEFIS|HISTORICO INSS|PRO.?LABORE)\b/, 'OUTROS', 3);
  return out;
}

/** "Comentário de defesa" que a extensão escreve no portal: só fatos do card e dos arquivos (nada de renda digitada, que pode estar desatualizada no card). Pura. */
export function comentarioDefesa(p: { nome: string; fh: boolean; valor: number; imovel: number; docs: DocPortal[] }): string {
  const brl = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const qtd = (s: DocPortal['slot']) => p.docs.filter((d) => d.slot === s).length;
  const partes = [
    qtd('HOLERITE') ? `${qtd('HOLERITE') > 1 ? `${qtd('HOLERITE')} últimos holerites` : 'holerite'}` : '',
    p.docs.some((d) => /^IMPOSTO DE RENDA/.test(norm(d.tipo))) ? `declaração do Imposto de Renda${p.docs.some((d) => /^RECIBO IMPOSTO/.test(norm(d.tipo))) ? ' com recibo de entrega' : ''}` : '',
    qtd('EXTRATO') ? 'extrato da conta corrente' : '',
    qtd('OUTROS') ? 'demais comprovantes de renda' : '',
  ].filter(Boolean);
  const lista = partes.length > 1 ? `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}` : partes[0] || 'documentos de renda';
  const pct = p.valor > 0 && p.imovel > 0 ? Math.round((p.valor / p.imovel) * 100) : 0;
  const operacao = p.valor > 0
    ? `${p.fh ? 'Financiamento' : 'Crédito com garantia de imóvel'} de ${brl(p.valor)}${p.imovel > 0 ? ` ${p.fh ? 'para a compra de imóvel' : 'sobre imóvel'} de ${brl(p.imovel)}${pct ? ` (${pct}% do valor do imóvel)` : ''}` : ''}. `
    : '';
  return `Cliente ${p.nome}. ${operacao}Encaminhamos para análise manual a comprovação de renda do cliente: ${lista}, em anexo. A documentação confirma a renda e a capacidade de pagamento; pedimos a reavaliação da proposta.`.replace(/\s+/g, ' ').trim();
}

/** Arquivos do cliente com a classificação já guardada (`_docInfo`), sem figurinha/print. */
async function arquivosClassificados(leadId: string, cf: Record<string, any>) {
  const { isStickerAttachment, isScreenshotAttachment } = require('./received-docs.service') as typeof import('./received-docs.service');
  const atts = (await prisma.messageAttachment.findMany({ where: { leadId, message: { direction: 'INBOUND' } }, orderBy: { createdAt: 'asc' }, select: { id: true, fileName: true, mimeType: true, createdAt: true, driveFileId: true, data: true } }))
    .filter(filtroArquivo).filter((a) => !isStickerAttachment(a as any) && !isScreenshotAttachment(a as any));
  const info = (cf._docInfo || {}) as Record<string, string>;
  return atts.map((a) => ({ ...a, tipo: String(info[a.id] || '').split('|')[0] })).filter((a) => a.tipo && a.tipo !== 'IGNORAR');
}

/** Põe o envio na fila da extensão (botão do card ou documentação completa com a IA ligada). Devolve o erro em texto, ou null quando ficou na fila. */
export async function pedirEnvioPortal(leadId: string, por: string): Promise<string | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, accountId: true, status: true, customFields: true } });
  if (!lead || lead.status !== 'OPEN') return 'card fechado';
  const cf = (lead.customFields || {}) as Record<string, any>;
  const st = (cf._santanderManual || {}) as SantManual;
  if (!st.askedAt || !st.proposta) return 'este card não tem análise manual do Santander aberta';
  if (st.portal && (st.portal.status === 'FILA' || st.portal.status === 'RODANDO')) return 'o envio já está na fila da extensão';
  if (st.portal?.status === 'OK') return `os documentos já foram enviados pelo portal em ${new Date(st.portal.fim || st.portal.pedidoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
  const docs = escolherDocsPortal(await arquivosClassificados(leadId, cf));
  if (!docs.length) return 'não achei os documentos de renda do cliente (contracheque, IR, extrato) — confira a aba Documentos';
  const now = new Date().toISOString();
  await salvar(leadId, { portal: { status: 'FILA', pedidoEm: now, por }, ...(st.prontoAt ? {} : { prontoAt: now }) });
  await note(leadId, `📤 ${rotulo(st)} (análise manual): pedi à extensão do Credimorar pra anexar no portal ${docs.length} documento(s) (${docs.map((d) => d.fileName).join('; ')}), escrever o comentário de defesa e enviar pra análise manual — ${por}. Quando terminar, aviso a Letícia por e-mail.`);
  return null;
}

/** Fila da extensão (`/credit-analysis/queue`, caps "manual"): um envio por vez, do produto do banco que pergunta (CREDIMORAR = Home Equity, CREDIMORAR_FH = Financiamento). */
export async function claimEnviosPortal(accountId: string, bank: string, limit = 1): Promise<Record<string, unknown>[]> {
  if (bank !== 'CREDIMORAR' && bank !== 'CREDIMORAR_FH') return [];
  const fh = bank === 'CREDIMORAR_FH';
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND "customFields"->'_santanderManual'->'portal'->>'status' = 'FILA' AND (COALESCE("customFields"->'_santanderManual'->>'produto', '') = 'FH') = ${fh} ORDER BY "customFields"->'_santanderManual'->'portal'->>'pedidoEm' ASC LIMIT ${limit}`;
  const out: Record<string, unknown>[] = [];
  for (const { id } of rows) {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true } });
    if (!lead) continue;
    const cf = (lead.customFields || {}) as Record<string, any>;
    const st = (cf._santanderManual || {}) as SantManual;
    const falha = async (erro: string) => { await salvar(id, { portal: { ...(st.portal as PortalEnvio), status: 'ERRO', fim: new Date().toISOString(), erro } }); await note(id, `⚠️ ${rotulo(st)} (análise manual): não mandei a extensão enviar pelo portal — ${erro}.`); };
    const docs = escolherDocsPortal(await arquivosClassificados(id, cf));
    if (!docs.length) { await falha('não achei os documentos de renda do cliente'); continue; }
    // Onde abrir: FH = a simulação do Credimorar (nº da linha CREDIMORAR_FH); HE = o link da proposta que a extensão gravou ao abrir a análise manual ("… Proposta: https://…").
    let simId = '', href = '';
    if (fh) {
      const r = await prisma.creditAnalysis.findFirst({ where: { leadId: id, bank: 'CREDIMORAR_FH', dryRun: false, proposalNumber: { not: null } }, orderBy: { createdAt: 'desc' }, select: { proposalNumber: true } });
      simId = String(r?.proposalNumber || '').replace(/\D/g, '');
      if (!simId) { await falha('não achei o nº da simulação do Financiamento no Credimorar'); continue; }
    } else {
      const r = await prisma.creditAnalysis.findFirst({ where: { leadId: id, bank: 'CREDIMORAR', dryRun: false, detail: { contains: 'bpo.credimorar.me' } }, orderBy: { createdAt: 'desc' }, select: { detail: true } });
      href = (/https:\/\/bpo\.credimorar\.me\/\S+/.exec(r?.detail || '') || [''])[0].replace(/[).,;]+$/, '');
      if (!href) { await falha('não achei o link da proposta no Credimorar (rode "Conferir Santander" no card)'); continue; }
    }
    const row = fh ? null : await prisma.creditAnalysis.findFirst({ where: { leadId: id, bank: 'CREDIMORAR', dryRun: false, proposalNumber: st.proposta }, orderBy: { createdAt: 'desc' }, select: { requestedValue: true } });
    const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
    const nome = String(cf.participante_1 || lead.name || '').replace(/\s+/g, ' ').trim();
    const comentario = comentarioDefesa({ nome, fh, valor: Number(row?.requestedValue || 0) || num(cf.valor_credito), imovel: num(cf.valor_imovel), docs });
    await salvar(id, { portal: { ...(st.portal as PortalEnvio), status: 'RODANDO', inicio: new Date().toISOString(), comentario, docIds: docs.map((d) => d.id) } });
    out.push({ leadId: id, leadName: lead.name, produto: fh ? 'FH' : 'HE', banco: (st.banco || 'Santander').split(' e ')[0], proposta: st.proposta, simId, href, comentario, docs });
  }
  return out;
}

/** A extensão devolve o envio: OK → nota + push + e-mail à Letícia com os documentos; erro → nota + push (o botão do card volta a valer). */
export async function resultadoEnvioPortal(accountId: string, leadId: string, body: { ok?: boolean; erro?: string; enviados?: string[]; amostra?: string }, io?: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const st = (cf._santanderManual || {}) as SantManual;
  const portal = (st.portal || { pedidoEm: new Date().toISOString(), por: 'extensão' }) as PortalEnvio;
  const rot = rotulo(st);
  const fim = new Date().toISOString();
  if (!body.ok) {
    const erro = String(body.erro || 'sem retorno da extensão').slice(0, 300);
    await salvar(leadId, { portal: { ...portal, status: 'ERRO', fim, erro } });
    await note(leadId, `⚠️ ${rot} (análise manual): a extensão NÃO conseguiu enviar pelo portal do Credimorar — ${erro}.${body.amostra ? `\n\nTela: ${String(body.amostra).slice(0, 600)}` : ''}\n\nConfira a proposta no Credimorar; pra tentar de novo, clique em "📤 Enviar documentos" no card.`);
    await pushDono(accountId, leadId, `⚠️ ${rot} manual: envio pelo portal falhou`, `${lead.name}: ${erro}`.slice(0, 160));
    return;
  }
  const enviados = (body.enviados || []).map((s) => String(s).slice(0, 120)).slice(0, 20);
  await salvar(leadId, { portal: { ...portal, status: 'OK', fim, enviados } });
  await note(leadId, `📤 ${rot} (análise manual): documentos ANEXADOS no portal do Credimorar e ENVIADOS pra análise manual da proposta ${st.proposta} (${enviados.length} arquivo(s): ${enviados.join('; ')}).\nComentário de defesa: "${portal.comentario || ''}"`);
  await pushDono(accountId, leadId, `📤 ${rot}: enviado pra análise manual`, `${lead.name}: proposta ${st.proposta}`);
  // E-mail à Letícia com os mesmos arquivos (Fabio 14/11: "mandar e-mail à Letícia com a documentação, pra ela fazer a defesa").
  if (st.forwardedAt) return;
  const ids = new Set(portal.docIds || []);
  const atts: Anexo[] = (await prisma.messageAttachment.findMany({ where: { leadId, id: { in: Array.from(ids) } }, orderBy: { createdAt: 'asc' }, select: { id: true, fileName: true, mimeType: true, createdAt: true, driveFileId: true, data: true } }));
  const tipos = ((cf._docInfo || {}) as Record<string, string>);
  await enviarParaLeticia(accountId, leadId, lead.name, cf, st, atts, tipos, [], io, portal.comentario || '');
}

/** Envio na fila há 2 h sem a extensão pegar, ou rodando há 20 min sem resultado: avisa a equipe (uma vez). Nunca reenvia sozinho — o "Enviar" pode já ter ido. */
async function envioPortalParado(): Promise<void> {
  const rows = await prisma.$queryRaw<{ id: string; accountId: string }[]>`SELECT id, "accountId" FROM "Lead" WHERE status = 'OPEN' AND "customFields"->'_santanderManual'->'portal'->>'status' IN ('FILA', 'RODANDO') AND "customFields"->'_santanderManual'->'portal'->>'avisoFila' IS NULL`;
  for (const r of rows) {
    const lead = await prisma.lead.findUnique({ where: { id: r.id }, select: { name: true, customFields: true } });
    const st = (((lead?.customFields || {}) as Record<string, any>)._santanderManual || {}) as SantManual;
    const p = st.portal;
    if (!lead || !p) continue;
    const rot = rotulo(st);
    if (p.status === 'RODANDO' && p.inicio && Date.now() - Date.parse(p.inicio) > 20 * 60_000) {
      await salvar(r.id, { portal: { ...p, status: 'ERRO', fim: new Date().toISOString(), erro: 'a extensão começou e não devolveu o resultado' } });
      await note(r.id, `⚠️ ${rot} (análise manual): a extensão começou a enviar pelo portal e não devolveu o resultado em 20 min. Confira no Credimorar se a análise manual foi enviada; se não, clique em "📤 Enviar documentos" de novo.`);
      await pushDono(r.accountId, r.id, `⚠️ ${rot} manual: confira o envio`, `${lead.name}: a extensão não devolveu o resultado`);
    } else if (p.status === 'FILA' && Date.now() - Date.parse(p.pedidoEm) > 2 * 3600_000) {
      await salvar(r.id, { portal: { ...p, avisoFila: new Date().toISOString() } });
      await note(r.id, `⏳ ${rot} (análise manual): o envio pelo portal está na fila há mais de 2 h e a extensão do Credimorar não pegou. Confira se ela está aberta e logada.`);
      await pushDono(r.accountId, r.id, `⏳ ${rot} manual: extensão não pegou o envio`, lead.name);
    }
  }
}

/** Estado pro card (botão "Enviar documentos"): o que o banco pediu, o que falta pela leitura e o envio pelo portal. */
export async function estadoSantanderManual(leadId: string): Promise<Record<string, unknown> | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { aiAutoReplyActive: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const st = (cf._santanderManual || {}) as SantManual;
  if (!lead || !st.askedAt || !st.proposta) return null;
  const arqs = await arquivosClassificados(leadId, cf);
  const novos = arqs.filter((a) => a.createdAt.getTime() > Date.parse(st.askedAt!));
  const { faltando } = faltandoParaSantanderManual(semFgtsCtps(st.itens || []), novos.map((a) => a.tipo), !!st.prontoAt);
  return {
    produto: st.produto === 'FH' ? 'FH' : 'HE', banco: st.banco || 'Santander', proposta: st.proposta, askedAt: st.askedAt, itens: semFgtsCtps(st.itens || []),
    faltando: st.prontoAt ? [] : faltando, prontoAt: st.prontoAt || null, docs: escolherDocsPortal(arqs).map((d) => d.fileName),
    portal: st.portal ? { status: st.portal.status, pedidoEm: st.portal.pedidoEm, fim: st.portal.fim || null, erro: st.portal.erro || null, por: st.portal.por } : null,
    forwardedAt: st.forwardedAt || null, segurado: !!st.forwardSkip, aiOn: !!lead.aiAutoReplyActive,
  };
}

async function bytesDoAnexo(accountId: string, a: Anexo): Promise<Buffer | null> {
  if (a.data && a.data.length) return Buffer.from(a.data);
  if (!a.driveFileId) return null;
  try { const { downloadDriveFile } = await import('./google.service'); return await downloadDriveFile(accountId, a.driveFileId, a.mimeType); } catch { return null; }
}

/** `comentarioPortal` preenchido = a extensão JÁ anexou e enviou pelo portal (Fabio 14/11): o e-mail avisa a Letícia, com os documentos, pra ela acompanhar/reforçar a defesa. */
async function enviarParaLeticia(accountId: string, leadId: string, leadName: string, cf: Record<string, any>, st: SantManual, docs: Anexo[], tipos: Record<string, string>, naoConferidos: string[], io?: Io, comentarioPortal?: string): Promise<void> {
  const viaPortal = comentarioPortal !== undefined;
  const { VISTORIA_SANTANDER_TO, enviarComReserva } = require('./vistoria-santander.service') as typeof import('./vistoria-santander.service');
  // Todos os documentos do cliente (Fabio 13/11: "ENCAMINHA TODOS OS DOCUMENTOS"), em até 3 e-mails de 10 anexos / 14 MB; o resto vai pelo link da pasta do Drive.
  const lotes: { filename: string; contentType: string; content: Buffer }[][] = [[]];
  const foraDoEmail: string[] = [];
  let bytesLote = 0;
  const usados = new Set<string>();
  for (const a of docs) {
    const tipo = String(tipos[a.id] || '').split('|')[0];
    const nome = `${tipo ? `${tipo} - ` : ''}${a.fileName || a.id}`.slice(0, 120);
    if (usados.has(nome)) continue; // mesmo arquivo mandado duas vezes
    const buf = await bytesDoAnexo(accountId, a);
    if (!buf || buf.length > MAX_BYTES_POR_EMAIL) { foraDoEmail.push(nome); continue; }
    let lote = lotes[lotes.length - 1];
    if (lote.length >= MAX_ANEXOS_POR_EMAIL || bytesLote + buf.length > MAX_BYTES_POR_EMAIL) {
      if (lotes.length >= MAX_EMAILS) { foraDoEmail.push(nome); continue; }
      lote = []; lotes.push(lote); bytesLote = 0;
    }
    lote.push({ filename: nome, contentType: a.mimeType || 'application/octet-stream', content: buf });
    bytesLote += buf.length;
    usados.add(nome);
  }
  const total = lotes.reduce((n, l) => n + l.length, 0);
  const rot = rotulo(st);
  const fh = st.produto === 'FH';
  const banco = st.banco || 'Santander';
  if (!total) {
    await salvar(leadId, { forwardFalhou: new Date().toISOString() });
    await note(leadId, `⚠️ ${rot} (análise manual): o cliente mandou os documentos, mas não consegui abrir nenhum arquivo pra encaminhar à Letícia. Encaminhe à mão.`);
    await pushDono(accountId, leadId, `⚠️ ${rot} manual: encaminhe à Letícia`, `${leadName}: não consegui abrir os arquivos`);
    return;
  }
  const nomeCliente = String(cf.participante_1 || leadName || '').replace(/\s+/g, ' ').trim();
  // FH: o nº da linha CREDIMORAR_FH é o da simulação (não o da proposta do banco) — o valor vem do card.
  const row = fh ? null : await prisma.creditAnalysis.findFirst({ where: { leadId, bank: 'CREDIMORAR', dryRun: false, proposalNumber: st.proposta }, orderBy: { createdAt: 'desc' }, select: { requestedValue: true } });
  const valor = Number(row?.requestedValue || cf.valor_credito || 0);
  const brl = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const link = String(cf.link_pasta_drive || '').trim();
  let de = '';
  const enviados: string[] = [];
  try {
    for (let i = 0; i < lotes.length; i++) {
      const lote = lotes[i];
      if (!lote.length) continue;
      const parte = lotes.length > 1 ? ` (parte ${i + 1} de ${lotes.length})` : '';
      const corpo = [
        'Olá, Letícia, tudo bem?', '',
        `A proposta ${banco} nº ${st.proposta} do cliente ${nomeCliente} (${fh ? 'financiamento habitacional' : 'crédito com garantia de imóvel'}${valor > 0 ? `, ${brl(valor)}` : ''}) não passou na análise automática e ficou em ANÁLISE MANUAL no portal.`,
        ...(viaPortal && i === 0 ? ['Já anexamos os documentos do cliente no portal do Credimorar e ENVIAMOS a proposta pra análise manual, com este comentário de defesa:', `"${comentarioPortal}"`, ''] : []),
        `${viaPortal ? 'Os mesmos documentos seguem em anexo' : 'O cliente já enviou os documentos — seguem em anexo'}${parte}:`,
        ...lote.map((f) => `• ${f.filename}`), '',
        ...(i === 0 && (foraDoEmail.length || naoConferidos.length) ? [
          ...(foraDoEmail.length ? [`Não couberam no e-mail: ${foraDoEmail.join('; ')}${link ? ` — estão na pasta do cliente: ${link}` : ''}.`] : []),
          ...(naoConferidos.length ? [`${fh ? 'Também pedimos ao cliente' : 'O portal também pediu'}: ${naoConferidos.join('; ')}.`] : []),
          '',
        ] : []),
        viaPortal
          ? 'Você consegue acompanhar a análise manual e reforçar a defesa com o Santander, se precisar?'
          : 'Você consegue atuar no processo pra gente? Anexar os documentos no portal, fazer o comentário de defesa e enviar pra análise manual.', '',
        'Qualquer dúvida, estou à disposição.', 'Obrigado!',
      ].join('\n');
      const env = await enviarComReserva(accountId, { to: [VISTORIA_SANTANDER_TO], cc: [], subject: `Análise manual ${banco}${fh ? ' - Financiamento' : ''} - ${nomeCliente.toUpperCase()} - proposta ${st.proposta}${viaPortal ? ' - enviada pelo portal' : ''}${parte}`, body: corpo, replyToId: null, leadId, io: (io || ({ to: () => ({ emit: () => {} }) })) as any, attachments: lote });
      de = env.de;
      enviados.push(...lote.map((f) => f.filename));
      if (env.falhas.length) await note(leadId, `⚠️ ${rot} (análise manual): a caixa ${env.falhas.map((f) => f.split(':')[0]).join(' e ')} não conseguiu enviar (${env.falhas.join(' | ')}); o e-mail saiu pela ${env.de}.`);
    }
  } catch (e: any) {
    await salvar(leadId, { forwardFalhou: `${new Date().toISOString()} ${String(e?.message || e).slice(0, 160)}` });
    await note(leadId, `⚠️ ${rot} (análise manual): tentei encaminhar os documentos à Letícia e não consegui: ${e?.message || e}.${enviados.length ? ` Já tinham saído: ${enviados.join('; ')}.` : ''} Encaminhe ${enviados.length ? 'o resto ' : ''}à mão.`);
    await pushDono(accountId, leadId, `⚠️ ${rot} manual: e-mail à Letícia não saiu`, leadName);
    return;
  }
  await salvar(leadId, { forwardedAt: new Date().toISOString(), forwardDe: de });
  await note(leadId, `📨 ${rot} (análise manual): ${viaPortal ? 'avisei a Letícia que a análise manual foi enviada pelo portal' : 'documentos encaminhados à Letícia pedindo que ela atue no processo'} (${VISTORIA_SANTANDER_TO}, de ${de}) — proposta ${st.proposta}, ${enviados.length} anexo(s): ${enviados.join('; ')}.${foraDoEmail.length ? `\nNão couberam no e-mail: ${foraDoEmail.join('; ')}${link ? ' (link da pasta no e-mail)' : ''}.` : ''}`);
  await pushDono(accountId, leadId, `📨 ${rot} manual: documentos à Letícia`, `${leadName}: proposta ${st.proposta}`);
}

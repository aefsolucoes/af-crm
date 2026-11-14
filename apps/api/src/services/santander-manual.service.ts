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
  templateFalhou?: string; forwardedAt?: string; forwardDe?: string; forwardFalhou?: string; forwardSkip?: string; incompletoSig?: string; confiraNoteAt?: string;
};

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
    const itens = linha.split(/\s*,\s*|\s+e\s+(?=[A-ZÀ-Ú0-9])/).map((x) => x.replace(/\.$/, '').trim()).filter((x) => x.length > 1);
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
  const itens = p.itens.length ? p.itens : ITENS_PADRAO;
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
    if (/OPCIONAL|DEMAIS DOCUMENTOS/.test(n)) continue;
    let ok: boolean | null = null;
    if (/HOLERITE|CONTRACHEQUE/.test(n)) ok = conta(/^CONTRACHEQUE\b/) >= (relaxar ? 1 : /\b3\b|TRES|ULTIMOS/.test(n) ? 3 : 1);
    else if (/IRPF|IMPOSTO DE RENDA/.test(n) && /EXTRATO/.test(n)) ok = conta(/^(RECIBO )?IMPOSTO DE RENDA\b/) >= 1 && conta(/^EXTRATO BANCARIO\b/) >= 1;
    else if (/IRPF|IMPOSTO DE RENDA/.test(n)) ok = conta(/^(RECIBO )?IMPOSTO DE RENDA\b/) >= 1;
    else if (/EXTRATO/.test(n)) ok = conta(/^EXTRATO BANCARIO\b/) >= 1;
    else if (/RENDA/.test(n)) ok = conta(RENDA) >= 1;
    else if (/IDENTIDADE|\bRG\b|\bCNH\b/.test(n)) ok = conta(/^(RG|CNH)\b/) >= 1;
    else if (/RESIDENCIA/.test(n)) ok = conta(/^COMPROVANTE DE RESIDENCIA\b/) >= 1;
    else if (/MATRICULA|ONUS/.test(n)) ok = conta(/^(CERTIDAO DE ONUS|MATRICULA DO IMOVEL)\b/) >= 1;
    else if (/IPTU/.test(n)) ok = conta(/^(CND IPTU|CAPA IPTU|GUIA IPTU|CERTIDAO DE CADASTRO IMOBILIARIO)\b/) >= 1;
    else if (/CASAMENTO|NASCIMENTO|ESTADO CIVIL/.test(n)) ok = conta(/^CERTIDAO DE (CASAMENTO|NASCIMENTO|OBITO|UNIAO)\b/) >= 1;
    if (ok === null) naoConferidos.push(item);
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
  // 2) Encaminhar à Letícia (no horário comercial dos avisos).
  if (!inNoticeWindow()) return;
  const ids = await prisma.$queryRaw<{ id: string; accountId: string }[]>`SELECT id, "accountId" FROM "Lead" WHERE status = 'OPEN' AND archived = false AND "customFields"->'_santanderManual'->>'askedAt' IS NOT NULL AND "customFields"->'_santanderManual'->>'forwardedAt' IS NULL AND "customFields"->'_santanderManual'->>'forwardFalhou' IS NULL AND "customFields"->'_santanderManual'->>'forwardSkip' IS NULL`;
  for (const l of ids) await encaminharSeCompleto(l.accountId, l.id, io).catch((e: any) => console.error('[Santander manual] encaminhar:', e?.message || e));
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
  let itens = st.itens || [];
  if (!itens.length) {
    const lida = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: bankDe(st), dryRun: false, detail: { contains: 'MANUAL ABERTA' } }, orderBy: { createdAt: 'desc' }, select: { detail: true } });
    const { parseDocumentosExigidos, docDoPortal } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
    itens = (parseDocumentosExigidos(lida?.detail)?.itens || []).map(docDoPortal);
    if (!itens.length) itens = st.produto === 'FH' ? await itensRendaPerfilFh(accountId, cf) : ITENS_PADRAO;
  }
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
  await enviarParaLeticia(accountId, leadId, lead.name, cf, st, docs, tiposPorId, naoConferidos, io);
}

async function bytesDoAnexo(accountId: string, a: Anexo): Promise<Buffer | null> {
  if (a.data && a.data.length) return Buffer.from(a.data);
  if (!a.driveFileId) return null;
  try { const { downloadDriveFile } = await import('./google.service'); return await downloadDriveFile(accountId, a.driveFileId, a.mimeType); } catch { return null; }
}

async function enviarParaLeticia(accountId: string, leadId: string, leadName: string, cf: Record<string, any>, st: SantManual, docs: Anexo[], tipos: Record<string, string>, naoConferidos: string[], io?: Io): Promise<void> {
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
        `O cliente já enviou os documentos — seguem em anexo${parte}:`,
        ...lote.map((f) => `• ${f.filename}`), '',
        ...(i === 0 && (foraDoEmail.length || naoConferidos.length) ? [
          ...(foraDoEmail.length ? [`Não couberam no e-mail: ${foraDoEmail.join('; ')}${link ? ` — estão na pasta do cliente: ${link}` : ''}.`] : []),
          ...(naoConferidos.length ? [`${fh ? 'Também pedimos ao cliente' : 'O portal também pediu'}: ${naoConferidos.join('; ')}.`] : []),
          '',
        ] : []),
        'Você consegue atuar no processo pra gente? Anexar os documentos no portal, fazer o comentário de defesa e enviar pra análise manual.', '',
        'Qualquer dúvida, estou à disposição.', 'Obrigado!',
      ].join('\n');
      const env = await enviarComReserva(accountId, { to: [VISTORIA_SANTANDER_TO], cc: [], subject: `Análise manual ${banco}${fh ? ' - Financiamento' : ''} - ${nomeCliente.toUpperCase()} - proposta ${st.proposta}${parte}`, body: corpo, replyToId: null, leadId, io: (io || ({ to: () => ({ emit: () => {} }) })) as any, attachments: lote });
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
  await note(leadId, `📨 ${rot} (análise manual): documentos encaminhados à Letícia (${VISTORIA_SANTANDER_TO}, de ${de}) pedindo que ela atue no processo da proposta ${st.proposta} — ${enviados.length} anexo(s): ${enviados.join('; ')}.${foraDoEmail.length ? `\nNão couberam no e-mail: ${foraDoEmail.join('; ')}${link ? ' (link da pasta no e-mail)' : ''}.` : ''}`);
  await pushDono(accountId, leadId, `📨 ${rot} manual: documentos à Letícia`, `${leadName}: proposta ${st.proposta}`);
}

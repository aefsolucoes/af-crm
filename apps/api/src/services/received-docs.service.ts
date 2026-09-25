import { PrismaClient } from '@prisma/client';
import { organizeReceivedDocsFolder, downloadDriveFileForVision } from './google.service';
import { logActivity } from './activity.service';

const prisma = new PrismaClient();

/* Card entrou em "Documentação Recebida" (qualquer setor que tenha a pasta
 * LEADS ATIVOS configurada em Department.activeLeadsFolderId): organiza a
 * pasta do cliente no Drive e grava o link em "Pasta no Drive". Roda por
 * polling (index.ts) em vez de hook de rota: o card chega nessa etapa por
 * vários caminhos (tela, "Fechado" migrando pro funil de contratação,
 * automação, IA), e Lead.stageEnteredAt (trigger no banco) marca quando
 * entrou — sem depender de cada caminho lembrar de chamar isto. */

const RECENT_ENTRY_DAYS = 7; // só quem entrou na etapa agora (não mexe em pasta antiga organizada à mão)
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
const MAX_VISION_BYTES = 4_500_000;
let running = false;

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function folderNameFor(lead: { name: string; customFields: unknown }): string {
  const cf = (lead.customFields || {}) as Record<string, string>;
  const raw = cf.participante_1 || lead.name || 'CLIENTE';
  return raw.replace(/[^\p{L}\p{N} .'-]/gu, '').replace(/\s+/g, ' ').trim().toUpperCase() || 'CLIENTE';
}

const DOC_PROMPT = `Este arquivo foi enviado por um cliente de crédito imobiliário (financiamento ou crédito com garantia de imóvel). Diga qual documento é.
Responda SOMENTE em uma linha, em CAIXA ALTA, sem acento. O nome do documento, de preferência um destes: RG, CNH, CPF, CERTIDAO DE NASCIMENTO, CERTIDAO DE CASAMENTO, COMPROVANTE DE RESIDENCIA, CONTRACHEQUE, EXTRATO BANCARIO, IMPOSTO DE RENDA, RECIBO IMPOSTO DE RENDA, CTPS, EXTRATO FGTS, HISTORICO INSS, CND IPTU, CERTIDAO DE ONUS, MATRICULA DO IMOVEL, CONTRATO SOCIAL, CARTAO CNPJ, DEFIS, PGDAS, DECORE.
Se for outro documento, use um nome curto que o descreva (até 4 palavras).
Depois do nome do documento, coloque " | " e o nome completo do titular como aparece no documento (a pessoa a quem ele pertence). Se não aparecer nome de pessoa, escreva só o nome do documento.
Exemplos: "CNH | JOAO CARLOS DA SILVA", "CONTRACHEQUE | MARIA SOUZA", "CND IPTU".
Se NÃO for documento (foto qualquer, selfie, figurinha, print de conversa), responda IGNORAR.`;

type AttachmentForVision = { id: string; driveFileId: string | null; data?: Uint8Array | null; mimeType: string };

export interface DocInfo { type: string; holder?: string }

const clean = (t: string, max: number) =>
  t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);

/** Tipo do documento e titular lendo o arquivo (Claude com visão) — {type:
 *  "CNH", holder: "JOAO DA SILVA"}. null = não é documento; undefined = não
 *  deu pra ler (tipo de arquivo, tamanho ou erro). Lê os bytes do banco se o
 *  anexo ainda não subiu pro Drive. */
export async function classifyDocument(accountId: string, att: AttachmentForVision): Promise<DocInfo | null | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  const isPdf = att.mimeType === 'application/pdf';
  const isImage = /^image\//.test(att.mimeType);
  if (!isPdf && !isImage) return undefined;

  let buffer: Buffer;
  let mimeType = att.mimeType;
  if (att.data && att.data.length) {
    buffer = Buffer.from(att.data);
  } else if (att.driveFileId) {
    ({ buffer, mimeType } = await downloadDriveFileForVision(accountId, att.driveFileId, att.mimeType));
  } else {
    return undefined;
  }
  if (buffer.length > MAX_VISION_BYTES) return undefined;
  const mediaType = isPdf ? 'application/pdf' : mimeType;
  if (!isPdf && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) return undefined;

  const source = { type: 'base64', media_type: mediaType, data: buffer.toString('base64') };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 80,
      messages: [{ role: 'user', content: [{ type: isPdf ? 'document' : 'image', source }, { type: 'text', text: DOC_PROMPT }] }],
    }),
  });
  if (!res.ok) {
    console.error('[DocsRecebidos] Erro ao ler documento:', res.status, (await res.text()).slice(0, 200));
    return undefined;
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = (data.content?.find((b) => b.type === 'text')?.text || '').split('\n')[0];
  const [typePart, holderPart] = text.split('|');
  const type = clean(typePart || '', 40);
  if (!type) return undefined;
  if (type === 'IGNORAR') return null;
  const holder = clean(holderPart || '', 60);
  return holder ? { type, holder } : { type };
}

export function docLabel(info: DocInfo): string {
  return info.holder ? `${info.type} ${info.holder.split(' ').slice(0, 2).join(' ')}` : info.type;
}

/** Documentos já lidos ficam guardados no card (customFields._docInfo, por
 *  id do anexo, "TIPO|TITULAR" ou "IGNORAR") — a conferência de documentação
 *  e o organizador de pasta leem cada arquivo uma vez só. */
export async function getDocInfo(accountId: string, leadId: string, atts: AttachmentForVision[]): Promise<Record<string, DocInfo | null>> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = ((lead?.customFields as Record<string, unknown>) || {});
  const cache = { ...((cf._docInfo as Record<string, string>) || {}) };
  let changed = false;
  for (const att of atts) {
    if (cache[att.id]) continue;
    const info = await classifyDocument(accountId, att).catch(() => undefined);
    if (info === undefined) continue;
    cache[att.id] = info === null ? 'IGNORAR' : `${info.type}|${info.holder || ''}`;
    changed = true;
  }
  if (changed) {
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const next: Record<string, unknown> = { ...((fresh?.customFields as Record<string, unknown>) || {}), _docInfo: cache };
    delete next._docTypes;
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: next as any } });
  }
  const out: Record<string, DocInfo | null> = {};
  for (const [id, v] of Object.entries(cache)) {
    if (v === 'IGNORAR') { out[id] = null; continue; }
    const [type, holder] = v.split('|');
    out[id] = holder ? { type, holder } : { type };
  }
  return out;
}

async function organizeLead(lead: {
  id: string; name: string; accountId: string; customFields: unknown; activeLeadsFolderId: string;
}): Promise<void> {
  const attachments = (await prisma.messageAttachment.findMany({
    where: { leadId: lead.id, driveFileId: { not: null }, message: { direction: 'INBOUND' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, driveFileId: true, fileName: true, mimeType: true },
  })).filter((a) => !/^(audio|video)\//.test(a.mimeType));
  const files = attachments.map((a) => ({ driveFileId: a.driveFileId!, fileName: a.fileName, mimeType: a.mimeType }));
  const docInfo = await getDocInfo(lead.accountId, lead.id, attachments);
  const attIdByDriveId = new Map(attachments.map((a) => [a.driveFileId!, a.id]));

  const freshLead = await prisma.lead.findUnique({ where: { id: lead.id }, select: { customFields: true } });
  const cf = { ...((freshLead?.customFields as Record<string, unknown>) || {}) };
  if (!files.length) {
    cf._driveOrganizedAt = new Date().toISOString();
    await prisma.lead.update({ where: { id: lead.id }, data: { customFields: cf as any } });
    await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: '📁 Card em Documentação Recebida, mas nenhum documento do cliente foi encontrado no Drive (anexos do WhatsApp). A pasta não foi organizada automaticamente.' } });
    return;
  }

  const clientFolderName = folderNameFor(lead);
  const result = await organizeReceivedDocsFolder(lead.accountId, {
    files,
    clientFolderName,
    activeLeadsFolderId: lead.activeLeadsFolderId,
    nameFor: async (f) => {
      const info = docInfo[attIdByDriveId.get(f.driveFileId) || ''];
      if (info === null) return null;
      return info ? docLabel(info) : '';
    },
  });

  cf.link_pasta_drive = result.folderUrl;
  cf._driveOrganizedAt = new Date().toISOString();
  delete cf._driveOrganizeFailedAt;
  await prisma.lead.update({ where: { id: lead.id }, data: { customFields: cf as any } });

  const lines = [
    `📁 Pasta organizada no Drive: ${clientFolderName} (em LEADS ATIVOS)`,
    result.folderUrl,
    '',
    `Documentos na subpasta COMPRADOR (${result.named.length}):`,
    ...result.named.map((n) => `• ${n.to}`),
  ];
  if (result.ignored.length) lines.push('', `Não são documentos, ficaram fora da COMPRADOR: ${result.ignored.join(', ')}`);
  await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: lines.join('\n') } });
  logActivity({
    accountId: lead.accountId, userId: null, userName: 'Organizador de documentos', action: 'lead_edited', leadId: lead.id, leadName: lead.name,
    summary: `organizou a pasta no Drive (${result.named.length} documentos) e preencheu "Pasta no Drive"`,
  });
  console.log(`[DocsRecebidos] ${lead.name} (${lead.id}): pasta organizada, ${result.named.length} documentos, ${result.ignored.length} ignorados`);
}

export async function organizeReceivedDocsLeads(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const leads = await prisma.lead.findMany({
      where: {
        archived: false,
        isGroup: false,
        stage: { name: { contains: 'recebida', mode: 'insensitive' } },
        stageEnteredAt: { gte: new Date(Date.now() - RECENT_ENTRY_DAYS * 86_400_000) },
        pipeline: { department: { activeLeadsFolderId: { not: null } } },
      },
      select: {
        id: true, name: true, accountId: true, customFields: true,
        stage: { select: { name: true } },
        pipeline: { select: { department: { select: { activeLeadsFolderId: true } } } },
      },
    });

    for (const lead of leads) {
      if (!norm(lead.stage.name).includes('documentacao recebida')) continue;
      const cf = (lead.customFields || {}) as Record<string, string>;
      if (cf.link_pasta_drive || cf._driveOrganizedAt) continue;
      if (cf._driveOrganizeFailedAt && Date.now() - new Date(cf._driveOrganizeFailedAt).getTime() < RETRY_AFTER_FAILURE_MS) continue;

      try {
        await organizeLead({ ...lead, activeLeadsFolderId: lead.pipeline.department!.activeLeadsFolderId! });
      } catch (err) {
        console.error(`[DocsRecebidos] Falha ao organizar a pasta de ${lead.name} (${lead.id}):`, (err as Error)?.message);
        await prisma.lead.update({
          where: { id: lead.id },
          data: { customFields: { ...cf, _driveOrganizeFailedAt: new Date().toISOString() } as any },
        }).catch(() => {});
      }
    }
  } finally {
    running = false;
  }
}

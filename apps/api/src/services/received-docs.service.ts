import { PrismaClient } from '@prisma/client';
import { organizeReceivedDocsFolder, downloadDriveFileForVision, ReceivedDocFile } from './google.service';
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
Responda SOMENTE com o nome do arquivo em CAIXA ALTA, sem extensão e sem acento, de preferência um destes: RG, CNH, CPF, CERTIDAO DE NASCIMENTO, CERTIDAO DE CASAMENTO, COMPROVANTE DE RESIDENCIA, CONTRACHEQUE, EXTRATO BANCARIO, IMPOSTO DE RENDA, RECIBO IMPOSTO DE RENDA, CTPS, EXTRATO FGTS, HISTORICO INSS, CND IPTU, CERTIDAO DE ONUS, MATRICULA DO IMOVEL, CONTRATO SOCIAL, CARTAO CNPJ, DEFIS, PGDAS, DECORE.
Se for outro documento, use um nome curto que o descreva (até 4 palavras).
Se NÃO for documento (foto qualquer, selfie, figurinha, print de conversa), responda IGNORAR.`;

/** Nome do documento lendo o arquivo (Claude com visão). null = não é
 *  documento; undefined = não deu pra ler (mantém o nome original). */
async function nameDocument(accountId: string, file: ReceivedDocFile): Promise<string | null | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  const isPdf = file.mimeType === 'application/pdf';
  const isImage = /^image\//.test(file.mimeType);
  if (!isPdf && !isImage) return undefined;

  const { buffer, mimeType } = await downloadDriveFileForVision(accountId, file.driveFileId, file.mimeType);
  if (buffer.length > MAX_VISION_BYTES) return undefined;
  const mediaType = isPdf ? 'application/pdf' : mimeType;
  if (!isPdf && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) return undefined;

  const source = { type: 'base64', media_type: mediaType, data: buffer.toString('base64') };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 40,
      messages: [{ role: 'user', content: [{ type: isPdf ? 'document' : 'image', source }, { type: 'text', text: DOC_PROMPT }] }],
    }),
  });
  if (!res.ok) {
    console.error('[DocsRecebidos] Erro ao ler documento:', res.status, (await res.text()).slice(0, 200));
    return undefined;
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const answer = (data.content?.find((b) => b.type === 'text')?.text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 40);
  if (!answer) return undefined;
  if (answer === 'IGNORAR') return null;
  return answer;
}

async function organizeLead(lead: {
  id: string; name: string; accountId: string; customFields: unknown; activeLeadsFolderId: string;
}): Promise<void> {
  const attachments = await prisma.messageAttachment.findMany({
    where: { leadId: lead.id, driveFileId: { not: null }, message: { direction: 'INBOUND' } },
    orderBy: { createdAt: 'asc' },
    select: { driveFileId: true, fileName: true, mimeType: true },
  });
  const files = attachments
    .filter((a) => !/^(audio|video)\//.test(a.mimeType))
    .map((a) => ({ driveFileId: a.driveFileId!, fileName: a.fileName, mimeType: a.mimeType }));

  const cf = { ...((lead.customFields as Record<string, unknown>) || {}) };
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
    nameFor: (f) => nameDocument(lead.accountId, f).then((n) => (n === undefined ? '' : n)),
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

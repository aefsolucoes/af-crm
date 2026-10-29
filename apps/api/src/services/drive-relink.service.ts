import { prisma } from '../lib/prisma';

/**
 * A equipe trocou o link da pasta do cliente no Drive (Fabio 29/10, Alexandro: o card apontava pra uma pasta criada pelo CRM, a de verdade era outra).
 * Leva pra pasta NOVA o que o CRM gerou na antiga — as certidões do ONR (subpasta IMOVEL) — e esquece a pasta MINUTA antiga (a leitura da minuta passa a olhar a nova).
 */
export async function pastaDoDriveTrocada(accountId: string, leadId: string, linkAntes: string, linkDepois: string): Promise<void> {
  const g = await import('./google.service');
  const nova = g.extractFolderId(linkDepois);
  if (!nova) return;
  const certs = await prisma.certidaoRequest.findMany({ where: { accountId, leadId, driveFileId: { not: null } }, select: { id: true, driveFileId: true, files: true } });
  const movidos: string[] = [];
  if (certs.length) {
    const imovel = await g.createFolder(accountId, 'IMOVEL', nova);
    for (const c of certs) {
      const ids = new Set<string>([c.driveFileId!, ...(((c.files as any[]) || []).map((f) => f?.driveFileId).filter(Boolean) as string[])]);
      for (const id of ids) {
        try { const r = await g.moveDriveItem(accountId, id, imovel.id); movidos.push(r.name); } catch { /* já estava lá, ou sem acesso */ }
      }
      await prisma.certidaoRequest.update({ where: { id: c.id }, data: { driveUrl: g.folderLink(imovel.id) } }).catch(() => {});
    }
  }
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  if (cf._minuta) { delete cf._minuta; await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } }); }
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📁 Pasta do Drive trocada${linkAntes ? ` (era ${linkAntes})` : ''}.${movidos.length ? ` Levei pra pasta nova (IMOVEL): ${movidos.join('; ')}.` : ''} A minuta passa a ser lida da pasta nova.` } }).catch(() => {});
}

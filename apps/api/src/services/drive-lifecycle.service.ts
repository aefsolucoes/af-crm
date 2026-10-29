import { prisma } from '../lib/prisma';
import { getDrive, extractFolderId, moveDriveItem, createFolder, folderLink } from './google.service';

/**
 * PASTA DO CLIENTE ACOMPANHA O CARD (Fabio 28/10):
 *  - Ganho  → a pasta sai de "LEADS ATIVOS" e vai pra "CONCLUIDOS / <ano> / <MM. MÊS>" da MESMA área (Home Equity ou Habitação); ano e mês são criados se faltarem.
 *  - Perdido → a pasta em "LEADS ATIVOS" vai SOLTA pra "LEADS FRIOS" da mesma área (qualquer card com o link da pasta, não só os de contratação).
 *  - Reaberto (Perdido → Aberto) → a pasta que está em "LEADS FRIOS" volta pra "LEADS ATIVOS".
 * A área é descoberta pelo lugar ONDE A PASTA ESTÁ (a pai dela é o "LEADS ATIVOS"/"LEADS FRIOS" de algum setor), não pelo funil do card.
 * Só age quando o STATUS do card muda (marcador customFields._pastaStatus = último status já tratado); pasta fora desses lugares não é mexida.
 * Poller a cada 5 min (index.ts).
 */

const MESES = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

/** Nome da pasta do mês no padrão "número e mês" (Fabio: "11. NOVEMBRO"). Pura (testável). */
export function monthFolderName(month1to12: number): string {
  return `${String(month1to12).padStart(2, '0')}. ${MESES[month1to12 - 1]}`;
}

/** Acha a pasta de um mês entre as que existem, aceitando os formatos antigos ("OUTUBRO", "10. OUTUBRO", "10.OUTUBRO", "03.MARCO", "3. MARÇO"). Pura (testável). */
export function findMonthFolder<T extends { name?: string | null }>(folders: T[], month1to12: number): T | undefined {
  const alvo = MESES[month1to12 - 1];
  return folders.find((f) => norm(String(f.name || '')).replace(/[^A-Z]/g, '') === alvo);
}

export type Area = { root: string; ativos: string; frios: string | null; concluidos: string | null; nome: string };

export async function loadAreas(accountId: string): Promise<Area[]> {
  const drive = await getDrive(accountId);
  const deps = await prisma.department.findMany({ where: { accountId, activeLeadsFolderId: { not: null } }, select: { name: true, activeLeadsFolderId: true } });
  const areas: Area[] = [];
  for (const d of deps) {
    try {
      const at = await drive.files.get({ fileId: d.activeLeadsFolderId!, fields: 'id,parents', supportsAllDrives: true });
      const root = at.data.parents?.[0];
      if (!root) continue;
      const filhos = (await drive.files.list({ q: `'${root}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: 'files(id,name)', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true })).data.files || [];
      areas.push({
        nome: d.name, root, ativos: d.activeLeadsFolderId!,
        frios: filhos.find((f) => /LEADS\s*FRIOS/.test(norm(f.name || '')))?.id || null,
        concluidos: filhos.find((f) => /CONCLU/.test(norm(f.name || '')))?.id || null,
      });
    } catch (e: any) { console.warn(`[Pasta do card] setor ${d.name}:`, e?.message); }
  }
  return areas;
}

async function listFoldersIn(accountId: string, parent: string) {
  const drive = await getDrive(accountId);
  return (await drive.files.list({ q: `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: 'files(id,name)', pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true })).data.files || [];
}

/** CONCLUIDOS / <ano> / <mês> — cria o que faltar. */
export async function monthFolderFor(accountId: string, concluidos: string, quando: Date): Promise<{ id: string; caminho: string }> {
  const brt = new Date(quando.getTime() - 3 * 3600_000);
  const ano = String(brt.getUTCFullYear()), mes = brt.getUTCMonth() + 1;
  const anos = await listFoldersIn(accountId, concluidos);
  const anoId = anos.find((f) => String(f.name || '').trim() === ano)?.id || (await createFolder(accountId, ano, concluidos)).id;
  const meses = await listFoldersIn(accountId, anoId);
  const achado = findMonthFolder(meses, mes);
  if (achado?.id) return { id: achado.id, caminho: `${ano} / ${achado.name}` };
  const novo = await createFolder(accountId, monthFolderName(mes), anoId);
  return { id: novo.id, caminho: `${ano} / ${monthFolderName(mes)} (pasta criada agora)` };
}

let running = false;

export async function processDriveLifecycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // cards com link de pasta cujo status mudou desde a última vez (marcador ausente = era Aberto)
    const rows = await prisma.$queryRaw<{ id: string; accountId: string; name: string; status: string; link: string }[]>`
      SELECT id, "accountId", name, status::text AS status, "customFields"->>'link_pasta_drive' AS link
      FROM "Lead"
      WHERE coalesce("customFields"->>'link_pasta_drive', '') <> ''
        AND status::text <> coalesce("customFields"->>'_pastaStatus', 'OPEN')
      ORDER BY "updatedAt" DESC LIMIT 20`;
    if (!rows.length) return;
    const areasPorConta = new Map<string, Area[]>();
    for (const r of rows) {
      try {
        if (!areasPorConta.has(r.accountId)) areasPorConta.set(r.accountId, await loadAreas(r.accountId));
        await tratar(r, areasPorConta.get(r.accountId)!);
      } catch (e: any) { console.warn(`[Pasta do card] ${r.name}:`, e?.message); }
    }
  } finally { running = false; }
}

async function marcar(leadId: string, status: string) {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((l?.customFields || {}) as any), _pastaStatus: status } } });
}

async function tratar(r: { id: string; accountId: string; name: string; status: string; link: string }, areas: Area[]) {
  const pasta = extractFolderId(r.link);
  const drive = await getDrive(r.accountId);
  let pai: string | undefined;
  try { pai = (await drive.files.get({ fileId: pasta, fields: 'parents,trashed', supportsAllDrives: true })).data.parents?.[0]; }
  catch { await marcar(r.id, r.status); return; } // pasta apagada/sem acesso: não insiste

  const nota = (content: string) => prisma.note.create({ data: { leadId: r.id, type: 'COMMENT', content } }).catch(() => {});
  if (r.status === 'WON') {
    const area = areas.find((a) => a.ativos === pai);
    if (area && area.concluidos) {
      const destino = await monthFolderFor(r.accountId, area.concluidos, new Date());
      await moveDriveItem(r.accountId, pasta, destino.id);
      await nota(`📁 Cliente ganho: a pasta foi pra CONCLUIDOS / ${destino.caminho} (${area.nome}). ${folderLink(pasta)}`);
    } else if (area && !area.concluidos) await nota(`⚠️ Cliente ganho, mas não achei a pasta "CONCLUIDOS" de ${area.nome} no Drive — a pasta do cliente ficou em LEADS ATIVOS.`);
  } else if (r.status === 'LOST') {
    const area = areas.find((a) => a.ativos === pai);
    if (area && area.frios) {
      await moveDriveItem(r.accountId, pasta, area.frios);
      await nota(`📁 Card perdido: a pasta saiu de LEADS ATIVOS e foi pra LEADS FRIOS (${area.nome}). Se o card for reaberto, ela volta. ${folderLink(pasta)}`);
    }
  } else if (r.status === 'OPEN') {
    const area = areas.find((a) => a.frios && a.frios === pai);
    if (area) {
      await moveDriveItem(r.accountId, pasta, area.ativos);
      await nota(`📁 Card reaberto: a pasta voltou de LEADS FRIOS pra LEADS ATIVOS (${area.nome}). ${folderLink(pasta)}`);
    }
  }
  await marcar(r.id, r.status);
}

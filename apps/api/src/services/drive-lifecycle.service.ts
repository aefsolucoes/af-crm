import { prisma } from '../lib/prisma';
import { getDrive, extractFolderId, moveDriveItem, createFolder, folderLink } from './google.service';

/**
 * PASTA DO CLIENTE ACOMPANHA O CARD (Fabio 28/10):
 *  - Ganho  → a pasta sai de "LEADS ATIVOS" e vai pra "CONCLUIDOS / <ano> / <MM. MÊS>" da MESMA área (Home Equity ou Habitação); ano e mês são criados se faltarem.
 *  - Perdido → a pasta em "LEADS ATIVOS" vai SOLTA pra "LEADS FRIOS" da mesma área (qualquer card com o link da pasta, não só os de contratação).
 *  - Reaberto (Perdido → Aberto) → a pasta que está em "LEADS FRIOS" volta pra "LEADS ATIVOS".
 * A área é descoberta pelo lugar ONDE A PASTA ESTÁ (a pai dela é o "LEADS ATIVOS"/"LEADS FRIOS" de algum setor), não pelo funil do card.
 * Só age quando o STATUS do card muda (marcador customFields._pastaStatus = último status já tratado); pasta fora desses lugares não é mexida.
 * Na hora (Fabio 10/11: o Pedro foi pra Perdido e a pasta continuava em LEADS ATIVOS — o poller só passava 3 min depois): qualquer mudança de status de card
 * pelo Prisma chama a mesma passada 3 s depois (ligarPastaNaHora, middleware). O poller de 5 min (index.ts) fica como garantia (erro do Drive, outra instância).
 *
 * Conferência de 16/11 (Fabio: "quando vai pra CONCLUÍDOS ou DESISTE, muda as pastas de lugar?") — três furos, corrigidos:
 *  - Card ARRASTADO pro funil "Concluído"/"Perdidos" sem marcar Ganho/Perdido (Andreia 06/11, Alexandro): o status continuava Aberto e a pasta não andava.
 *    Agora a situação do card é o status OU o funil (Concluído = Ganho, Perdidos = Perdido) — `situacaoDoCard`.
 *  - Card SEM o link da pasta, ou com link velho (pasta apagada/na lixeira — Sérgio Furoni, Renata Vieira): a pasta em LEADS ATIVOS não era achada.
 *  - Segunda pasta do mesmo cliente ("JULIO CESAR BELARMINO DA SILVA- SANTANDER" ao lado da do link) ficava pra trás.
 *    Agora, além da pasta do link, vai junto toda pasta de LEADS ATIVOS (LEADS FRIOS, no reaberto) com o NOME EXATO do cliente (`mesmoNome`: nome inteiro igual,
 *    sem acento e sem o que vem depois do traço). Primeiro+último nome NÃO serve: "MARIA … DA SILVA" pegaria pasta de outra Maria. Pasta que é de outro card
 *    aberto (link ou mesmo nome) não sai. Card sem link só entra quando a mudança é vista agora (middleware) — os antigos ficam onde estão (mover só com o OK do Fabio).
 */

const MESES = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

const PARTICULAS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E']);

/** "JULIO CESAR BELARMINO DA SILVA- SANTANDER" → "JULIO CESAR BELARMINO SILVA": sem acento, sem "de/da/dos…" e sem o que vem depois do traço (banco). Pura (testável). */
export function nomeBase(s: string): string {
  return norm(String(s || '').split(/\s*[-–]\s*/)[0]).replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !PARTICULAS.has(w)).join(' ');
}

/** A pasta tem o nome EXATO da pessoa (2 palavras ou mais)? Pura (testável). */
export function mesmoNome(nomePasta: string, nomePessoa: string): boolean {
  const p = nomeBase(nomePessoa);
  return p.split(' ').length >= 2 && nomeBase(nomePasta) === p;
}

/** Nomes da pessoa do card: participante_1 e o 1º nome do card ("PEDRO LUIS BARBOSA / SUELI SILVA BARBOSA" → PEDRO LUIS BARBOSA). Pura (testável). */
export function nomesDoCard(name: string, participante?: string | null): string[] {
  return [participante, String(name || '').split('/')[0]].map((x) => String(x || '').trim()).filter(Boolean);
}

/** Situação do card pra pasta: o status manda; Aberto num funil "Concluído" conta como Ganho e num "Perdidos" como Perdido (card arrastado de funil sem marcar). Pura (testável). */
export function situacaoDoCard(status: string, funil: string): 'OPEN' | 'WON' | 'LOST' {
  if (status === 'WON' || status === 'LOST') return status;
  const f = norm(funil);
  return f.startsWith('CONCLU') ? 'WON' : f.startsWith('PERDID') ? 'LOST' : 'OPEN';
}

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
  const todas: { id?: string | null; name?: string | null }[] = [];
  let pageToken: string | undefined;
  do { // LEADS FRIOS passa de 200 pastas
    const r = (await drive.files.list({ q: `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: 'nextPageToken,files(id,name)', pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true })).data;
    todas.push(...(r.files || []));
    pageToken = r.nextPageToken || undefined;
  } while (pageToken);
  return todas;
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
let deNovo = false; // pedido "na hora" chegou com uma passada rodando: roda outra quando ela terminar
let agendado: ReturnType<typeof setTimeout> | null = null;
/** Cards cujo status/funil mudou AGORA (visto pelo middleware). Card sem o link da pasta só entra por aqui (ou se já foi marcado antes):
 *  os Perdidos antigos sem link não saem procurando pasta pelo nome. */
const mudaramAgora = new Set<string>();

/** Status de card mudou: a passada roda em 3 s (junta várias mudanças seguidas numa só). */
export function pastaAcompanhaAgora(): void {
  if (agendado) return;
  agendado = setTimeout(() => {
    agendado = null;
    processDriveLifecycle().catch((err) => console.error('[Pasta do card] Na hora:', err?.message));
  }, 3000);
}

const STATUS_ACOES = new Set(['update', 'updateMany', 'upsert']);
/** Liga o "na hora": depois de todo update/upsert de Lead que mexe no status OU no funil (card arrastado pro Concluído/Perdidos), agenda a passada.
 *  Chamado uma vez no início do servidor (index.ts). */
export function ligarPastaNaHora(): void {
  prisma.$use(async (params, next) => {
    const r = await next(params);
    if (params.model === 'Lead' && STATUS_ACOES.has(params.action)) {
      const a = (params.args || {}) as Record<string, any>;
      const mexeu = (d: any) => !!d && typeof d === 'object' && (d.status !== undefined || d.pipelineId !== undefined || d.pipeline !== undefined);
      if (mexeu(a.data) || mexeu(a.update)) {
        const id = a.where?.id;
        if (mudaramAgora.size > 2000) mudaramAgora.clear(); // trava de segurança (Drive fora por horas)
        for (const x of typeof id === 'string' ? [id] : Array.isArray(id?.in) ? id.in : []) if (typeof x === 'string') mudaramAgora.add(x);
        pastaAcompanhaAgora();
      }
    }
    return r;
  });
}

type Linha = { id: string; accountId: string; name: string; status: 'OPEN' | 'WON' | 'LOST'; link: string; participante: string };
type Aberto = { id: string; name: string; nomes: string[]; link: string };
type Ctx = {
  areas: (accountId: string) => Promise<Area[]>;
  pastasEm: (accountId: string, pai: string) => Promise<{ id: string; name: string }[]>;
  abertos: (accountId: string) => Promise<Aberto[]>;
  movidas: Set<string>;
};

/** Leituras de uma passada (setores, pastas de LEADS ATIVOS/FRIOS, cards abertos), feitas uma vez só. */
function novoContexto(): Ctx {
  const cache = new Map<string, Promise<unknown>>();
  const memo = <T>(k: string, f: () => Promise<T>): Promise<T> => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k) as Promise<T>; };
  return {
    areas: (acc) => memo(`a:${acc}`, () => loadAreas(acc)),
    pastasEm: (acc, pai) => memo(`p:${pai}`, async () => (await listFoldersIn(acc, pai)).filter((f) => f.id).map((f) => ({ id: f.id!, name: f.name || '' }))),
    abertos: (acc) => memo(`o:${acc}`, async () => {
      const ls = await prisma.$queryRaw<{ id: string; name: string; status: string; funil: string; participante: string; link: string }[]>`
        SELECT l.id, l.name, l.status::text AS status, p.name AS funil,
          coalesce(l."customFields"->>'participante_1', '') AS participante, coalesce(l."customFields"->>'link_pasta_drive', '') AS link
        FROM "Lead" l JOIN "Pipeline" p ON p.id = l."pipelineId"
        WHERE l."accountId" = ${acc} AND l.archived = false AND l."isGroup" = false AND l.status::text = 'OPEN'`;
      return ls.filter((x) => situacaoDoCard(x.status, x.funil) === 'OPEN').map((x) => ({ id: x.id, name: x.name, nomes: nomesDoCard(x.name, x.participante), link: x.link }));
    }),
    movidas: new Set<string>(),
  };
}

export async function processDriveLifecycle(): Promise<void> {
  if (running) { deNovo = true; return; }
  running = true;
  try {
    const agora = [...mudaramAgora];
    // situação (status, ou funil Concluído/Perdidos) diferente da última já tratada (marcador ausente = era Aberto).
    // Card com link da pasta: sempre. Sem link: só se já foi marcado antes ou se a mudança é de agora.
    const rows = await prisma.$queryRaw<(Omit<Linha, 'status'> & { status: string; funil: string })[]>`
      SELECT id, "accountId", name, status, funil, link, participante FROM (
        SELECT l.id, l."accountId", l.name, l."updatedAt", l.status::text AS status, p.name AS funil,
          coalesce(l."customFields"->>'_pastaStatus', 'OPEN') AS marca,
          coalesce(l."customFields"->>'link_pasta_drive', '') AS link,
          coalesce(l."customFields"->>'participante_1', '') AS participante,
          coalesce(jsonb_exists(l."customFields", '_pastaStatus'), false) AS marcado
        FROM "Lead" l JOIN "Pipeline" p ON p.id = l."pipelineId"
        WHERE l."isGroup" = false
      ) x
      WHERE (CASE WHEN x.status IN ('WON', 'LOST') THEN x.status
                  WHEN upper(x.funil) LIKE 'CONCLU%' THEN 'WON'
                  WHEN upper(x.funil) LIKE 'PERDID%' THEN 'LOST' ELSE 'OPEN' END) <> x.marca
        AND (x.link <> '' OR x.marcado OR x.id = ANY(${agora}::text[]))
      ORDER BY x."updatedAt" DESC LIMIT 20`;
    // mudou mas a situação é a mesma (ex.: troca de funil entre abertos): sai da lista
    if (rows.length < 20) for (const id of agora) if (!rows.some((r) => r.id === id)) mudaramAgora.delete(id);
    if (!rows.length) return;
    const ctx = novoContexto();
    for (const r of rows) {
      try {
        await tratar({ ...r, status: situacaoDoCard(r.status, r.funil) }, ctx);
        mudaramAgora.delete(r.id);
      } catch (e: any) { console.warn(`[Pasta do card] ${r.name}:`, e?.message); }
    }
  } finally {
    running = false;
    if (deNovo) { deNovo = false; pastaAcompanhaAgora(); }
  }
}

/** Grava só a chave `_pastaStatus` (jsonb_set): regravar o customFields inteiro apagava o que outro processo gravou no meio-tempo. */
async function marcar(leadId: string, status: string) {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_pastaStatus}', ${JSON.stringify(status)}::jsonb, true) WHERE id = ${leadId}`;
}

async function tratar(r: Linha, ctx: Ctx) {
  const areas = await ctx.areas(r.accountId);
  const drive = await getDrive(r.accountId);
  const nota = (content: string) => prisma.note.create({ data: { leadId: r.id, type: 'COMMENT', content } }).catch(() => {});
  const saindo = r.status !== 'OPEN'; // Ganho/Perdido: sai de LEADS ATIVOS; reaberto: volta de LEADS FRIOS

  // 1) a pasta do link do card (apagada, na lixeira ou sem acesso = como se não tivesse link)
  const pastas: { id: string; nome: string; pai: string; peloNome: boolean }[] = [];
  const linkId = r.link ? extractFolderId(r.link) : '';
  if (linkId) {
    try {
      const d = (await drive.files.get({ fileId: linkId, fields: 'name,parents,trashed', supportsAllDrives: true })).data;
      if (!d.trashed && d.parents?.[0]) pastas.push({ id: linkId, nome: d.name || '', pai: d.parents[0], peloNome: false });
    } catch { /* procura pelo nome */ }
  }
  // 2) toda pasta com o nome EXATO do cliente no lugar de onde sai (2ª pasta "- SANTANDER", card sem link ou com link velho)
  const nomes = nomesDoCard(r.name, r.participante);
  const origens = areas.map((a) => (saindo ? a.ativos : a.frios)).filter((x): x is string => !!x);
  for (const pai of origens) {
    for (const f of await ctx.pastasEm(r.accountId, pai)) {
      if (!pastas.some((p) => p.id === f.id) && nomes.some((n) => mesmoNome(f.name, n))) pastas.push({ id: f.id, nome: f.name, pai, peloNome: true });
    }
  }

  const abertos = saindo && pastas.length ? await ctx.abertos(r.accountId) : [];
  for (const p of pastas) {
    const area = areas.find((a) => (saindo ? a.ativos : a.frios) === p.pai);
    if (!area || ctx.movidas.has(p.id)) continue; // fora de LEADS ATIVOS/FRIOS (ou já movida nesta passada): não mexe
    const como = p.peloNome ? ' (achei pelo nome do cliente)' : '';
    // Ganho/Perdido: pasta que também é de um card ABERTO (mesmo link ou mesmo nome — card repetido do cliente) fica onde está
    const dono = abertos.find((o) => o.id !== r.id && (o.link.includes(p.id) || o.nomes.some((n) => mesmoNome(p.nome, n))));
    if (dono) {
      await nota(`⚠️ A pasta "${p.nome}" ficou em LEADS ATIVOS (${area.nome}): ela também é do card aberto "${dono.name}". ${folderLink(p.id)}`);
      continue;
    }
    if (r.status === 'WON') {
      if (!area.concluidos) { await nota(`⚠️ Cliente ganho, mas não achei a pasta "CONCLUIDOS" de ${area.nome} no Drive — a pasta "${p.nome}" ficou em LEADS ATIVOS.`); continue; }
      const destino = await monthFolderFor(r.accountId, area.concluidos, new Date());
      await moveDriveItem(r.accountId, p.id, destino.id);
      await nota(`📁 Cliente ganho: a pasta "${p.nome}" foi pra CONCLUIDOS / ${destino.caminho} (${area.nome})${como}. ${folderLink(p.id)}`);
    } else if (r.status === 'LOST') {
      if (!area.frios) continue;
      await moveDriveItem(r.accountId, p.id, area.frios);
      await nota(`📁 Card perdido: a pasta "${p.nome}" saiu de LEADS ATIVOS e foi pra LEADS FRIOS (${area.nome})${como}. Se o card for reaberto, ela volta. ${folderLink(p.id)}`);
    } else {
      await moveDriveItem(r.accountId, p.id, area.ativos);
      await nota(`📁 Card reaberto: a pasta "${p.nome}" voltou de LEADS FRIOS pra LEADS ATIVOS (${area.nome})${como}. ${folderLink(p.id)}`);
    }
    ctx.movidas.add(p.id);
  }
  await marcar(r.id, r.status);
}

import { prisma } from '../lib/prisma';

/**
 * ARQUIVOS INCLUÍDOS NA PASTA DO DRIVE POR FORA DA CONVERSA (Fabio 16/11, Adriano: "coloca a IA para ler pastas novas que foram criadas e documentos incluídos de fora").
 * A equipe sobe a certidão, o IPTU, os documentos do vendedor… direto na pasta do cliente (ou numa subpasta nova). A conferência, o painel de documentos e a IA só conheciam
 * os anexos da conversa: o que entrava por fora ficava invisível e o CRM podia pedir de novo ao cliente.
 * Agora cada arquivo da pasta (subpastas inclusive) que NÃO veio da conversa, NÃO foi gerado pelo CRM e ainda não foi visto vira ANEXO de uma mensagem "Incluído na pasta do
 * Drive" (canal e-mail, já lida — como a proposta montada pelo CRM) e segue o caminho de qualquer anexo: leitura pela IA → conferência → pasta organizada. O anexo aponta pro
 * MESMO arquivo do Drive (nada é baixado de novo nem duplicado). Na etapa de documentação vale a conferência normal; nas outras, a conferência silenciosa (sem mensagem ao
 * cliente, sem mover o card), que atualiza o "o que falta" que a IA lê.
 * Gerado pelo CRM = marca appProperties.afcrm (uploadFile, desde 16/11). Antes disso, só conta como "de fora" o arquivo mexido por OUTRA conta do Google
 * (lastModifyingUser.me = false) — ou tudo, no botão/endpoint com `todos`.
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/** Arquivos criados depois disto sem a marca do CRM são de fora (antes, o CRM ainda não marcava os dele). */
const MARCA_DESDE = new Date('2026-11-16T21:00:00Z').getTime();
const MAX_BYTES = 25 * 1024 * 1024;
const TIPOS = /^(application\/pdf|image\/(jpeg|png|webp|gif))$/i;
/** Pastas que não são documento do cliente: repetidos/sem uso (organizador) e a minuta (minuta.service). */
const PASTA_FORA = /^(DESNECESSARIO|MINUTA)/i;
/** Arquivos que não são documento do cliente: simulações/evolução das parcelas, ficha cadastral, minuta, temporário do OCR. */
const NOME_FORA = /SIMULA|EVOLUCAO.?(DAS.?)?PARCELAS|FICHA CADASTRAL|MINUTA|^__OCR_TMP/i;
const semAcento = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');

type Arq = { id: string; name: string; mimeType: string; size: number; path: string; createdTime: string; doCrm: boolean; outraConta: boolean };

async function listar(accountId: string, rootId: string): Promise<Arq[]> {
  const { getDrive } = require('./google.service') as typeof import('./google.service');
  const drive = await getDrive(accountId);
  const out: Arq[] = [];
  async function walk(folderId: string, path: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let pageToken: string | undefined;
    do {
      const res: any = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, appProperties, lastModifyingUser(me))',
        pageSize: 200, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          if (!PASTA_FORA.test(semAcento(f.name))) await walk(f.id, path ? `${path} > ${f.name}` : f.name, depth + 1);
          continue;
        }
        out.push({ id: f.id, name: f.name, mimeType: f.mimeType, size: Number(f.size) || 0, path, createdTime: f.createdTime || '', doCrm: f.appProperties?.afcrm === '1', outraConta: f.lastModifyingUser?.me === false });
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  }
  await walk(rootId, '', 0);
  return out;
}

/** Os arquivos de fora ainda não vistos na pasta do card. Pura sobre a lista (testável). */
export function filtrarDeFora(arquivos: Arq[], conhecidos: Set<string>, todos = false, forcar: Set<string> = new Set()): Arq[] {
  return arquivos.filter((f) => !conhecidos.has(f.id) && TIPOS.test(f.mimeType) && f.size > 0 && f.size <= MAX_BYTES && !NOME_FORA.test(semAcento(f.name))
    // `forcar` = documentos que a EQUIPE anexou no card (documentos-equipe): o CRM sobe com a marca, mas são documentos do cliente e a conferência precisa ler (Marcos 19/11)
    && (forcar.has(f.id) || (!f.doCrm && (todos || new Date(f.createdTime).getTime() > MARCA_DESDE
      // de antes da marca: só o que OUTRA conta subiu nos últimos 7 dias (o 1º giro não despeja a pasta antiga inteira na leitura)
      || (f.outraConta && new Date(f.createdTime).getTime() > Date.now() - 7 * 86_400_000)))));
}

/** Procura na pasta do card os arquivos incluídos por fora e manda pra leitura. Devolve os nomes que entraram.
 *  `ids`: arquivos que entram mesmo tendo sido subidos pelo CRM (os que a equipe acabou de anexar pelo card). Os de `_documentosEquipe` entram sempre. */
export async function importarArquivosDeFora(accountId: string, leadId: string, io?: Io, opts: { todos?: boolean; ids?: string[] } = {}): Promise<{ novos: string[] }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, isGroup: true, customFields: true, stage: { select: { name: true } } } });
  if (!lead || lead.isGroup) return { novos: [] };
  const cf = (lead.customFields || {}) as Record<string, any>;
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) return { novos: [] };
  const { extractFolderId } = require('./google.service') as typeof import('./google.service');
  const arquivos = await listar(accountId, extractFolderId(link));
  const conhecidos = new Set<string>([
    ...(await prisma.messageAttachment.findMany({ where: { leadId, driveFileId: { not: null } }, select: { driveFileId: true } })).map((a) => a.driveFileId as string),
    ...(await prisma.certidaoRequest.findMany({ where: { leadId, driveFileId: { not: null } }, select: { driveFileId: true } })).map((c) => c.driveFileId as string),
    ...Object.keys((cf._driveDeFora || {}) as Record<string, unknown>),
  ]);
  // Documentos anexados pela equipe no card (Fabio 19/11, Marcos: CNH e comprovante subidos em 12/11 pelo card eram cobrados de novo — a conferência não lia).
  const daEquipe = (Array.isArray(cf._documentosEquipe) ? cf._documentosEquipe : []).map((d: any) => String(d?.id || '')).filter(Boolean);
  const candidatos = filtrarDeFora(arquivos, conhecidos, !!opts.todos, new Set<string>([...(opts.ids || []), ...daEquipe]));
  if (!candidatos.length) return { novos: [] };

  // Pega a vez arquivo por arquivo (poller e botão juntos, dois servidores no deploy): só quem gravou a chave nova em _driveDeFora cria o anexo.
  const meus: Arq[] = [];
  for (const f of candidatos) {
    const marca = JSON.stringify({ [f.id]: { nome: f.name.slice(0, 120), pasta: f.path.slice(0, 80), em: new Date().toISOString() } });
    const n = await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_driveDeFora}', COALESCE("customFields"->'_driveDeFora', '{}'::jsonb) || ${marca}::jsonb, true)
      WHERE id = ${leadId} AND NOT jsonb_exists(COALESCE("customFields"->'_driveDeFora', '{}'::jsonb), ${f.id})`;
    if (n) meus.push(f);
  }
  if (!meus.length) return { novos: [] };

  const nomes = meus.map((f) => (f.path ? `${f.path} / ${f.name}` : f.name));
  const content = `📧 Incluído na pasta do Drive\n${nomes.map((n) => `📎 ${n}`).join('\n')}\n\nOrigem: arquivos incluídos na pasta do Drive do cliente fora da conversa (pela equipe ou por outro caminho) — o CRM lê e confere como os documentos da conversa. O cliente não mandou por aqui.`;
  const msg = await prisma.message.create({ data: { content, direction: 'INBOUND', channel: 'EMAIL', leadId, status: 'SENT', read: true } });
  for (const f of meus) {
    await prisma.messageAttachment.create({ data: { messageId: msg.id, leadId, fileName: f.name, mimeType: f.mimeType, data: null, driveFileId: f.id } });
  }
  const completo = await prisma.message.findUnique({ where: { id: msg.id }, include: { attachments: { select: { id: true, fileName: true, mimeType: true } }, sentBy: { select: { id: true, name: true } } } });
  io?.to?.(`lead:${leadId}`)?.emit?.('new_message', completo);

  const { etapaConfere, scheduleDocsCheck } = require('./docs-checker.service') as typeof import('./docs-checker.service');
  const naDocumentacao = etapaConfere(lead.stage?.name || '', cf);
  if (naDocumentacao) await scheduleDocsCheck(accountId, leadId, io as any).catch(() => {});
  else {
    // Fora da etapa de documentação: conferência silenciosa (a do botão "Conferir documentos" — sem mensagem ao cliente, sem mover o card), 2 min depois.
    const due = JSON.stringify(new Date(Date.now() + 2 * 60_000).toISOString());
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsRelerDue}', ${due}::jsonb, true) WHERE id = ${leadId}`.catch(() => {});
  }
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📁 ${meus.length} arquivo(s) incluído(s) na pasta do Drive fora da conversa entraram na leitura de documentos${naDocumentacao ? '' : ' (conferência silenciosa: nada vai pro cliente e o card não sai do lugar)'}: ${nomes.slice(0, 30).join('; ')}${nomes.length > 30 ? ` e mais ${nomes.length - 30}` : ''}.` } }).catch(() => {});
  return { novos: nomes };
}

let rodando = false;
/** Vigia (07h–22h, a cada 15 min): cards abertos com pasta no Drive, da documentação em diante (Aguardando Documentação, Análise CAIXA e o funil "Em contratação"),
 *  mexidos nos últimos 30 dias. */
export async function vigiarPastasDeFora(io?: Io): Promise<void> {
  if (rodando) return;
  const h = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
  if (h < 7 || h >= 22) return;
  rodando = true;
  try {
    const leads = await prisma.$queryRaw<{ id: string; accountId: string }[]>`
      SELECT l.id, l."accountId" FROM "Lead" l JOIN "Stage" st ON st.id = l."stageId" JOIN "Pipeline" p ON p.id = l."pipelineId"
      WHERE l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false AND COALESCE(l."customFields"->>'link_pasta_drive', '') <> ''
        AND l."updatedAt" > now() - interval '30 days'
        AND (p.name ILIKE 'Em contrata%' OR st.name ILIKE '%aguardando documenta%' OR st.name ILIKE 'an_lise caixa%')
      ORDER BY l."updatedAt" DESC LIMIT 60`;
    for (const l of leads) {
      try { await importarArquivosDeFora(l.accountId, l.id, io); } catch (e: any) { console.warn(`[Drive de fora] ${l.id}:`, e?.message || e); }
    }
  } finally { rodando = false; }
}

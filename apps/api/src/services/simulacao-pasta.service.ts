/**
 * UMA SIMULAÇÃO NA PASTA (Fabio 12/11): "a pasta só deve ter uma simulação, ou seja a que o cliente irá seguir — qualquer banco, HE e FH".
 * Na raiz da pasta do cliente fica a simulação MAIS NOVA de cada banco; depois que o cliente escolheu o banco (campo "Instituição" do card — ⭐ / "Seguir com esta"),
 * só a desse banco. As outras vão pra subpasta DESNECESSARIO ("ANTERIOR - …"; conteúdo idêntico = "REPETIDO - …") — nunca apaga. Cliente pediu outro prazo →
 * só simulação nova (a proposta continua), e a do prazo antigo sai da raiz. Os arquivos movidos ficam em `_simulacoesForaDaPasta` pro organizador não trazê-los de volta.
 */
import { prisma } from '../lib/prisma';

/** Arquivo de simulação: o que a equipe manda ("simulacao CAIXA.pdf", "EVOLUCAO_PARCELAS_INTER…"), o PDF do botão ("AeF_INTER_fulano.pdf") e o da CAIXA ("SIMULACAO CAIXA …"). */
export const SIMULACAO_ARQUIVO_RE = /simula|evolu[cç][aã]o[ _-]*(das[ _-]*)?parcelas|^AeF_/i;

const sem = (s: string) => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Banco do arquivo pelo nome ('' = não deu pra saber). "AeF_FH_ITAU_…" → ITAU; "SIMULACAO CAIXA SBPE …" → CAIXA. Também serve pro campo "Instituição" do card. */
export function bancoDoArquivo(nome: string): string {
  const n = sem(nome);
  const aef = /^AEF_(?:FH_)?([A-Z]+)/.exec(n);
  if (aef) return aef[1];
  const tem = (re: string) => new RegExp(`(^|[^A-Z])(${re})([^A-Z]|$)`).test(n);
  if (tem('CAIXA|CEF')) return 'CAIXA';
  if (tem('SANTANDER')) return 'SANTANDER';
  if (tem('INTER')) return 'INTER';
  if (tem('CREDITAS')) return 'CREDITAS';
  if (tem('ITAU')) return 'ITAU';
  if (tem('BRADESCO')) return 'BRADESCO';
  if (tem('BRB')) return 'BRB';
  return '';
}

export type ArquivoSimulacao = { id: string; nome: string; md5?: string; criado: string };
export type Motivo = 'ANTERIOR' | 'REPETIDO';

/** Quais simulações saem da raiz. Pura (testável). `nova` = a que acabou de ser salva: sempre fica. `seguido` = banco que o cliente escolheu (null = ainda comparando). */
export function quaisSaem(files: ArquivoSimulacao[], o: { seguido?: string | null; nova?: string | null } = {}): { id: string; nome: string; motivo: Motivo }[] {
  const ord = [...files].sort((a, b) => Number(b.id === o.nova) - Number(a.id === o.nova) || String(b.criado).localeCompare(String(a.criado)));
  const sai = new Map<string, Motivo>();
  // 1) Mesmo conteúdo (md5 do Drive): fica um — a nova, senão a de nome nosso (não "AeF_…"), senão a mais nova.
  const porMd5 = new Map<string, ArquivoSimulacao[]>();
  for (const f of ord) if (f.md5) porMd5.set(f.md5, [...(porMd5.get(f.md5) || []), f]);
  for (const g of porMd5.values()) {
    if (g.length < 2) continue;
    const fica = g.find((f) => f.id === o.nova) || g.find((f) => !/^AeF_/i.test(f.nome)) || g[0];
    for (const f of g) if (f !== fica) sai.set(f.id, 'REPETIDO');
  }
  // 2) Por banco: fica a mais nova de cada um.
  const ficam: ArquivoSimulacao[] = [];
  const vistos = new Set<string>();
  for (const f of ord) {
    if (sai.has(f.id)) continue;
    const b = bancoDoArquivo(f.nome);
    if (vistos.has(b)) sai.set(f.id, 'ANTERIOR');
    else { vistos.add(b); ficam.push(f); }
  }
  // 3) Cliente já escolheu o banco (e tem simulação dele): só a dele — a nova fica mesmo se for de outro banco (acabou de ser feita).
  if (o.seguido && ficam.some((f) => bancoDoArquivo(f.nome) === o.seguido)) {
    for (const f of ficam) if (bancoDoArquivo(f.nome) !== o.seguido && f.id !== o.nova) sai.set(f.id, 'ANTERIOR');
  }
  return files.filter((f) => sai.has(f.id)).map((f) => ({ id: f.id, nome: f.nome, motivo: sai.get(f.id)! }));
}

/** Nome do arquivo na DESNECESSARIO (sem prefixo em dobro). */
export function nomeForaDaPasta(nome: string, motivo: Motivo): string {
  return /^(ANTERIOR|REPETIDO) - /i.test(nome) ? nome : `${motivo} - ${nome}`;
}

/** Aplica a regra na raiz da pasta do cliente (link "Pasta no Drive"). Devolve os nomes que foram pra DESNECESSARIO. `nota: false` = quem chamou escreve a nota. */
export async function manterUmaSimulacao(accountId: string, leadId: string, o: { nova?: string | null; nota?: boolean } = {}): Promise<string[]> {
  const cf = (((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields) || {}) as Record<string, any>;
  const pasta = String(cf.link_pasta_drive || '').trim();
  if (!pasta) return [];
  const google = await import('./google.service');
  const folderId = google.extractFolderId(pasta);
  const drive = await google.getDrive(accountId);
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    fields: 'files(id, name, md5Checksum, createdTime)',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const sims = (res.data.files || [])
    .filter((f) => f.id && f.name && SIMULACAO_ARQUIVO_RE.test(f.name))
    .map((f) => ({ id: f.id!, nome: f.name!, md5: f.md5Checksum || undefined, criado: f.createdTime || '' }));
  const saem = quaisSaem(sims, { seguido: bancoDoArquivo(String(cf.instituicao || '')) || null, nova: o.nova });
  if (!saem.length) return [];
  const destino = (await google.createFolder(accountId, 'DESNECESSARIO', folderId)).id;
  const movidos: string[] = [];
  const marcados: Record<string, Motivo> = {};
  for (const s of saem) {
    const nome = nomeForaDaPasta(s.nome, s.motivo);
    try {
      await drive.files.update({ fileId: s.id, addParents: destino, removeParents: folderId, requestBody: { name: nome }, fields: 'id', supportsAllDrives: true });
      movidos.push(nome);
      marcados[s.id] = s.motivo;
    } catch (e: any) {
      console.error(`[Simulação na pasta] não movi ${s.nome}:`, e?.message);
    }
  }
  if (Object.keys(marcados).length) {
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || jsonb_build_object('_simulacoesForaDaPasta', COALESCE("customFields"->'_simulacoesForaDaPasta', '{}'::jsonb) || ${JSON.stringify(marcados)}::jsonb) WHERE id = ${leadId}`;
  }
  if (movidos.length && o.nota !== false) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📁 Uma simulação só na pasta (a que o cliente vai seguir): ${movidos.join(', ')} ${movidos.length > 1 ? 'foram' : 'foi'} pra DESNECESSARIO.` } }).catch(() => {});
  }
  return movidos;
}

/** PDF de simulação mandado ao cliente pelo botão/aviso: o anexo sobe pro Drive na pasta técnica do WhatsApp (em segundo plano) — espera o upload, leva pra raiz
 *  da pasta do cliente e aplica a regra. Sem "Pasta no Drive" no card: fica onde está (o organizador traz depois). */
export async function levarSimulacaoPraPasta(accountId: string, leadId: string, attachmentId: string): Promise<void> {
  let driveId: string | null = null;
  for (let i = 0; i < 12 && !driveId; i++) {
    driveId = (await prisma.messageAttachment.findUnique({ where: { id: attachmentId }, select: { driveFileId: true } }))?.driveFileId || null;
    if (!driveId) await new Promise((r) => setTimeout(r, 5000));
  }
  if (!driveId) return;
  const cf = (((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields) || {}) as Record<string, any>;
  const pasta = String(cf.link_pasta_drive || '').trim();
  if (!pasta) return;
  const google = await import('./google.service');
  const folderId = google.extractFolderId(pasta);
  const drive = await google.getDrive(accountId);
  const atual = await drive.files.get({ fileId: driveId, fields: 'parents', supportsAllDrives: true });
  const tirar = (atual.data.parents || []).filter((p) => p !== folderId).join(',');
  if (tirar || !(atual.data.parents || []).includes(folderId)) {
    await drive.files.update({ fileId: driveId, addParents: folderId, ...(tirar ? { removeParents: tirar } : {}), fields: 'id', supportsAllDrives: true });
  }
  await manterUmaSimulacao(accountId, leadId, { nova: driveId });
}

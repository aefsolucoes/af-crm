import { prisma } from '../lib/prisma';

/**
 * CONFERÊNCIA DE DOCUMENTOS CORTADA PELO DEPLOY (Fabio 12/11: card com 33 arquivos saídos de um zip — a conferência foi cortada 4 vezes seguidas pelo reinício
 * do servidor e só terminou na 5ª). A automática apaga `_docsCheckDue` antes de rodar e a leitura só era gravada no fim: reiniciou no meio, perdia tudo e
 * não voltava sozinha; o botão "Conferir documentos" também morria calado.
 *
 * Enquanto roda, a conferência deixa a marca no card — `_docsConferindo` (a automática, que fala com o cliente e move o card) ou `_docsConferindoBotao` (a
 * silenciosa: botão e releitura) — com { at, n, por }. Terminou (com ou sem erro) → a marca sai. Marca com horário de ANTES de o servidor subir = conferência
 * cortada pelo reinício → `retomarConferenciasInterrompidas` roda de novo; a leitura que já tinha saído foi guardada arquivo por arquivo (`_docReviewParcial`,
 * doc-review.service; `_docInfo`, received-docs.service) e não é paga de novo. Até 3 tentativas: na 3ª queda seguida, anotação + push pra equipe.
 */

export type ModoConferencia = 'auto' | 'botao';
type Marca = { at: string; n: number; por?: string };
const CHAVE: Record<ModoConferencia, string> = { auto: '_docsConferindo', botao: '_docsConferindoBotao' };
export const MAX_TENTATIVAS_CONFERENCIA = 3;
const SERVER_BOOT_AT = Date.now();

/** Põe a marca (só a chave dela, por SQL — ver customfields-write-race) e devolve o horário que a identifica. */
export async function marcarConferencia(leadId: string, modo: ModoConferencia, opts: { n?: number; por?: string } = {}): Promise<string> {
  const marca: Marca = { at: new Date().toISOString(), n: Math.max(1, opts.n || 1), ...(opts.por ? { por: opts.por } : {}) };
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), ${`{${CHAVE[modo]}}`}::text[], ${JSON.stringify(marca)}::jsonb, true) WHERE id = ${leadId}`
    .catch((e: any) => console.warn('[Docs] marca da conferência:', e?.message));
  return marca.at;
}

/** Tira a marca — só a SUA (outra conferência do mesmo card que começou depois deixa a dela). */
export async function desmarcarConferencia(leadId: string, modo: ModoConferencia, at: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - ${CHAVE[modo]}::text WHERE id = ${leadId} AND "customFields"->${CHAVE[modo]}::text->>'at' = ${at}`
    .catch((e: any) => console.warn('[Docs] tirar a marca da conferência:', e?.message));
}

/** O que fazer com uma marca encontrada no boot. Pura. `antesDoBoot`: só marca de antes de o servidor subir foi cortada (a de depois é deste servidor). */
export function decidirRetomada(marca: Partial<Marca> | null | undefined, bootIso: string, agora: number): 'RETOMAR' | 'DESISTIR' | 'VELHA' | 'IGNORAR' {
  if (!marca?.at || !(marca.at < bootIso)) return 'IGNORAR';
  if (agora - Date.parse(marca.at) > 12 * 3_600_000) return 'VELHA'; // servidor parado meio dia: não retoma conferência de outro momento
  return (Number(marca.n) || 1) >= MAX_TENTATIVAS_CONFERENCIA ? 'DESISTIR' : 'RETOMAR';
}

/** Ao subir o servidor (index.ts, 150 s depois — o servidor antigo já parou): conferências que o reinício cortou rodam de novo, uma por vez. */
export async function retomarConferenciasInterrompidas(io: any): Promise<void> {
  const boot = new Date(SERVER_BOOT_AT).toISOString();
  for (const modo of ['auto', 'botao'] as ModoConferencia[]) {
    const chave = CHAVE[modo];
    const leads = await prisma.$queryRaw<{ id: string; accountId: string; name: string; marca: Marca }[]>`SELECT id, "accountId", name, "customFields"->${chave}::text AS marca FROM "Lead" WHERE "customFields"->${chave}::text->>'at' < ${boot}`;
    for (const l of leads) {
      // Tira a marca antes (atômico): roda uma vez só por card, mesmo com dois servidores no ar durante o deploy.
      const pegou = await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - ${chave}::text WHERE id = ${l.id} AND "customFields"->${chave}::text->>'at' = ${l.marca?.at || ''}`;
      if (!pegou) continue;
      const decisao = decidirRetomada(l.marca, boot, Date.now());
      const n = Number(l.marca?.n) || 1;
      if (decisao === 'VELHA' || decisao === 'IGNORAR') continue;
      if (decisao === 'DESISTIR') {
        await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `⚠️ A conferência de documentos${modo === 'auto' ? '' : ' (botão)'} foi interrompida ${n} vezes seguidas pelo reinício do servidor e o CRM parou de tentar. Clique em "Conferir documentos" quando der.` } }).catch(() => {});
        (require('./push.service') as typeof import('./push.service')).sendPushToAccount(l.accountId, { title: `⚠️ ${l.name}: conferência de documentos`, body: 'Interrompida pelo reinício do servidor — clique em "Conferir documentos"', leadId: l.id }).catch(() => {});
        continue;
      }
      const docs = require('./docs-checker.service') as typeof import('./docs-checker.service');
      console.log(`[Docs] ${l.name} (${l.id}): conferência ${modo === 'auto' ? 'automática' : 'do botão'} cortada pelo reinício do servidor — rodando de novo (tentativa ${n + 1})`);
      try {
        if (modo === 'auto') {
          // Documento novo chegou depois do corte: o poller já vai conferir com tudo junto — não roda duas ao mesmo tempo.
          const fresh = await prisma.lead.findUnique({ where: { id: l.id }, select: { status: true, customFields: true } });
          if (fresh?.status !== 'OPEN' || (fresh.customFields as any)?._docsCheckDue) continue;
          const at = await marcarConferencia(l.id, 'auto', { n: n + 1 });
          try { await docs.checkDocsComplete(l.accountId, l.id, io); } finally { await desmarcarConferencia(l.id, 'auto', at); }
        } else {
          await docs.conferirDocumentosAgora(l.accountId, l.id, l.marca?.por || 'CRM', io, { tentativa: n + 1 });
        }
      } catch (e: any) {
        console.error(`[Docs] retomada da conferência ${l.id}:`, e?.message || e);
      }
    }
  }
}

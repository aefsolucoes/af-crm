import { prisma } from '../lib/prisma';

/** PENDÊNCIAS DA IA DESLIGADA (Fabio 05/11: "sempre que eu ativar a IA no card do cliente, a IA leia toda a conversa e saiba o que fazer… não só nessa etapa, mas também
 *  em outras"). Fluxo que ia falar com o cliente e não falou porque a IA do card estava desligada guarda aqui O QUE ficou por dizer (em `customFields._pendenteIa`, uma
 *  entrada por assunto). Ao religar a IA, `retomarComIa` (whatsapp.service) lê a conversa inteira + estas pendências e manda UMA mensagem retomando o que ainda faltar
 *  (o que a equipe já tratou na conversa fica de fora). */

export type PendenciaIa = { em: string; o: string };

/** Guarda (ou atualiza) a pendência `chave`. Nunca lança. */
export async function guardarPendenciaIa(leadId: string, chave: string, oQue: string): Promise<void> {
  const p: PendenciaIa = { em: new Date().toISOString(), o: oQue.replace(/\s+/g, ' ').trim().slice(0, 600) };
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || jsonb_build_object('_pendenteIa', COALESCE("customFields"->'_pendenteIa', '{}'::jsonb) || jsonb_build_object(${chave}::text, ${JSON.stringify(p)}::jsonb)) WHERE id = ${leadId}`.catch((e: any) => console.error('[Pendência IA]', e?.message));
}

export async function lerPendenciasIa(leadId: string): Promise<Record<string, PendenciaIa>> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  return (((l?.customFields || {}) as Record<string, any>)._pendenteIa || {}) as Record<string, PendenciaIa>;
}

export async function limparPendenciasIa(leadId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) - '_pendenteIa' WHERE id = ${leadId}`.catch(() => {});
}

/** Fluxos que, com a IA desligada, ficaram marcados como "com a equipe" e pararam de andar: ao religar, voltam a andar sozinhos (cada poller retoma no próximo minuto).
 *  - perguntas que ficaram com a equipe SÓ porque a IA estava desligada (renda do casal, ocorrências no nome — `porIa`) → PENDING;
 *  - pedidos marcados "equipe (IA do card desligada)" (averbar a quitação, transferir o imóvel, dados do laudo) → marcador apagado.
 *  O resto (cadastro divergente, SCR, avisos prontos…) volta pelas pendências (`guardarPendenciaIa`). */
export async function destravarFluxosIa(leadId: string): Promise<string[]> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (l?.customFields || {}) as Record<string, any>;
  const feitos: string[] = [];
  for (const k of ['_rendaCasal', '_ocorrencias']) {
    if (cf[k]?.status === 'EQUIPE' && cf[k]?.porIa === true) {
      await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(jsonb_set("customFields", ARRAY[${k}::text, 'status'], '"PENDING"'::jsonb, true), ARRAY[${k}::text, 'porIa'], 'false'::jsonb, true) WHERE id = ${leadId}`;
      feitos.push(k);
    }
  }
  for (const [k, campo] of [['_quitacaoAverbar', 'teamAt'], ['_transferenciaAsk', 'teamNotifiedAt'], ['_laudoAsk', 'teamAt']] as const) {
    if (cf[k]?.[campo] && /IA do card desligada/i.test(String(cf[k]?.por || ''))) {
      await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" #- ARRAY[${k}::text, ${campo}::text] WHERE id = ${leadId}`;
      feitos.push(k);
    }
  }
  return feitos;
}

import { prisma } from '../lib/prisma';

/**
 * CHAVE GERAL DOS PASSOS AUTOMÁTICOS DA CONTRATAÇÃO (Fabio 22/10: "vamos seguir os passos manuais, por enquanto; quando tudo estiver certinho a gente coloca no automático").
 * Desligada (padrão): o CRM NÃO manda mensagem ao cliente nem e-mail ao banco por conta própria nos passos abaixo — deixa uma nota + push na equipe, com o texto pronto, e a equipe faz à mão.
 * Ligada: o comportamento automático de sempre (código todo preservado, é só ligar em Análise de Crédito).
 * Passos cobertos: solicitar a vistoria (Inter e Santander) e a pergunta "seguir com a proposta" do Inter; perguntar ao cliente as 4 informações do laudo do apartamento e preencher o laudo na fila da extensão;
 * pedir a transferência do imóvel; pedir a averbação do termo de quitação; a triagem da CAIXA depois da aprovação; a oferta e o pedido da certidão pelo ONR (o botão "Pedir certidão pelo ONR" do card vale sempre).
 * Não cobre: as reconferências/re-execuções das análises (cobrança do cliente e 8h), o aviso de aprovação e a conversa normal da IA com o cliente.
 */

const TTL_MS = 20_000;
const cache = new Map<string, { at: number; on: boolean }>();

/** PILOTO POR CARD (Fabio 13/11, Vicente: "vamos colocar o CRM para fazer esse processo sozinho, será nosso primeiro processo do Santander rodando automático"): o card com
 *  `_contratacaoAuto` roda os passos da contratação no automático mesmo com a chave geral desligada. Quem chama passa o leadId. */
export async function contractingAutoOn(accountId: string, leadId?: string): Promise<boolean> {
  if (leadId && (await pilotoContratacao(leadId))) return true;
  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.on;
  const s = await prisma.creditAutoSetting.findUnique({ where: { accountId }, select: { contractingAuto: true } });
  const on = !!s?.contractingAuto;
  cache.set(accountId, { at: Date.now(), on });
  return on;
}

/** O card está no piloto da contratação automática? */
export async function pilotoContratacao(leadId: string): Promise<boolean> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  return !!((l?.customFields || {}) as Record<string, any>)._contratacaoAuto?.on;
}

/** Liga/desliga o piloto num card (só a chave, por SQL) + nota. */
export async function setPilotoContratacao(leadId: string, on: boolean, por: string): Promise<void> {
  if (on) {
    const v = JSON.stringify({ on: true, por, at: new Date().toISOString() });
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_contratacaoAuto}', ${v}::jsonb, true) WHERE id = ${leadId}`;
  } else await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_contratacaoAuto' WHERE id = ${leadId}`;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: on
    ? `🚀 Contratação AUTOMÁTICA ligada só neste card (piloto, por ${por}): os passos da contratação (vistoria, certidão, laudo, transferência…) saem sozinhos daqui pra frente; quando o CRM ficar em dúvida de como seguir, a equipe recebe push.`
    : `⏸️ Piloto da contratação automática desligado neste card (por ${por}): os passos voltam a seguir a chave geral.` } }).catch(() => {});
}

export function resetContractingAutoCache(accountId: string): void {
  cache.delete(accountId);
}

export async function setContractingAuto(accountId: string, on: boolean, userId?: string): Promise<void> {
  await prisma.creditAutoSetting.upsert({
    where: { accountId },
    create: { accountId, enabled: false, contractingAuto: on, updatedById: userId || null },
    update: { contractingAuto: on, updatedById: userId || null },
  });
  resetContractingAutoCache(accountId);
}

/**
 * Passo manual: uma nota (+ push, se pedido) por card e por passo — nunca repete. O registro fica em customFields._manualSteps[passo].
 * Devolve true se avisou agora, false se já tinha avisado antes.
 */
export async function manualStep(opts: { accountId: string; leadId: string; leadName: string; step: string; note: string; pushTitle?: string; pushBody?: string }): Promise<boolean> {
  const fresh = await prisma.lead.findUnique({ where: { id: opts.leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  const done = { ...((cf._manualSteps || {}) as Record<string, string>) };
  if (done[opts.step]) return false;
  done[opts.step] = new Date().toISOString();
  cf._manualSteps = done;
  await prisma.lead.update({ where: { id: opts.leadId }, data: { customFields: cf as any } });
  await prisma.note.create({ data: { leadId: opts.leadId, type: 'COMMENT', content: opts.note } }).catch(() => {});
  if (opts.pushTitle) {
    try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(opts.accountId, { title: opts.pushTitle, body: opts.pushBody || opts.leadName, leadId: opts.leadId }).catch(() => {}); } catch { /* aviso */ }
  }
  return true;
}

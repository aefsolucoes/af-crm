import { prisma } from '../lib/prisma';

/* Resultado da Avaliação de Risco da CAIXA. A tela do envio só dá o número da proposta (Fabio 01/11: "O RESULTADO NÃO SAI NESSA TELA, PRECISA CONSULTAR
 * DEPOIS" e "PARA CONSULTAR O RESULTADO, PRECISA VOLTAR NO MENU E IR EM FORMULÁRIOS ENVIADOS"): Consulta de Formulários Enviados → Buscar por CPF →
 * Consultar. A extensão Cadastro Caixa consulta pelo CPF do tomador e devolve a tela. 1ª fase: só sob pedido, e a tela vira nota pra mapear onde fica o
 * resultado. Fica em _caixaResultado, fora de _caixaCadastro (a fila do cadastro regrava aquela chave inteira). */

type Cf = Record<string, any>;
const LEASE_MS = 10 * 60_000;

async function salvar(leadId: string, mut: (r: Cf) => void): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const r: Cf = { ...(((l?.customFields || {}) as Cf)._caixaResultado || {}) };
  mut(r);
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaResultado}', ${JSON.stringify(r)}::jsonb, true) WHERE id = ${leadId}`;
}

/** Tomador da avaliação = 1º participante da ficha de cadastro. */
function tomador(cf: Cf): { nome: string; cpf: string } | null {
  const ps: any[] = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  const p = ps.find((x, i) => (Number(x?.ordem) || i + 1) === 1);
  return p ? { nome: String(p.nome || ''), cpf: String(p.cpf || '').replace(/\D/g, '') } : null;
}

/** Botão/pedido "consultar o resultado": só pra avaliação já ENVIADA à CAIXA. Erro em texto quando não dá. */
export async function pedirConsultaResultado(accountId: string, leadId: string, por: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  if (!/^ENVIADA/i.test(String(cf._caixaCadastro?.avaliacao?.status || ''))) return 'A Avaliação de Risco deste card ainda não foi enviada à CAIXA';
  if (tomador(cf)?.cpf.length !== 11) return 'Sem o CPF do tomador na ficha de cadastro';
  await salvar(leadId, (r) => { r.status = 'FILA'; r.pedidoEm = new Date().toISOString(); r.por = por; r.tentativas = 0; delete r.inicio; });
  return null;
}

/** Próxima consulta de resultado pra extensão (a fila da CAIXA chama quando não há consulta/cadastro/avaliação). FILA, ou RODANDO largada há mais de 10 min
 *  (até 3 tentativas). */
export async function proximaConsultaResultado(accountId: string) {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaResultado'->>'status' IN ('FILA', 'RODANDO')
    ORDER BY "customFields"->'_caixaResultado'->>'pedidoEm' ASC LIMIT 10`;
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true } });
    const cf = (l?.customFields || {}) as Cf;
    const r = cf._caixaResultado || {};
    if (r.status === 'RODANDO' && !(r.inicio && Date.now() - Date.parse(r.inicio) > LEASE_MS && (r.tentativas || 0) < 3)) continue;
    const t = tomador(cf);
    if (!t || t.cpf.length !== 11) continue;
    await salvar(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; });
    return { tipo: 'consultarAvaliacao', leadId: id, leadName: l!.name, ordem: 1, nome: t.nome, cpf: t.cpf };
  }
  return null;
}

/** Tela da Consulta de Formulários Enviados que a extensão devolveu: guarda, anota no card e avisa por push. */
export async function gravarConsultaResultado(accountId: string, leadId: string, r: { status: string; texto: string }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!l) return;
  await salvar(leadId, (x) => { x.status = r.status; x.fim = new Date().toISOString(); x.ultimaTela = String(r.texto || '').slice(0, 3000); });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Resultado da Avaliação de Risco CAIXA (Formulários Enviados): ${r.status}\n\n${String(r.texto || '').slice(0, 3500)}` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  // "2ª autorização do PV" (Fabio 01/11): o cliente rodou crédito mais de uma vez, com correspondentes diferentes — o colaborador pede a autorização à agência.
  if (/autoriza[cç][aã]o do PV/i.test(`${r.status}\n${r.texto}`)) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '⚠️ A CAIXA pede a 2ª AUTORIZAÇÃO DO PV (agência): o cliente rodou crédito mais de uma vez, com correspondentes diferentes. Solicite a autorização à agência para seguir com a avaliação.' } }).catch(() => {});
    sendPushToAccount(accountId, { title: `⚠️ ${l.name}: pedir autorização à agência (PV)`, body: 'A CAIXA pede a 2ª autorização do PV: solicite à agência para seguir com a avaliação.', leadId }).catch(() => {});
    return;
  }
  sendPushToAccount(accountId, { title: `🏦 ${l.name}: resultado da avaliação CAIXA`, body: r.status.slice(0, 120), leadId }).catch(() => {});
}

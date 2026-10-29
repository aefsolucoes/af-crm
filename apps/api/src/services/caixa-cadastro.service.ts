import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/* Fila do cadastro na CAIXA (Fabio 29/10: "quero que o CRM indique qual cliente rodar"). A extensão "Cadastro CAIXA (Caixa Aqui)" pergunta a fila a cada minuto.
 * Ordem da CAIXA (Fabio 29/10): (1) consultar o nome de cada participante em Oportunidades de Negócios; (2) limpo → cadastrar 1º e 2º participante (2º sem renda:
 * "SEM RENDA" e salvar); (3) análise de crédito. Os dados vêm da ficha de cadastro (`_fichaCadastral`, lida dos documentos do Drive).
 * Estado no card: `_caixaCadastro` = { status: FILA | CONSULTADO, pedidoEm, por, consultas: { [ordem]: { at, texto } }, atual?: { ordem, desde } }.
 * Entra na fila: pela equipe (POST /api/leads/:id/caixa-cadastro) ou sozinho quando a ficha está pronta e o cliente vai pela CAIXA
 * (Financiamento: "Sim, quero" à CAIXA/BRB; Home Equity: reaberto pela CAIXA). */

type Cf = Record<string, any>;
const LEASE_MS = 10 * 60_000; // participante "em consulta" há mais que isso = a extensão largou; volta pra fila

async function salvar(leadId: string, mut: (c: Cf) => void): Promise<Cf> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((l?.customFields || {}) as Cf) };
  const c: Cf = { ...(cf._caixaCadastro || {}) };
  mut(c);
  cf._caixaCadastro = c;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
  return c;
}

const participantesDa = (cf: Cf): any[] => {
  const ps = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  return ps.map((p: any, i: number) => {
    const n = Number(p.ordem) || i + 1;
    return { ...p, ordem: n, cpf: String(p.cpf || cf[`cpf_${n}`] || '').replace(/\D/g, ''), telefone: cf[`telefone_${n}`] || '', email: cf[`email_${n}`] || '' };
  });
};

/** Coloca o card na fila. Erro em texto quando não dá. */
export async function pedirCadastroCaixa(accountId: string, leadId: string, por: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  if (!participantesDa(cf).length) return 'O card ainda não tem a ficha de cadastro (anotação "📋 FICHA DE CADASTRO — CAIXA")';
  await salvar(leadId, (c) => { c.status = 'FILA'; c.pedidoEm = new Date().toISOString(); c.por = por; c.consultas = {}; delete c.atual; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Card na fila da CAIXA (${por}): a extensão vai consultar o nome de cada participante em Oportunidades de Negócios e gravar o resultado aqui.` } }).catch(() => {});
  logActivity({ accountId, userId: null, userName: por, action: 'lead_edited', leadId, leadName: l.name, summary: 'colocou o card na fila do cadastro da CAIXA' } as any);
  return null;
}

/** Próximo trabalho da extensão: o 1º participante ainda sem consulta do card mais antigo na fila. Marca como "em consulta" (10 min). */
export async function proximaConsulta(accountId: string): Promise<any | null> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaCadastro'->>'status' = 'FILA'
    ORDER BY "customFields"->'_caixaCadastro'->>'pedidoEm' ASC LIMIT 10`;
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true } });
    const cf = (l?.customFields || {}) as Cf;
    const c = cf._caixaCadastro || {};
    if (c.atual && Date.now() - Date.parse(c.atual.desde) < LEASE_MS) return null; // um por vez: espera o que está em andamento
    const p = participantesDa(cf).find((x) => !c.consultas?.[x.ordem]);
    if (!p) continue;
    if (p.cpf.length !== 11) {
      await salvar(id, (x) => { x.consultas = { ...(x.consultas || {}), [p.ordem]: { at: new Date().toISOString(), texto: 'SEM CPF na ficha nem no card — consulta não feita' } }; });
      await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: `⚠️ CAIXA: ${p.nome || `${p.ordem}º participante`} sem CPF na ficha nem no card — não consultei. Corrija o CPF no card.` } }).catch(() => {});
      continue;
    }
    await salvar(id, (x) => { x.atual = { ordem: p.ordem, desde: new Date().toISOString() }; });
    return { leadId: id, leadName: l!.name, ordem: p.ordem, nome: p.nome, cpf: p.cpf };
  }
  return null;
}

/** Resultado da consulta de um participante → anotação; todos consultados → CONSULTADO + push pra equipe cadastrar. */
export async function gravarConsulta(accountId: string, leadId: string, ordem: number, texto: string): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const p = participantesDa((l.customFields || {}) as Cf).find((x) => x.ordem === Number(ordem));
  const limpo = String(texto || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3500);
  const c = await salvar(leadId, (x) => { x.consultas = { ...(x.consultas || {}), [ordem]: { at: new Date().toISOString(), texto: limpo } }; delete x.atual; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 CAIXA — Oportunidades de Negócios (${ordem}º participante: ${p?.nome || '—'}), consultado pela extensão:\n\n${limpo}` } }).catch(() => {});
  const todos = participantesDa((l.customFields || {}) as Cf).every((x) => c.consultas?.[x.ordem]);
  if (!todos) return;
  await salvar(leadId, (x) => { x.status = 'CONSULTADO'; x.consultadoEm = new Date().toISOString(); });
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `🏦 ${l.name}: consulta da CAIXA pronta`, body: 'Confira o resultado nas anotações e, se estiver limpo, faça o cadastro (a extensão preenche).', leadId }).catch(() => {});
}

/** Cards prontos pro cadastro (consultados) — a extensão mostra pra escolher na hora de preencher. */
export async function prontosParaCadastro(accountId: string): Promise<any[]> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaCadastro'->>'status' IN ('FILA', 'CONSULTADO')
    ORDER BY "customFields"->'_caixaCadastro'->>'pedidoEm' ASC LIMIT 30`;
  const out: any[] = [];
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true } });
    const cf = (l?.customFields || {}) as Cf;
    out.push({ leadId: id, leadName: l!.name, status: cf._caixaCadastro?.status, participantes: participantesDa(cf) });
  }
  return out;
}

/** Entra sozinho na fila: ficha pronta + cliente vai pela CAIXA. Roda no poller. */
export async function processFilaCaixa(accountId: string): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND "isGroup" = false
      AND "customFields"->'_fichaCadastral' IS NOT NULL AND "customFields"->'_caixaCadastro' IS NULL
      AND ("customFields"->'_fhCaixaAnswer'->>'resposta' = 'SIM' OR "customFields"->>'_reentryCaixaAt' IS NOT NULL)
    LIMIT 5`;
  for (const { id } of ids) await pedirCadastroCaixa(accountId, id, 'automático (cliente vai pela CAIXA)').catch((e) => console.error('[CAIXA] fila:', e?.message));
}

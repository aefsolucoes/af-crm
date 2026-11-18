/* ── DESBLOQUEIO DO CADASTRO CAIXA — cliente atendido por OUTRO convênio (Fabio 18/11, Lucas Henrique: "precisamos cancelar e refazer pelo nosso convênio;
 * para isso o cliente encaminha um código token para conseguirmos cancelar e liberar o cadastro para nós").
 * No Caixa Aqui: Cadastro de Clientes → CPF → Consultar → aviso "Este cliente já está sendo atendido por outro convênio. Deseja cancelar avaliações de risco ou
 * propostas válidas a pedido do cliente?" → SIM → "Cancelamento de Avaliações e Propostas via Token" (celular cadastrado, só os 4 últimos dígitos) → "Enviar Token"
 * → o cliente recebe o token por SMS, repassa pra gente e ele é digitado na tela seguinte → o cadastro é liberado.
 * Trabalho da extensão "Cadastro CAIXA" pela mesma fila (`tipo: 'desbloquear'`); estado em `_caixaDesbloqueio` (fora do _caixaCadastro, que a fila regrava). */
import { prisma } from '../lib/prisma';
import { participantesDa } from './caixa-cadastro.service';

type Cf = Record<string, any>;
const LEASE_MS = 10 * 60_000;
const mascaraCpf = (s: string) => String(s || '').replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '[CPF]').replace(/\b\d{11}\b/g, '[CPF]');

async function salvarDesbloqueio(leadId: string, mut: (d: Cf) => void): Promise<Cf> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const d: Cf = { ...(((l?.customFields || {}) as Cf)._caixaDesbloqueio || {}) };
  mut(d);
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaDesbloqueio}', ${JSON.stringify(d)}::jsonb, true) WHERE id = ${leadId}`;
  return d;
}

/** Final do celular do card (4 dígitos) — a tela do token da CAIXA mostra só "Celular (XX) - xxxxx - 8584"; com mais de um número, a extensão marca o que bate. */
function finaisDoCard(cf: Cf, phones: (string | null | undefined)[]): string[] {
  const nums = [...phones, cf.telefone_1, cf.telefone, cf.celular_1].map((x) => String(x || '').replace(/\D/g, '')).filter((x) => x.length >= 8);
  return [...new Set(nums.map((x) => x.slice(-4)))];
}

/** Pede à extensão o caminho do desbloqueio. `enviar`: vai até o "Enviar Token" (o SMS da CAIXA sai pro cliente) — só com o OK da equipe. */
export async function pedirDesbloqueio(accountId: string, leadId: string, por: string, opts: { enviar?: boolean } = {}): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, customFields: true } });
  if (!l) return 'Card não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const p1 = participantesDa(cf).find((x) => x.ordem === 1);
  if (!p1 || String(p1.cpf || '').length !== 11) return 'O card não tem o CPF do 1º participante';
  const atual = cf._caixaDesbloqueio as Cf | undefined;
  if (atual?.status === 'RODANDO' && atual.inicio && Date.now() - Date.parse(atual.inicio) < LEASE_MS) return 'A extensão já está no desbloqueio deste cliente';
  const modo = opts.enviar ? 'enviar' : 'ver';
  await salvarDesbloqueio(leadId, (d) => {
    for (const k of Object.keys(d)) if (k !== 'historico') delete d[k];
    Object.assign(d, { status: 'FILA', modo, pedidoEm: new Date().toISOString(), por, tentativas: 0 });
  });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔓 CAIXA — desbloqueio do cadastro (cliente em outro convênio) na fila da extensão (${por}): ${modo === 'enviar' ? 'ela vai até o "Enviar Token" — a CAIXA manda o token por SMS pro celular cadastrado do cliente' : 'ela abre o cadastro e para no aviso do outro convênio, sem enviar token'}.` } }).catch(() => {});
  return null;
}

/** Próximo desbloqueio pra extensão (um por vez). */
export async function proximoDesbloqueio(accountId: string): Promise<any | null> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false
      AND "customFields"->'_caixaDesbloqueio'->>'status' IN ('FILA', 'RODANDO')
    ORDER BY "customFields"->'_caixaDesbloqueio'->>'pedidoEm' ASC LIMIT 5`;
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true, contact: { select: { phone: true, whatsappPhone: true } } } });
    const cf = (l?.customFields || {}) as Cf;
    const d = (cf._caixaDesbloqueio || {}) as Cf;
    if (d.status === 'RODANDO') {
      if (d.inicio && Date.now() - Date.parse(d.inicio) < LEASE_MS) return null; // em andamento
      if ((d.tentativas || 0) >= 2) {
        await salvarDesbloqueio(id, (x) => { x.status = 'ERRO: a extensão largou no meio (2 tentativas)'; x.fim = new Date().toISOString(); });
        await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: '⚠️ CAIXA — desbloqueio do cadastro: a extensão largou no meio duas vezes. Confira no Caixa Aqui (Cadastro de Clientes).' } }).catch(() => {});
        continue;
      }
    }
    const p1 = participantesDa(cf).find((x) => x.ordem === 1);
    if (!p1 || String(p1.cpf || '').length !== 11) {
      await salvarDesbloqueio(id, (x) => { x.status = 'ERRO: sem CPF do 1º participante'; x.fim = new Date().toISOString(); });
      continue;
    }
    await salvarDesbloqueio(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; });
    return { tipo: 'desbloquear', leadId: id, leadName: l!.name, ordem: 1, nome: p1.nome, cpf: p1.cpf, modo: d.modo === 'enviar' ? 'enviar' : 'ver', finais: finaisDoCard(cf, [l!.contact?.whatsappPhone, l!.contact?.phone]) };
  }
  return null;
}

/** O que a extensão viu/fez → card (estado + anotação) e push nos marcos. */
export async function gravarDesbloqueio(accountId: string, leadId: string, body: { status: string; texto?: string; telefones?: string[]; campos?: string[]; final?: boolean }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!l) return;
  const status = String(body.status || '').slice(0, 200);
  const texto = mascaraCpf(String(body.texto || '')).slice(0, 3000);
  const telefones = (body.telefones || []).map((x) => String(x).slice(0, 60)).slice(0, 6);
  await salvarDesbloqueio(leadId, (d) => {
    d.status = status;
    d.atualizadoEm = new Date().toISOString();
    if (telefones.length) d.telefones = telefones;
    if (/^TOKEN ENVIADO/.test(status)) d.enviadoEm = d.atualizadoEm;
    if (body.final !== false) d.fim = d.atualizadoEm;
    d.historico = [...(d.historico || []), { at: d.atualizadoEm, status }].slice(-12);
  });
  const campos = (body.campos || []).slice(0, 30).join(' · ');
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔓 CAIXA — desbloqueio do cadastro: ${status}${telefones.length ? `\nCelular(es) da CAIXA pro token: ${telefones.join('; ')}` : ''}\n\nTela do Caixa Aqui:\n${texto}${campos ? `\n\nBotões/campos: ${mascaraCpf(campos)}` : ''}` } }).catch(() => {});
  if (/^(TOKEN ENVIADO|LIBERADO|SEM OUTRO CONVÊNIO|PAROU|ERRO)/.test(status)) {
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `🔓 ${l.name}: desbloqueio CAIXA`, body: `${status}${telefones.length ? ` — ${telefones[0]}` : ''}`.slice(0, 180), leadId }).catch(() => {});
  }
}

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

/** Pede à extensão o caminho do desbloqueio. modo `ver`: para no aviso do outro convênio; `ate` (padrão): responde SIM, marca o celular na tela do token e para;
 *  `enviar`: clica "Enviar Token" (o SMS da CAIXA sai pro cliente) — só depois de o cliente concordar em seguir com a gente. */
export async function pedirDesbloqueio(accountId: string, leadId: string, por: string, opts: { modo?: 'ver' | 'ate' | 'enviar' } = {}): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, customFields: true } });
  if (!l) return 'Card não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const p1 = participantesDa(cf).find((x) => x.ordem === 1);
  if (!p1 || String(p1.cpf || '').length !== 11) return 'O card não tem o CPF do 1º participante';
  const atual = cf._caixaDesbloqueio as Cf | undefined;
  if (atual?.status === 'RODANDO' && atual.inicio && Date.now() - Date.parse(atual.inicio) < LEASE_MS) return 'A extensão já está no desbloqueio deste cliente';
  const modo = opts.modo === 'ver' || opts.modo === 'enviar' ? opts.modo : 'ate';
  await salvarDesbloqueio(leadId, (d) => {
    for (const k of Object.keys(d)) if (k !== 'historico') delete d[k];
    Object.assign(d, { status: 'FILA', modo, pedidoEm: new Date().toISOString(), por, tentativas: 0 });
  });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔓 CAIXA — desbloqueio do cadastro (cliente em outro convênio) na fila da extensão (${por}): ${modo === 'enviar' ? 'ela clica "Enviar Token" — a CAIXA manda o código por SMS pro celular cadastrado do cliente' : modo === 'ate' ? 'ela responde SIM ao aviso, marca o celular na tela do token e PARA antes do "Enviar Token"' : 'ela abre o cadastro e para no aviso do outro convênio'}.` } }).catch(() => {});
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
    return { tipo: 'desbloquear', leadId: id, leadName: l!.name, ordem: 1, nome: p1.nome, cpf: p1.cpf, modo: d.modo === 'enviar' || d.modo === 'ver' ? d.modo : 'ate', finais: finaisDoCard(cf, [l!.contact?.whatsappPhone, l!.contact?.phone]) };
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

/** Linha da IA do cliente (Fabio 18/11, Lucas: "perguntar ao cliente se ele se recorda dessa aprovação e se podemos seguir por aqui, para isso precisa encaminhar o
 *  token"). Só com a consulta da CAIXA mostrando outro correspondente. Pura. */
export function aiOutroCorrespondenteLinha(cf: Cf, temOutro: boolean): string | null {
  if (!temOutro) return null;
  const d = (cf._caixaDesbloqueio || {}) as Cf;
  if (/^LIBERADO/.test(String(d.status || ''))) return 'CAIXA — o cadastro do cliente, que estava com outro correspondente, JÁ FOI LIBERADO pra gente: siga o processo da CAIXA normalmente, sem tocar mais no assunto.';
  const final = ((d.telefones || []) as string[]).map((t) => String(t).replace(/\D/g, '').slice(-4)).find((x) => x.length === 4);
  const cel = final ? `o celular dele cadastrado na CAIXA (final ${final})` : 'o celular dele cadastrado na CAIXA';
  const enviado = d.enviadoEm ? new Date(String(d.enviadoEm)) : null;
  const hora = enviado ? enviado.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }) : '';
  const estado = enviado
    ? `O CÓDIGO JÁ FOI ENVIADO pela CAIXA por SMS pra ${cel} às ${hora}. Peça que ele mande o código aqui assim que chegar (vale por pouco tempo). Se ele disser que não chegou, pergunte à equipe — não prometa reenvio.`
    : `Se ainda não perguntou (veja o histórico), na sua PRÓXIMA resposta — depois de responder o que ele disse — pergunte se ele se lembra dessa análise/aprovação feita em outro correspondente e se pode seguir por aqui com a gente; explique em uma frase que, pra isso, a CAIXA manda um código por SMS pra ${cel} e ele repassa o código aqui. Se ele concordar, diga que o código chega em instantes por SMS e que é só mandar aqui (a equipe dispara o envio). Se ele já respondeu, não pergunte de novo.`;
  return `CAIXA — CLIENTE EM OUTRO CORRESPONDENTE (Fabio 18/11): a consulta da CAIXA mostra uma avaliação de crédito/proposta dele feita por OUTRO correspondente. Pra seguir com a gente, essa análise antiga é cancelada A PEDIDO DELE: a CAIXA manda um código por SMS e, com o código, a gente libera o cadastro aqui. ${estado} Não diga o nome nem o número do outro correspondente, não use as palavras "convênio" ou "token" (diga "código por SMS da CAIXA"), não peça documento por causa disso. Se ele não quiser cancelar, disser que não fez análise em outro lugar ou tiver dúvida que você não sabe responder, pergunte à equipe.`;
}

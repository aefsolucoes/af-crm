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
  const c: Cf = { ...(((l?.customFields || {}) as Cf)._caixaCadastro || {}) };
  mut(c);
  // Grava SÓ a chave _caixaCadastro (jsonb_set): regravar o card inteiro trazia de volta chaves que outro processo tinha acabado de tirar (Jézer 29/10).
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaCadastro}', ${JSON.stringify(c)}::jsonb, true) WHERE id = ${leadId}`;
  return c;
}

const participantesDa = (cf: Cf): any[] => {
  const ps = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  const base = ps.map((p: any, i: number) => {
    const n = Number(p.ordem) || i + 1;
    return { ...p, ordem: n, cpf: String(p.cpf || cf[`cpf_${n}`] || '').replace(/\D/g, ''), telefone: cf[`telefone_${n}`] || '', email: cf[`email_${n}`] || '' };
  });
  // CPF do cônjuge: a certidão de casamento não traz — se o cônjuge é o outro participante do card, usa o CPF dele (Jézer/Bianca 29/10).
  const primeiroNome = (s: string) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim().split(/\s+/)[0];
  return base.map((p: any) => {
    if (!p.conjuge?.nome || String(p.conjuge.cpf || '').replace(/\D/g, '').length === 11) return p;
    const outro = base.find((o: any) => o.ordem !== p.ordem && primeiroNome(o.nome) === primeiroNome(p.conjuge.nome) && o.cpf.length === 11);
    return outro ? { ...p, conjuge: { ...p.conjuge, cpf: outro.cpf } } : p;
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
  // Depois das consultas: cadastros pedidos (Fabio 29/10: "faz o cadastro da Bianca e da Adriana").
  const cads = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaCadastro'->'cadastros' IS NOT NULL
    ORDER BY "customFields"->'_caixaCadastro'->>'pedidoEm' ASC LIMIT 10`;
  for (const { id } of [...ids, ...cads.filter((x) => !ids.some((y) => y.id === x.id))]) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true } });
    const cf = (l?.customFields || {}) as Cf;
    const c = cf._caixaCadastro || {};
    if (c.atual && Date.now() - Date.parse(c.atual.desde) < LEASE_MS) return null; // um por vez: espera o que está em andamento
    if (c.status !== 'FILA') {
      const ps = participantesDa(cf);
      // FILA, ou RODANDO que passou do prazo (a extensão largou no meio — volta pra fila, até 3 tentativas).
      const ordem = Object.entries(c.cadastros || {}).find(([, v]: [string, any]) => v?.status === 'FILA' || (v?.status === 'RODANDO' && v.inicio && Date.now() - Date.parse(v.inicio) > LEASE_MS && (v.tentativas || 0) < 3))?.[0];
      const pc = ordem && ps.find((x) => x.ordem === Number(ordem));
      if (!pc) continue;
      await salvar(id, (x) => { x.atual = { ordem: pc.ordem, desde: new Date().toISOString(), tipo: 'cadastrar' }; x.cadastros[pc.ordem] = { ...x.cadastros[pc.ordem], status: 'RODANDO', inicio: new Date().toISOString(), tentativas: (x.cadastros[pc.ordem]?.tentativas || 0) + 1 }; });
      const { fontes, faltando, ...participante } = pc;
      const p1 = ps.find((x) => x.ordem === 1);
      return { tipo: 'cadastrar', leadId: id, leadName: l!.name, ordem: pc.ordem, nome: pc.nome, cpf: pc.cpf, participante, primeiro: p1 ? { endereco: p1.endereco } : null };
    }
    const p = participantesDa(cf).find((x) => !c.consultas?.[x.ordem]);
    if (!p) continue;
    if (p.cpf.length !== 11) {
      await salvar(id, (x) => { x.consultas = { ...(x.consultas || {}), [p.ordem]: { at: new Date().toISOString(), texto: 'SEM CPF na ficha nem no card — consulta não feita' } }; });
      await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: `⚠️ CAIXA: ${p.nome || `${p.ordem}º participante`} sem CPF na ficha nem no card — não consultei. Corrija o CPF no card.` } }).catch(() => {});
      continue;
    }
    await salvar(id, (x) => { x.atual = { ordem: p.ordem, desde: new Date().toISOString() }; });
    return { tipo: 'consultar', leadId: id, leadName: l!.name, ordem: p.ordem, nome: p.nome, cpf: p.cpf };
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

/** Conferência do cadastro (Fabio 29/10: "orientar o CRM para que ele faça a conferência dos dados"): a extensão manda o que ficou em cada campo da tela
 *  do Caixa Aqui e a IA compara com a ficha do participante (lida dos documentos). Anotação no card + resposta pra extensão mostrar. */
const SYSTEM_CONFERE = `Você confere um CADASTRO de cliente preenchido no portal da CAIXA (Caixa Aqui) contra a FICHA DE CADASTRO do participante (dados lidos dos documentos dele).
Recebe a lista de campos da tela (rótulo e valor que ficou) e a ficha. Compare campo a campo o que existe nos dois: nome, CPF, nascimento, sexo, identidade (tipo, número, órgão, UF, emissão), naturalidade, nacionalidade, filiação, estado civil, regime, cônjuge, endereço/CEP, telefone, e-mail, trabalho e renda.
Regras da A&F (Fabio 29/10 — NÃO são divergência): a identidade é a do documento apresentado (com CNH, vale o número de registro, órgão "ÓRGÃO DE TRÂNSITO" e UF/emissão da CNH); CNH vencida não é problema; participante SEM RENDA vai com Tipo de Ocupação FORMAL e Ocupação ADMINISTRADOR; bairro vale o do comprovante de residência (a consulta do CEP pode trazer outro nome — não é divergência se a tela tem o do comprovante); tipo de imóvel CASA e ocupação do imóvel PRÓPRIA QUITADA são padrão da A&F; a lista de ocupações da CAIXA não tem todos os cargos — a opção MAIS PARECIDA com o cargo da ficha vale (ex.: "Analista PCPM Sr" → ANALISTA DE SISTEMAS); RENDA LANÇADA (Fabio 30/10): de cada fonte vale o contracheque VÁLIDO (últimos 3 meses) de MAIOR recebimento — não precisa ser o mais recente; o IMPOSTO DE RENDA RETIDO NA FONTE do contracheque (irRetido) TEM que estar no campo de IR retido — vazio/0,00 com desconto de IR no contracheque = "faltando"; aposentadoria vai com comprovante EXTRATO DE BENEFÍCIO PREVIDENCIÁRIO; MAIS DE UMA RENDA: a profissão/ocupação da 1ª tela é a da MAIOR renda, igual à ocupação lançada na renda dela, e cada renda leva a ocupação DELA; renda de aposentadoria (fundo de previdência/seguridade, INSS, "outrasRendas" aposentadoria) = APOSENTADO (EXCETO FUNCIONÁRIO PÚBLICO), sem a data de admissão do outro emprego — não é divergência ocupação APOSENTADO com o cargo de outro emprego na ficha; grau de instrução é sempre SUPERIOR COMPLETO; o nome reduzido abrevia os nomes do meio e nunca o último sobrenome; estado civil e regime vêm juntos ("CASADO (A) COM COMUNHÃO PARCIAL DE BENS"); Declaração de Propósitos = só Movimentação de Conta e Empréstimos/Financiamentos com Financiamento Habitacional SIM; formato diferente (maiúsculas, acento, pontuação, máscara de CPF/CEP/data) NÃO é divergência; campo que EXISTE na tela e ficou vazio, mas a ficha tem = "faltando"; campo que NÃO aparece nesta tela = ignore (o cadastro da CAIXA tem várias páginas: dados pessoais na 1ª, endereço/telefone/e-mail na 2ª — nunca cobre o que é de outra página); campo que a ficha não tem = ignore.
Responda SOMENTE com JSON: {"ok": true|false, "divergencias": ["<campo: na tela X, na ficha Y>"], "faltando": ["<campo que a ficha tem e a tela deixou vazio>"], "resumo": "<1 frase>"}`;

export async function conferirCadastro(accountId: string, leadId: string, ordem: number, campos: { rotulo: string; valor: string }[]): Promise<{ ok: boolean; divergencias: string[]; faltando: string[]; resumo: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return null;
  const p = participantesDa((l.customFields || {}) as Cf).find((x) => x.ordem === Number(ordem));
  if (!p) return null;
  const { fontes, faltando, ...ficha } = p;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8192, system: SYSTEM_CONFERE, messages: [{ role: 'user', content: [{ type: 'text', text: `FICHA:\n${JSON.stringify(ficha)}\n\nCAMPOS DA TELA:\n${JSON.stringify(campos.slice(0, 200))}` }] }] }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  let r: any;
  try { r = JSON.parse((data.content?.find((b) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return null; }
  const out: { ok: boolean; divergencias: string[]; faltando: string[]; resumo: string } = { ok: !!r.ok, divergencias: Array.isArray(r.divergencias) ? r.divergencias.map(String) : [], faltando: Array.isArray(r.faltando) ? r.faltando.map(String) : [], resumo: String(r.resumo || '') };
  const linhas = [...out.divergencias.map((d) => `• ❌ ${d}`), ...out.faltando.map((f) => `• ⚠️ vazio na tela: ${f}`)];
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔎 Conferência do cadastro na CAIXA — ${ordem}º participante (${p.nome || '—'}): ${out.ok && !linhas.length ? '✅ tudo confere com os documentos.' : 'precisa corrigir antes de gravar:'}${linhas.length ? `\n${linhas.join('\n')}` : ''}${out.resumo ? `\n${out.resumo}` : ''}` } }).catch(() => {});
  await salvar(leadId, (x) => { x.conferencias = { ...(x.conferencias || {}), [ordem]: { at: new Date().toISOString(), ok: out.ok && !linhas.length } }; });
  return out;
}

/** Pede o cadastro de participantes na CAIXA (a extensão faz: CPF → formulário preenchido pela ficha → conferência do CRM). */
export async function pedirCadastroParticipantes(accountId: string, leadId: string, ordens: number[], por: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const ps = participantesDa((l.customFields || {}) as Cf);
  const validos = ordens.filter((o) => ps.some((p) => p.ordem === o));
  if (!validos.length) return 'Participante não está na ficha';
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}) }; for (const o of validos) x.cadastros[o] = { status: 'FILA', pedidoEm: new Date().toISOString(), por }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Cadastro na CAIXA pedido (${por}) para: ${validos.map((o) => ps.find((p) => p.ordem === o)?.nome || `${o}º`).join(', ')}. A extensão preenche pela ficha e o CRM confere.` } }).catch(() => {});
  return null;
}

/** Ficha refeita com documento novo da pasta (Fabio 29/10 — Bianca sem RG/CNH): o cadastro que não saiu porque faltava a identidade e agora a ficha tem → volta pra fila. */
export async function reenfileirarComFichaNova(leadId: string, antes: any[]): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const cads = (cf._caixaCadastro?.cadastros || {}) as Record<string, any>;
  const temId = (p: any) => !!String(p?.identidade?.numero || '').trim();
  const ps = participantesDa(cf);
  const voltar = Object.entries(cads)
    .filter(([o, v]) => v && !['GRAVADO', 'FILA', 'RODANDO'].includes(String(v.status)) && !temId(antes.find((p: any, i: number) => (Number(p.ordem) || i + 1) === Number(o))) && temId(ps.find((p) => p.ordem === Number(o))))
    .map(([o]) => Number(o));
  if (!voltar.length) return;
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}) }; for (const o of voltar) x.cadastros[o] = { status: 'FILA', pedidoEm: new Date().toISOString(), por: 'CRM (documento novo)' }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Chegou o documento de identidade de ${voltar.map((o) => ps.find((p) => p.ordem === o)?.nome || `${o}º`).join(', ')} — a ficha foi refeita e o cadastro na CAIXA voltou pra fila da extensão.` } }).catch(() => {});
}

/** Dado novo na ficha (resposta do cliente com CNPJ/admissão — Fabio 30/10): cadastro da CAIXA que não saiu (nem gravado, nem na fila/rodando) volta pra fila. */
export async function reenfileirarCadastrosPendentes(leadId: string, motivo: string): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cads = (((l?.customFields || {}) as Cf)._caixaCadastro?.cadastros || {}) as Record<string, any>;
  const voltar = Object.entries(cads).filter(([, v]) => v && !['GRAVADO', 'FILA', 'RODANDO'].includes(String(v.status))).map(([o]) => Number(o));
  if (!voltar.length) return;
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}) }; for (const o of voltar) x.cadastros[o] = { status: 'FILA', pedidoEm: new Date().toISOString(), por: `CRM (${motivo})` }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Cadastro na CAIXA de volta pra fila da extensão (${motivo}).` } }).catch(() => {});
}

/** Formulário do cadastro ("Imprimir Formulário" da tela final da CAIXA, PDF) → subpasta FORMULARIOS da pasta do cliente no Drive (Fabio 30/10).
 *  A assinatura do cliente na ficha da CAIXA fica pra contratação. Cadastro refeito: troca o arquivo de mesmo nome. */
export async function salvarFormularioCaixa(accountId: string, leadId: string, ordem: number, pdfBase64: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) return 'O card não tem a pasta do Drive';
  const data = Buffer.from(String(pdfBase64 || ''), 'base64');
  if (data.length < 1000 || data.subarray(0, 4).toString('latin1') !== '%PDF') return 'O arquivo do formulário não é um PDF';
  const p = participantesDa(cf).find((x) => x.ordem === Number(ordem));
  const quem = String(p?.nome || `${ordem}º participante`).toUpperCase();
  const nome = `FICHA CADASTRAL CAIXA - ${quem}.pdf`;
  const google = await import('./google.service');
  const pasta = await google.createFolder(accountId, 'FORMULARIOS', google.extractFolderId(link));
  for (const velho of (await google.listFolderContents(accountId, pasta.id)).filter((f) => f.name === nome)) await google.trashDriveItem(accountId, velho.id).catch(() => {});
  const up = await google.uploadFile(accountId, { name: nome, mimeType: 'application/pdf', parentId: pasta.id, data });
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}), [ordem]: { ...(x.cadastros?.[ordem] || {}), formulario: up.id } }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📄 Formulário do cadastro na CAIXA de ${quem} salvo na pasta FORMULARIOS do Drive (${nome}). A assinatura do cliente fica pra contratação.` } }).catch(() => {});
  return null;
}

/** Resultado do cadastro vindo da extensão (preenchido + conferência; salvo ou parado antes de salvar). */
export async function gravarCadastro(accountId: string, leadId: string, ordem: number, r: { status: string; texto: string }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const p = participantesDa((l.customFields || {}) as Cf).find((x) => x.ordem === Number(ordem));
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}), [ordem]: { ...(x.cadastros?.[ordem] || {}), status: r.status, fim: new Date().toISOString() } }; delete x.atual; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Cadastro na CAIXA — ${ordem}º participante (${p?.nome || '—'}): ${r.status}\n\n${String(r.texto || '').slice(0, 3500)}` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `🏦 ${l.name}: cadastro CAIXA (${p?.nome || `${ordem}º`})`, body: r.status, leadId }).catch(() => {});
}

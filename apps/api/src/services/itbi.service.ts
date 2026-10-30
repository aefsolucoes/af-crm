import { prisma } from '../lib/prisma';

/* ITBI NO DF pela DEITBI (Declaração Eletrônica de ITBI da Receita do DF) — Fabio 30/10: "vamos fazer uma extensão para solicitar ITBI de um cliente".
 * Decisões: DF primeiro (outras cidades depois, uma por vez); a guia (DAR) vai pro cliente no WhatsApp e fica na pasta ITBI do Drive; quem pede é a
 * equipe (botão no card ou Jarvis) — nada automático; o login no portal é com o certificado A1 da A&F ("F CLEMENTE", CNPJ 49.592.816/0001-40).
 *
 * Regras do portal (manual DEITBI + tela):
 *  - 1 transmitente × 1 adquirente × 1 imóvel por declaração: casal vira várias declarações, cada uma com o seu percentual do imóvel e valor proporcional.
 *  - ENVIAR GERA O IMPOSTO (não é simulação). Por isso o pedido começa em CONFERIR: a extensão preenche, clica em "Finalizar e Calcular" e devolve o
 *    Resumo (base de cálculo, alíquota, valor do ITBI) SEM enviar; a equipe confere no card e confirma o envio (ENVIAR). Só então a guia é gerada.
 *  - Natureza 004 (compra e venda com alienação fiduciária) quando há financiamento; 001 (compra e venda) sem financiamento. As duas exigem anexar em PDF o
 *    contrato/minuta (004: "contrato ou escritura"; 001: "minuta de escritura") — vem da pasta MINUTA do Drive do cliente.
 *  - Compra e venda pode cair em "lançamento de ofício" (sem guia na hora): a extensão avisa e a equipe segue pelo Atendimento Virtual.
 * Estado no card: customFields._itbi (só este fluxo escreve nele; gravado por SQL na chave, sem regravar o card inteiro). Leitura da minuta: _itbiLeitura. */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

export type ItbiPessoa = { nome: string; cpf: string; email?: string; telefone?: string; percentual: number };
export type ItbiDeclaracao = {
  idx: number; transmitente: ItbiPessoa; adquirente: ItbiPessoa; percentual: number; valorPactuado: number;
  status: 'PENDENTE' | 'CALCULADA' | 'ENVIADA' | 'GUIA' | 'OFICIO' | 'FALHOU';
  valorBem?: number; baseCalculo?: number; valorItbi?: number; aliquota?: number; protocolo?: string; guia?: string; vencimento?: string;
  linhaDigitavel?: string; darDriveId?: string; darUrl?: string; darNome?: string; detail?: string; at?: string;
};
export type Itbi = {
  status: 'REQUESTED' | 'RUNNING' | 'CALCULADO' | 'DONE' | 'OFICIO' | 'FAILED' | 'CANCELED';
  modo: 'CONFERIR' | 'ENVIAR';
  natureza: '004' | '001';
  inscricao: string; valorTotal: number; imovelNovo?: boolean;
  contrato: { numero?: string; instituicao?: string };
  anexo: { driveFileId: string; nome: string } | null;
  vendedores: ItbiPessoa[]; compradores: ItbiPessoa[]; declaracoes: ItbiDeclaracao[];
  requestedAt: string; requestedById?: string | null; claimedAt?: string | null; claimedIdx?: number | null; lastProgress?: string | null;
  attempts: number; detail?: string; finishedAt?: string | null; enviarAoCliente: boolean;
  envio?: { templateAt?: string; enviadoAt?: string; falha?: string };
};
type Leitura = {
  arquivo: { id: string; nome: string }; vendedores: { nome: string; cpf: string; percentual?: number | null }[]; compradores: { nome: string; cpf: string; percentual?: number | null }[];
  inscricao: string; matricula: string; valorCompraVenda: number | null; valorFinanciado: number | null; numeroContrato: string; instituicao: string; imovelNovo: boolean | null; endereco: string; observacao: string;
};

/** Declarante: a A&F (dados de contato que a tela pede no 1º passo). */
export const ITBI_DECLARANTE = { telefone: '61981721313', email: 'comercial@aefsolucoesfinanceiras.com.br' };
const JOB_STUCK_MS = 20 * 60_000;

const dig = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const brl = (n: number | null | undefined) => (n || n === 0 ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—');
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  const t = String(v ?? '').replace(/[^\d.,]/g, '');
  if (!t) return null;
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : /\.\d{3}$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const cpfOk = (c: string) => {
  const d = dig(c);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
};

async function cfOf(leadId: string) {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  return (l?.customFields || {}) as Record<string, any>;
}
/** Grava só a chave `chave` do card (jsonb_set): não apaga o que outro processo gravou no meio-tempo. */
async function salvarChave(leadId: string, chave: '_itbi' | '_itbiLeitura', valor: unknown) {
  await prisma.$executeRawUnsafe(`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{${chave}}', $1::jsonb, true) WHERE id = $2`, JSON.stringify(valor), leadId);
}
async function nota(leadId: string, content: string) { await prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {}); }
function push(accountId: string, title: string, body: string, leadId: string, userIds?: string[]) {
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }, userIds).catch(() => {}); } catch { /* push é só aviso */ }
}
function emitir(io: Io, accountId: string, leadId: string) { io?.to(`account_${accountId}`).emit('itbi_updated', { leadId }); }

// ── Leitura da minuta (vendedores, compradores, inscrição do IPTU, valores, contrato) ──────────────────────────────────────────
const SYSTEM_LEITURA = `Você lê a MINUTA/CONTRATO de compra e venda de um imóvel (com ou sem financiamento bancário) pra preencher a declaração de ITBI no Distrito Federal. Extraia SÓ o que está escrito — nunca invente.
Responda SOMENTE com JSON:
{"vendedores":[{"nome":"<nome completo>","cpf":"<só dígitos ou vazio>","percentual":<% do imóvel que esse vendedor transmite, se o documento disser; senão null>}],
"compradores":[{"nome":"<nome completo>","cpf":"<só dígitos ou vazio>","percentual":<% que esse comprador adquire, se disser; senão null>}],
"inscricaoIptu":"<inscrição imobiliária do IPTU/TLP do imóvel (no DF, 8 dígitos), só dígitos, ou vazio>","matricula":"<nº da matrícula do imóvel ou vazio>",
"valorCompraVenda":<preço de compra e venda do imóvel, número, ou null>,"valorFinanciado":<valor financiado pelo banco, número, ou null>,
"numeroContrato":"<número do contrato/da proposta no banco ou vazio>","instituicao":"<banco/credor fiduciário (ex.: BANCO INTER S.A.) ou vazio>",
"imovelNovo":<true se o imóvel é NOVO em 1ª transferência (comprado da construtora/incorporadora); false se usado; null se não der pra saber>,
"endereco":"<endereço do imóvel como está escrito>","observacao":"<1 frase: o que é o documento e qualquer ponto de atenção>"}
VENDEDORES = quem vende/transmite (outorgante vendedor, transmitente). Cônjuge que só assina como anuente casado com o vendedor TAMBÉM é vendedor se o documento o qualificar como vendedor/transmitente. COMPRADORES = quem compra (outorgado comprador, adquirente, devedor fiduciante). O banco NÃO é comprador.
Números em reais como número puro (ex.: 380000.5).`;

async function acharMinuta(accountId: string, cf: Record<string, any>): Promise<{ id: string; name: string; mimeType: string; size: number } | null> {
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) return null;
  const google = await import('./google.service');
  const arquivos = await google.listAllFilesInFolderTree(accountId, google.extractFolderId(link), 3);
  const pdfs = arquivos.filter((f) => f.mimeType === 'application/pdf');
  // A minuta do banco é o "contrato" que a declaração 004 pede anexado (instrumento particular com força de escritura). Prefere o que está na pasta MINUTA.
  const naPasta = pdfs.filter((f) => /(^|\/)minuta(\/|$)/i.test(f.path || '') || /minuta/i.test(f.name));
  const contrato = pdfs.filter((f) => /contrato|instrumento/i.test(f.name));
  const escolhido = [...naPasta, ...contrato][0];
  return escolhido ? { id: escolhido.id, name: escolhido.name, mimeType: escolhido.mimeType, size: Number(escolhido.size || 0) } : null;
}

async function lerMinutaItbi(accountId: string, file: { id: string; name: string }): Promise<Leitura | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const google = await import('./google.service');
  const buf = await google.downloadDriveFile(accountId, file.id, 'application/pdf');
  if (buf.length > 25 * 1024 * 1024) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8192, system: SYSTEM_LEITURA, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }, { type: 'text', text: `Arquivo: ${file.name}` }] }] }),
  }).catch(() => null);
  if (!res || !res.ok) { console.error('[ITBI] leitura da minuta:', res?.status, res ? (await res.text()).slice(0, 200) : ''); return null; }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  try {
    const j = JSON.parse((data.content?.find((b) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || '');
    const pessoas = (x: unknown) => (Array.isArray(x) ? x : []).map((p: any) => ({ nome: String(p?.nome || '').trim().toUpperCase().slice(0, 120), cpf: dig(p?.cpf).slice(0, 11), percentual: num(p?.percentual) })).filter((p) => p.nome || p.cpf);
    return {
      arquivo: { id: file.id, nome: file.name }, vendedores: pessoas(j.vendedores), compradores: pessoas(j.compradores),
      inscricao: dig(j.inscricaoIptu), matricula: String(j.matricula || '').slice(0, 30), valorCompraVenda: num(j.valorCompraVenda), valorFinanciado: num(j.valorFinanciado),
      numeroContrato: String(j.numeroContrato || '').slice(0, 50), instituicao: String(j.instituicao || '').slice(0, 50), imovelNovo: typeof j.imovelNovo === 'boolean' ? j.imovelNovo : null,
      endereco: String(j.endereco || '').slice(0, 200), observacao: String(j.observacao || '').slice(0, 300),
    };
  } catch { return null; }
}

/** Divide o imóvel entre os pares vendedor × comprador (1:1:1 do portal). Percentual informado vale; sem ele, partes iguais. */
export function montarDeclaracoes(vendedores: ItbiPessoa[], compradores: ItbiPessoa[], valorTotal: number): ItbiDeclaracao[] {
  const partes = (lista: ItbiPessoa[]) => {
    const soma = lista.reduce((s, p) => s + (p.percentual || 0), 0);
    return Math.abs(soma - 100) < 0.01 ? lista.map((p) => p.percentual) : lista.map(() => 100 / lista.length);
  };
  const pv = partes(vendedores), pc = partes(compradores);
  const out: ItbiDeclaracao[] = [];
  vendedores.forEach((v, i) => compradores.forEach((c, k) => {
    const percentual = Math.round(pv[i] * pc[k]) / 100; // % do imóvel nesta declaração (2 casas: é o que o campo do portal aceita)
    out.push({ idx: out.length, transmitente: v, adquirente: c, percentual, valorPactuado: Math.round(valorTotal * percentual) / 100, status: 'PENDENTE' });
  }));
  // Arredondamento (3 vendedores = 33,33% cada): a última declaração fica com a sobra, pra somar 100% e o valor inteiro.
  if (out.length > 1) {
    const ult = out[out.length - 1];
    ult.percentual = Math.round((100 - out.slice(0, -1).reduce((s, d) => s + d.percentual, 0)) * 100) / 100;
    ult.valorPactuado = Math.round((valorTotal - out.slice(0, -1).reduce((s, d) => s + d.valorPactuado, 0)) * 100) / 100;
  }
  return out;
}

export type ItbiOverrides = Partial<{ inscricao: string; valorTotal: number; natureza: '004' | '001'; numeroContrato: string; instituicao: string; vendedores: Partial<ItbiPessoa>[]; compradores: Partial<ItbiPessoa>[]; anexoDriveFileId: string; releitura: boolean }>;

/** O que vai ser declarado (lê a minuta 1 vez e guarda). `faltam` = o que impede o pedido. */
export async function previewItbi(accountId: string, leadId: string, ov: ItbiOverrides = {}) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead) throw new Error('card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  const avisos: string[] = [];
  // Minuta: lê uma vez (ou de novo se o arquivo mudou / pediram releitura).
  let leitura = cf._itbiLeitura as Leitura | undefined;
  const minuta = await acharMinuta(accountId, cf).catch((e) => { avisos.push(`não consegui listar a pasta do Drive (${e?.message || e})`); return null; });
  if (minuta && (ov.releitura || !leitura || leitura.arquivo?.id !== minuta.id)) {
    const lida = await lerMinutaItbi(accountId, minuta).catch((e) => { console.error('[ITBI] minuta:', e?.message); return null; });
    if (lida) { leitura = lida; await salvarChave(leadId, '_itbiLeitura', lida); }
    else avisos.push(`não consegui ler a minuta "${minuta.name}"`);
  }
  if (!minuta) avisos.push('não achei a minuta/contrato em PDF na pasta do cliente (pasta MINUTA) — ela é anexo obrigatório da declaração');

  // Compradores: os do card (participante 1 e 2) + o que a minuta diz; vendedores: só da minuta (o card não guarda vendedor).
  const doCard: ItbiPessoa[] = [1, 2].map((n) => ({ nome: String(cf[`participante_${n}`] || '').trim().toUpperCase(), cpf: dig(cf[`cpf_${n}`]), email: String(cf[`email_${n}`] || '').trim(), telefone: dig(cf[`telefone_${n}`]), percentual: 0 })).filter((p) => p.cpf);
  const daMinuta = (leitura?.compradores || []).map((p) => ({ nome: p.nome, cpf: p.cpf, percentual: p.percentual || 0 }));
  let compradores: ItbiPessoa[] = daMinuta.length ? daMinuta.map((p) => { const c = doCard.find((x) => x.cpf && x.cpf === p.cpf) || doCard.find((x) => x.nome && x.nome === p.nome); return { ...p, cpf: p.cpf || c?.cpf || '', email: c?.email, telefone: c?.telefone }; }) : doCard;
  let vendedores: ItbiPessoa[] = (leitura?.vendedores || []).map((p) => ({ nome: p.nome, cpf: p.cpf, percentual: p.percentual || 0 }));
  if (ov.compradores?.length) compradores = ov.compradores.map((p) => ({ nome: String(p.nome || '').toUpperCase(), cpf: dig(p.cpf), email: p.email, telefone: dig(p.telefone), percentual: Number(p.percentual) || 0 }));
  if (ov.vendedores?.length) vendedores = ov.vendedores.map((p) => ({ nome: String(p.nome || '').toUpperCase(), cpf: dig(p.cpf), email: p.email, telefone: dig(p.telefone), percentual: Number(p.percentual) || 0 }));

  const inscricao = dig(ov.inscricao || leitura?.inscricao || Object.values((cf._docReview || {}) as Record<string, any>).map((r: any) => dig(r?.inscricao)).find((x) => x.length === 8) || '');
  const valorTotal = Number(ov.valorTotal) || leitura?.valorCompraVenda || num(cf.valor_imovel) || 0;
  const financiado = leitura?.valorFinanciado || num(cf.valor_credito) || 0;
  const natureza: '004' | '001' = ov.natureza || (financiado > 0 ? '004' : '001');
  const anexo = ov.anexoDriveFileId ? { driveFileId: ov.anexoDriveFileId, nome: 'contrato.pdf' } : minuta ? { driveFileId: minuta.id, nome: minuta.name } : null;
  if (leitura?.valorCompraVenda && num(cf.valor_imovel) && Math.abs(leitura.valorCompraVenda - (num(cf.valor_imovel) || 0)) > 1) avisos.push(`a minuta diz ${brl(leitura.valorCompraVenda)} de compra e venda e o card ${brl(num(cf.valor_imovel))} — vale o da minuta`);
  if (!/(^|\s)df$|distrito federal|bras[ií]lia/i.test(`${leitura?.endereco || ''} ${cf.cidade_imovel || ''}`) && leitura?.endereco) avisos.push(`o endereço da minuta não parece ser do DF ("${leitura.endereco.slice(0, 80)}") — esta extensão só faz ITBI do DF`);

  const faltam: string[] = [];
  if (inscricao.length !== 8) faltam.push('inscrição do IPTU do imóvel (8 dígitos)');
  if (!(valorTotal > 0)) faltam.push('valor de compra e venda');
  if (!vendedores.length) faltam.push('vendedor(es): nome e CPF');
  vendedores.forEach((v) => { if (!cpfOk(v.cpf)) faltam.push(`CPF válido do vendedor ${v.nome || '?'}`); });
  if (!compradores.length) faltam.push('comprador(es): nome e CPF');
  compradores.forEach((c) => { if (!cpfOk(c.cpf)) faltam.push(`CPF válido do comprador ${c.nome || '?'}`); });
  if (!anexo) faltam.push(natureza === '004' ? 'contrato/minuta do financiamento em PDF (pasta MINUTA)' : 'minuta da escritura em PDF (pasta MINUTA)');
  const declaracoes = faltam.length ? [] : montarDeclaracoes(vendedores, compradores, valorTotal);
  const aliquota = leitura?.imovelNovo ? 1 : 2;
  return {
    leadName: lead.name, natureza, inscricao, valorTotal, financiado, aliquotaEsperada: aliquota, itbiEstimado: Math.round(valorTotal * aliquota) / 100,
    contrato: { numero: ov.numeroContrato ?? leitura?.numeroContrato ?? dig(cf.num_proposta).slice(0, 50), instituicao: ov.instituicao ?? leitura?.instituicao ?? String(cf.instituicao || '') },
    anexo, vendedores, compradores, declaracoes, faltam, avisos, imovelNovo: leitura?.imovelNovo ?? null, minuta: leitura ? { arquivo: leitura.arquivo.nome, observacao: leitura.observacao, endereco: leitura.endereco } : null,
    atual: (cf._itbi || null) as Itbi | null,
  };
}

/** Pede o ITBI (botão do card / Jarvis). Começa sempre em CONFERIR: a extensão calcula e para antes de enviar. */
export async function pedirItbi(accountId: string, leadId: string, p: { userId?: string; overrides?: ItbiOverrides; io?: Io }) {
  const pv = await previewItbi(accountId, leadId, p.overrides || {});
  if (pv.faltam.length) throw new Error(`falta: ${pv.faltam.join('; ')}`);
  const atual = pv.atual;
  if (atual && ['REQUESTED', 'RUNNING'].includes(atual.status)) throw new Error('já tem um pedido de ITBI andando neste card');
  if (atual && atual.declaracoes?.some((d) => d.status === 'ENVIADA' || d.status === 'GUIA')) throw new Error('este card já tem declaração de ITBI ENVIADA (imposto lançado) — pra refazer, cancele a guia no portal antes');
  const itbi: Itbi = {
    status: 'REQUESTED', modo: 'CONFERIR', natureza: pv.natureza, inscricao: pv.inscricao, valorTotal: pv.valorTotal, imovelNovo: pv.imovelNovo ?? undefined,
    contrato: pv.contrato, anexo: pv.anexo, vendedores: pv.vendedores, compradores: pv.compradores, declaracoes: pv.declaracoes,
    requestedAt: new Date().toISOString(), requestedById: p.userId || null, attempts: 0, enviarAoCliente: true,
  };
  await salvarChave(leadId, '_itbi', itbi);
  await nota(leadId, `🏛️ ITBI (Receita DF) pedido: ${pv.declaracoes.length} declaração(ões), natureza ${pv.natureza === '004' ? '004 COMPRA E VENDA - AL FIDUCIÁRIA' : '001 COMPRA E VENDA'}, inscrição ${pv.inscricao}, valor ${brl(pv.valorTotal)}.\n${pv.declaracoes.map((d) => `• ${d.transmitente.nome} → ${d.adquirente.nome}: ${d.percentual}% (${brl(d.valorPactuado)})`).join('\n')}\nA extensão preenche e CALCULA, sem enviar; o envio (que gera o imposto) é confirmado depois, no card.`);
  emitir(p.io, accountId, leadId);
  return itbi;
}

/** A equipe conferiu o cálculo e confirma o ENVIO (gera o imposto e a guia). */
export async function confirmarEnvioItbi(accountId: string, leadId: string, p: { userId?: string; io?: Io }) {
  const cf = await cfOf(leadId);
  const it = cf._itbi as Itbi | undefined;
  if (!it) throw new Error('este card não tem pedido de ITBI');
  if (it.status !== 'CALCULADO') throw new Error('o ITBI ainda não foi calculado no portal (ou já foi enviado)');
  const novo: Itbi = { ...it, status: 'REQUESTED', modo: 'ENVIAR', attempts: 0, claimedAt: null, claimedIdx: null, detail: undefined, declaracoes: it.declaracoes.map((d) => (d.status === 'CALCULADA' ? { ...d, status: 'PENDENTE' as const } : d)) };
  await salvarChave(leadId, '_itbi', novo);
  await nota(leadId, `🏛️ ITBI: envio CONFIRMADO — a extensão envia a declaração (gera o imposto), gera a guia e manda ao cliente. Total calculado: ${brl(it.declaracoes.reduce((s, d) => s + (d.valorItbi || 0), 0))}.`);
  emitir(p.io, accountId, leadId);
  return novo;
}

export async function cancelarItbi(accountId: string, leadId: string, p: { io?: Io }) {
  const it = (await cfOf(leadId))._itbi as Itbi | undefined;
  if (!it) throw new Error('este card não tem pedido de ITBI');
  if (it.declaracoes.some((d) => d.status === 'ENVIADA' || d.status === 'GUIA')) throw new Error('já tem declaração ENVIADA — o cancelamento é no portal (DEITBI – Cancelar Declaração Eletrônica)');
  await salvarChave(leadId, '_itbi', { ...it, status: 'CANCELED', finishedAt: new Date().toISOString() });
  await nota(leadId, '🏛️ ITBI: pedido cancelado no CRM (nada foi enviado à Receita).');
  emitir(p.io, accountId, leadId);
}

// ── Fila da extensão ──────────────────────────────────────────────────────────────────────────────────────────────────
/** A extensão pergunta "tem serviço?". Uma declaração por vez (a próxima PENDENTE do card mais antigo). */
export async function claimItbi(accountId: string) {
  // Trabalho parado (sem sinal da extensão) volta pra fila; 3 tentativas e falha.
  const presos = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND "customFields"->'_itbi'->>'status' = 'RUNNING'`;
  for (const { id } of presos) {
    const it = (await cfOf(id))._itbi as Itbi;
    const ultimo = new Date(it.lastProgress || it.claimedAt || 0).getTime();
    if (Date.now() - ultimo < JOB_STUCK_MS) return null; // um por vez: tem trabalho andando
    const attempts = (it.attempts || 0) + 1;
    await salvarChave(id, '_itbi', { ...it, status: attempts >= 3 ? 'FAILED' : 'REQUESTED', attempts, claimedAt: null, detail: 'a extensão parou de dar sinal' });
    if (attempts >= 3) await nota(id, '⚠️ ITBI: a extensão parou 3 vezes sem terminar — confira a janela do portal da Receita DF.');
  }
  const fila = await prisma.$queryRaw<{ id: string; name: string }[]>`SELECT id, name FROM "Lead" WHERE "accountId" = ${accountId} AND "customFields"->'_itbi'->>'status' = 'REQUESTED' ORDER BY "customFields"->'_itbi'->>'requestedAt' ASC LIMIT 1`;
  if (!fila.length) return null;
  const { id: leadId, name } = fila[0];
  const it = (await cfOf(leadId))._itbi as Itbi;
  const d = it.declaracoes.find((x) => x.status === 'PENDENTE');
  if (!d) { await salvarChave(leadId, '_itbi', { ...it, status: it.modo === 'CONFERIR' ? 'CALCULADO' : 'DONE' }); return null; }
  await salvarChave(leadId, '_itbi', { ...it, status: 'RUNNING', claimedAt: new Date().toISOString(), lastProgress: new Date().toISOString(), claimedIdx: d.idx });
  return {
    leadId, leadName: name, modo: it.modo, natureza: it.natureza, declarante: ITBI_DECLARANTE, idx: d.idx, total: it.declaracoes.length,
    transmitente: d.transmitente, adquirente: d.adquirente, percentual: d.percentual, valorPactuado: d.valorPactuado, inscricao: it.inscricao,
    contrato: it.contrato, anexo: it.anexo ? { nome: it.anexo.nome, path: `/itbi/${leadId}/anexo` } : null,
    // Envio: a extensão confere se o Resumo bate com o que a equipe viu no CONFERIR (mesmo valor do ITBI).
    esperado: d.valorItbi ? { valorItbi: d.valorItbi, baseCalculo: d.baseCalculo } : null, aliquotaEsperada: it.imovelNovo ? 1 : 2,
  };
}

/** PDF do contrato/minuta pra extensão anexar na declaração. */
export async function anexoItbi(accountId: string, leadId: string): Promise<{ buffer: Buffer; nome: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  const it = ((lead?.customFields || {}) as any)._itbi as Itbi | undefined;
  if (!it?.anexo) throw new Error('pedido sem anexo');
  const google = await import('./google.service');
  return { buffer: await google.downloadDriveFile(accountId, it.anexo.driveFileId, 'application/pdf'), nome: it.anexo.nome };
}

/** A extensão conta o andamento de uma declaração. */
export async function reportItbi(accountId: string, leadId: string, data: Record<string, any>, io?: Io) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  const it = ((lead?.customFields || {}) as any)._itbi as Itbi | undefined;
  if (!lead || !it) throw new Error('pedido de ITBI não encontrado');
  const idx = Number(data.idx);
  const d = it.declaracoes.find((x) => x.idx === idx);
  if (!d) throw new Error('declaração não encontrada');
  const agora = new Date().toISOString();
  const quem = `${d.transmitente.nome} → ${d.adquirente.nome}`;
  const userIds = it.requestedById ? [it.requestedById] : undefined;
  it.lastProgress = agora;
  switch (String(data.event)) {
    case 'step': d.detail = String(data.stage || '').slice(0, 200); break;
    case 'login': {
      if (!it.detail?.startsWith('aguardando login')) push(accountId, '🔐 Receita DF pedindo login', `${lead.name}: a extensão do ITBI está na tela de login — escolha o certificado da A&F (F CLEMENTE)`, leadId, userIds);
      it.detail = 'aguardando login no portal da Receita DF'; break;
    }
    case 'resumo': {
      Object.assign(d, { valorBem: num(data.valorBem) ?? undefined, baseCalculo: num(data.baseCalculo) ?? undefined, valorItbi: num(data.valorItbi) ?? undefined, aliquota: Number(String(data.aliquota || '').replace(',', '.')) || undefined, at: agora });
      if (it.modo === 'CONFERIR') {
        d.status = 'CALCULADA';
        const faltam = it.declaracoes.filter((x) => x.status === 'PENDENTE').length;
        it.status = faltam ? 'REQUESTED' : 'CALCULADO';
        it.claimedAt = null;
        if (!faltam) {
          const total = it.declaracoes.reduce((s, x) => s + (x.valorItbi || 0), 0);
          await nota(leadId, `🏛️ ITBI CALCULADO no portal (nada enviado ainda):\n${it.declaracoes.map((x) => `• ${x.transmitente.nome} → ${x.adquirente.nome} (${x.percentual}%): base ${brl(x.baseCalculo)}, alíquota ${x.aliquota ?? '?'}%, ITBI ${brl(x.valorItbi)}`).join('\n')}\nTotal: ${brl(total)}. Confira e confirme o ENVIO no card (bloco ITBI) ou pelo assistente — o envio gera o imposto e a guia vai pro cliente.`);
          push(accountId, '🏛️ ITBI calculado — confirme o envio', `${lead.name}: ${brl(total)} (${it.declaracoes.length} declaração(ões))`, leadId, userIds);
        }
      }
      break;
    }
    case 'enviada': { d.status = 'ENVIADA'; d.protocolo = String(data.protocolo || '').slice(0, 40) || d.protocolo; d.guia = String(data.guia || '').slice(0, 40) || d.guia; d.at = agora; break; }
    case 'oficio': {
      d.status = 'OFICIO'; d.detail = String(data.mensagem || '').slice(0, 500); it.status = 'OFICIO'; it.finishedAt = agora; it.claimedAt = null;
      await nota(leadId, `⚠️ ITBI (${quem}): o portal mandou para LANÇAMENTO DE OFÍCIO — não gerou guia. Mensagem: "${d.detail}". Siga pelo Atendimento Virtual da Receita DF (assunto ITBI).`);
      push(accountId, '⚠️ ITBI: lançamento de ofício', `${lead.name}: o portal não gerou a guia — seguir pelo Atendimento Virtual`, leadId, userIds);
      break;
    }
    case 'failed': {
      const motivo = String(data.reason || 'sem detalhe').slice(0, 400);
      d.detail = motivo;
      const definitivo = !!data.definitivo || (it.attempts || 0) + 1 >= 3;
      it.attempts = (it.attempts || 0) + 1;
      it.claimedAt = null;
      if (definitivo) {
        d.status = 'FALHOU'; it.status = 'FAILED'; it.detail = motivo; it.finishedAt = agora;
        await nota(leadId, `⚠️ ITBI (${quem}) NÃO concluiu: ${motivo}`);
        push(accountId, '⚠️ ITBI não concluiu', `${lead.name}: ${motivo.slice(0, 140)}`, leadId, userIds);
      } else it.status = 'REQUESTED';
      break;
    }
    default: throw new Error('evento desconhecido');
  }
  await salvarChave(leadId, '_itbi', it);
  emitir(io, accountId, leadId);
  return { ok: true, status: it.status };
}

/** A extensão devolve a guia (DAR) em PDF: vai pra subpasta ITBI do Drive, a declaração fica GUIA e, com todas prontas, a guia vai pro cliente. */
export async function guiaItbi(accountId: string, leadId: string, p: { idx: number; pdf: Buffer; info: Record<string, any>; io?: Io }) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const it = cf._itbi as Itbi | undefined;
  if (!lead || !it) throw new Error('pedido de ITBI não encontrado');
  const d = it.declaracoes.find((x) => x.idx === p.idx);
  if (!d) throw new Error('declaração não encontrada');
  if (p.pdf.length < 800 || p.pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('o corpo não é um PDF');
  const google = await import('./google.service');
  const link = String(cf.link_pasta_drive || '').trim();
  const pasta = link ? google.extractFolderId(link) : '';
  if (!pasta) throw new Error('o card não tem a pasta do Drive');
  const sub = await google.createFolder(accountId, 'ITBI', pasta);
  const nomeArq = `GUIA ITBI - ${d.adquirente.nome}${it.declaracoes.length > 1 ? ` - ${d.transmitente.nome.split(' ')[0]} ${d.percentual}%` : ''}${d.guia || p.info.guia ? ` - ${d.guia || p.info.guia}` : ''}.pdf`.replace(/[\\/:*?"<>|]/g, ' ');
  const up = await google.uploadFile(accountId, { name: nomeArq, mimeType: 'application/pdf', data: p.pdf, parentId: sub.id });
  Object.assign(d, {
    status: 'GUIA', darDriveId: up.id, darUrl: up.webViewLink || google.folderLink(sub.id), darNome: nomeArq, at: new Date().toISOString(),
    guia: String(p.info.guia || d.guia || '').slice(0, 40) || undefined, vencimento: String(p.info.vencimento || '').slice(0, 20) || undefined,
    linhaDigitavel: String(p.info.linhaDigitavel || '').slice(0, 80) || undefined, valorItbi: num(p.info.valor) ?? d.valorItbi,
  });
  const faltam = it.declaracoes.filter((x) => x.status !== 'GUIA').length;
  it.status = faltam ? (it.declaracoes.some((x) => x.status === 'PENDENTE') ? 'REQUESTED' : it.status) : 'DONE';
  it.claimedAt = null; it.lastProgress = new Date().toISOString();
  if (!faltam) it.finishedAt = new Date().toISOString();
  await salvarChave(leadId, '_itbi', it);
  await nota(leadId, `📄 Guia do ITBI salva no Drive (pasta ITBI): ${nomeArq}${d.valorItbi ? ` — ${brl(d.valorItbi)}` : ''}${d.vencimento ? `, vence ${d.vencimento}` : ''}.${faltam ? ` Faltam ${faltam} declaração(ões).` : ' Todas as guias prontas: vou mandar ao cliente.'}`);
  emitir(p.io, accountId, leadId);
  if (!faltam) await enviarGuiasAoCliente(accountId, leadId, p.io).catch((e) => console.error('[ITBI] envio ao cliente:', e?.message));
  return it;
}

/** Manda as guias ao cliente (07h–21h). Conversa fechada: template "Olá, tudo bem?" e as guias saem quando ele responder (o poller confere). */
export async function enviarGuiasAoCliente(accountId: string, leadId: string, io?: Io): Promise<'ENVIADO' | 'TEMPLATE' | 'DEPOIS' | 'FALHOU'> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const it = cf._itbi as Itbi | undefined;
  if (!lead || !it || it.status !== 'DONE' || !it.enviarAoCliente || it.envio?.enviadoAt) return 'DEPOIS';
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return 'DEPOIS';
  const msg = require('./message.service') as typeof import('./message.service');
  if (!(await whatsappWindowOpen(leadId))) {
    if (it.envio?.templateAt) return 'DEPOIS'; // já chamou: espera a resposta
    const t = await msg.sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: 'ola_tudo_bem', language: 'pt_BR', bodyParams: [], previewText: 'Olá, tudo bem?', io: undefined } as any);
    if (!t.success) { await salvarChave(leadId, '_itbi', { ...it, envio: { ...(it.envio || {}), falha: (t as any).error || 'template não saiu' } }); return 'FALHOU'; }
    await salvarChave(leadId, '_itbi', { ...it, envio: { ...(it.envio || {}), templateAt: new Date().toISOString() } });
    await nota(leadId, '📨 ITBI: conversa fechada — mandei o template "Olá, tudo bem?". A guia do ITBI vai quando o cliente responder.');
    return 'TEMPLATE';
  }
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || '';
  const total = it.declaracoes.reduce((s, d) => s + (d.valorItbi || 0), 0);
  const vencs = [...new Set(it.declaracoes.map((d) => d.vencimento).filter(Boolean))];
  const google = await import('./google.service');
  for (const [i, d] of it.declaracoes.entries()) {
    if (!d.darDriveId) continue;
    const buffer = await google.downloadDriveFile(accountId, d.darDriveId, 'application/pdf');
    const caption = i === 0
      ? `${nome ? `${nome}, s` : 'S'}egue a guia do ITBI${it.declaracoes.length > 1 ? ` (${it.declaracoes.length} guias, uma por declaração)` : ''}${total ? `, no total de ${brl(total)}` : ''}${vencs.length ? `, com vencimento em ${vencs.join(' e ')}` : ''}. O ITBI é o imposto de transmissão do imóvel e precisa estar pago pra seguir com o registro no cartório. Depois de pagar, me manda o comprovante por aqui. 🙂`
      : undefined;
    const r = await msg.sendOutboundMedia({ accountId, leadId, buffer, fileName: d.darNome || 'Guia ITBI.pdf', mimeType: 'application/pdf', caption, io: io || undefined });
    if (!r.success) {
      await salvarChave(leadId, '_itbi', { ...it, envio: { ...(it.envio || {}), falha: r.error } });
      await nota(leadId, `⚠️ ITBI: a guia não saiu pro cliente (${r.error}). Ela está na pasta ITBI do Drive.`);
      push(accountId, '⚠️ Guia do ITBI não saiu', `${lead.name}: ${r.error}`, leadId);
      return 'FALHOU';
    }
  }
  await salvarChave(leadId, '_itbi', { ...it, envio: { ...(it.envio || {}), enviadoAt: new Date().toISOString(), falha: undefined } });
  await nota(leadId, `✅ ITBI: guia${it.declaracoes.length > 1 ? 's enviadas' : ' enviada'} ao cliente no WhatsApp${total ? ` (total ${brl(total)})` : ''}.`);
  push(accountId, '✅ Guia do ITBI enviada ao cliente', `${lead.name}${total ? `: ${brl(total)}` : ''}`, leadId);
  return 'ENVIADO';
}

/** Poller (1 min): guias prontas que ainda não foram ao cliente (fora do horário ou esperando a resposta ao template). */
export async function processItbiEnvios(accountId: string, io?: Io): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND "customFields"->'_itbi'->>'status' = 'DONE' AND "customFields"->'_itbi'->'envio'->>'enviadoAt' IS NULL AND COALESCE("customFields"->'_itbi'->>'enviarAoCliente', 'true') = 'true' LIMIT 10`;
  for (const { id } of ids) await enviarGuiasAoCliente(accountId, id, io).catch((e) => console.error('[ITBI] envio:', e?.message));
}

/** Resumo pra IA/Jarvis. */
export function resumoItbi(it: Itbi | null | undefined): string {
  if (!it) return 'sem pedido de ITBI';
  const st: Record<string, string> = { REQUESTED: 'na fila da extensão', RUNNING: 'a extensão está no portal', CALCULADO: 'calculado, esperando a equipe confirmar o envio', DONE: 'guia emitida', OFICIO: 'lançamento de ofício (sem guia)', FAILED: 'falhou', CANCELED: 'cancelado' };
  return `ITBI ${st[it.status] || it.status} (${it.modo})${it.detail ? ` — ${it.detail}` : ''}\n${it.declaracoes.map((d) => `• ${d.transmitente.nome} → ${d.adquirente.nome} ${d.percentual}% ${brl(d.valorPactuado)}: ${d.status}${d.valorItbi ? `, ITBI ${brl(d.valorItbi)}` : ''}${d.vencimento ? `, vence ${d.vencimento}` : ''}${d.detail && d.status !== 'GUIA' ? ` (${d.detail})` : ''}`).join('\n')}${it.envio?.enviadoAt ? '\nGuia enviada ao cliente.' : ''}`;
}

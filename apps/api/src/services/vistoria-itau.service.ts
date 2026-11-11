import { prisma } from '../lib/prisma';
import { sexoParaFormulario } from './sexo-pelo-nome';
import { moverParaVistoria } from './vistoria-inter.service';

type Io = Parameters<typeof moverParaVistoria>[3];

/**
 * VISTORIA DO ITAÚ NO FINANCIAMENTO (Fabio 11/11: "precisamos solicitar a vistoria de um cliente pelo Itaú" → "extensão preenche").
 * No portal Itaú Imóveis não existe "pedir vistoria": depois da aprovação a proposta fica em "Formulários Digitais — Pronto para preenchimento"
 * (compradores, vendedor, imóvel com o contato da vistoria, DPS do seguro). Com os formulários completos vem o "Envio de Documentos (Mesa de entrada)"
 * e só então o Itaú faz a "Análise de Documentos e Avaliação do Imóvel" (a vistoria).
 * Quem digita no portal é a extensão "Financiamento Itaú" (CPF/RG do cliente e do vendedor nunca são digitados por pessoa — regra do Fabio).
 * O CRM monta os dados: compradores pela ficha cadastral lida dos documentos (_fichaCadastral), vendedor pela pasta VENDEDOR (_fichaVendedor),
 * imóvel pelo card (CEP, número, matrícula, cartório, inscrição do IPTU lida na conferência) e o contato da vistoria (campo "Contato vistoria").
 * O que faltar a extensão deixa em branco, salva o resto e o CRM avisa a equipe (nota + push) — nada é pedido ao cliente sozinho.
 * DPS (declaração de saúde): seguradora Itaú (padrão do Fabio 03/11). As perguntas de saúde o portal avisa que omitir/errar pode cancelar a indenização,
 *   então só vão marcadas "nenhuma doença" com o OK da equipe no card (customFields._vistItauDpsOk = true); sem isso ficam em branco e entram no "falta".
 * Estado: customFields._vistItau = { status: REQUESTED | RUNNING | PARTIAL | SAVED | FAILED, requestedAt, by, claimedAt, at, faltando, erro, etapa }.
 */

type Cf = Record<string, any>;
export type EnderecoItau = { cep: string; logradouro: string; numero: string; complemento: string; bairro: string; cidade: string; uf: string };
export type DocItau = { tipo: 'RG' | 'CNH' | ''; numero: string; orgao: string; uf: string; emissao: string };
export type PessoaItau = {
  nome: string; cpf: string; nascimento: string; sexo: 'M' | 'F' | ''; nacionalidade: string; ufNascimento: string; cidadeNascimento: string;
  email: string; celular: string; profissao: string; estadoCivil: string; regimeBens: string; dataCasamento: string; uniaoEstavel: boolean;
  doc: DocItau; mae: string; pai: string; endereco: EnderecoItau;
};
export type VendedorItau = PessoaItau & { conjuge: PessoaItau | null; conta: { banco: string; agencia: string; conta: string } | null };
export type DadosItau = {
  proposta: string;
  compradores: PessoaItau[];
  vendedores: VendedorItau[];
  imovel: { cep: string; numero: string; complemento: string; matricula: string; iptu: string; cartorio: string; cidade: string; uf: string };
  contato: { nome: string; email: string; celular: string };
  contaItau: { agencia: string; conta: string } | null;
  percentuais: number[];
  fgts: boolean;
  gastosCartorio: boolean;
  seguradora: 'ITAU';
  dps: { nenhumaDoenca: boolean };
};
type St = { status?: string; requestedAt?: string; by?: string; claimedAt?: string; at?: string; faltando?: string[]; erro?: string | null; etapa?: string; proposta?: string };

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
const dig = (v: unknown) => s(v).replace(/\D/g, '');
const norm = (v: unknown) => s(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };

/** Grava só a chave _vistItau (jsonb_set): não apaga o que outro processo gravou no meio-tempo. */
async function salvaSt(leadId: string, st: St) {
  await prisma.$executeRawUnsafe(`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_vistItau}', $1::jsonb, true) WHERE id = $2`, JSON.stringify(st), leadId);
}

/** dd/mm/aaaa a partir de dd/mm/aaaa, aaaa-mm-dd ou ISO. */
export function dataBr(v: unknown): string {
  const t = s(v);
  let m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Regime de bens no texto que o portal usa na lista. Pura. */
export function regimeItau(v: unknown): string {
  const n = norm(v);
  if (!n) return '';
  if (/obrigat/.test(n)) return 'Regime da Separação Obrigatória';
  if (/separa/.test(n)) return 'Regime da Separação Total de Bens';
  if (/aquest/.test(n)) return 'Regime de Participação Final nos Aquestos';
  if (/universal/.test(n)) return 'Regime de Comunhão Universal';
  if (/parcial|comunhao/.test(n)) return 'Regime de Comunhão Parcial de Bens';
  return '';
}

/** Estado civil como o portal grava ("Casado", "Solteiro"…). Pura. */
export function estadoCivilItau(v: unknown): { estadoCivil: string; uniaoEstavel: boolean } {
  const n = norm(v);
  if (/uniao|estavel|convivente/.test(n)) return { estadoCivil: 'Solteiro', uniaoEstavel: true };
  if (/casad/.test(n)) return { estadoCivil: 'Casado', uniaoEstavel: false };
  if (/divorc/.test(n)) return { estadoCivil: 'Divorciado', uniaoEstavel: false };
  if (/separad/.test(n)) return { estadoCivil: 'Separado', uniaoEstavel: false };
  if (/viuv/.test(n)) return { estadoCivil: 'Viúvo', uniaoEstavel: false };
  if (/solteir/.test(n)) return { estadoCivil: 'Solteiro', uniaoEstavel: false };
  return { estadoCivil: '', uniaoEstavel: false };
}

/** Pessoa da ficha cadastral (formato do ficha-cadastral.service) → campos do formulário do Itaú. Pura. */
export function pessoaItau(p: Record<string, any>, extra: { email?: string; celular?: string; sexo?: 'M' | 'F' | null } = {}): PessoaItau {
  const id = (p.identidade || {}) as Record<string, any>;
  const nat = (p.naturalidade || {}) as Record<string, any>;
  const e = (p.endereco || {}) as Record<string, any>;
  const ec = estadoCivilItau(p.estadoCivil);
  const tipo = /cnh/i.test(s(id.tipo)) ? 'CNH' : s(id.numero) ? 'RG' : '';
  const nacionalidade = !s(p.nacionalidade) || /brasil/i.test(s(p.nacionalidade)) ? 'BRASILEIRA' : s(p.nacionalidade).toUpperCase();
  return {
    nome: s(p.nome), cpf: dig(p.cpf), nascimento: dataBr(p.nascimento), sexo: extra.sexo || '', nacionalidade,
    ufNascimento: s(nat.uf).toUpperCase().slice(0, 2), cidadeNascimento: s(nat.cidade),
    email: s(extra.email || p.email), celular: dig(extra.celular || p.telefone), profissao: s(p.profissao || p.trabalho?.cargo),
    estadoCivil: ec.estadoCivil, regimeBens: regimeItau(p.regimeBens), dataCasamento: dataBr(p.dataCasamento), uniaoEstavel: ec.uniaoEstavel,
    doc: { tipo, numero: s(tipo === 'CNH' ? (p.cnh?.numero || id.numero) : id.numero).replace(/[.\-\s]/g, ''), orgao: s(id.orgao).toUpperCase(), uf: s(id.uf).toUpperCase().slice(0, 2), emissao: dataBr(id.emissao) },
    mae: s(p.mae), pai: s(p.pai),
    endereco: { cep: dig(e.cep), logradouro: s(e.logradouro), numero: s(e.numero), complemento: s(e.complemento), bairro: s(e.bairro), cidade: s(e.cidade), uf: s(e.uf).toUpperCase().slice(0, 2) },
  };
}

/** O que falta de uma pessoa pro formulário. Pura. */
export function faltasPessoa(p: PessoaItau, quem: string, comEndereco = true): string[] {
  const f: string[] = [];
  if (!p.cpf) f.push(`CPF ${quem}`);
  if (!p.nascimento) f.push(`data de nascimento ${quem}`);
  if (!p.sexo) f.push(`sexo ${quem}`);
  if (!p.ufNascimento || !p.cidadeNascimento) f.push(`naturalidade ${quem}`);
  if (!p.doc.numero || !p.doc.orgao || !p.doc.emissao) f.push(`RG/CNH ${quem} (número, órgão e data de expedição)`);
  if (!p.mae) f.push(`nome da mãe ${quem}`);
  if (!p.estadoCivil) f.push(`estado civil ${quem}`);
  if (p.estadoCivil === 'Casado' && (!p.regimeBens || !p.dataCasamento)) f.push(`regime de bens e data do casamento ${quem}`);
  if (!p.profissao) f.push(`profissão ${quem}`);
  if (!p.email) f.push(`e-mail ${quem}`);
  if (!p.celular) f.push(`celular ${quem}`);
  if (comEndereco && (!p.endereco.cep || !p.endereco.numero)) f.push(`endereço com CEP e número ${quem}`);
  return f;
}

/** Número da proposta aprovada no Itaú: a análise ITAU_FH (portal Itaú Imóveis), senão o trecho "Itaú: … proposta N" do resumo do card. */
async function propostaDoItau(leadId: string, cf: Cf): Promise<string> {
  const a = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: 'ITAU_FH', dryRun: false, status: 'APPROVED', proposalNumber: { not: null } }, orderBy: { updatedAt: 'desc' }, select: { proposalNumber: true } });
  if (a?.proposalNumber) return dig(a.proposalNumber);
  const m = /Ita[uú]:[^|]*?proposta\s*(\d{6,})/i.exec(s(cf._fhResumo));
  return m ? m[1] : '';
}

/** "Nome - (61) 99999-9999 - email@x" (campo Contato vistoria) → partes. Pura. */
export function contatoDoCampo(v: unknown): { nome: string; email: string; celular: string } {
  const t = s(v);
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(t)?.[0] || '';
  const tel = /(\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4})/.exec(t)?.[1] || '';
  const nome = t.replace(email, '').replace(tel, '').replace(/[-–—|,;:()]+/g, ' ').replace(/\b(tel|telefone|cel|celular|whats(app)?|e-?mail)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return { nome, email, celular: dig(tel) };
}

/** Monta os dados do formulário e a lista do que falta. Lê o banco; não grava nada. */
export async function montarDadosItau(accountId: string, leadId: string): Promise<{ dados: DadosItau; faltando: string[]; nome: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true, contact: { select: { email: true, phone: true } } } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Cf;
  const faltando: string[] = [];
  const proposta = await propostaDoItau(leadId, cf);
  if (!proposta) faltando.push('número da proposta aprovada no Itaú');

  // Compradores: ficha cadastral (documentos) + e-mail/telefone do card.
  const ficha = ((cf._fichaCadastral?.participantes || []) as any[]).slice().sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0));
  const compradores: PessoaItau[] = [];
  for (const n of [1, 2]) {
    const f = ficha.find((p) => Number(p.ordem) === n) || ficha[n - 1];
    if (!f) continue;
    const email = s(cf[`email_${n}`]) || (n === 1 ? s(lead.contact?.email) : '');
    const celular = s(cf[`telefone_${n}`]) || (n === 1 ? s(lead.contact?.phone) : '');
    compradores.push(pessoaItau(f, { email, celular, sexo: sexoParaFormulario(n === 1 ? cf : null, f.nome, f.sexo) }));
  }
  if (!compradores.length) faltando.push('ficha cadastral dos compradores (documentos pessoais lidos)');
  compradores.forEach((c, i) => faltando.push(...faltasPessoa(c, i === 0 ? 'do 1º comprador' : 'do 2º comprador')));

  // Vendedor(es): pasta VENDEDOR do Drive (lida sob demanda e guardada em _fichaVendedor).
  let pessoasV = ((cf._fichaVendedor?.pessoas || []) as any[]);
  if (!pessoasV.length) {
    try { pessoasV = (await (require('./ficha-cadastral.service') as typeof import('./ficha-cadastral.service')).lerVendedores(accountId, leadId)) || []; } catch { pessoasV = []; }
  }
  const dv = (cf._dadosVistoriaFh || {}) as Cf;
  const vendedores: VendedorItau[] = [];
  const cpfsConjuge = new Set(pessoasV.map((p) => dig(p.conjuge?.cpf)).filter(Boolean));
  for (const p of pessoasV) {
    if (cpfsConjuge.has(dig(p.cpf)) && vendedores.some((v) => v.conjuge?.cpf === dig(p.cpf))) continue;
    const base = pessoaItau(p, { email: s(dv.vendedor?.email), celular: s(dv.vendedor?.telefone), sexo: sexoParaFormulario(null, p.nome, p.sexo) });
    if (!base.profissao && dv.vendedor?.profissao) base.profissao = s(dv.vendedor.profissao);
    const cj = p.conjuge?.cpf ? pessoasV.find((x) => dig(x.cpf) === dig(p.conjuge.cpf)) : null;
    const conjuge = cj ? pessoaItau(cj, { sexo: sexoParaFormulario(null, cj.nome, cj.sexo) }) : null;
    const conta = dv.conta?.conta ? { banco: dig(dv.conta.banco).padStart(3, '0'), agencia: dig(dv.conta.agencia), conta: `${dig(dv.conta.conta)}${dig(dv.conta.digito)}` } : null;
    vendedores.push({ ...base, conjuge, conta });
  }
  if (!vendedores.length) faltando.push('documentos do vendedor (RG/CNH, certidão de estado civil e comprovante de residência na pasta VENDEDOR)');
  vendedores.forEach((v, i) => {
    faltando.push(...faltasPessoa(v, vendedores.length > 1 ? `do ${i + 1}º vendedor` : 'do vendedor'));
    if (v.conjuge) faltando.push(...faltasPessoa(v.conjuge, 'do cônjuge do vendedor', false));
    if (!v.conta) faltando.push(`conta para crédito ${vendedores.length > 1 ? `do ${i + 1}º vendedor` : 'do vendedor'} (banco, agência e conta)`);
  });

  // Imóvel: card + inscrição do IPTU lida na conferência de documentos.
  const revs = Object.values((cf._docReview || {}) as Record<string, any>);
  const iptu = dig(cf.inscricao_imovel || revs.map((r) => r?.inscricao).find(Boolean));
  const endTxt = s(cf.endereco_imovel);
  const complemento = s(cf.complemento_imovel) || s(/^[^,—]*?((?:\b(?:LT|LOTE|QD|QUADRA|TO|TORRE|BL|BLOCO|AP|APTO|APARTAMENTO|CASA|SALA)\b[^,—]*)+)/i.exec(endTxt)?.[1]).replace(/\s+/g, ' ');
  const numeroImovel = s(cf.imovel_numero || cf._endImovelN);
  // "…LT 4 TO II AP, 1408": o número do apartamento vem depois da vírgula — junta no complemento ("LT 4 TO II AP 1408").
  const complementoCompleto = /\b(AP|APTO|APARTAMENTO|SALA|CASA|UNIDADE)\s*$/i.test(complemento) && numeroImovel && !complemento.includes(numeroImovel) ? `${complemento} ${numeroImovel}` : complemento;
  const imovel = {
    cep: dig(cf.imovel_cep || cf.cep_imovel), numero: numeroImovel, complemento: complementoCompleto,
    matricula: dig(cf.numero_matricula || cf.matricula_imovel), iptu, cartorio: s(cf.cartorio_registro), cidade: s(cf.cidade_imovel), uf: s(cf.uf_imovel || (/\/([A-Z]{2})\b/.exec(endTxt)?.[1] || '')).toUpperCase(),
  };
  if (!imovel.cep) faltando.push('CEP do imóvel');
  if (!imovel.matricula) faltando.push('número da matrícula do imóvel');
  if (!imovel.iptu) faltando.push('inscrição do IPTU do imóvel');
  if (!imovel.cartorio) faltando.push('cartório de registro do imóvel');

  // Contato da vistoria: campo do card (corretor, vendedor, inquilino…). Sem e-mail no campo, vai o e-mail do comprador.
  const ct = contatoDoCampo(cf.contato_vistoria || (dv.contato ? `${s(dv.contato.nome)} ${s(dv.contato.telefone)}` : ''));
  const contato = { nome: ct.nome, celular: ct.celular, email: ct.email || compradores[0]?.email || '' };
  if (!contato.nome || !contato.celular) faltando.push('contato da vistoria (nome e celular de quem acompanha o engenheiro)');

  const cc = (dv.contaComprador || {}) as Cf;
  const contaItau = cc.conta && !cc.naoTem ? { agencia: dig(cc.agencia), conta: `${dig(cc.conta)}${dig(cc.digito)}` } : null;
  const percentuais = compradores.length > 1 ? [50, 50] : [100];
  return {
    nome: lead.name,
    faltando: Array.from(new Set(faltando)),
    dados: { proposta, compradores, vendedores, imovel, contato, contaItau, percentuais, fgts: /sim|true|fgts/i.test(s(cf.usa_fgts || cf.fgts)), gastosCartorio: false, seguradora: 'ITAU', dps: { nenhumaDoenca: cf._vistItauDpsOk === true } },
  };
}

// ─── Botão do card ───

export async function itauVistoriaStatus(accountId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Cf;
  const proposta = await propostaDoItau(leadId, cf);
  return { aplicavel: !!proposta || !!cf._vistItau, proposta: proposta || null, st: (cf._vistItau || null) as St | null, dpsOk: cf._vistItauDpsOk === true };
}

export async function itauVistoriaPreview(accountId: string, leadId: string) {
  const { dados, faltando } = await montarDadosItau(accountId, leadId);
  return { proposta: dados.proposta, faltando, compradores: dados.compradores.map((c) => c.nome), vendedores: dados.vendedores.map((v) => v.nome), contato: dados.contato, imovel: dados.imovel };
}

/** Declaração de saúde (DPS) "nenhuma doença" pros compradores — só com o OK da equipe (Fabio 11/11: "sim" pro Pedro e a Euma). Grava só a chave. */
export async function autorizarDpsItau(accountId: string, leadId: string, userId: string, ok: boolean) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true } });
  if (!lead) throw new Error('Card não encontrado');
  await prisma.$executeRawUnsafe(`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_vistItauDpsOk}', $1::jsonb, true) WHERE id = $2`, JSON.stringify(ok), leadId);
  const quem = (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name || 'a equipe';
  await note(leadId, ok
    ? `🩺 ${quem} autorizou a declaração de saúde (DPS) do Itaú com "nenhuma doença" e "não" nas perguntas de invalidez/acidente pra todos os compradores. Vale no próximo "Preencher formulários do Itaú".`
    : `🩺 ${quem} retirou a autorização da DPS "nenhuma doença" do Itaú: as perguntas de saúde ficam em branco.`);
  return { ok: true, dpsOk: ok };
}

/** Clique em "Preencher formulários do Itaú": vai pra fila da extensão (ela salva o que tiver e devolve o que faltou). */
export async function requestItauVistoria(accountId: string, leadId: string, userId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Cf;
  const st = (cf._vistItau || {}) as St;
  if ((st.status === 'REQUESTED' || st.status === 'RUNNING') && Date.now() - new Date(st.claimedAt || st.requestedAt || 0).getTime() < 20 * 60_000) throw new Error('Os formulários do Itaú já estão na fila da extensão.');
  const proposta = await propostaDoItau(leadId, cf);
  if (!proposta) throw new Error('Este card não tem proposta aprovada no Itaú.');
  const quem = (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name || 'a equipe';
  await salvaSt(leadId, { status: 'REQUESTED', requestedAt: new Date().toISOString(), by: quem, proposta, erro: null, faltando: st.faltando || [] });
  await note(leadId, `🏠 ${quem} pediu os formulários digitais do Itaú (proposta ${proposta}): a extensão "Financiamento Itaú" preenche compradores, vendedor, imóvel (com o contato da vistoria) e o seguro no portal e salva. O que faltar fica em branco e vem numa nota.`);
  return { ok: true, proposta };
}

/** A extensão pergunta "tem formulário do Itaú pra preencher?". Um por vez; RUNNING sem sinal há 20 min = falha. */
export async function claimItauVistoria(accountId: string): Promise<{ leadId: string; leadName: string; proposta: string; dados: DadosItau; faltando: string[] } | null> {
  const rows = await prisma.$queryRaw<{ id: string; name: string; customFields: any }[]>`SELECT id, name, "customFields" FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false AND "customFields"->'_vistItau'->>'status' IN ('REQUESTED','RUNNING') ORDER BY "updatedAt" ASC LIMIT 5`;
  for (const r of rows) {
    const st = ((r.customFields || {}) as Cf)._vistItau as St;
    if (st.status === 'RUNNING') {
      if (Date.now() - new Date(st.claimedAt || 0).getTime() > 20 * 60_000) {
        await salvaSt(r.id, { ...st, status: 'FAILED', erro: 'a extensão não terminou em 20 min' });
        await note(r.id, '⚠️ A extensão não terminou os formulários do Itaú em 20 min (janela fechada ou travou). Clique de novo no card.');
      }
      continue;
    }
    try {
      const { dados, faltando } = await montarDadosItau(accountId, r.id);
      if (!dados.proposta) { await salvaSt(r.id, { ...st, status: 'FAILED', erro: 'sem número da proposta do Itaú' }); continue; }
      await salvaSt(r.id, { ...st, status: 'RUNNING', claimedAt: new Date().toISOString(), faltando });
      return { leadId: r.id, leadName: r.name, proposta: dados.proposta, dados, faltando };
    } catch (e: any) {
      await salvaSt(r.id, { ...st, status: 'FAILED', erro: String(e?.message || e).slice(0, 300) });
    }
  }
  return null;
}

/** Resultado da extensão. event: step (sinal de vida) | saved (salvou; `completo` = o portal deu os formulários como completos) | failed. */
export async function reportItauVistoria(accountId: string, leadId: string, d: { event: string; detail?: string; reason?: string; completo?: boolean; faltando?: string[]; etapa?: string; secoes?: Record<string, boolean> }, io?: Io) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const st = (((lead.customFields || {}) as Cf)._vistItau || {}) as St;
  const agora = new Date().toISOString();
  if (d.event === 'step') { await salvaSt(leadId, { ...st, claimedAt: agora, etapa: s(d.etapa).slice(0, 120) || st.etapa }); return { ok: true }; }
  if (d.event === 'failed') {
    const motivo = s(d.reason || 'erro').slice(0, 400);
    await salvaSt(leadId, { ...st, status: 'FAILED', at: agora, erro: motivo });
    await note(leadId, `⚠️ A extensão NÃO conseguiu preencher os formulários do Itaú (proposta ${st.proposta || '?'}): ${motivo}${d.etapa ? ` — etapa: ${s(d.etapa)}` : ''}.`);
    push(accountId, '⚠️ Itaú: formulários não preenchidos', `${lead.name}: ${motivo.slice(0, 90)}`, leadId);
    return { ok: true };
  }
  // saved
  const faltando = Array.from(new Set((Array.isArray(d.faltando) ? d.faltando : st.faltando || []).map((x) => s(x)).filter(Boolean))).slice(0, 40);
  const secoes = d.secoes ? Object.entries(d.secoes).map(([k, v]) => `${v ? '✅' : '⏳'} ${k}`).join(' · ') : '';
  if (d.completo) {
    await salvaSt(leadId, { ...st, status: 'SAVED', at: agora, erro: null, faltando: [] });
    await note(leadId, `✅ Formulários digitais do Itaú preenchidos e salvos no portal (proposta ${st.proposta || '?'}). ${secoes}\nPróximo passo no portal: "Envio de Documentos — Mesa de entrada"; depois o Itaú faz a análise dos documentos e a avaliação (vistoria) do imóvel.`);
    push(accountId, '✅ Itaú: formulários salvos', `${lead.name}: falta o envio dos documentos (Mesa de entrada)`, leadId);
  } else {
    await salvaSt(leadId, { ...st, status: 'PARTIAL', at: agora, erro: null, faltando });
    await note(leadId, `🏠 Formulários do Itaú salvos EM PARTE no portal (proposta ${st.proposta || '?'}). ${secoes}\nFalta pra completar:\n${faltando.map((f) => `• ${f}`).join('\n') || '• (o portal não disse o quê — confira na proposta)'}\nCom os dados no card/pasta, clique de novo em "Preencher formulários do Itaú".`);
    push(accountId, '🏠 Itaú: formulários em parte', `${lead.name}: faltam ${faltando.length} item(ns)`, leadId);
  }
  if (d.detail) await note(leadId, `🏠 Itaú (detalhe da extensão): ${s(d.detail).slice(0, 1500)}`);
  return { ok: true };
}

import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/* ── VENDEDORES no cadastro da CAIXA (Fabio 18/11, Fernanda — contratação do Financiamento pela CAIXA): "precisaremos cadastrar os vendedores no SIOPI, para isso
 * precisa cadastrar os vendedores no CAIXA Aqui para que eles apareçam no SIOPI" + "eles serão cadastrados sem renda" + "não precisa de um card".
 * O vendedor NÃO vira card nem participante da ficha (`_fichaCadastral.participantes` alimenta fluxos que falam com o cliente — lição de 12/11): a ficha dele fica
 * em `_caixaVendedores` no card do comprador e a extensão "Cadastro CAIXA (Caixa Aqui)" recebe um trabalho `cadastrar` igual ao do participante, com
 * `vendedor: true`, ordem 101, 102… e `semRenda: true`. Gravar o cadastro do vendedor só anota e avisa: nada de análise, conferência dos compradores ou mensagem.
 * Vendedor que JÁ tem cadastro na CAIXA: fica como está (só conferido com os documentos) — o CRM não troca a renda de quem não é cliente.
 * Dados (Fabio 18/11): documentos da pasta VENDEDOR (RG/CNH, certidão de estado civil, print/ficha com e-mail e endereço); endereço = comprovante → informado → o do
 * imóvel vendido; telefone/e-mail que nenhum arquivo traz → POST /caixa-cadastro/:id/vendedores/dados.
 * Estado: `_caixaVendedores` = { at, por, pessoas: [...], informado: { [ordem]: { telefone, email } }, cadastros: { [ordem]: { status, pedidoEm, inicio, fim, tentativas } }, atual? }. */

type Cf = Record<string, any>;
export const ORDEM_VENDEDOR = 101;
export const ehOrdemVendedor = (o: unknown): boolean => Number(o) >= ORDEM_VENDEDOR;
const LEASE_MS = 10 * 60_000;
const dig = (v: unknown) => String(v ?? '').replace(/\D/g, '');

async function salvarV(leadId: string, mut: (c: Cf) => void): Promise<Cf> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const c: Cf = { ...(((l?.customFields || {}) as Cf)._caixaVendedores || {}) };
  mut(c);
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaVendedores}', ${JSON.stringify(c)}::jsonb, true) WHERE id = ${leadId}`;
  return c;
}
const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => {
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body: body.slice(0, 180), leadId }).catch(() => {}); } catch { /* só aviso */ }
};

/** Vendedores da ficha com o telefone/e-mail informados pela equipe por cima. Pura. */
export function vendedoresDaFicha(cf: Cf): any[] {
  const v = cf._caixaVendedores || {};
  const inf = (v.informado || {}) as Record<string, { telefone?: string; email?: string }>;
  return (Array.isArray(v.pessoas) ? v.pessoas : []).map((p: any) => {
    const i = inf[p.ordem] || {};
    return { ...p, telefone: dig(i.telefone) || dig(p.telefone), email: String(i.email || p.email || '').trim().toLowerCase() };
  });
}

/** O que falta pro cadastro do vendedor no Caixa Aqui (sem renda). Pura. */
export function faltaVendedor(p: any): string[] {
  const f: string[] = [];
  if (dig(p?.cpf).length !== 11) f.push('CPF');
  if (!String(p?.identidade?.numero || '').trim()) f.push('documento de identidade (RG/CNH)');
  if (!String(p?.nascimento || '').trim()) f.push('data de nascimento');
  if (!String(p?.mae || '').trim()) f.push('nome da mãe');
  if (!String(p?.estadoCivil || '').trim()) f.push('estado civil');
  if (dig(p?.endereco?.cep).length !== 8) f.push('endereço com CEP');
  if (dig(p?.telefone).length < 10) f.push('telefone (celular)');
  return f;
}

/** Pessoa lida na pasta VENDEDOR → formato do participante da ficha (o que a extensão já sabe preencher). `mesAno` = mês/ano do endereço quando não há comprovante
 *  (o campo é obrigatório na CAIXA; pro vendedor o comprovante não tem prazo — Fabio 18/11). Pura. */
export function paraParticipante(p: any, ordem: number, mesAno: string): any {
  const id = p?.identidade?.numero ? p.identidade
    : p?.cnh?.numero ? { tipo: 'CNH', numero: p.cnh.numero, orgao: p.cnh.orgao, uf: p.cnh.uf, emissao: p.cnh.emissao, validade: p.cnh.validade, primeiraHabilitacao: p.cnh.primeiraHabilitacao }
      : p?.rg?.numero ? { tipo: 'RG', numero: p.rg.numero, orgao: p.rg.orgao, uf: p.rg.uf, emissao: p.rg.emissao } : null;
  const e = p?.endereco || {};
  return {
    ordem, vendedor: true, nome: p?.nome || null, cpf: dig(p?.cpf), nascimento: p?.nascimento || null, sexo: p?.sexo || null, nacionalidade: p?.nacionalidade || 'BRASILEIRA',
    naturalidade: p?.naturalidade || null, identidade: id, mae: p?.mae || null, pai: p?.pai || null,
    estadoCivil: p?.estadoCivil || null, regimeBens: p?.regimeBens || null, dataCasamento: p?.dataCasamento || null, conjuge: p?.conjuge || null,
    endereco: { ...e, comprovanteMesAno: e.comprovanteMesAno || mesAno }, enderecoDoImovel: !!e.doImovel,
    pis: null, profissao: p?.profissao || null, escolaridade: p?.escolaridade || null, telefone: dig(p?.telefone), email: String(p?.email || '').trim().toLowerCase(),
    trabalho: { vinculo: null, esfera: null, empregador: null, cnpj: null, cargo: null, admissao: null }, contracheques: [],
    semRenda: true, rendaInformal: false, rendaBrutaMensal: null, rendaLiquidaMensal: null, outrasRendas: [], patrimonioTotal: null, faltando: [],
  };
}

const mascaraCpf = (c: string) => (c.length === 11 ? `${c.slice(0, 3)}.***.***-${c.slice(9)}` : '—');

/** Lê a pasta VENDEDOR e grava a ficha dos vendedores no card (+ anotação). Só os donos da certidão de ônus, quando ela foi lida. Erro em texto. */
export async function montarFichaVendedores(accountId: string, leadId: string, por: string): Promise<{ erro?: string; pessoas?: any[] }> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return { erro: 'Lead não encontrado' };
  const cf = (l.customFields || {}) as Cf;
  const fc = require('./ficha-cadastral.service') as typeof import('./ficha-cadastral.service');
  const rd = require('./received-docs.service') as typeof import('./received-docs.service');
  let lidas = (await fc.lerVendedores(accountId, leadId)) || [];
  if (!lidas.length) return { erro: 'Nenhum documento na pasta VENDEDOR do Drive (ou o card não tem a pasta)' };
  lidas = await fc.vendedoresComEndereco(leadId, cf, lidas);
  const daOnus = rd.vendedoresDoImovel(cf);
  const doImovel = daOnus.length ? lidas.filter((p: any) => daOnus.some((n) => rd.mesmaPessoa(String(p.nome || ''), n))) : lidas;
  const base = (doImovel.length ? doImovel : lidas).filter((p: any) => dig(p.cpf).length === 11 || String(p.nome || '').trim());
  const hoje = new Date();
  const mesAno = `${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
  let pessoas = base.map((p: any, i: number) => paraParticipante(p, ORDEM_VENDEDOR + i, mesAno));
  // CPF do cônjuge: o outro vendedor com o mesmo primeiro nome (casal na mesma certidão de ônus).
  const pn = (s: unknown) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim().split(/\s+/)[0];
  pessoas = pessoas.map((p: any) => {
    if (!p.conjuge?.nome || dig(p.conjuge.cpf).length === 11) return p;
    const o = pessoas.find((x: any) => x.ordem !== p.ordem && pn(x.nome) === pn(p.conjuge.nome) && x.cpf.length === 11);
    return o ? { ...p, conjuge: { ...p.conjuge, cpf: o.cpf } } : p;
  });
  const v = await salvarV(leadId, (x) => { x.at = new Date().toISOString(); x.por = por; x.pessoas = pessoas; x.cadastros = x.cadastros || {}; x.informado = x.informado || {}; });
  const comInf = vendedoresDaFicha({ _caixaVendedores: v });
  const linhas = comInf.map((p: any) => {
    const f = faltaVendedor(p);
    const e = p.endereco || {};
    return `👤 Vendedor ${p.ordem - ORDEM_VENDEDOR + 1}: ${p.nome || '—'} — CPF ${mascaraCpf(p.cpf)}\n• Identidade: ${p.identidade ? `${p.identidade.tipo || ''} ${p.identidade.numero || ''} ${p.identidade.orgao || ''}/${p.identidade.uf || ''}`.replace(/\s+/g, ' ').trim() : '—'} · nascimento ${p.nascimento || '—'} · mãe ${p.mae || '—'}\n• Estado civil: ${p.estadoCivil || '—'}${p.regimeBens ? ` (${p.regimeBens})` : ''}${p.conjuge?.nome ? ` · cônjuge ${p.conjuge.nome}` : ''}\n• Endereço${p.enderecoDoImovel ? ' (o do imóvel — sem comprovante nem endereço informado)' : ''}: ${[e.logradouro, e.numero, e.complemento, e.bairro, e.cidade && `${e.cidade}/${e.uf || ''}`, e.cep].filter(Boolean).join(', ') || '—'}\n• Telefone: ${p.telefone || '—'} · e-mail: ${p.email || '—'} · renda: SEM RENDA\n${f.length ? `⚠️ Falta pro cadastro: ${f.join(', ')}` : '✅ Pronto pro cadastro no Caixa Aqui'}`;
  });
  await note(leadId, `📋 FICHA DE CADASTRO — VENDEDORES (CAIXA)\nPra cadastrar os vendedores no Caixa Aqui (sem renda) e eles aparecerem no SIOPI na contratação (Fabio 18/11). Lida da pasta VENDEDOR do Drive.\n\n${linhas.join('\n\n')}`);
  logActivity({ accountId, userId: null, userName: por, action: 'lead_edited', leadId, leadName: l.name, summary: 'gravou a ficha de cadastro dos vendedores (CAIXA)' } as any);
  return { pessoas: comInf };
}

/** Telefone/e-mail do vendedor informados pela equipe (nenhum documento traz). */
export async function informarDadosVendedor(accountId: string, leadId: string, ordem: number, dados: { telefone?: string; email?: string }, por: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const p = vendedoresDaFicha((l.customFields || {}) as Cf).find((x) => x.ordem === Number(ordem));
  if (!p) return 'Esse vendedor não está na ficha dos vendedores (grave a ficha primeiro)';
  const tel = dig(dados.telefone).replace(/^55(?=\d{10,11}$)/, '');
  const email = String(dados.email || '').trim().toLowerCase();
  if (dados.telefone !== undefined && tel && (tel.length < 10 || tel.length > 11)) return 'Telefone inválido (DDD + número)';
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'E-mail inválido';
  await salvarV(leadId, (x) => { x.informado = { ...(x.informado || {}), [ordem]: { ...(x.informado?.[ordem] || {}), ...(tel ? { telefone: tel } : {}), ...(email ? { email } : {}) } }; });
  await note(leadId, `✏️ Dados do vendedor ${p.nome || ordem} informados por ${por}:${tel ? ` telefone ${tel}` : ''}${email ? ` e-mail ${email}` : ''}.`);
  return null;
}

/** Põe os vendedores com a ficha completa na fila da extensão. Devolve o resumo (quem foi pra fila e o que falta dos outros). */
export async function pedirCadastroVendedores(accountId: string, leadId: string, por: string, ordens?: number[]): Promise<{ erro?: string; fila: string[]; faltando: string[] }> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return { erro: 'Lead não encontrado', fila: [], faltando: [] };
  let ps = vendedoresDaFicha((l.customFields || {}) as Cf);
  if (!ps.length) {
    const r = await montarFichaVendedores(accountId, leadId, por);
    if (r.erro) return { erro: r.erro, fila: [], faltando: [] };
    ps = r.pessoas || [];
  }
  const cads = (((l.customFields || {}) as Cf)._caixaVendedores?.cadastros || {}) as Cf;
  const fila: any[] = []; const faltando: string[] = [];
  for (const p of ps) {
    if (ordens?.length && !ordens.includes(p.ordem)) continue;
    if (/^GRAVADO/i.test(String(cads[p.ordem]?.status || ''))) continue;
    const f = faltaVendedor(p);
    if (f.length) faltando.push(`${p.nome || `vendedor ${p.ordem}`}: ${f.join(', ')}`); else fila.push(p);
  }
  if (fila.length) await salvarV(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}) }; for (const p of fila) x.cadastros[p.ordem] = { status: 'FILA', pedidoEm: new Date().toISOString(), por, tentativas: 0 }; });
  await note(leadId, `🏦 Cadastro dos VENDEDORES no Caixa Aqui (sem renda), pedido por ${por}: ${fila.length ? `na fila da extensão — ${fila.map((p) => p.nome).join(', ')}.` : 'ninguém foi pra fila.'}${faltando.length ? `\n⚠️ Esperando dado: ${faltando.join('; ')}.` : ''}`);
  return { fila: fila.map((p) => p.nome), faltando };
}

/** Algum cadastro de vendedor nas mãos da extensão agora? (a fila da CAIXA é um por vez) */
export async function vendedorEmAndamento(accountId: string): Promise<boolean> {
  const prazo = new Date(Date.now() - LEASE_MS).toISOString();
  const r = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false AND "customFields"->'_caixaVendedores'->'atual'->>'desde' >= ${prazo}`;
  return Number(r[0]?.n || 0) > 0;
}

/** Próximo cadastro de vendedor pra extensão (depois de consultas, cadastros e avaliações dos compradores). */
export async function proximoCadastroVendedor(accountId: string): Promise<any | null> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND EXISTS (
        SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof("customFields"->'_caixaVendedores'->'cadastros') = 'object' THEN "customFields"->'_caixaVendedores'->'cadastros' ELSE '{}'::jsonb END) AS c(k, v)
        WHERE c.v->>'status' IN ('FILA', 'RODANDO')
      )
    ORDER BY "updatedAt" ASC LIMIT 10`;
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true } });
    const cf = (l?.customFields || {}) as Cf;
    const v = cf._caixaVendedores || {};
    if (v.atual && Date.now() - Date.parse(v.atual.desde) < LEASE_MS) return null; // um por vez
    const ordem = Object.entries((v.cadastros || {}) as Cf).find(([, c]: [string, any]) => c?.status === 'FILA' || (c?.status === 'RODANDO' && c.inicio && Date.now() - Date.parse(c.inicio) > LEASE_MS && (c.tentativas || 0) < 3))?.[0];
    if (!ordem) continue;
    const p = vendedoresDaFicha(cf).find((x) => x.ordem === Number(ordem));
    const f = p ? faltaVendedor(p) : ['vendedor fora da ficha'];
    if (f.length) {
      await salvarV(id, (x) => { x.cadastros[ordem] = { ...x.cadastros[ordem], status: `ESPERANDO: ${f.join(', ')}`, fim: new Date().toISOString() }; });
      await note(id, `⏸️ Cadastro do vendedor ${p?.nome || ordem} no Caixa Aqui segurado: falta ${f.join(', ')}.`);
      continue;
    }
    await salvarV(id, (x) => { x.atual = { ordem: Number(ordem), desde: new Date().toISOString() }; x.cadastros[ordem] = { ...x.cadastros[ordem], status: 'RODANDO', inicio: new Date().toISOString(), tentativas: (x.cadastros[ordem]?.tentativas || 0) + 1 }; });
    const { faltando, ...participante } = p;
    return { tipo: 'cadastrar', vendedor: true, leadId: id, leadName: `${l!.name} — vendedor`, ordem: Number(ordem), nome: p.nome, cpf: p.cpf, participante: { ...participante, avaliacaoFeita: false }, primeiro: null };
  }
  return null;
}

/** Resultado do cadastro do vendedor (a extensão manda pela rota de sempre, /:leadId/cadastro com a ordem 101+). Só anota e avisa. */
export async function gravarCadastroVendedor(accountId: string, leadId: string, ordem: number, r: { status: string; texto: string; antigo?: string }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const p = vendedoresDaFicha((l.customFields || {}) as Cf).find((x) => x.ordem === Number(ordem));
  const quem = p?.nome || `vendedor ${ordem}`;
  await salvarV(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}), [ordem]: { ...(x.cadastros?.[ordem] || {}), status: r.status, fim: new Date().toISOString() } }; delete x.atual; });
  if (r.antigo && r.antigo.trim()) await note(leadId, `🗂️ Cadastro ANTIGO na CAIXA do VENDEDOR ${quem}, como estava:\n\n${r.antigo.slice(0, 12000)}`);
  await note(leadId, `🏦 Cadastro na CAIXA — VENDEDOR ${quem}: ${r.status}\n\n${String(r.texto || '').slice(0, 3500)}`);
  push(accountId, `🏦 ${l.name}: cadastro CAIXA do vendedor`, `${quem}: ${r.status}`, leadId);
}

/** Anota a conferência do vendedor no estado dele (não no `_caixaCadastro` dos compradores). */
export async function marcarConferenciaVendedor(leadId: string, ordem: number, info: Cf): Promise<void> {
  await salvarV(leadId, (x) => { x.conferencias = { ...(x.conferencias || {}), [ordem]: { at: new Date().toISOString(), ...info } }; });
}

/** Formulário do cadastro do vendedor salvo: guarda o id no estado dele. */
export async function marcarFormularioVendedor(leadId: string, ordem: number, fileId: string): Promise<void> {
  await salvarV(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}), [ordem]: { ...(x.cadastros?.[ordem] || {}), formulario: fileId } }; });
}

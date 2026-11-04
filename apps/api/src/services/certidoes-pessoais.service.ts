import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { cidadeUfDe } from './certidao-offer.service';

/**
 * CERTIDÕES DO PROCESSO pela extensão "Certidões (automática)" (Fabio 04/11). O conjunto PADRÃO de todo processo:
 *  - para CADA PESSOA (comprador(es) e vendedor(es)): Conjunta Receita/PGFN, Justiça Federal, Cíveis e Criminais (TJ), Trabalhista e a da Fazenda
 *    (estado/município da pessoa — DF: CND do GDF na Receita DF);
 *  - para o IMÓVEL: CND de IPTU (prefeitura do município — DF: Receita DF pela inscrição). É a "CND de IPTU que a A&F emite" da vistoria do Santander.
 * Justiça Federal, TJ e Fazenda mudam por ESTADO (sai do endereço da pessoa) e o IPTU por MUNICÍPIO: tabela abaixo, começando pelo DF. O que ainda não está
 * na tabela (ou é de estado/município sem robô) vira nota + push "emitir à mão" com o link. Sem o estado da pessoa: nota + push pra equipe (nunca pergunta ao cliente).
 * Matrícula/ônus continua na extensão Certidão ONR.
 *
 * Fila em customFields._certidoes (gravada SÓ por jsonb_set — corrida no customFields, 29/10); pessoas digitadas pela equipe (vendedor) em _certPessoas.
 * Gatilho: botão "Emitir certidões" no card (conjunto todo ou uma avulsa). A chave dos passos automáticos da contratação está DESLIGADA: o CRM só sugere.
 * Captcha: a extensão preenche e PARA — quem resolve é a pessoa (push). O PDF vem pela extensão (sem download no computador) → Drive (COMPRADOR / VENDEDOR /
 * IMOVEL) com nome padrão → leitura do resultado (negativa / positiva com efeito de negativa / positiva) → nota + push. Nada sai ao cliente nem ao banco.
 */

export type CertTipo = 'FEDERAL' | 'JUSTICA_FEDERAL' | 'TJ' | 'TRABALHISTA' | 'FAZENDA' | 'IPTU';
export const TIPOS_PESSOA: CertTipo[] = ['FEDERAL', 'JUSTICA_FEDERAL', 'TJ', 'TRABALHISTA', 'FAZENDA'];
export const CERT_NOME: Record<CertTipo, string> = {
  FEDERAL: 'Conjunta Receita/PGFN (tributos federais)',
  JUSTICA_FEDERAL: 'Justiça Federal',
  TJ: 'Ações Cíveis e Criminais (TJ)',
  TRABALHISTA: 'Trabalhista (CNDT)',
  FAZENDA: 'Fazenda (estado/município)',
  IPTU: 'CND de IPTU do imóvel',
};
type Papel = 'COMPRADOR' | 'VENDEDOR';
/** `mae` = nome da mãe: o TJDFT exige pra emitir (Julio 04/11) — sem ele a extensão preenche o resto e espera a pessoa digitar. */
export type Pessoa = { nome: string; doc: string; nascimento?: string; mae?: string; papel: Papel; uf?: string; cidade?: string };
type Imovel = { inscricao: string; cidade: string; uf: string };
/** Onde emitir: `adapter` = a extensão sabe preencher; sem ele, só o link (emitir à mão). `partes` = quantas certidões saem (TRF1: cível + criminal). */
export type Site = { orgao: string; url: string; adapter?: string; extra?: Record<string, string>; partes?: string[] };
export type CertJob = {
  id: string; tipo: CertTipo; status: 'REQUESTED' | 'RUNNING' | 'WAITING' | 'DONE' | 'FAILED' | 'MANUAL' | 'CANCELED';
  pessoa?: Pessoa; imovel?: Imovel; site?: Site;
  requestedAt: string; requestedBy?: string | null; claimedAt?: string; beatAt?: string; waitingPushAt?: string; doneAt?: string;
  erro?: string; detalhe?: string; arquivos?: { nome: string; url: string | null; resultado: string }[];
};

// ── Tabela por UF / município (começa pelo DF — Fabio 04/11). Link só quando conferido; o resto cai na busca. ─────────────────────────
const TRF1_UFS = ['AC', 'AM', 'AP', 'BA', 'DF', 'GO', 'MA', 'MT', 'PA', 'PI', 'RO', 'RR', 'TO'];
const TRF_DA_UF: Record<string, string> = {
  ...Object.fromEntries(TRF1_UFS.map((uf) => [uf, 'TRF1'])), RJ: 'TRF2', ES: 'TRF2', SP: 'TRF3', MS: 'TRF3', RS: 'TRF4', PR: 'TRF4', SC: 'TRF4',
  PE: 'TRF5', AL: 'TRF5', CE: 'TRF5', PB: 'TRF5', RN: 'TRF5', SE: 'TRF5', MG: 'TRF6',
};
const busca = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
/** Justiça Federal: TRF1 (13 UFs, o mesmo site — a extensão escolhe "Regionalizada (1º e 2º Graus)" e emite Cível e Criminal). */
function siteJusticaFederal(uf: string): Site {
  const trf = TRF_DA_UF[uf] || '';
  if (trf === 'TRF1') return { orgao: 'TRF1 (Justiça Federal da 1ª Região)', url: 'https://sistemas.trf1.jus.br/certidao/#/solicitacao', adapter: 'trf1', extra: { orgao: 'Regionalizada' }, partes: ['Cível', 'Criminal'] };
  return { orgao: trf ? `${trf} (Justiça Federal)` : 'Justiça Federal', url: busca(`certidão negativa justiça federal ${trf} emitir online`) };
}
/** Cíveis e Criminais: Tribunal de Justiça do estado. DF = TJDFT ("Especial (Cível e Criminal)"). */
function siteTj(uf: string): Site {
  if (uf === 'DF') return { orgao: 'TJDFT', url: 'https://cnc.tjdft.jus.br/solicitacao-externa', adapter: 'tjdft', extra: { tipo: 'Especial' } };
  return { orgao: `TJ${uf}`, url: busca(`certidão negativa ações cíveis e criminais TJ${uf} emitir online`) };
}
/** Fazenda: DF = Receita DF (Certidão de Débitos "Junto ao GDF"); demais: SEFAZ do estado e/ou prefeitura. */
function siteFazenda(uf: string, cidade: string): Site {
  if (uf === 'DF') return { orgao: 'Receita do DF (GDF)', url: 'https://ww1.receita.fazenda.df.gov.br/cidadao/certidoes/Certidao', adapter: 'receitadf', extra: { alvo: 'PESSOA' } };
  return { orgao: `SEFAZ-${uf}${cidade ? ` / Prefeitura de ${cidade}` : ''}`, url: busca(`certidão negativa de débitos estaduais SEFAZ ${uf}`) };
}
/** IPTU: prefeitura do município. Brasília/DF = Receita DF pela inscrição do imóvel. */
function siteIptu(uf: string, cidade: string): Site {
  if (uf === 'DF') return { orgao: 'Receita do DF (IPTU)', url: 'https://ww1.receita.fazenda.df.gov.br/cidadao/certidoes/Certidao', adapter: 'receitadf', extra: { alvo: 'IMOVEL' } };
  return { orgao: `Prefeitura de ${cidade || '?'}/${uf}`, url: busca(`certidão negativa de débitos imobiliários IPTU prefeitura ${cidade} ${uf}`) };
}
export function siteDe(tipo: CertTipo, p: { uf?: string; cidade?: string }): Site | null {
  const uf = String(p.uf || '').toUpperCase(), cidade = String(p.cidade || '');
  switch (tipo) {
    case 'FEDERAL': return { orgao: 'Receita Federal / PGFN', url: 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home', adapter: 'receita' };
    case 'TRABALHISTA': return { orgao: 'TST (CNDT)', url: 'https://cndt-certidao.tst.jus.br/gerarCertidao', adapter: 'tst' };
    case 'JUSTICA_FEDERAL': return uf ? siteJusticaFederal(uf) : null;
    case 'TJ': return uf ? siteTj(uf) : null;
    case 'FAZENDA': return uf ? siteFazenda(uf, cidade) : null;
    case 'IPTU': return uf ? siteIptu(uf, cidade) : null;
  }
}

// ── Utilidades ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const dig = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const norm = (s: string) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const ATIVOS = new Set(['REQUESTED', 'RUNNING', 'WAITING']);
const FILA_MAX = 60;
const note = (leadId: string, content: string, userId?: string | null) => prisma.note.create({ data: { leadId, type: 'COMMENT', content, ...(userId ? { userId } : {}) } }).catch(() => {});
async function pushDono(accountId: string, leadId: string, title: string, body: string) {
  try {
    const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { userId: true } });
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    const tem = l?.userId ? await prisma.pushSubscription.count({ where: { userId: l.userId } }) : 0;
    sendPushToAccount(accountId, { title, body, leadId }, tem && l?.userId ? [l.userId] : undefined).catch(() => {});
  } catch { /* aviso */ }
}
const filaDe = (cf: Record<string, any>): CertJob[] => (Array.isArray(cf._certidoes) ? cf._certidoes : []);
async function gravarFila(leadId: string, fila: CertJob[]) {
  const f = fila.slice(-FILA_MAX);
  const pend = f.some((j) => ATIVOS.has(j.status));
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_certidoes}', ${JSON.stringify(f)}::jsonb, true), '{_certPend}', ${JSON.stringify(pend)}::jsonb, true) WHERE id = ${leadId}`;
}
async function mexer(leadId: string, fn: (fila: CertJob[]) => void): Promise<CertJob[]> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const fila = filaDe((l?.customFields || {}) as Record<string, any>).map((j) => ({ ...j }));
  fn(fila);
  await gravarFila(leadId, fila);
  return fila;
}
const docValido = (d: string) => d.length === 11 || d.length === 14;
const nascValido = (s?: string) => /^\d{2}\/\d{2}\/\d{4}$/.test(String(s || '').trim());
const alvoTxt = (j: CertJob) => (j.pessoa ? `${j.pessoa.nome} (${j.pessoa.papel === 'VENDEDOR' ? 'vendedor' : 'comprador'})` : `imóvel${j.imovel?.inscricao ? ` — inscrição ${j.imovel.inscricao}` : ''}`);

/** Estado/cidade da pessoa pelo endereço: proposta do site ("Endereço: …, Cidade/UF — CEP") e card. Sem isso, a equipe informa no botão. */
async function enderecoDoComprador(leadId: string, cf: Record<string, any>): Promise<{ uf: string; cidade: string } | null> {
  const prop = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Endereço:' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  const linha = /^\s*Endere[cç]o:\s*([^\n]+)/im.exec(prop?.content || '')?.[1] || '';
  const cu = (linha && cidadeUfDe(linha.replace(/\s+[—–-]\s*CEP.*$/i, ''))) || (cf.uf_1 || cf.uf ? cidadeUfDe(`${cf.cidade_1 || cf.cidade || ''}/${cf.uf_1 || cf.uf}`) : null);
  return cu ? { uf: cu.uf.toUpperCase(), cidade: cu.cidade } : null;
}
/** Imóvel: inscrição (capa/guia do IPTU ou matrícula já lidas na conferência) + cidade/UF (proposta do site ou card). */
async function imovelDoCard(leadId: string, cf: Record<string, any>): Promise<Imovel> {
  const revs = Object.values((cf._docReview || {}) as Record<string, any>);
  const inscricao = String(cf.inscricao_imovel || revs.map((r) => r?.inscricao).find(Boolean) || '').trim();
  const prop = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Imóvel em garantia' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  const garantia = /Im[oó]vel em garantia:\s*([^\n]+)/i.exec(prop?.content || '')?.[1] || '';
  const cu = (garantia && cidadeUfDe(garantia)) || cidadeUfDe(`${cf.cidade_imovel || ''}/${cf.uf_imovel || cf.uf || ''}`);
  return { inscricao, cidade: cu?.cidade || String(cf.cidade_imovel || ''), uf: (cu?.uf || '').toUpperCase() };
}

// ── Tela do card ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function certidoesPreview(accountId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  const end = await enderecoDoComprador(leadId, cf);
  const pessoas: Pessoa[] = [];
  const p1 = String(cf.participante_1 || lead.name || '').trim();
  if (p1) pessoas.push({ nome: p1, doc: dig(cf.cpf_1), nascimento: String(cf.nascimento_1 || ''), papel: 'COMPRADOR', uf: end?.uf || '', cidade: end?.cidade || '' });
  if (String(cf.participante_2 || '').trim()) pessoas.push({ nome: String(cf.participante_2).trim(), doc: dig(cf.cpf_2), nascimento: String(cf.nascimento_2 || ''), papel: 'COMPRADOR', uf: end?.uf || '', cidade: end?.cidade || '' });
  // Gravadas pela equipe no botão (vendedor, 2º comprador com outro endereço…) — valem por cima das do card (mesmo documento).
  for (const s of (Array.isArray(cf._certPessoas) ? cf._certPessoas : []) as Pessoa[]) {
    const i = pessoas.findIndex((p) => (s.doc && dig(p.doc) === dig(s.doc)) || norm(p.nome) === norm(s.nome));
    if (i >= 0) pessoas[i] = { ...pessoas[i], ...s }; else pessoas.push(s);
  }
  const fila = filaDe(cf).slice().reverse().slice(0, 30);
  return { pessoas, imovel: await imovelDoCard(leadId, cf), fila, tipos: CERT_NOME };
}

/** Botão "Emitir certidões": cria os pedidos (conjunto todo ou avulsos). Sem robô pro estado/município → nota + push "emitir à mão" com o link. */
export async function pedirCertidoes(accountId: string, leadId: string, userId: string | null, body: { pessoas?: (Pessoa & { tipos?: CertTipo[] })[]; imovel?: (Imovel & { emitir?: boolean }) | null }) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  const novos: CertJob[] = []; const manuais: string[] = []; const faltas: string[] = []; const pulados: string[] = []; const avisos: string[] = [];
  const atual = filaDe(cf);
  const jaNaFila = (tipo: CertTipo, chave: string) => atual.some((j) => j.tipo === tipo && ATIVOS.has(j.status) && (dig(j.pessoa?.doc) || dig(j.imovel?.inscricao)) === chave);
  const agora = new Date().toISOString();
  const salvarPessoas: Pessoa[] = [];

  for (const raw of body.pessoas || []) {
    const p: Pessoa = { nome: String(raw.nome || '').trim(), doc: dig(raw.doc), nascimento: String(raw.nascimento || '').trim(), mae: String(raw.mae || '').trim(), papel: raw.papel === 'VENDEDOR' ? 'VENDEDOR' : 'COMPRADOR', uf: String(raw.uf || '').trim().toUpperCase().slice(0, 2), cidade: String(raw.cidade || '').trim() };
    const tipos = (raw.tipos || []).filter((t) => TIPOS_PESSOA.includes(t));
    if (!tipos.length) continue;
    if (!p.nome || !docValido(p.doc)) { faltas.push(`${p.nome || 'pessoa sem nome'}: CPF/CNPJ inválido`); continue; }
    salvarPessoas.push(p);
    for (const tipo of tipos) {
      if (jaNaFila(tipo, p.doc)) { pulados.push(`${CERT_NOME[tipo]} — ${p.nome}`); continue; }
      if (tipo === 'FEDERAL' && p.doc.length === 11 && !nascValido(p.nascimento)) { faltas.push(`${p.nome}: falta a data de nascimento (dd/mm/aaaa) pra ${CERT_NOME.FEDERAL}`); continue; }
      if (tipo === 'TJ' && p.uf === 'DF' && p.doc.length === 11 && !p.mae) avisos.push(`${p.nome}: o TJDFT pede o NOME DA MÃE — sem ele a extensão preenche o resto e espera alguém digitar na janela (dá pra informar no botão)`);
      const site = siteDe(tipo, p);
      if (!site) { faltas.push(`${p.nome}: falta o ESTADO do endereço pra ${CERT_NOME[tipo]}`); continue; }
      const job: CertJob = { id: crypto.randomUUID(), tipo, status: site.adapter ? 'REQUESTED' : 'MANUAL', pessoa: p, site, requestedAt: agora, requestedBy: userId };
      novos.push(job);
      if (!site.adapter) manuais.push(`• ${CERT_NOME[tipo]} — ${p.nome}: ${site.orgao} → ${site.url}`);
    }
  }
  if (body.imovel?.emitir) {
    const im: Imovel = { inscricao: String(body.imovel.inscricao || '').trim(), cidade: String(body.imovel.cidade || '').trim(), uf: String(body.imovel.uf || '').trim().toUpperCase().slice(0, 2) };
    if (!im.inscricao) faltas.push('Imóvel: falta a inscrição do IPTU (capa/guia do IPTU ou matrícula)');
    else if (!im.uf) faltas.push('Imóvel: falta o município/UF');
    else if (jaNaFila('IPTU', dig(im.inscricao))) pulados.push(`${CERT_NOME.IPTU}`);
    else {
      const site = siteDe('IPTU', im)!;
      novos.push({ id: crypto.randomUUID(), tipo: 'IPTU', status: site.adapter ? 'REQUESTED' : 'MANUAL', imovel: im, site, requestedAt: agora, requestedBy: userId });
      if (!site.adapter) manuais.push(`• ${CERT_NOME.IPTU} (inscrição ${im.inscricao}): ${site.orgao} → ${site.url}`);
    }
  }
  if (!novos.length && !faltas.length) throw new Error(pulados.length ? 'Essas certidões já estão na fila da extensão.' : 'Escolha ao menos uma certidão.');

  // Pessoas digitadas pela equipe ficam guardadas (o vendedor não está no card) — só a chave _certPessoas.
  if (salvarPessoas.length) {
    const antes = (Array.isArray(cf._certPessoas) ? cf._certPessoas : []) as Pessoa[];
    const juntas = [...antes.filter((a) => !salvarPessoas.some((s) => dig(s.doc) === dig(a.doc))), ...salvarPessoas].slice(-12);
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_certPessoas}', ${JSON.stringify(juntas)}::jsonb, true) WHERE id = ${leadId}`;
  }
  if (novos.length) await mexer(leadId, (f) => { f.push(...novos); });

  const naFila = novos.filter((j) => j.status === 'REQUESTED');
  const linhas = [
    naFila.length ? `🧾 Certidões na fila da extensão "Certidões" (${naFila.length}):\n${naFila.map((j) => `• ${CERT_NOME[j.tipo]} — ${alvoTxt(j)} (${j.site?.orgao})`).join('\n')}\nCaptcha que aparecer, quem resolve é a pessoa no Chrome (chega push). O PDF vai sozinho pra pasta do Drive.` : '',
    manuais.length ? `✍️ Emitir À MÃO (ainda sem robô pra esse estado/município) e subir na pasta do Drive:\n${manuais.join('\n')}` : '',
    faltas.length ? `⚠️ Não pedi (falta dado — informe no botão "Emitir certidões"):\n${faltas.map((f) => `• ${f}`).join('\n')}` : '',
    avisos.length ? avisos.map((a) => `ℹ️ ${a}`).join('\n') : '',
  ].filter(Boolean);
  if (linhas.length) await note(leadId, linhas.join('\n\n'), userId);
  if (manuais.length || faltas.length) await pushDono(accountId, leadId, manuais.length ? '✍️ Certidão pra emitir à mão' : '⚠️ Certidão sem dado', `${lead.name}: ${[manuais.length ? `${manuais.length} à mão` : '', faltas.length ? `${faltas.length} sem dado` : ''].filter(Boolean).join(', ')}`);
  return { naFila: naFila.length, manuais: manuais.length, faltas, pulados };
}

export async function cancelarCertidao(accountId: string, leadId: string, jobId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true } });
  if (!lead) throw new Error('Card não encontrado');
  await mexer(leadId, (f) => { const j = f.find((x) => x.id === jobId); if (j && (ATIVOS.has(j.status) || j.status === 'MANUAL')) { j.status = 'CANCELED'; j.doneAt = new Date().toISOString(); } });
  return { ok: true };
}

// ── Fila da extensão ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SEM_SINAL_MS = 15 * 60_000; // a extensão manda sinal de vida a cada minuto enquanto a janela está aberta (inclusive esperando o captcha)
export type CertClaim = { leadId: string; leadName: string; job: CertJob };

/** A extensão pergunta "tem certidão pra emitir?" (a cada 30 s). Uma por vez na conta; sem sinal há 15 min = falhou (janela fechada/Chrome travado). */
export async function claimCertidaoPessoal(accountId: string): Promise<CertClaim | null> {
  const rows = await prisma.$queryRaw<{ id: string; name: string; customFields: any }[]>`SELECT id, name, "customFields" FROM "Lead" WHERE "accountId" = ${accountId} AND "customFields"->>'_certPend' = 'true' LIMIT 50`;
  let ocupado = false;
  let melhor: { leadId: string; leadName: string; job: CertJob } | null = null;
  for (const r of rows) {
    const fila = filaDe((r.customFields || {}) as Record<string, any>);
    let mudou = false;
    for (const j of fila) {
      if (j.status !== 'RUNNING' && j.status !== 'WAITING') continue;
      if (Date.now() - new Date(j.beatAt || j.claimedAt || 0).getTime() > SEM_SINAL_MS) {
        j.status = 'FAILED'; j.erro = 'a janela da extensão fechou ou travou (sem sinal há 15 min)'; j.doneAt = new Date().toISOString(); mudou = true;
        await note(r.id, `⚠️ ${CERT_NOME[j.tipo]} — ${alvoTxt(j)}: ${j.erro}. Peça de novo no botão "Emitir certidões".`);
      } else ocupado = true;
    }
    if (mudou) await gravarFila(r.id, fila);
    const prox = fila.filter((j) => j.status === 'REQUESTED').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0];
    if (prox && (!melhor || prox.requestedAt < melhor.job.requestedAt)) melhor = { leadId: r.id, leadName: r.name, job: prox };
  }
  if (ocupado || !melhor) return null;
  const agora = new Date().toISOString();
  let pego: CertJob | null = null;
  await mexer(melhor.leadId, (f) => { const j = f.find((x) => x.id === melhor!.job.id && x.status === 'REQUESTED'); if (j) { j.status = 'RUNNING'; j.claimedAt = agora; j.beatAt = agora; pego = { ...j }; } });
  const p = pego as CertJob | null;
  return p ? { leadId: melhor.leadId, leadName: melhor.leadName, job: p } : null;
}

export async function reportCertidaoPessoal(accountId: string, leadId: string, jobId: string, d: { event: string; detail?: string; reason?: string }) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!lead) throw new Error('Card não encontrado');
  let job: CertJob | null = null; let pushEsperando = false;
  await mexer(leadId, (f) => {
    const j = f.find((x) => x.id === jobId);
    if (!j || !ATIVOS.has(j.status)) return;
    j.beatAt = new Date().toISOString();
    if (d.event === 'waiting') { j.status = 'WAITING'; j.detalhe = String(d.detail || '').slice(0, 300); if (!j.waitingPushAt) { j.waitingPushAt = j.beatAt; pushEsperando = true; } }
    else if (d.event === 'step') { if (j.status === 'WAITING' && d.detail === 'retomou') j.status = 'RUNNING'; }
    else if (d.event === 'failed') { j.status = 'FAILED'; j.erro = String(d.reason || 'erro').slice(0, 400); j.doneAt = j.beatAt; }
    else if (d.event === 'pending') { j.status = 'MANUAL'; j.detalhe = String(d.detail || '').slice(0, 400); j.doneAt = j.beatAt; } // o órgão não emitiu na hora (homônimo/análise): protocolo na nota
    job = { ...j };
  });
  const j = job as CertJob | null;
  if (!j) return { ok: true };
  if (pushEsperando) await pushDono(accountId, leadId, '🧾 Resolva o captcha da certidão', `${CERT_NOME[j.tipo]} — ${lead.name}: a janela da extensão "Certidões" está esperando no Chrome`);
  if (d.event === 'failed') {
    await note(leadId, `⚠️ A extensão NÃO emitiu ${CERT_NOME[j.tipo]} — ${alvoTxt(j)}: ${j.erro}. Emitir à mão: ${j.site?.url || ''}`);
    await pushDono(accountId, leadId, '⚠️ Certidão não emitida', `${lead.name}: ${CERT_NOME[j.tipo]} — ${String(j.erro).slice(0, 80)}`);
  }
  if (d.event === 'pending') {
    await note(leadId, `⏳ ${CERT_NOME[j.tipo]} — ${alvoTxt(j)}: o órgão não emitiu na hora. ${j.detalhe}\nAcompanhe/baixe em ${j.site?.url || ''} e suba na pasta do Drive.`);
    await pushDono(accountId, leadId, '⏳ Certidão em análise no órgão', `${lead.name}: ${CERT_NOME[j.tipo]}`);
  }
  return { ok: true };
}

// ── Arquivo emitido → Drive + leitura ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Negativa / positiva com efeito de negativa / positiva, pelo texto do PDF. Pura. */
export function resultadoDaCertidao(texto: string): 'NEGATIVA' | 'POSITIVA COM EFEITO DE NEGATIVA' | 'POSITIVA' | 'NADA CONSTA' | 'CONSTA' | '?' {
  const t = norm(texto).replace(/\s+/g, ' ');
  if (/POSITIVA COM EFEITOS? DE NEGATIVA/.test(t)) return 'POSITIVA COM EFEITO DE NEGATIVA';
  if (/CERTIDAO POSITIVA|CERTIDAO DE DEBITOS? POSITIVA/.test(t)) return 'POSITIVA';
  if (/NADA CONSTA|NAO CONSTA[MR]?\b|NAO EXISTE[MN]? (PROCESSOS?|ACOES|DEBITOS?)|INEXISTE/.test(t) && !/\bCONSTA[MR]? (OS|AS)? ?(SEGUINTES|PROCESSOS?)\b/.test(t)) return /CERTIDAO NEGATIVA/.test(t) ? 'NEGATIVA' : 'NADA CONSTA';
  if (/CERTIDAO NEGATIVA/.test(t)) return 'NEGATIVA';
  if (/\bCONSTA[MR]?\b.{0,40}(PROCESSO|ACAO|ACOES|DEBITO)/.test(t)) return 'CONSTA';
  return '?';
}
const ROTULO_ARQ: Record<CertTipo, string> = { FEDERAL: 'CND FEDERAL RECEITA PGFN', JUSTICA_FEDERAL: 'CERTIDAO JUSTICA FEDERAL', TJ: 'CERTIDAO CIVEL E CRIMINAL', TRABALHISTA: 'CNDT TRABALHISTA', FAZENDA: 'CND FAZENDA', IPTU: 'CND IPTU' };
function nomeDoArquivo(j: CertJob, parte?: string): string {
  const org = (j.site?.orgao || '').replace(/\s*\(.*$/, '');
  const base = j.tipo === 'IPTU'
    ? `CND IPTU - INSCRICAO ${j.imovel?.inscricao || ''}`
    : `${ROTULO_ARQ[j.tipo]}${parte ? ` ${norm(parte)}` : ''}${org && j.tipo !== 'FEDERAL' && j.tipo !== 'TRABALHISTA' ? ` ${norm(org)}` : ''} - ${norm(j.pessoa?.nome || '')}`;
  return `${base.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150)}.pdf`;
}
/** Pasta do cliente no Drive: link do card → pasta com o nome → cria em LEADS ATIVOS do setor (e grava o link). */
async function pastaDoCliente(accountId: string, leadId: string): Promise<string> {
  const g = await import('./google.service');
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { activeLeadsFolderId: true } } } } } });
  if (!lead) throw new Error('card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  const link = String(cf.link_pasta_drive || '').trim();
  if (link) return g.extractFolderId(link);
  const nome = String(cf.participante_1 || lead.name || '').trim();
  const achada = nome ? await g.findFolderByNameUnderRoot(accountId, nome).catch(() => null) : null;
  if (achada?.folderId) return achada.folderId;
  const ativos = lead.pipeline?.department?.activeLeadsFolderId;
  if (!ativos) throw new Error('o card não tem pasta no Drive e o setor não tem a pasta LEADS ATIVOS configurada');
  const nomePasta = nome.replace(/[^\p{L}\p{N} .'-]/gu, '').replace(/\s+/g, ' ').trim().toUpperCase() || 'CLIENTE';
  const pasta = await g.createFolder(accountId, nomePasta, ativos);
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{link_pasta_drive}', ${JSON.stringify(g.folderLink(pasta.id))}::jsonb, true) WHERE id = ${leadId} AND COALESCE("customFields"->>'link_pasta_drive', '') = ''`;
  return pasta.id;
}

export async function receberArquivoCertidao(accountId: string, leadId: string, jobId: string, d: { b64?: string; parte?: string; final?: boolean }) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const j0 = filaDe((lead.customFields || {}) as Record<string, any>).find((x) => x.id === jobId);
  if (!j0) throw new Error('Pedido de certidão não encontrado');
  const pdf = Buffer.from(String(d.b64 || ''), 'base64');
  if (pdf.length < 800 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('o arquivo recebido não é um PDF');
  const { extractDocumentText } = await import('./knowledge.service');
  const texto = await extractDocumentText(pdf, 'application/pdf').catch(() => '');
  const resultado = texto ? resultadoDaCertidao(texto) : '?';
  // Confere se é da pessoa/imóvel certo: o documento (CPF/CNPJ ou inscrição) tem de aparecer no PDF quando o PDF tem texto.
  const chave = j0.pessoa ? dig(j0.pessoa.doc) : dig(j0.imovel?.inscricao);
  const confere = !texto || !chave || dig(texto).includes(chave);
  const nome = nomeDoArquivo(j0, d.parte);
  const sub = j0.tipo === 'IPTU' ? 'IMOVEL' : j0.pessoa?.papel === 'VENDEDOR' ? 'VENDEDOR' : 'COMPRADOR';
  const g = await import('./google.service');
  const raiz = await pastaDoCliente(accountId, leadId);
  const pasta = await g.createFolder(accountId, sub, raiz);
  const up = await g.uploadFile(accountId, { name: nome, mimeType: 'application/pdf', data: pdf, parentId: pasta.id });
  const url = up.webViewLink || g.folderLink(pasta.id);
  const partesEsperadas = j0.site?.partes?.length || 1;
  let fim: CertJob | null = null;
  await mexer(leadId, (f) => {
    const j = f.find((x) => x.id === jobId);
    if (!j) return;
    j.arquivos = [...(j.arquivos || []).filter((a) => a.nome !== nome), { nome, url, resultado }];
    j.beatAt = new Date().toISOString();
    if (d.final || j.arquivos.length >= partesEsperadas) { j.status = 'DONE'; j.doneAt = j.beatAt; }
    fim = { ...j };
  });
  const ruim = resultado === 'POSITIVA' || resultado === 'CONSTA';
  await note(leadId, `${ruim ? '⚠️' : '📄'} ${CERT_NOME[j0.tipo]}${d.parte ? ` (${d.parte})` : ''} — ${alvoTxt(j0)}: ${resultado === '?' ? 'emitida (não consegui ler o resultado — confira)' : resultado}. Salva no Drive, pasta ${sub}:\n${nome}\n${url}${confere ? '' : `\n⚠️ O ${j0.pessoa ? 'CPF/CNPJ' : 'nº de inscrição'} do pedido NÃO aparece no PDF — confira se é da pessoa/imóvel certo.`}`);
  if (ruim || !confere) await pushDono(accountId, leadId, ruim ? `⚠️ Certidão ${resultado}` : '⚠️ Confira a certidão', `${lead.name}: ${CERT_NOME[j0.tipo]} — ${alvoTxt(j0)}`);
  return { ok: true, nome, url, resultado, done: (fim as CertJob | null)?.status === 'DONE' };
}

// ── Sugestão (o CRM não pede sozinho: a chave dos passos automáticos da contratação está desligada) ───────────────────────────────────────────
const SUGESTAO_MS = 12 * 3600_000;
/** E-mail do banco pedindo certidões → nota + push com o botão. Uma vez a cada 12 h por card. */
export async function sugerirCertidoesPorEmail(accountId: string, leadId: string, texto: string): Promise<boolean> {
  const t = norm(texto);
  if (!/CERTID|CND\b|NADA CONSTA/.test(t)) return false;
  const quais: string[] = [];
  if (/TRIBUTOS FEDERAIS|RECEITA FEDERAL|PGFN|DIVIDA ATIVA DA UNIAO|CONJUNTA/.test(t)) quais.push(CERT_NOME.FEDERAL);
  if (/JUSTICA FEDERAL|\bTRF\d?\b|SECAO JUDICIARIA/.test(t)) quais.push(CERT_NOME.JUSTICA_FEDERAL);
  if (/CIVEIS|CIVEL|CRIMINA|DISTRIBUI|TJDFT|TRIBUNAL DE JUSTICA/.test(t)) quais.push(CERT_NOME.TJ);
  if (/TRABALHIST|CNDT|\bTRT\d*\b/.test(t)) quais.push(CERT_NOME.TRABALHISTA);
  if (/FAZENDA|GDF|SEFAZ|DEBITOS ESTADUAIS|RECEITA DO DF/.test(t)) quais.push(CERT_NOME.FAZENDA);
  if (/IPTU|TRIBUTOS IMOBILIARIOS|DEBITOS IMOBILIARIOS/.test(t)) quais.push(CERT_NOME.IPTU);
  if (!quais.length) return false;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const at = ((l?.customFields || {}) as Record<string, any>)._certSugeridoAt;
  if (at && Date.now() - new Date(at).getTime() < SUGESTAO_MS) return false;
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_certSugeridoAt}', ${JSON.stringify(new Date().toISOString())}::jsonb, true) WHERE id = ${leadId}`;
  await note(leadId, `🧾 O e-mail do banco fala em certidões (${quais.join(', ')}). Dá pra emitir pelo botão "Emitir certidões" (aba Financiamento do card): a extensão "Certidões" emite e guarda na pasta do Drive. Nada é enviado ao cliente nem ao banco.`);
  await pushDono(accountId, leadId, '🧾 Banco pediu certidões', `${l?.name || ''}: ${quais.join(', ').slice(0, 110)}`);
  return true;
}

import { prisma } from '../lib/prisma';
import { createCertidaoRequest, enderecoTexto, type EnderecoCertidao } from './certidao.service';
import { contractingAutoOn, manualStep } from './contracting-auto.service';

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/**
 * ESCRITURA → MATRÍCULA → ONR (Fabio 20/10, Luiz Fernando). O cliente manda a escritura (traz o número da matrícula e o cartório) em vez da certidão de ônus/matrícula:
 *  1) a conferência dos documentos acha a matrícula e a cidade/UF na escritura (`certidaoFromDocs`);
 *  2) a IA SE OFERECE pra emitir pelo ONR ("é essencial pra solicitar a vistoria; posso emitir por aqui, pelo cartório digital?" — sem custo e sem nome de empresa) — UMA vez por matrícula (`maybeOfferCertidao`);
 *  3) QUANDO O CLIENTE ACEITA ("sim, pode"), é nesse momento que a extensão do ONR é acionada: cria o CertidaoRequest (`ensureCertidaoRequest`), a extensão pede no RI Digital, captura o PIX e o CRM manda o PIX ao cliente;
 *  4) recusa ("prefiro tirar no cartório") só anota. A A&F NUNCA emite sem esse OK (regra de 15/10).
 * O cartório vai como 'AUTO': a extensão escolhe o único cartório da cidade (se houver mais de um, ela avisa as opções e não conclui).
 */

const AUTORIZOU_EMISSAO = '🏛️ CLIENTE AUTORIZOU A EMISSÃO DA CERTIDÃO'; // mesmo marcador do docs-checker (a conferência lê)
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});

/** Cidade e UF de um texto como "Ofício de Registro de Imóveis da Comarca de Itapema/SC" ou "…, Bairro Meia Praia, Itapema/SC". Pura (testável). */
export function cidadeUfDe(txt: string): { cidade: string; uf: string } | null {
  const m = /\/\s*([A-Z]{2})\b/.exec(String(txt || ''));
  if (!m) return null;
  let antes = String(txt).slice(0, m.index).replace(/[.\s]+$/, '');
  if (/\b(?:comarca|munic[ií]pio|cidade)\s+(?:de|do|da)\s+/i.test(antes)) antes = antes.replace(/^.*\b(?:comarca|munic[ií]pio|cidade)\s+(?:de|do|da)\s+/i, '');
  else { const reg = /^.*\b(?:im[óo]veis|registro|of[íi]cio|cart[óo]rio)\s+(?:de|do|da)\s+(.+)$/i.exec(antes); if (reg) antes = reg[1]; }
  antes = (antes.split(/[,;–-]/).pop() || '').trim().replace(/^(?:de|do|da)\s+/i, '');
  if (antes.length < 2 || antes.length > 40) return null;
  return { cidade: antes, uf: m[1] };
}

type Rev = { tipo?: string; resultado?: string; matricula?: string; cartorio?: string; endereco?: string; encerrada?: unknown };

const ORDINAIS: Record<string, number> = { primeiro: 1, segundo: 2, terceiro: 3, quarto: 4, quinto: 5, sexto: 6, setimo: 7, oitavo: 8, nono: 9, decimo: 10 };
/** Número do cartório ("1º Ofício", "2º Registro de Imóveis", "Segundo Ofício") escrito na escritura; null se for o cartório único da comarca. Pura (testável). */
export function numeroDoCartorio(txt: string): number | null {
  const t = String(txt || '');
  const a = /\b(\d{1,2})\s*[º°ª]/.exec(t) || /\b(\d{1,2})\s*o?\s+(?:of[íi]cio|cart[óo]rio|registro|servi[çc]o)/i.exec(t);
  if (a) return parseInt(a[1], 10);
  const w = /\b(primeiro|segundo|terceiro|quarto|quinto|sexto|s[ée]timo|oitavo|nono|d[ée]cimo)\b/i.exec(t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  return w ? ORDINAIS[w[1].toLowerCase()] || null : null;
}

/** O cliente já tem em mãos certidão de ônus/matrícula do cartório que vale? Pura. */
export function temCertidaoEmMaos(cf: Record<string, any>): boolean {
  if (cf._matriculaDivergente) return false; // a certidão que ele tem é de OUTRA matrícula (o termo de quitação cita a correta): precisa de uma nova
  const revs = Object.values((cf._docReview || {}) as Record<string, Rev>);
  return revs.some((r) => /^(MATRICULA|CERTIDAO DE ONUS)/.test(String(r?.tipo || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')) && r.resultado !== 'PROBLEMA' && !r.encerrada);
}

/** Matrícula + cartório + cidade/UF lidos nos documentos do cliente (escritura, IPTU, cadastro). null se não der pra pedir. Pura. */
export function certidaoFromDocs(cf: Record<string, any>): { matricula: string; cartorio: string; cidade: string; uf: string } | null {
  // Matrícula DIVERGENTE (Fabio 21/10, Edson: a certidão do cliente é da 70.617 e o termo de quitação cita a 94168 — antiga, transporte, matrícula-mãe ou nova): pede a certidão da matrícula CORRETA.
  const dv = cf._matriculaDivergente as { correta?: string; cidade?: string; uf?: string; cartorio?: string } | undefined;
  if (dv?.correta && dv.cidade && dv.uf) {
    const n = numeroDoCartorio(String(dv.cartorio || ''));
    return { matricula: digits(dv.correta), cartorio: n ? `${n}º - ${dv.cidade.toUpperCase()}` : 'AUTO', cidade: dv.cidade, uf: dv.uf };
  }
  const revs = (Object.values((cf._docReview || {}) as Record<string, Rev>) as Rev[]).filter((r) => r && r.resultado !== 'NAO_DOCUMENTO');
  const comMat = revs.filter((r) => digits(r.matricula).length >= 1 && digits(r.matricula).length <= 12);
  if (!comMat.length) return null;
  // prefere a escritura (traz matrícula + cartório); senão qualquer documento do imóvel que cite a matrícula
  const ordenado = [...comMat].sort((a, b) => (/ESCRITURA/.test(String(b.tipo)) ? 1 : 0) - (/ESCRITURA/.test(String(a.tipo)) ? 1 : 0));
  for (const r of ordenado) {
    const cu = cidadeUfDe(String(r.cartorio || '')) || cidadeUfDe(String(r.endereco || ''));
    if (cu) {
      // O nome do cartório vem NA ESCRITURA (Fabio 20/10): usa o número dele ("1º Ofício") pra a extensão achar o cartório na lista do portal; sem número (cartório único) vai 'AUTO'.
      const n = numeroDoCartorio(String(r.cartorio || ''));
      return { matricula: digits(r.matricula), cartorio: n ? `${n}º - ${cu.cidade.toUpperCase()}` : 'AUTO', cidade: cu.cidade, uf: cu.uf };
    }
  }
  return null;
}

const TIPOS_LOGRADOURO: [RegExp, string][] = [[/^(av|av\.|avenida)\b/i, 'Avenida'], [/^(r|r\.|rua)\b/i, 'Rua'], [/^(tv|trav|travessa)\b/i, 'Travessa'], [/^(al|alameda)\b/i, 'Alameda'], [/^(est|estr|estrada)\b/i, 'Estrada'], [/^(rod|rodovia)\b/i, 'Rodovia'], [/^(pc|pç|praca|praça)\b/i, 'Praça'], [/^(lgo|largo)\b/i, 'Largo'], [/^(vl|vila)\b/i, 'Vila'], [/^(bc|beco)\b/i, 'Beco']];

/** Endereço do imóvel pro pedido da certidão POR ENDEREÇO (Fabio 29/10: cliente que não sabe a matrícula): proposta do site ("Endereço do imóvel", "CEP do imóvel",
 *  "Imóvel em garantia: Cidade/UF") + campos do card. Proprietário provável (participante + CPF) vai nas Observações. null = falta CEP, rua/número ou cidade/UF. */
export async function enderecoDoImovel(leadId: string, cf: Record<string, any>): Promise<{ endereco: EnderecoCertidao; cidade: string; uf: string } | null> {
  const prop = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Endereço do imóvel' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  const t = prop?.content || '';
  const linha = (re: RegExp) => (re.exec(t)?.[1] || '').trim();
  const endTxt = linha(/Endere[cç]o do im[oó]vel:\s*([^\n]+)/i);
  const [ruaParte, bairro] = endTxt.split(/\s+[—–]\s+/);
  const cep = digits(linha(/CEP do im[oó]vel:\s*([\d.-]+)/i) || cf.imovel_cep);
  const cu = cidadeUfDe(linha(/Im[oó]vel em garantia:\s*([^\n]+)/i)) || cidadeUfDe(`${cf.cidade_imovel || cf.cidade || ''}/${cf.uf || ''}`);
  const m = /^(.*?),\s*(\d{1,6}[A-Za-z]?)\b\s*(.*)$/.exec(String(ruaParte || '').trim());
  let rua = (m ? m[1] : String(ruaParte || '')).trim();
  const numero = (m ? m[2] : String(cf.imovel_numero || '')).trim();
  const complemento = (m ? m[3].replace(/^[\s,;-]+/, '') : String(cf.imovel_complemento || '')).trim();
  let tipoLogradouro = 'Rua';
  for (const [re, nome] of TIPOS_LOGRADOURO) if (re.test(rua)) { tipoLogradouro = nome; rua = rua.replace(re, '').replace(/^[\s.]+/, '').trim(); break; }
  if (cep.length !== 8 || !rua || !numero || !cu) {
    // Fernanda Karita 29/10: a proposta diz "Endereço do imóvel em garantia: Mesmo endereço do cliente" — o endereço é o do cliente ("Endereço: Av. X, 130 - Apto 12 — Bairro, Cidade/UF — CEP …").
    const garantia = linha(/Endere[cç]o do im[oó]vel em garantia:\s*([^\n]+)/i);
    const doCliente = linha(/^\s*Endere[cç]o:\s*([^\n]+)/im);
    const alvo = /mesmo endere/i.test(garantia) ? doCliente : garantia;
    const e = alvo ? enderecoDeTexto(alvo) : null;
    if (e) {
      const dono0 = String(cf.participante_1 || '').trim(); const cpf0 = digits(cf.cpf_1);
      return { ...e, endereco: { ...e.endereco, observacao: dono0 ? `Proprietário: ${dono0}${cpf0.length === 11 ? ` (CPF ${cpf0.slice(0, 3)}.${cpf0.slice(3, 6)}.${cpf0.slice(6, 9)}-${cpf0.slice(9)})` : ''}` : undefined } };
    }
    return enderecoDosDocumentos(cf);
  }
  const dono = String(cf.participante_1 || '').trim();
  const cpf = digits(cf.cpf_1);
  return {
    cidade: cu.cidade, uf: cu.uf,
    endereco: { cep, tipoLogradouro, logradouro: rua, numero, complemento: complemento.slice(0, 30) || undefined, bairro: bairro?.trim() || undefined, observacao: dono ? `Proprietário: ${dono}${cpf.length === 11 ? ` (CPF ${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)})` : ''}` : undefined },
  };
}

/** Endereço do imóvel lido num DOCUMENTO do imóvel que o cliente mandou (matrícula, certidão de ônus, escritura, IPTU, cadastro imobiliário…): o campo `endereco` da leitura da conferência
 *  ("RUA 294, Nº 135, APTO 201, MEIA PRAIA, ITAPEMA/SC, CEP 88220000"). Fabio 29/10: a certidão por endereço deve usar o endereço dos documentos da conversa. Pura (testável). */
export function enderecoDeTexto(txt: string): { endereco: EnderecoCertidao; cidade: string; uf: string } | null {
  const t = String(txt || '').replace(/\s+/g, ' ').replace(/\s+[—–-]\s+/g, ', ').trim();
  if (!t) return null;
  const cepM = /CEP[:\s]*([\d.\-]{8,10})/i.exec(t) || /\b(\d{2}\.?\d{3}-?\d{3})\b/.exec(t);
  const cep = digits(cepM?.[1]);
  const semCep = t.replace(/,?\s*CEP[:\s]*[\d.\-]{8,10}/i, '').replace(/\b\d{2}\.?\d{3}-?\d{3}\b/, '').trim();
  let cu = cidadeUfDe(semCep);
  if (!cu) { const m = /([A-Za-zÀ-ú' ]{2,40}?)\s*[,–-]\s*([A-Z]{2})\s*(?:,|$)/.exec(semCep); if (m) cu = { cidade: m[1].trim(), uf: m[2] }; }
  if (cep.length !== 8 || !cu) return null;
  const segs = semCep.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
  let logr = segs[0] || '';
  let numero = '';
  const inl = /^(.*?)\s+(?:n[º°o.]*\s*)?(\d{1,6}[A-Za-z]?)$/i.exec(logr);
  const rest: string[] = [];
  for (const sg of segs.slice(1)) {
    const n = /^(?:n[º°o.]*\s*)(\d{1,6}[A-Za-z]?)$/i.exec(sg) || (!numero ? /^(\d{1,6}[A-Za-z]?)$/.exec(sg) : null);
    const n2 = !numero && !n ? /^(?:n[º°o.]*\s*)?(\d{1,6}[A-Za-z]?)\s+(.+)$/i.exec(sg) : null;
    if (n && !numero) numero = n[1];
    else if (n2) { numero = n2[1]; rest.push(n2[2]); }
    else rest.push(sg);
  }
  if (!numero && inl && /\D/.test(inl[1])) { logr = inl[1]; numero = inl[2]; }
  if (!numero) return null;
  const cidadeSeg = cu.cidade.toLowerCase();
  const util = rest.filter((x) => !x.toLowerCase().includes(cidadeSeg) && !/^[A-Z]{2}$/.test(x) && !/\/\s*[A-Z]{2}$/.test(x) && x !== cu!.uf);
  const complemento = util.filter((x) => /\b(apto|apartamento|bloco|casa|sala|lote|quadra|andar|ed\.|edif|resid)/i.test(x)).join(', ');
  const bairro = [...util].reverse().find((x) => !/\b(apto|apartamento|bloco|casa|sala|lote|quadra|andar|ed\.|edif|resid)/i.test(x)) || '';
  let tipoLogradouro = 'Rua';
  let rua = logr;
  for (const [re, nome] of TIPOS_LOGRADOURO) if (re.test(rua)) { tipoLogradouro = nome; rua = rua.replace(re, '').replace(/^[\s.]+/, '').trim(); break; }
  if (!rua) return null;
  return { cidade: cu.cidade, uf: cu.uf, endereco: { cep, tipoLogradouro, logradouro: rua, numero, complemento: complemento.slice(0, 30) || undefined, bairro: bairro || undefined } as EnderecoCertidao };
}

function enderecoDosDocumentos(cf: Record<string, any>): { endereco: EnderecoCertidao; cidade: string; uf: string } | null {
  const revs = (Object.values((cf._docReview || {}) as Record<string, Rev>) as Rev[]).filter((r) => r && r.resultado !== 'NAO_DOCUMENTO' && r.endereco);
  const peso = (r: Rev) => (/MATRICULA|ONUS/.test(String(r.tipo || '').toUpperCase()) ? 0 : /ESCRITURA/.test(String(r.tipo || '').toUpperCase()) ? 1 : 2);
  const dono = String(cf.participante_1 || '').trim();
  const cpf = digits(cf.cpf_1);
  for (const r of [...revs].sort((a, b) => peso(a) - peso(b))) {
    const e = enderecoDeTexto(String(r.endereco));
    if (e) return { ...e, endereco: { ...e.endereco, observacao: dono ? `Proprietário: ${dono}${cpf.length === 11 ? ` (CPF ${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)})` : ''}` : undefined } };
  }
  return null;
}

export function certidaoOfferText(nome: string | null, saudar: boolean, matricula: string): string {
  // Texto do Fabio (21/10): SEM nome de empresa nem de pessoa, SEM custo (se o cliente perguntar: varia de região pra região, em torno de R$ 40 a R$ 100), diz que a certidão é essencial pra SOLICITAR A VISTORIA
  // e pergunta primeiro se o cliente TEM a certidão, ou se pode emitir pelo cartório digital.
  return `${saudar ? `Oi${nome ? `, ${nome}` : ''}! ` : ''}Recebi a escritura do imóvel e já identifiquei o número da matrícula (nº ${matricula}), porém não recebi a certidão de ônus/matrícula, ela é essencial para que possamos solicitar a vistoria. Você teria ela aí ou posso emitir ela por aqui, através do cartório digital?`;
}

/** Oferta SEM matrícula (Fabio 30/10, "Sim, oferece e confirma"): uma mensagem só — oferece emitir pelo endereço e pede pra confirmar o endereço. O "sim" autoriza e confirma juntos. */
export function certidaoOfferEnderecoText(nome: string | null, saudar: boolean, endereco: string): string {
  return `${saudar ? `Oi${nome ? `, ${nome}` : ''}! ` : ''}Não recebi a certidão de ônus/matrícula do imóvel, ela é essencial para que possamos solicitar a vistoria. Você teria ela aí ou posso emitir por aqui, através do cartório digital, pelo endereço do imóvel? Se puder emitir, só me confirma se o endereço é este:\n${endereco}`;
}

/** Fora do horário de pedido (07h–20h) o pedido espera as 07h: avisa o cliente que o PIX vai de manhã. */
async function avisaPixAmanha(accountId: string, leadId: string, io: Io) {
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  await sendOutboundWhatsApp({ accountId, leadId, content: 'Combinado! O cartório digital gera o pagamento durante o dia, então amanhã cedo te mando o PIX da certidão por aqui.', io: (io || undefined) as any }).catch(() => {});
}

async function carrega(leadId: string) {
  return prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, accountId: true, aiAutoReplyActive: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
}
async function salvaOferta(leadId: string, patch: Record<string, unknown>) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  cf._certidaoOffer = { ...(cf._certidaoOffer || {}), ...patch };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}

/** A IA oferece a emissão (uma vez por matrícula). Só Home Equity (ou Financiamento pelo Inter) em "Aguardando Documentação", IA do card ligada, sem STOP TOTAL, 07h–21h e janela de 24 h aberta (senão tenta de novo na próxima conferência). */
export async function maybeOfferCertidao(accountId: string, leadId: string, io: Io, opts: { porEnderecoOk?: boolean } = {}): Promise<boolean> {
  const lead = await carrega(leadId);
  if (!lead || lead.accountId !== accountId) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused || !lead.aiAutoReplyActive) return false;
  if (cf._docsCheckDue) return false; // ele ainda está mandando documento: a conferência (que roda depois) é quem faz a oferta
  if (!/aguardando document/i.test((lead.stage?.name || '').normalize('NFD').replace(/[̀-ͯ]/g, ''))) return false;
  // Home Equity; no Financiamento só quem segue pelo Inter (Fabio 30/10: "INTER MESMO FLUXO") — os outros bancos do FH ainda são à mão.
  const dept = lead.pipeline?.department?.name || '';
  if (!/home equity/i.test(dept) && !(/habitacional/i.test(dept) && /^inter$/i.test(String(cf._fhChosen?.bank || '')) && !cf._optouCaixa)) return false;
  if (temCertidaoEmMaos(cf)) return false;
  const d = certidaoFromDocs(cf);
  if (!d) return opts.porEnderecoOk ? maybeOfferPorEndereco(accountId, leadId, lead, cf, io) : false;
  const oferta = cf._certidaoOffer as { matricula?: string; at?: string } | undefined;
  if (oferta?.matricula === d.matricula) return false; // já ofereci (aceitou, recusou ou está esperando a resposta)
  const ativo = await prisma.certidaoRequest.findFirst({ where: { leadId, matricula: d.matricula, status: { notIn: ['CANCELLED', 'FAILED'] } }, select: { id: true } });
  if (ativo) return false;
  // Chave da contratação (Fabio 23/10: "coloca um interruptor igual da vistoria"): desligada, a IA NÃO oferece a emissão — nota + push com o passo pra equipe (que combina com o cliente e usa o botão do card).
  if (!(await contractingAutoOn(accountId))) {
    await manualStep({ accountId, leadId, leadName: lead.name, step: `certidao-oferta-${d.matricula}`, pushTitle: '🏛️ Certidão de ônus/matrícula', pushBody: `${lead.name}: mandou a escritura sem a certidão — oferecer a emissão`,
      note: `🏛️ O cliente mandou a escritura (matrícula ${d.matricula}, ${d.cidade}/${d.uf}) e não a certidão de ônus/matrícula. Passo manual (automação da contratação desligada): a IA NÃO ofereceu a emissão. Se for emitir pelo cartório digital (ONR), combine com o cliente (a certidão é essencial pra solicitar a vistoria; o custo só se ele perguntar) e use o botão "Pedir certidão pelo ONR" na aba Financiamento do card.` });
    return false;
  }
  const { inNoticeWindow, whatsappWindowOpen, conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow() || !(await whatsappWindowOpen(leadId))) return false;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || null;
  const texto = certidaoOfferText(nome, !(await conversationActive(leadId)), d.matricula);
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: (io || undefined) as any });
  if (!r.success) return false;
  await salvaOferta(leadId, { matricula: d.matricula, cidade: d.cidade, uf: d.uf, at: new Date().toISOString() });
  await note(leadId, `🏛️ O cliente mandou a escritura (matrícula ${d.matricula}, ${d.cidade}/${d.uf}) e não a certidão de ônus. Ofereci emitir pelo cartório digital (ONR); o PIX vai ao cliente. Quando ele aceitar, a extensão do ONR é acionada sozinha.`);
  return true;
}

/** Sem matrícula nos documentos (Fernanda 29/10): só a conferência dos documentos chama (ela é quem sabe que a certidão falta). Uma vez por endereço. */
async function maybeOfferPorEndereco(accountId: string, leadId: string, lead: NonNullable<Awaited<ReturnType<typeof carrega>>>, cf: Record<string, any>, io: Io): Promise<boolean> {
  const e = await enderecoDoImovel(leadId, cf);
  if (!e) return false;
  const chave = `END:${digits(e.endereco.cep)}:${digits(e.endereco.numero) || e.endereco.lote || ''}`;
  if ((cf._certidaoOffer as any)?.matricula === chave) return false;
  const ativo = await prisma.certidaoRequest.findFirst({ where: { leadId, pedidoPor: 'ENDERECO', status: { notIn: ['CANCELLED', 'FAILED'] } }, select: { id: true } });
  if (ativo) return false;
  const pe = cf._certidaoEndereco as EnderecoAsk | undefined;
  if (pe?.askedAt && !pe.answeredAt && Date.now() - new Date(pe.askedAt).getTime() < 7 * 86_400_000) return false; // já perguntado (Jarvis/equipe), esperando
  const end = `${enderecoTexto(e.endereco)} — ${e.cidade}/${e.uf}`;
  if (!(await contractingAutoOn(accountId))) {
    await manualStep({ accountId, leadId, leadName: lead.name, step: `certidao-oferta-${chave}`, pushTitle: '🏛️ Certidão de ônus/matrícula', pushBody: `${lead.name}: falta a certidão e não há matrícula — oferecer a emissão pelo endereço`,
      note: `🏛️ Falta a certidão de ônus/matrícula e os documentos não trazem a matrícula. Passo manual (automação da contratação desligada): a IA NÃO ofereceu a emissão. Pra emitir pelo endereço (${end}), combine com o cliente e peça pelo Jarvis ou pelo botão do card.` });
    return false;
  }
  const { inNoticeWindow, whatsappWindowOpen, conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow() || !(await whatsappWindowOpen(leadId))) return false;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || null;
  const texto = certidaoOfferEnderecoText(nome, !(await conversationActive(leadId)), end);
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: (io || undefined) as any });
  if (!r.success) return false;
  await salvaOferta(leadId, { matricula: chave, cidade: e.cidade, uf: e.uf, at: new Date().toISOString() });
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const c = { ...((fresh?.customFields || {}) as Record<string, any>) };
  c._certidaoEndereco = { endereco: e.endereco, cidade: e.cidade, uf: e.uf, cartorio: 'AUTO', sendPix: true, askedAt: new Date().toISOString(), oferta: true } as EnderecoAsk;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: c as any } });
  await note(leadId, `🏛️ Falta a certidão de ônus/matrícula e os documentos não trazem a matrícula: ofereci emitir pelo cartório digital pelo ENDEREÇO (${end}) e pedi pra confirmar o endereço. Confirmando, o CRM pede sozinho e o PIX vai ao cliente.`);
  return true;
}

/** O cliente JÁ mandou uma certidão de ônus/matrícula que vale (e o banco não recusou)? Então não há o que emitir/cobrar: nem a oferta nem o pedido no ONR (Fabio 23/10, Luiz Fernando: a certidão
 *  estava no card e o 'Ok, obrigado!' dele ainda disparou o PIX). */
async function jaTemCertidaoValida(leadId: string, cf: Record<string, any>): Promise<boolean> {
  if (!temCertidaoEmMaos(cf)) return false;
  const recusou = await (require('./doc-review.service') as typeof import('./doc-review.service')).bancoRecusouCertidao(leadId).catch(() => false);
  return !recusou;
}

/** Cria o pedido no ONR (a extensão pega na fila): chamado quando o cliente aceitou. Uma vez por matrícula. */
export async function ensureCertidaoRequest(accountId: string, leadId: string, opts: { manual?: boolean; userId?: string; sendPix?: boolean; porEndereco?: boolean } = {}): Promise<{ created: boolean; why?: string; agendado?: boolean }> {
  const lead = await carrega(leadId);
  if (!lead || lead.accountId !== accountId) return { created: false, why: 'lead não encontrado' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  // Clique da equipe no botão do card (opts.manual) vale sempre; o caminho automático respeita a chave e a certidão que o cliente já mandou.
  if (!opts.manual && (await jaTemCertidaoValida(leadId, cf))) return { created: false, why: 'o cliente já enviou a certidão de ônus/matrícula e o banco não recusou' };
  const d = opts.porEndereco ? null : certidaoFromDocs(cf);
  if (!d) {
    // Sem matrícula nos documentos (o cliente não sabe): pede POR ENDEREÇO (Fabio 29/10). Cartório 'AUTO': cidade com um só, a extensão escolhe; com mais de um,
    // o CRM pergunta ao cliente qual é; se ele não souber, a equipe confere no mapa do registro de imóveis.
    const e = await enderecoDoImovel(leadId, cf);
    if (!e) return { created: false, why: 'não achei a matrícula nos documentos nem o endereço completo do imóvel (CEP, rua, número, cidade/UF)' };
    if (!opts.manual && !(await contractingAutoOn(accountId))) {
      await manualStep({ accountId, leadId, leadName: lead.name, step: 'certidao-pedido-endereco', pushTitle: '🏛️ Certidão pelo ONR', pushBody: `${lead.name}: o cliente aceitou — peça pelo botão do card`,
        note: `🏛️ A emissão da certidão pelo ENDEREÇO do imóvel (${enderecoTexto(e.endereco)}, ${e.cidade}/${e.uf}) está autorizada, mas o pedido NÃO foi feito sozinho: passo manual (automação da contratação desligada). Use o botão "Pedir certidão pelo ONR" do card.` });
      return { created: false, why: 'modo manual da contratação' };
    }
    try {
      const out = await createCertidaoRequest(prisma, { accountId, leadId, uf: e.uf, cidade: e.cidade, cartorio: 'AUTO', pedidoPor: 'ENDERECO', endereco: e.endereco, source: opts.manual ? 'USER' : 'AI', userId: opts.manual ? opts.userId : undefined, sendPix: opts.sendPix });
      return { created: !out.duplicate, agendado: !out.duplicate && !!out.agendado };
    } catch (err: any) {
      await note(leadId, `⚠️ Não consegui criar o pedido da certidão pelo endereço: ${err?.message || err}. Peça pelo card.`);
      return { created: false, why: String(err?.message || err) };
    }
  }
  if (!opts.manual && !(await contractingAutoOn(accountId))) {
    await manualStep({ accountId, leadId, leadName: lead.name, step: `certidao-pedido-${d.matricula}`, pushTitle: '🏛️ Certidão pelo ONR', pushBody: `${lead.name}: o cliente aceitou — peça pelo botão do card`,
      note: `🏛️ A emissão da certidão (matrícula ${d.matricula}, ${d.cidade}/${d.uf}) está autorizada, mas o pedido NÃO foi feito sozinho: passo manual (automação da contratação desligada). Use o botão "Pedir certidão pelo ONR" na aba Financiamento do card — a extensão pede no RI Digital e o PIX vai ao cliente.` });
    return { created: false, why: 'modo manual da contratação' };
  }
  const existente = await prisma.certidaoRequest.findFirst({ where: { leadId, matricula: d.matricula, status: { notIn: ['CANCELLED', 'FAILED'] } }, select: { id: true } });
  if (existente) return { created: false, why: 'já existe pedido pra esta matrícula' };
  try {
    const out = await createCertidaoRequest(prisma, { accountId, leadId, uf: d.uf, cidade: d.cidade, cartorio: d.cartorio, matricula: d.matricula, source: opts.manual ? 'USER' : 'AI', userId: opts.manual ? opts.userId : undefined, sendPix: opts.sendPix });
    return { created: !out.duplicate, agendado: !out.duplicate && !!out.agendado };
  } catch (e: any) {
    await note(leadId, `⚠️ O cliente autorizou a emissão da certidão, mas não consegui criar o pedido no ONR: ${e?.message || e}. Peça pelo botão da certidão no card.`);
    return { created: false, why: String(e?.message || e) };
  }
}

/** Pro botão "Pedir certidão pelo ONR" do card: dá pra pedir? (matrícula + cidade/UF lidas nos documentos e nenhum pedido andando). */
export async function previewCertidaoDosDocs(accountId: string, leadId: string, opts: { porEndereco?: boolean } = {}): Promise<{ possible: boolean; matricula?: string; cidade?: string; uf?: string; jaTemCertidao: boolean; existe: boolean } | null> {
  const lead = await carrega(leadId);
  if (!lead || lead.accountId !== accountId) return null;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const d = opts.porEndereco ? null : certidaoFromDocs(cf);
  const e = d ? null : await enderecoDoImovel(leadId, cf); // sem matrícula (ou pedido pelo endereço): pelo endereço do imóvel
  const existe = !!(await prisma.certidaoRequest.findFirst({ where: { leadId, ...(d ? { matricula: d.matricula } : { pedidoPor: 'ENDERECO' }), status: { notIn: ['CANCELLED', 'FAILED'] } }, select: { id: true } }));
  return { possible: !!(d || e) && !existe, matricula: d?.matricula || (e ? `pelo endereço: ${enderecoTexto(e.endereco)}` : undefined), cidade: d?.cidade || e?.cidade, uf: d?.uf || e?.uf, jaTemCertidao: await jaTemCertidaoValida(leadId, cf), existe };
}

/** Opções de cartório que a extensão listou ao falhar ("… (opções: 1º OFÍCIO - X | 2º OFÍCIO - X)"). Pura (testável). */
export function opcoesDeCartorio(reason: string): string[] {
  const m = /\(op[cç][õo]es:\s*(.+?)\)\s*(?:—|-|$)/i.exec(String(reason || ''));
  if (!m) return [];
  return m[1].split('|').map((x) => x.trim()).filter((x) => x && !/selecione|^-+$/i.test(x));
}

/** A extensão não soube qual cartório pedir (a escritura não diz e a cidade tem mais de um): CONFIRMA COM O CLIENTE (Fabio 20/10: "pode confirmar com o cliente também se não souber"). Uma vez por matrícula. */
export async function askClientCartorio(accountId: string, req: { id: string; leadId: string; matricula: string; cidade: string; uf: string; endereco?: string }, reason: string, io: Io): Promise<boolean> {
  const opcoes = opcoesDeCartorio(reason);
  if (opcoes.length < 2 || opcoes.length > 12) return false;
  const lead = await carrega(req.leadId);
  if (!lead || lead.accountId !== accountId) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const antes = cf._certidaoCartorio as { matricula?: string; askedAt?: string } | undefined;
  if (antes?.matricula === req.matricula && antes?.askedAt) return false;
  if (cf._autoPaused || !lead.aiAutoReplyActive) return false;
  const { inNoticeWindow, whatsappWindowOpen, conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow() || !(await whatsappWindowOpen(req.leadId))) return false;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || null;
  const saud = (await conversationActive(req.leadId)) ? '' : `Oi${nome ? `, ${nome}` : ''}! `;
  const texto = `${saud}Pra pedir a certidão ${req.endereco ? 'do seu imóvel' : `da matrícula ${req.matricula}`} preciso saber o cartório de registro de imóveis. Em ${req.cidade} o portal tem estas opções:\n${opcoes.map((o) => `• ${o}`).join('\n')}\n\n${req.endereco ? 'Você sabe qual deles atende o seu bairro (aparece no contrato, escritura ou carnê do IPTU)?' : 'Na sua escritura ou matrícula aparece qual deles?'} Se não souber, sem problema, é só me avisar.`;
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId, leadId: req.leadId, content: texto, io: (io || undefined) as any });
  if (!r.success) return false;
  const fresh = await prisma.lead.findUnique({ where: { id: req.leadId }, select: { customFields: true } });
  const c2: Record<string, any> = { ...((fresh?.customFields || {}) as Record<string, any>), _certidaoCartorio: { requestId: req.id, matricula: req.matricula, cidade: req.cidade, uf: req.uf, opcoes, askedAt: new Date().toISOString() } as Record<string, any> };
  if (req.endereco) { const orig = await prisma.certidaoRequest.findUnique({ where: { id: req.id }, select: { endereco: true } }); c2._certidaoCartorio.endereco = orig?.endereco || null; }
  await prisma.lead.update({ where: { id: req.leadId }, data: { customFields: c2 as any } });
  await note(req.leadId, `🏛️ A escritura não diz qual é o cartório de ${req.cidade} (o portal tem ${opcoes.length}). Perguntei ao cliente qual aparece na escritura/matrícula; com a resposta o pedido é refeito sozinho.`);
  return true;
}

/** Resposta do cliente à pergunta do cartório: escolheu uma opção → refaz o pedido no ONR com ela; "não sei" → avisa a equipe. */
async function respondeCartorio(accountId: string, leadId: string, text: string, pend: { requestId?: string; matricula: string; cidade: string; uf: string; opcoes: string[]; endereco?: EnderecoCertidao | null }, io: Io): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 1000,
      system: 'O cliente respondeu qual é o cartório de registro de imóveis do imóvel dele. Escolha, entre as OPÇÕES numeradas, a que a resposta indica. Responda SÓ JSON: {"opcao": <número da opção, ou 0 se a resposta não indica nenhuma>, "naoSei": <true se o cliente disse que não sabe/não lembra>}. Se a resposta for pergunta ou outro assunto: {"opcao":0,"naoSei":false}.',
      messages: [{ role: 'user', content: `OPÇÕES:\n${pend.opcoes.map((o, i) => `${i + 1}) ${o}`).join('\n')}\n\nRESPOSTA DO CLIENTE: ${text}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return;
  const d: any = await res.json().catch(() => null);
  let j: any = {};
  try { j = JSON.parse(String(d?.content?.find((b: any) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { /* indefinido */ }
  const idx = Number(j.opcao) || 0;
  const salva = async (patch: Record<string, unknown>) => {
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const c = { ...((fresh?.customFields || {}) as Record<string, any>) };
    c._certidaoCartorio = { ...(c._certidaoCartorio || {}), ...patch };
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: c as any } });
  };
  if (idx >= 1 && idx <= pend.opcoes.length) {
    const escolhido = pend.opcoes[idx - 1];
    await salva({ answeredAt: new Date().toISOString(), escolhido });
    try {
      const out = await createCertidaoRequest(prisma, { accountId, leadId, uf: pend.uf, cidade: pend.cidade, cartorio: escolhido, ...(pend.endereco ? { pedidoPor: 'ENDERECO' as const, endereco: pend.endereco } : { matricula: pend.matricula }), source: 'AI' });
      await note(leadId, `🏛️ O cliente confirmou o cartório: ${escolhido}. Pedido refeito no ONR${out.duplicate ? ' (já havia um andando)' : ''}.`);
      io?.to(`account_${accountId}`).emit('certidao_updated', { leadId });
    } catch (e: any) { await note(leadId, `⚠️ O cliente confirmou o cartório (${escolhido}), mas não consegui refazer o pedido: ${e?.message || e}.`); }
  } else if (j.naoSei === true) {
    await salva({ answeredAt: new Date().toISOString(), naoSei: true });
    await note(leadId, `⚠️ O cliente NÃO sabe qual é o cartório (${pend.cidade}/${pend.uf}).${pend.endereco ? ` Descubra pelo CEP ${pend.endereco.cep} no mapa do registro de imóveis (https://www.registrodeimoveis.org.br/servicos/mapa — digite o endereço ou o CEP e veja o Ofício responsável)` : ' Confira na escritura/matrícula (nome do cartório de registro)'} e peça a certidão pelo card.`);
    try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '🏛️ Cartório da certidão', body: 'O cliente não sabe qual é o cartório — confira na escritura', leadId }).catch(() => {}); } catch { /* push é só aviso */ }
  }
}

/** A última mensagem que a empresa mandou (a que o cliente está respondendo) fala da certidão/emissão? "Ok, obrigado!" em resposta a "já solicitei a vistoria" NÃO aceita nada
 *  (Fabio 23/10, Luiz Fernando: a oferta de 21/10 ainda estava aberta e um "Ok, obrigado!" virou autorização — o PIX de R$ 35,20 saiu e o cliente pagou). Pura (testável). */
export function mensagemFalaDaCertidao(texto: string): boolean {
  return /certid[aã]o|\bonr\b|emiss[aã]o|emitir|emitid|cart[oó]rio|matr[ií]cula|[oô]nus/i.test(String(texto || ''));
}

/** Mensagem do cliente depois da oferta: aceitou? Aceitou → autorização anotada + extensão do ONR acionada. Roda a cada texto inbound, mas só gasta IA enquanto há oferta esperando resposta. */
export async function checkCertidaoAcceptance(accountId: string, leadId: string, text: string, io: Io): Promise<void> {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 400) return;
  const lead = await carrega(leadId);
  if (!lead || lead.accountId !== accountId) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const ir = cf._certidaoIrregular as IrregularAsk | undefined;
  if (ir?.askedAt && !ir.answeredAt && Date.now() - new Date(ir.askedAt).getTime() < 7 * 86_400_000) { await respondeImovelRegular(accountId, leadId, clean, ir, io); return; }
  const pe = cf._certidaoEndereco as EnderecoAsk | undefined;
  if (pe?.askedAt && !pe.answeredAt && Date.now() - new Date(pe.askedAt).getTime() < 7 * 86_400_000) { await respondeEndereco(accountId, leadId, clean, pe, io); return; }
  const pend = cf._certidaoCartorio as { requestId?: string; matricula: string; cidade: string; uf: string; opcoes: string[]; askedAt?: string; answeredAt?: string } | undefined;
  if (pend?.askedAt && !pend.answeredAt && !cf._autoPaused) { await respondeCartorio(accountId, leadId, clean, pend, io); return; }
  const of = cf._certidaoOffer as { matricula?: string; at?: string; acceptedAt?: string; declinedAt?: string } | undefined;
  if (!of?.at || of.acceptedAt || of.declinedAt || cf._autoPaused) return;
  if (Date.now() - new Date(of.at).getTime() > 7 * 86_400_000) return; // oferta velha: não gasta IA lendo toda mensagem
  // A oferta só vale enquanto o card AINDA espera documentação (mesma regra de quando ela é feita): com a documentação recebida / em contratação não há mais o que emitir sozinho.
  if (!/aguardando document/i.test((lead.stage?.name || '').normalize('NFD').replace(/[̀-ͯ]/g, ''))) return;
  if (await jaTemCertidaoValida(leadId, cf)) return; // já mandou a certidão: a oferta perdeu o sentido, nada a autorizar
  // O cliente tem que estar respondendo à PERGUNTA DA CERTIDÃO: se a última mensagem da empresa (equipe ou IA) é sobre outro assunto, o "ok/sim/obrigado" dele não autoriza nada.
  const ultima = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', channel: 'WHATSAPP', deleted: false, NOT: { content: '' } }, orderBy: { createdAt: 'desc' }, select: { content: true, createdAt: true } });
  if (!ultima || !mensagemFalaDaCertidao(ultima.content || '')) return;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const estadoCrm = await (require('./ai-shared.service') as typeof import('./ai-shared.service')).aiCardState(leadId).catch(() => '');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 1000,
      system: 'A atendente de um correspondente bancário perguntou ao cliente se ele tem a certidão de ônus/matrícula do imóvel ou se pode emitir pelo cartório digital (ONR). Leia a RESPOSTA do cliente e classifique. Responda SÓ JSON: {"r":"SIM"|"NAO"|"TEM"|"INDEFINIDO"}. SIM = aceitou que se emita (ex.: "pode", "sim", "pode emitir", "ok", "manda o pix"). TEM = disse que TEM a certidão e vai mandar. NAO = recusou ou prefere tirar sozinho no cartório. INDEFINIDO = pergunta (inclusive sobre o custo), dúvida, assunto diferente ou resposta que não decide. A resposta só vale como SIM/NAO/TEM se for resposta à ÚLTIMA MENSAGEM DA ATENDENTE e ela estiver tratando da certidão/emissão; se a última mensagem for sobre outro assunto (vistoria, documento, andamento), um "ok", "sim", "obrigado" ou "blz" é só um agradecimento/ciência: INDEFINIDO. Na dúvida, INDEFINIDO (SIM manda cobrar um PIX do cliente).',
      messages: [{ role: 'user', content: `${estadoCrm ? `ESTADO DO CARD NO CRM:\n${estadoCrm}\n\n` : ''}OFERTA: emitir a certidão da matrícula ${of.matricula} pelo cartório digital (ONR).\nÚLTIMA MENSAGEM DA ATENDENTE (a que o cliente está respondendo): ${String(ultima.content || '').replace(/\s+/g, ' ').slice(0, 500)}\nRESPOSTA DO CLIENTE: ${clean}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return;
  const d: any = await res.json().catch(() => null);
  const raw = String(d?.content?.find((b: any) => b.type === 'text')?.text || '');
  let r = 'INDEFINIDO';
  try { r = String(JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}').r || 'INDEFINIDO').toUpperCase(); } catch { /* indefinido */ }
  if (r === 'NAO') {
    await salvaOferta(leadId, { declinedAt: new Date().toISOString() });
    await note(leadId, `🏛️ O cliente NÃO quer que a A&F emita a certidão ("${clean.slice(0, 120)}"): ele prefere tirar direto no cartório. Nada foi pedido no ONR.`);
    return;
  }
  if (r === 'TEM') {
    const jaAvisou = !!(cf._certidaoOffer as any)?.temAt;
    await salvaOferta(leadId, { temAt: new Date().toISOString() }); // a oferta continua valendo: se depois ele pedir pra emitir, vale
    if (!jaAvisou) await note(leadId, `🏛️ O cliente diz que TEM a certidão de ônus/matrícula e vai mandar ("${clean.slice(0, 120)}"). Nada foi pedido no ONR; se ele não mandar, a oferta de emitir continua valendo.`);
    return;
  }
  if (r !== 'SIM') return;
  await salvaOferta(leadId, { acceptedAt: new Date().toISOString() });
  await note(leadId, `${AUTORIZOU_EMISSAO} — o cliente aceitou a oferta ("${clean.slice(0, 120)}"): a emissão pelo ONR foi autorizada (o PIX vai ao cliente).`);
  const out = await ensureCertidaoRequest(accountId, leadId);
  if (out.created) io?.to(`account_${accountId}`).emit('certidao_updated', { leadId });
  if (out.agendado) await avisaPixAmanha(accountId, leadId, io);
  else if (out.why) console.warn(`[Certidão] ${lead.name}: aceitou, mas o pedido não foi criado — ${out.why}`);
}


/** Cliente comprou o imóvel e AINDA NÃO transferiu/registrou a escritura no nome dele (Fabio 21/10, Luiz: "ele informou que não transferiu ainda"): o dono na matrícula é o VENDEDOR — a conferência NÃO pergunta de quem é o imóvel
 *  (ele já explicou) e não trava por isso. Marca `_transferenciaPendente` e dá o assunto da "pergunta do dono" por resolvido. Pura no regex (testável). */
export const TRANSFERENCIA_PENDENTE_RX = /\b(?:ainda\s+)?n[aã]o\s+(?:registrei|transferi|averbei|passei\s+(?:pro|para\s+o)\s+meu\s+nome|fiz\s+(?:o\s+)?(?:registro|transfer[eê]ncia))|ainda\s+consta\s+o\s+antigo\s+propriet[aá]rio|n[aã]o\s+(?:est[aá]|foi)\s+(?:registrad[oa]|transferid[oa])\s+(?:no|em)\s+meu\s+nome|escritura\s+(?:ainda\s+)?n[aã]o\s+(?:foi\s+)?registrada/i;
export async function marcarTransferenciaPendente(accountId: string, leadId: string, text: string): Promise<void> {
  const t = String(text || '').trim();
  if (!t || t.length > 600 || !TRANSFERENCIA_PENDENTE_RX.test(t)) return;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true, stage: { select: { name: true } } } });
  if (!lead) return;
  const cf = { ...((lead.customFields || {}) as Record<string, any>) };
  if (cf._transferenciaPendente) return;
  cf._transferenciaPendente = { at: new Date().toISOString(), disse: t.slice(0, 160) };
  cf._donoResolvedAt = new Date().toISOString();
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
  await note(leadId, `🏠 O cliente disse que AINDA NÃO transferiu/registrou a escritura no nome dele ("${t.slice(0, 120)}"): o dono na matrícula é o vendedor. Não pergunto mais de quem é o imóvel e isso não trava a documentação — o registro precisa sair antes da liberação do valor.`);
}

// ── Confirmar o endereço com o cliente e SÓ DEPOIS pedir a certidão (Fabio 29/10, Fernanda Karita: "confirmar com a cliente e quando ela confirmar solicitar a certidão de ônus") ──
type EnderecoAsk = { endereco: EnderecoCertidao; cidade: string; uf: string; cartorio?: string; sendPix?: boolean; userId?: string; askedAt?: string; answeredAt?: string; oferta?: boolean };

/** Manda ao cliente "confirma o endereço do imóvel?" e guarda o pedido esperando o SIM. Sem endereço passado, usa o da proposta/documentos (enderecoDoImovel). */
export async function askEnderecoCertidao(accountId: string, leadId: string, opts: { endereco?: EnderecoCertidao; cidade?: string; uf?: string; cartorio?: string; sendPix?: boolean; userId?: string }, io: Io): Promise<{ ok: boolean; erro?: string; texto?: string }> {
  const lead = await carrega(leadId);
  if (!lead || lead.accountId !== accountId) return { ok: false, erro: 'card não encontrado' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  const e = opts.endereco && opts.cidade && opts.uf ? { endereco: opts.endereco, cidade: opts.cidade, uf: opts.uf } : await enderecoDoImovel(leadId, cf);
  if (!e) return { ok: false, erro: 'não achei o endereço completo do imóvel (CEP, rua, número, cidade/UF)' };
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || null;
  const texto = `${nome ? `${nome}, p` : 'P'}ra emitir a certidão de ônus do imóvel, confirma pra mim se o endereço é este?\n${enderecoTexto(e.endereco)} — ${e.cidade}/${e.uf}`;
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: (io || undefined) as any });
  if (!r.success) return { ok: false, erro: 'não consegui mandar a mensagem (janela de 24 h do WhatsApp fechada?)' };
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const c = { ...((fresh?.customFields || {}) as Record<string, any>) };
  c._certidaoEndereco = { endereco: e.endereco, cidade: e.cidade, uf: e.uf, cartorio: opts.cartorio || 'AUTO', sendPix: opts.sendPix !== false, userId: opts.userId, askedAt: new Date().toISOString() } as EnderecoAsk;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: c as any } });
  await note(leadId, `🏛️ Perguntei ao cliente se o endereço do imóvel é ${enderecoTexto(e.endereco)} (${e.cidade}/${e.uf}). Confirmando, o CRM pede a certidão de ônus pelo endereço sozinho.`);
  return { ok: true, texto };
}

/** Resposta do cliente à confirmação do endereço. SIM → pede a certidão; correção/"não" → nota + push pra equipe (o CRM não reescreve o endereço sozinho); outro assunto → continua esperando. Pura nas regras. */
export function classificaRespostaEndereco(texto: string): 'SIM' | 'CORRIGE' | 'OUTRO' {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (/\bnao\b|errad|outro endere|na verdade|o correto|o certo e/.test(t) || (/\d{2,}/.test(t) && /\b(rua|av|avenida|apto|apartamento|cep|n[ou]mero|bloco|torre)\b/.test(t))) return 'CORRIGE';
  if (/^(sim|isso|correto|certo|confirmo|confirmado|exato|exatamente|e esse|esse mesmo|e isso|pode|ok|okay|positivo|esta certo|ta certo|perfeito|isso mesmo)\b/.test(t)) return 'SIM';
  return 'OUTRO';
}
async function respondeEndereco(accountId: string, leadId: string, texto: string, pe: EnderecoAsk, io: Io): Promise<void> {
  let tipo: 'SIM' | 'CORRIGE' | 'OUTRO' | 'NAO' | 'TEM' = classificaRespostaEndereco(texto);
  if (pe.oferta) {
    // Oferta da IA (cobra um PIX do cliente): o "sim/ok" só vale respondendo à pergunta da certidão, com o card ainda esperando documentação e sem certidão em mãos.
    const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/\btenho\b|vou (te )?(mandar|enviar)|ja (te )?(mandei|enviei)|tenho ela/.test(t) && !/pode emitir|pode tirar|emite/.test(t)) tipo = 'TEM';
    else if (tipo === 'CORRIGE' && !/\d{2,}/.test(t)) tipo = 'NAO';
    if (tipo === 'SIM') {
      const lead = await carrega(leadId);
      const cf0 = (lead?.customFields || {}) as Record<string, any>;
      const ultima = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', channel: 'WHATSAPP', deleted: false, NOT: { content: '' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
      if (!ultima || !mensagemFalaDaCertidao(ultima.content || '')) return;
      if (cf0._autoPaused || !/aguardando document/i.test((lead?.stage?.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')) || (await jaTemCertidaoValida(leadId, cf0))) return;
    }
  }
  if (tipo === 'OUTRO') return;
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, name: true } });
  const c = { ...((fresh?.customFields || {}) as Record<string, any>) };
  c._certidaoEndereco = { ...(c._certidaoEndereco || {}), answeredAt: new Date().toISOString(), resposta: tipo };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: c as any } });
  if (tipo === 'TEM') { await note(leadId, `🏛️ O cliente diz que TEM a certidão de ônus/matrícula e vai mandar (“${texto.slice(0, 120)}”). Nada foi pedido no ONR.`); return; }
  if (tipo === 'NAO') { await note(leadId, `🏛️ O cliente NÃO quer que a A&F emita a certidão (“${texto.slice(0, 120)}”). Nada foi pedido no ONR.`); return; }
  if (tipo === 'CORRIGE') {
    await note(leadId, `⚠️ O cliente NÃO confirmou o endereço da certidão: “${texto.slice(0, 300)}”. Confira e peça a certidão com o endereço certo (Jarvis: pedir_certidao com o endereço).`);
    try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '🏛️ Endereço da certidão', body: `${fresh?.name || 'Cliente'} corrigiu o endereço do imóvel`, leadId }).catch(() => {}); } catch { /* aviso */ }
    return;
  }
  try {
    const out = await createCertidaoRequest(prisma, { accountId, leadId, uf: pe.uf, cidade: pe.cidade, cartorio: pe.cartorio || 'AUTO', pedidoPor: 'ENDERECO', endereco: pe.endereco, source: 'AI', userId: pe.userId, sendPix: pe.sendPix !== false });
    if (pe.oferta) await note(leadId, `${AUTORIZOU_EMISSAO} — o cliente aceitou a emissão pelo endereço (“${texto.slice(0, 120)}”).`);
    await note(leadId, `🏛️ O cliente confirmou o endereço (${enderecoTexto(pe.endereco)}). Pedi a certidão de ônus pelo endereço no ONR${out.duplicate ? ' (já havia um pedido andando)' : ''}.`);
    io?.to(`account_${accountId}`).emit('certidao_updated', { leadId });
    if (!out.duplicate && out.agendado) await avisaPixAmanha(accountId, leadId, io);
  } catch (e: any) { await note(leadId, `⚠️ O cliente confirmou o endereço, mas não consegui pedir a certidão: ${e?.message || e}.`); }
}

// ── Área irregular (Fabio 30/10: "envia o push e pergunta ao cliente"): a pesquisa do cartório indicou que o endereço pode não ter matrícula. Pergunta antes de pedir (cada pedido é cobrança). ──
type IrregularAsk = { uf: string; cidade: string; cartorio: string; endereco: EnderecoCertidao; sendPix?: boolean; userId?: string; motivo?: string; askedAt?: string; answeredAt?: string; resposta?: 'SIM' | 'NAO' };

export async function askImovelRegular(accountId: string, leadId: string, p: Omit<IrregularAsk, 'askedAt' | 'answeredAt' | 'resposta'>): Promise<boolean> {
  const lead = await carrega(leadId);
  if (!lead || lead.accountId !== accountId) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused) return false;
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow() || !(await whatsappWindowOpen(leadId))) return false;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || null;
  const texto = `${nome ? `${nome}, p` : 'P'}ra emitir a certidão do imóvel, uma dúvida: ele tem matrícula registrada no Cartório de Registro de Imóveis (escritura registrada)? Pergunto porque, pelo endereço, a região pode ainda não ser regularizada.`;
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: undefined });
  if (!r.success) return false;
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const c = { ...((fresh?.customFields || {}) as Record<string, any>) };
  c._certidaoIrregular = { ...p, askedAt: new Date().toISOString() } as IrregularAsk;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: c as any } });
  return true;
}

async function respondeImovelRegular(accountId: string, leadId: string, texto: string, ir: IrregularAsk, io: Io): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 600,
      system: 'A atendente perguntou ao cliente se o imóvel dele tem matrícula registrada no Cartório de Registro de Imóveis (escritura registrada), porque a região pode não ser regularizada. Classifique a RESPOSTA. Só JSON: {"r":"SIM"|"NAO"|"INDEFINIDO"}. SIM = confirma que tem matrícula/escritura registrada. NAO = não tem, só contrato de compra e venda/gaveta, cessão de direitos, posse, área não regularizada, ou não sabe se é registrado. INDEFINIDO = outro assunto, pergunta ou resposta que não decide. Na dúvida, INDEFINIDO (SIM faz cobrar um PIX do cliente).',
      messages: [{ role: 'user', content: `RESPOSTA DO CLIENTE: ${texto.slice(0, 400)}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return;
  const d: any = await res.json().catch(() => null);
  let r = 'INDEFINIDO';
  try { r = String(JSON.parse(String(d?.content?.find((b: any) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || '{}').r || 'INDEFINIDO').toUpperCase(); } catch { /* indefinido */ }
  if (r !== 'SIM' && r !== 'NAO') return;
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, name: true } });
  const c = { ...((fresh?.customFields || {}) as Record<string, any>) };
  c._certidaoIrregular = { ...(c._certidaoIrregular || {}), answeredAt: new Date().toISOString(), resposta: r };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: c as any } });
  if (r === 'NAO') {
    await note(leadId, `⚠️ O cliente disse que o imóvel NÃO tem matrícula registrada (“${texto.slice(0, 160)}”). A certidão não foi pedida — sem matrícula o imóvel não serve de garantia; fale com o cliente.`);
    try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '⚠️ Imóvel sem matrícula', body: `${fresh?.name || 'Cliente'}: disse que o imóvel não tem matrícula registrada`, leadId }).catch(() => {}); } catch { /* aviso */ }
    return;
  }
  try {
    const out = await createCertidaoRequest(prisma, { accountId, leadId, uf: ir.uf, cidade: ir.cidade, cartorio: ir.cartorio || 'AUTO', pedidoPor: 'ENDERECO', endereco: ir.endereco, source: 'AI', userId: ir.userId, sendPix: ir.sendPix !== false });
    await note(leadId, `🏛️ O cliente confirmou que o imóvel tem matrícula registrada (“${texto.slice(0, 120)}”). Pedi a certidão pelo endereço${out.duplicate ? ' (já havia um pedido andando)' : ''}.`);
    io?.to(`account_${accountId}`).emit('certidao_updated', { leadId });
    if (!out.duplicate && out.agendado) await avisaPixAmanha(accountId, leadId, io);
  } catch (e: any) { await note(leadId, `⚠️ O cliente confirmou que o imóvel tem matrícula, mas não consegui pedir a certidão: ${e?.message || e}.`); }
}

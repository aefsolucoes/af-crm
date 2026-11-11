import { prisma } from '../lib/prisma';

/**
 * ENDEREÇO DO IMÓVEL NO CARD (Fabio 30/10: "o endereço no card deve ser preenchido assim que tiver a documentação do imóvel, coloca para o CRM fazer isso automaticamente").
 * Fontes, nessa ordem: proposta do site / leitura dos documentos (enderecoDoImovel), o endereço lido nos documentos do imóvel (_docReview: matrícula/ônus, IPTU/cadastro,
 * escritura) e, sem nada disso, o CEP + número do card (ViaCEP). Preenche SÓ campo vazio: "Endereço do imóvel" (endereco_imovel, criado na mesma aba do CEP), CEP, número,
 * complemento e cidade. Roda no poller quando muda o número de documentos lidos do card (_endImovelN) — vale também pra card antigo.
 * Caso Pedro (30/10): o e-mail do questionário do Inter saiu com "Endereço dos proponentes: (confirmo em seguida)" porque o card não tinha o endereço.
 */

type Cf = Record<string, any>;
type Info = { texto: string; cep?: string; numero?: string; complemento?: string; cidade?: string; fonte: string };

const vazio = (v: unknown) => v === undefined || v === null || String(v).trim() === '' || String(v).trim() === 'null';
const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const fmtCep = (c: string) => `${c.slice(0, 5)}-${c.slice(5)}`;

/** "Rua X, 1757 - AP 203 — Umarizal — Belém/PA — CEP 66050-350". Pura. */
export function formatarEndereco(e: { tipoLogradouro?: string; logradouro?: string; numero?: string; complemento?: string; bairro?: string; cep?: string }, cidade?: string, uf?: string): string {
  const cep = String(e.cep || '').replace(/\D/g, '');
  const rua = [e.tipoLogradouro, e.logradouro].filter((v) => !vazio(v)).join(' ');
  return [
    `${rua}${vazio(e.numero) ? '' : `, ${e.numero}`}${vazio(e.complemento) ? '' : ` - ${e.complemento}`}`,
    e.bairro, cidade ? `${cidade}${uf ? `/${uf}` : ''}` : null, cep.length === 8 ? `CEP ${fmtCep(cep)}` : null,
  ].filter((v) => !vazio(v)).join(' — ');
}

/** Endereço pelos campos do imóvel no card + CEP (ViaCEP). */
export async function enderecoDoCard(cf: Cf): Promise<Info | null> {
  const cep = String(cf.imovel_cep || '').replace(/\D/g, '');
  if (cep.length !== 8 || vazio(cf.imovel_numero)) return null;
  const v = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(6000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Record<string, any> | null;
  if (!v || v.erro || vazio(v.logradouro)) return null;
  const numero = String(cf.imovel_numero).trim();
  const complemento = vazio(cf.imovel_complemento) ? undefined : String(cf.imovel_complemento).trim();
  return { texto: formatarEndereco({ logradouro: v.logradouro, numero, complemento, bairro: v.bairro, cep }, v.localidade, v.uf), cep: fmtCep(cep), numero, complemento, cidade: v.localidade, fonte: 'CEP e número do card' };
}

/** Endereço lido num documento do imóvel (como está escrito), o de matrícula/ônus primeiro. Pura. */
export function enderecoDosDocs(cf: Cf): Info | null {
  const peso = (t: string) => (/MATRICULA|ONUS/.test(t) ? 0 : /IPTU|CADASTRO IMOBILIARIO/.test(t) ? 1 : /ESCRITURA/.test(t) ? 2 : 9);
  const revs = (Object.values((cf._docReview || {}) as Record<string, any>) as any[])
    .filter((r) => r && r.resultado !== 'NAO_DOCUMENTO' && !vazio(r.endereco) && peso(norm(r.tipo)) < 9)
    .sort((a, b) => peso(norm(a.tipo)) - peso(norm(b.tipo)));
  const r = revs[0];
  if (!r) return null;
  const texto = String(r.endereco).replace(/\s+/g, ' ').trim();
  const cep = /\b(\d{5})-?(\d{3})\b/.exec(texto);
  return { texto, ...(cep ? { cep: `${cep[1]}-${cep[2]}` } : {}), fonte: String(r.tipo || 'documento do imóvel').toLowerCase() };
}

// ─── Cidade pro campo "Local e Data" dos formulários que o cliente assina ───
const tituloCidade = (s: string) => s.toLowerCase().replace(/(^|[\s-])(\S)/g, (_m, a, b) => a + b.toUpperCase()).replace(/(^|\s)(Da|De|Do|Das|Dos|E)(?=\s)/g, (m, a, b) => (a ? a + b.toLowerCase() : m));
/** "BRASILIA/DF", "Belém - PA", "mogi das cruzes" → "Brasilia", "Belém", "Mogi das Cruzes". Vazio, com número ou comprido demais = '' (não é cidade). Pura. */
export function limpaCidade(v: unknown): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').replace(/(?:\s*\/\s*[A-Za-z]{2}|\s+[–-]\s*[A-Z]{2})\s*$/, '').replace(/^[\s,;.-]+|[\s,;.-]+$/g, '');
  if (vazio(s) || s.length < 2 || s.length > 40 || /\d/.test(s)) return '';
  return s === s.toUpperCase() || s === s.toLowerCase() ? tituloCidade(s) : s;
}

const UFS = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));
/** Cidade escrita num endereço ("…, MEIA PRAIA, ITAPEMA/SC, CEP 88220000", "…, SOBRADINHO, BRASILIA - DF"): só vale com uma UF de verdade ao lado ("…, SN, …" não é UF). Pura. */
export function cidadeDeEndereco(txt: unknown): string {
  const t = String(txt ?? '').replace(/\s+/g, ' ').replace(/,?\s*CEP[:\s]*[\d.\-]{8,10}/i, '').replace(/\b\d{2}\.?\d{3}-?\d{3}\b/, '').replace(/\s+[—–]\s+/g, ', ').trim();
  if (vazio(t)) return '';
  const barra = /\/\s*([A-Za-z]{2})\b/.exec(t);
  if (barra && UFS.has(barra[1].toUpperCase())) {
    const c = limpaCidade(t.slice(0, barra.index).split(/\s*[,;]\s*|\s+[–-]\s+/).pop());
    if (c) return c;
  }
  const soltas = [...t.matchAll(/([A-Za-zÀ-ú' ]{2,40}?)\s*[,–-]\s*([A-Z]{2})\s*(?=,|$)/g)].filter((m) => UFS.has(m[2]));
  return soltas.length ? limpaCidade(soltas[soltas.length - 1][1]) : '';
}

/** Cidade que já está escrita no card, sem buscar nada fora — nessa ordem: as que quem chama já tem (proposta do site), a residência lida nos documentos (ficha cadastral),
 *  os campos de cidade do card e o endereço do imóvel (campo do card ou o que está escrito na matrícula/ônus, IPTU ou escritura). '' = não achou. Pura (testável). */
export function cidadeNoCard(cf: Cf, preferidas: unknown[] = []): string {
  for (const p of preferidas) { const c = limpaCidade(p); if (c) return c; }
  const ficha = ((cf._fichaCadastral?.participantes || []) as any[]).filter(Boolean).slice().sort((a, b) => (Number(a.ordem) || 9) - (Number(b.ordem) || 9));
  for (const p of ficha) { const c = limpaCidade(p.endereco?.cidade); if (c) return c; }
  for (const k of ['cidade_1', 'cidade', 'cidade_imovel']) { const c = limpaCidade(cf[k]); if (c) return c; }
  for (const txt of [cf.endereco_imovel, enderecoDosDocs(cf)?.texto]) { const c = cidadeDeEndereco(txt); if (c) return c; }
  return '';
}

/** CEPs que o card conhece (imóvel primeiro, depois a residência dos participantes e o que estiver escrito no endereço do imóvel). Pura. */
function cepsDoCard(cf: Cf): string[] {
  const out: string[] = [];
  const poe = (v: unknown) => { const d = String(v ?? '').replace(/\D/g, ''); if (d.length === 8 && !out.includes(d)) out.push(d); };
  poe(cf.imovel_cep); poe(cf.cep_imovel);
  for (const p of ((cf._fichaCadastral?.participantes || []) as any[])) poe(p?.endereco?.cep);
  for (const txt of [cf.endereco_imovel, enderecoDosDocs(cf)?.texto]) { const m = /\b(\d{2}\.?\d{3}-?\d{3})\b/.exec(String(txt || '')); if (m) poe(m[1]); }
  return out;
}

/** Cidade pro "Local e Data" (Fabio 11/11: "quando o CRM for preencher o USECASA pra solicitar a vistoria do Santander, precisa colocar o local também" — a autorização do
 *  Home Equity só olhava a proposta do site; cliente que veio pelo WhatsApp recebia o formulário só com a data). Card primeiro (cidadeNoCard); sem nada escrito, o endereço
 *  do imóvel montado pela proposta/documentos e, por último, o CEP (ViaCEP). '' = não achou em lugar nenhum (quem chama segura o formulário e avisa a equipe). */
export async function cidadeDaAssinatura(leadId: string, cf: Cf, preferidas: unknown[] = []): Promise<string> {
  const escrita = cidadeNoCard(cf, preferidas);
  if (escrita) return escrita;
  const { enderecoDoImovel } = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
  const e = await enderecoDoImovel(leadId, cf).catch(() => null);
  const doImovel = limpaCidade(e?.cidade);
  if (doImovel) return doImovel;
  for (const cep of cepsDoCard(cf)) {
    const v = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(6000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Record<string, any> | null;
    const c = v && !v.erro ? limpaCidade(v.localidade) : '';
    if (c) return c;
  }
  return '';
}

export async function enderecoDoImovelInfo(leadId: string, cf: Cf): Promise<Info | null> {
  const { enderecoDoImovel } = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
  const e = await enderecoDoImovel(leadId, cf).catch(() => null);
  if (e) {
    const x = e.endereco;
    return { texto: formatarEndereco(x, e.cidade, e.uf), cep: String(x.cep || '').replace(/\D/g, '').length === 8 ? fmtCep(String(x.cep).replace(/\D/g, '')) : undefined, numero: x.numero, complemento: x.complemento, cidade: e.cidade, fonte: 'proposta/documentos do imóvel' };
  }
  return enderecoDosDocs(cf) || (await enderecoDoCard(cf));
}

let campoOk = new Set<string>();
/** Campo "Endereço do imóvel" (endereco_imovel) na mesma aba do CEP do imóvel. */
async function garanteCampo(accountId: string): Promise<void> {
  if (campoOk.has(accountId)) return;
  const tem = await prisma.fieldDefinition.findFirst({ where: { accountId, key: 'endereco_imovel' }, select: { id: true } });
  if (!tem) {
    const cep = await prisma.fieldDefinition.findFirst({ where: { accountId, key: 'imovel_cep' }, select: { tab: true, order: true } });
    await prisma.fieldDefinition.create({ data: { accountId, key: 'endereco_imovel', name: 'Endereço do imóvel', type: 'TEXT', tab: cep?.tab || 'Financiamento', order: cep?.order ?? 0, options: [] } });
  }
  campoOk.add(accountId);
}

/** Preenche o endereço do imóvel no card (só campos vazios). Devolve o texto gravado (ou null). */
export async function preencherEnderecoDoImovel(accountId: string, leadId: string): Promise<string | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  if (!lead) return null;
  const cf = (lead.customFields || {}) as Cf;
  const n = Object.keys((cf._docReview || {}) as Record<string, unknown>).length;
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_endImovelN}', to_jsonb(${n}::int), true) WHERE id = ${leadId}`;
  if (!vazio(cf.endereco_imovel)) return null;
  const info = await enderecoDoImovelInfo(leadId, cf);
  if (!info || vazio(info.texto)) return null;
  const patch: Record<string, string> = { endereco_imovel: info.texto.slice(0, 200) };
  if (vazio(cf.imovel_cep) && info.cep) patch.imovel_cep = info.cep;
  if (vazio(cf.imovel_numero) && !vazio(info.numero) && /^\d{1,6}[A-Za-z]?$/.test(String(info.numero).trim())) patch.imovel_numero = String(info.numero).trim();
  if (vazio(cf.imovel_complemento) && !vazio(info.complemento)) patch.imovel_complemento = String(info.complemento).trim().slice(0, 60);
  if (vazio(cf.cidade_imovel) && !vazio(info.cidade)) patch.cidade_imovel = String(info.cidade).trim();
  await garanteCampo(accountId).catch((e: any) => console.warn('[Endereço do imóvel] campo:', e?.message));
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb WHERE id = ${leadId} AND COALESCE("customFields"->>'endereco_imovel', '') = ''`;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏠 Endereço do imóvel preenchido no card (${info.fonte}): ${info.texto}${patch.imovel_cep ? '' : vazio(cf.imovel_cep) ? '\n⚠️ Sem CEP no documento — confira o CEP do imóvel no card.' : ''}` } }).catch(() => {});
  return info.texto;
}

/** Poller (1 min, credit-auto): card com documento lido novo (ou com CEP + número) e sem "Endereço do imóvel". */
export async function processEnderecoImovel(accountId: string): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead"
    WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND "isGroup" = false
      AND COALESCE("customFields"->>'endereco_imovel', '') = ''
      AND (
        (jsonb_typeof("customFields"->'_docReview') = 'object'
          AND COALESCE(("customFields"->>'_endImovelN')::int, -1) <> (SELECT count(*) FROM jsonb_object_keys("customFields"->'_docReview')))
        OR (COALESCE("customFields"->>'imovel_cep', '') <> '' AND COALESCE("customFields"->>'imovel_numero', '') <> '' AND "customFields"->>'_endImovelN' IS NULL)
      )
    ORDER BY "updatedAt" DESC LIMIT 20`;
  for (const { id } of ids) await preencherEnderecoDoImovel(accountId, id).catch((e: any) => console.warn('[Endereço do imóvel]', e?.message));
}

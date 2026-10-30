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

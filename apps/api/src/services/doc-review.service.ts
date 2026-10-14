import { PrismaClient } from '@prisma/client';
import { downloadDriveFileForVision } from './google.service';
import { getDocInfo } from './received-docs.service';
import { todayContextLine } from './ai-shared.service';

const prisma = new PrismaClient();

/* A IA LÊ o conteúdo de cada documento que o cliente manda (imagem ou PDF) e diz se está CORRETO pra ir ao banco: legível, atualizado, no nome certo,
 * com frente e verso quando é RG/CNH (Fabio 14/10: "preciso que a IA também passe a ler os documentos e saiba se estão corretos ou não").
 * A conferência de "chegou tudo?" (docs-checker) só olhava tipo e titular; aqui é a qualidade. Cada arquivo é lido uma vez e fica guardado no card
 * (customFields._docReview, por id do anexo). */

const MAX_REVIEW_BYTES = 10_000_000;

export interface DocReview {
  tipo: string;
  titular: string;
  resultado: 'OK' | 'PROBLEMA' | 'NAO_DOCUMENTO';
  problemas: string[];
  lado: 'frente' | 'verso' | 'ambos' | '';
  emissao: string;
  observacao: string;
}

const SYSTEM = `Você é a conferente de documentos de um correspondente bancário (crédito com garantia de imóvel e financiamento habitacional). Olhe o ARQUIVO que o cliente mandou pelo WhatsApp e diga se ele está CORRETO para seguir ao banco. Responda SOMENTE com JSON:
{"tipo":"<nome curto: RG, CNH, CPF, CERTIDAO DE NASCIMENTO, CERTIDAO DE CASAMENTO, COMPROVANTE DE RESIDENCIA, CONTRACHEQUE, EXTRATO BANCARIO, IMPOSTO DE RENDA, CERTIDAO DE ONUS REAIS, MATRICULA, CND IPTU, ESCRITURA ou outro nome curto>","titular":"<nome completo como está no documento, ou vazio>","resultado":"OK|PROBLEMA|NAO_DOCUMENTO","problemas":["<frase dirigida AO CLIENTE (você), educada e curta, dizendo o que está errado e o que fazer — ex.: \"Manda uma foto mais nítida, a data não dá pra ler.\" Nunca escreva \"peça ao cliente\">"],"lado":"<só RG/CNH: frente, verso ou ambos (o que aparece nesta imagem); senão vazio>","emissao":"<AAAA-MM-DD da emissão/competência se aparecer, senão vazio>","observacao":"<detalhe INTERNO útil pra equipe (ex.: constam ônus ou alienação fiduciária na matrícula, validade do documento); senão vazio>"}

Critérios — aponte PROBLEMA só quando for real; documento legível e correto é OK, não invente defeito:
- Legibilidade: foto desfocada, escura, com reflexo, cortada ou com dado importante ilegível → PROBLEMA ("manda uma foto mais nítida/inteira").
- RG/CNH: NÃO dê problema por mostrar só um lado (o cliente pode mandar frente e verso em fotos separadas): só preencha "lado". CNH digital (print do app) conta como "ambos". CNH vencida → PROBLEMA.
- Atualização (use a data de hoje): comprovante de residência com mais de 90 dias; certidão de ônus reais ou matrícula com mais de 30 dias; CND de IPTU vencida; contracheque que não seja dos últimos 3 meses → PROBLEMA, dizendo o prazo exigido. A data que vale na matrícula/certidão é a de EMISSÃO da certidão (carimbo/linha "certidão emitida em…", em geral no topo ou no fim), NÃO as datas dos registros e averbações dentro dela (um registro de 2011 não torna a certidão antiga). Se a data de emissão/validade não aparecer mas o documento parece inteiro e legível, é OK: anote "sem data de emissão visível" na observação.
- Titular: compare com os participantes do card. RG/CNH/CPF/certidão/documento de renda em nome de OUTRA pessoa → PROBLEMA ("está no nome de X; o participante é Y"). Comprovante de residência em nome de parente/outra pessoa NÃO é problema por si só; documentos do imóvel seguem o proprietário.
- Documento de várias páginas (matrícula, ônus, escritura, IR) que parece parcial: NÃO marque PROBLEMA; escreva em "observacao" que parece parcial.
- Se não for documento (selfie, figurinha, print de conversa, foto qualquer): resultado NAO_DOCUMENTO.`;

type Att = { id: string; driveFileId: string | null; data?: Uint8Array | null; mimeType: string; fileName?: string; createdAt?: Date };

function cleanText(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Lê UM arquivo. undefined = não deu pra ler (tipo, tamanho, erro de rede/API) — tenta de novo na próxima conferência. */
export async function reviewAttachment(accountId: string, att: Att, context: string): Promise<DocReview | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  const isPdf = att.mimeType === 'application/pdf';
  const isImage = /^image\//.test(att.mimeType);
  if (!isPdf && !isImage) return undefined;
  let buffer: Buffer;
  let mimeType = att.mimeType;
  try {
    if (att.data && att.data.length) buffer = Buffer.from(att.data);
    else if (att.driveFileId) ({ buffer, mimeType } = await downloadDriveFileForVision(accountId, att.driveFileId, att.mimeType));
    else return undefined;
  } catch { return undefined; }
  if (buffer.length > MAX_REVIEW_BYTES) return undefined;
  const mediaType = isPdf ? 'application/pdf' : mimeType;
  if (!isPdf && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) return undefined;
  const source = { type: 'base64', media_type: mediaType, data: buffer.toString('base64') };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: isPdf ? 'document' : 'image', source }, { type: 'text', text: context }] }],
    }),
  }).catch(() => null);
  if (!res || !res.ok) {
    if (res) console.error('[DocReview] Erro Anthropic:', res.status, (await res.text()).slice(0, 200));
    return undefined;
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const raw = data.content?.find((b) => b.type === 'text')?.text || '';
  try {
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const resultado = j.resultado === 'OK' || j.resultado === 'PROBLEMA' || j.resultado === 'NAO_DOCUMENTO' ? j.resultado : null;
    if (!resultado) return undefined;
    const lado = j.lado === 'frente' || j.lado === 'verso' || j.lado === 'ambos' ? j.lado : '';
    const problemas = (Array.isArray(j.problemas) ? j.problemas : []).map((p: unknown) => cleanText(p, 200)).filter(Boolean).slice(0, 4);
    return { tipo: cleanText(j.tipo, 50).toUpperCase(), titular: cleanText(j.titular, 80), resultado, problemas: resultado === 'PROBLEMA' ? problemas : [], lado, emissao: cleanText(j.emissao, 10), observacao: cleanText(j.observacao, 240) };
  } catch { return undefined; }
}

function participantsContext(cf: Record<string, any>, leadName: string): string {
  const parts = [
    cf.participante_1 && `1) ${cf.participante_1}${cf.cpf_1 ? ` (CPF ${String(cf.cpf_1).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')})` : ''}`,
    cf.participante_2 && `2) ${cf.participante_2}${cf.cpf_2 ? ` (CPF ${String(cf.cpf_2).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')})` : ''}`,
  ].filter(Boolean).join('\n') || `1) ${leadName}`;
  return `${todayContextLine()}\nParticipantes do card:\n${parts}\n\nConfira este arquivo.`;
}

export interface ReviewSummary {
  /** Revisões novas desta rodada (pra nota no card). */
  novas: { arquivo: string; r: DocReview }[];
  /** Problemas que valem agora (a revisão MAIS RECENTE de cada tipo+titular; frente/verso de RG/CNH somados). */
  problemas: { doc: string; texto: string[] }[];
  /** Documentos conferidos e OK (rótulo). */
  ok: string[];
}

const docKey = (r: DocReview) => `${r.tipo}|${r.titular.split(' ').slice(0, 2).join(' ')}`.toUpperCase();
const docLabel = (r: DocReview) => (r.titular ? `${r.tipo} (${r.titular.split(' ').slice(0, 2).join(' ')})` : r.tipo);

/** Lê os documentos que ainda não foram lidos e devolve a situação atual de cada um. */
export async function reviewReceivedDocs(accountId: string, leadId: string): Promise<ReviewSummary | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) return null;
  const atts = (await prisma.messageAttachment.findMany({
    where: { leadId, message: { direction: 'INBOUND' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, driveFileId: true, data: true, mimeType: true, fileName: true, createdAt: true },
  })).filter((a) => !/^(audio|video)\//.test(a.mimeType));
  if (!atts.length) return null;

  const info = await getDocInfo(accountId, leadId, atts); // classificação barata: pula o que não é documento
  const cf0 = (lead.customFields || {}) as Record<string, any>;
  const cache: Record<string, DocReview> = { ...((cf0._docReview as Record<string, DocReview>) || {}) };
  const context = participantsContext(cf0, lead.name);
  const novas: ReviewSummary['novas'] = [];
  for (const a of atts) {
    if (cache[a.id] || info[a.id] === null || info[a.id] === undefined) continue;
    const r = await reviewAttachment(accountId, a, context);
    if (!r) continue;
    cache[a.id] = r;
    novas.push({ arquivo: a.fileName || a.id, r });
  }
  if (novas.length) {
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _docReview: cache } } });
  }

  // Situação atual: a leitura mais recente de cada tipo+titular (reenviou corrigido → o problema antigo some); RG/CNH somam os lados.
  const ordered = atts.map((a) => cache[a.id]).filter((r): r is DocReview => !!r && r.resultado !== 'NAO_DOCUMENTO');
  const latest = new Map<string, DocReview>();
  const lados = new Map<string, Set<string>>();
  const isId = (r: DocReview) => /^(RG|CNH)\b/.test(r.tipo);
  for (const r of ordered) {
    // RG/CNH sem nome legível (ex.: foto só do verso): não vira documento à parte — o lado conta pro RG/CNH do titular que já chegou.
    if (isId(r) && !r.titular) {
      const donos = [...latest.entries()].filter(([, v]) => v.tipo === r.tipo);
      if (donos.length && r.lado && r.resultado === 'OK') {
        for (const [k] of donos) {
          const s = lados.get(k) || new Set<string>();
          if (r.lado === 'ambos') { s.add('frente'); s.add('verso'); } else s.add(r.lado);
          lados.set(k, s);
        }
      }
      continue;
    }
    latest.set(docKey(r), r);
    if (/^(RG|CNH)\b/.test(r.tipo) && r.lado && r.resultado === 'OK') {
      const s = lados.get(docKey(r)) || new Set<string>();
      if (r.lado === 'ambos') { s.add('frente'); s.add('verso'); } else s.add(r.lado);
      lados.set(docKey(r), s);
    }
  }
  const problemas: ReviewSummary['problemas'] = [];
  const ok: string[] = [];
  for (const [k, r] of latest) {
    const texto = r.resultado === 'PROBLEMA' ? [...r.problemas] : [];
    if (/^(RG|CNH)\b/.test(r.tipo) && r.resultado === 'OK') {
      const s = lados.get(k) || new Set<string>();
      if (!(s.has('frente') && s.has('verso'))) texto.push(`só chegou ${s.has('frente') ? 'a frente' : s.has('verso') ? 'o verso' : 'um lado'} — manda ${s.has('frente') ? 'também o verso' : s.has('verso') ? 'também a frente' : 'frente e verso'}`);
    }
    if (texto.length) problemas.push({ doc: docLabel(r), texto });
    else ok.push(docLabel(r));
  }
  return { novas, problemas, ok };
}

/** Mensagem ao cliente com o que precisa ser corrigido (curta, educada, sem jargão). */
export function buildDocProblemsMessage(s: ReviewSummary): string {
  const linhas = s.problemas.map((p) => `⚠️ *${p.doc}* — ${p.texto.join('; ')}`);
  const oks = s.ok.length ? `\n\nJá conferi e estão certinhos ✅: ${s.ok.join(', ')}.` : '';
  return `Conferi os documentos que você mandou e preciso de um ajuste:\n\n${linhas.join('\n')}${oks}\n\nAssim que você reenviar, eu confiro de novo!`;
}

/** Bloco pro prompt da IA de conversa: o que cada documento recebido tem de bom/ruim (só leitura). Vazio se nada foi conferido. */
export async function aiDocsContext(leadId: string): Promise<string> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const rev = (cf._docReview || {}) as Record<string, DocReview>;
  const items = Object.values(rev).filter((r) => r.resultado !== 'NAO_DOCUMENTO');
  if (!items.length) return '';
  const latest = new Map<string, DocReview>();
  for (const r of items) latest.set(docKey(r), r);
  const linhas = [...latest.values()].map((r) => `- ${docLabel(r)}: ${r.resultado === 'OK' ? 'OK' : `PROBLEMA — ${r.problemas.join('; ')}`}${r.emissao ? ` (emissão ${r.emissao})` : ''}${r.lado ? ` [${r.lado}]` : ''}`);
  const falta = cf._docsFaltando ? `\nAinda falta (lista do banco): ${cf._docsFaltando}` : '';
  return `DOCUMENTOS DESTE CLIENTE (a IA LEU os arquivos que ele mandou — frente/verso, legibilidade, validade e titular):\n${linhas.join('\n')}${falta}`;
}

export const DOCS_REVIEW_RULES = `DOCUMENTOS — quando o bloco "DOCUMENTOS DESTE CLIENTE" aparecer abaixo, ele traz o que a IA leu dos arquivos que o cliente mandou. Use SÓ ele pra dizer se um documento está certo ou o que falta corrigir ("tá certo?", "faltou alguma coisa?"): nunca diga que um documento está OK se ele não está no bloco como OK, e nunca invente defeito. Se o cliente perguntar de um documento que NÃO está no bloco, diga que ainda não chegou/ainda está sendo conferido. Quando houver PROBLEMA, peça só o ajuste que o bloco descreve, em 1 frase curta. A conferência automática já avisa o cliente do que precisa corrigir quando ele manda os arquivos — não repita a mesma cobrança se ela já está na conversa.`;

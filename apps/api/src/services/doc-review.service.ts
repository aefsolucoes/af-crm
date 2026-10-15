import { PrismaClient } from '@prisma/client';
import { downloadDriveFileForVision } from './google.service';
import { getDocInfo, isStickerAttachment } from './received-docs.service';
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
  resultado: 'OK' | 'PROBLEMA' | 'NAO_DOCUMENTO' | 'DUVIDA';
  problemas: string[];
  lado: 'frente' | 'verso' | 'ambos' | '';
  emissao: string;
  observacao: string;
  /** DUVIDA: a pergunta pra equipe (a IA não tem segurança se o documento serve). */
  duvida?: string;
  /** Depois da resposta da equipe: regra geral que vale pra outros clientes (vazio = foi só desse caso). */
  regra?: string;
}

const SYSTEM = `Você é a conferente de documentos de um correspondente bancário (crédito com garantia de imóvel e financiamento habitacional). Olhe o ARQUIVO que o cliente mandou pelo WhatsApp e diga se ele está CORRETO para seguir ao banco. Responda SOMENTE com JSON:
{"tipo":"<nome curto: RG, CNH, CPF, CERTIDAO DE NASCIMENTO, CERTIDAO DE CASAMENTO, AUTORIZACAO SCR BACEN, COMPROVANTE DE RESIDENCIA, CONTRACHEQUE, EXTRATO BANCARIO, IMPOSTO DE RENDA, CERTIDAO DE ONUS REAIS, MATRICULA, CND IPTU, ESCRITURA ou outro nome curto>","titular":"<nome completo como está no documento, ou vazio>","resultado":"OK|PROBLEMA|NAO_DOCUMENTO|DUVIDA","problemas":["<frase dirigida AO CLIENTE (você), educada e curta, dizendo o que está errado e o que fazer — ex.: \"Manda uma foto mais nítida, a data não dá pra ler.\" Nunca escreva \"peça ao cliente\">"],"lado":"<só RG/CNH: frente, verso ou ambos (o que aparece nesta imagem); senão vazio>","emissao":"<AAAA-MM-DD da emissão/competência se aparecer, senão vazio>","observacao":"<detalhe INTERNO útil pra equipe (ex.: constam ônus ou alienação fiduciária na matrícula, validade do documento); senão vazio>","duvida":"<SÓ se resultado DUVIDA: a pergunta objetiva pra equipe, 1 a 2 frases, dizendo o que você viu e o que precisa saber; senão vazio>","regra":"<SÓ quando a equipe já respondeu: a regra geral, em 1 frase, que vale pra OUTROS clientes; se foi só sobre este caso, vazio>"}

Critérios — aponte PROBLEMA só quando for real; documento legível e correto é OK, não invente defeito:
- Legibilidade: foto desfocada, escura, com reflexo, cortada ou com dado importante ilegível → PROBLEMA ("manda uma foto mais nítida/inteira").
- RG/CNH: NÃO dê problema por mostrar só um lado (o cliente pode mandar frente e verso em fotos separadas): só preencha "lado". CNH digital (print do app) conta como "ambos". CNH vencida → PROBLEMA.
- Atualização (use a data de hoje): comprovante de residência com mais de 90 dias; certidão de ônus reais ou matrícula com mais de 30 dias; CND de IPTU vencida; contracheque que não seja dos últimos 3 meses → PROBLEMA, dizendo o prazo exigido. A data que vale na matrícula/certidão é a de EMISSÃO da certidão (carimbo/linha "certidão emitida em…", em geral no topo ou no fim), NÃO as datas dos registros e averbações dentro dela (um registro de 2011 não torna a certidão antiga). Se a data de emissão/validade não aparecer mas o documento parece inteiro e legível, é OK: anote "sem data de emissão visível" na observação.
- Titular: compare com os participantes do card. RG/CNH/CPF/certidão/documento de renda em nome de OUTRA pessoa → PROBLEMA ("está no nome de X; o participante é Y"). Comprovante de residência em nome de parente/outra pessoa NÃO é problema por si só; documentos do imóvel seguem o proprietário.
- Documento de várias páginas (matrícula, ônus, escritura, IR) que parece parcial: NÃO marque PROBLEMA; escreva em "observacao" que parece parcial.
- Se não for documento (selfie, figurinha, print de conversa, foto qualquer): resultado NAO_DOCUMENTO.
- AUTORIZACAO SCR BACEN (formulário "Autorização SCR Bacen" que a Creditas pede): só vale ASSINADA. Assinada = carimbo/assinatura eletrônica do gov.br ("Assinado digitalmente/de forma digital por NOME … gov.br", com CPF) ou assinatura de próprio punho no campo de assinatura; "titular" = a PESSOA QUE ASSINOU/preencheu (nome do participante). Formulário em branco, sem assinatura, ou sem o nome/CPF preenchido → PROBLEMA (diga ao cliente: "assine pelo gov.br e mande o PDF assinado"). Assinatura legível e nome batendo com o participante → OK.
- DÚVIDA: se você NÃO tem segurança pra dizer que o documento serve ou não (documento raro ou que você não reconhece; nome com grafia diferente que pode ou não ser a mesma pessoa; suspeita de montagem ou adulteração; documento que contradiz o card; regra do banco que você não conhece), NÃO chute: resultado DUVIDA e escreva a pergunta pra equipe em "duvida". Não use DUVIDA por preguiça — documento legível e claro é OK ou PROBLEMA. A equipe vai abrir ESTE arquivo e responder; as respostas anteriores aparecem em "REGRAS APRENDIDAS COM A EQUIPE" (siga-as antes de perguntar de novo).`;

type Att = { id: string; driveFileId: string | null; data?: Uint8Array | null; mimeType: string; fileName?: string; createdAt?: Date };

function cleanText(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Lê UM arquivo. undefined = não deu pra ler (tipo, tamanho, erro de rede/API) — tenta de novo na próxima conferência. */
export async function reviewAttachment(accountId: string, att: Att, context: string, opts: { learned?: string; teamAnswer?: { pergunta: string; resposta: string } } = {}): Promise<DocReview | undefined> {
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
      system: opts.learned ? `${SYSTEM}\n\nREGRAS APRENDIDAS COM A EQUIPE (respostas anteriores a dúvidas de documento — valem pra qualquer cliente):\n${opts.learned}` : SYSTEM,
      messages: [{ role: 'user', content: [{ type: isPdf ? 'document' : 'image', source }, { type: 'text', text: opts.teamAnswer
        ? `${context}\n\nVocê teve uma dúvida sobre ESTE arquivo e a EQUIPE já olhou e respondeu. Dúvida: ${opts.teamAnswer.pergunta}\nResposta da equipe: ${opts.teamAnswer.resposta}\nDecida agora: resultado OK (a equipe aceitou o documento) ou PROBLEMA (a equipe disse que não serve — em "problemas" escreva o que o cliente deve fazer). NÃO devolva DUVIDA. Preencha "regra" se a resposta vale pra outros clientes.`
        : context }] }],
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
    const resultado = j.resultado === 'OK' || j.resultado === 'PROBLEMA' || j.resultado === 'NAO_DOCUMENTO' || j.resultado === 'DUVIDA' ? j.resultado : null;
    if (!resultado) return undefined;
    const duvida = cleanText(j.duvida, 400);
    if (resultado === 'DUVIDA' && (opts.teamAnswer || !duvida)) return undefined; // com a resposta da equipe não pode voltar a duvidar; sem pergunta não dá pra levar pra equipe
    const lado = j.lado === 'frente' || j.lado === 'verso' || j.lado === 'ambos' ? j.lado : '';
    const problemas = (Array.isArray(j.problemas) ? j.problemas : []).map((p: unknown) => cleanText(p, 200)).filter(Boolean).slice(0, 4);
    return { tipo: cleanText(j.tipo, 50).toUpperCase(), titular: cleanText(j.titular, 80), resultado, problemas: resultado === 'PROBLEMA' ? problemas : [], lado, emissao: cleanText(j.emissao, 10), observacao: cleanText(j.observacao, 240), ...(resultado === 'DUVIDA' ? { duvida } : {}), ...(opts.teamAnswer && cleanText(j.regra, 300) ? { regra: cleanText(j.regra, 300) } : {}) };
  } catch { return undefined; }
}

function participantsContext(cf: Record<string, any>, leadName: string): string {
  const parts = [
    cf.participante_1 && `1) ${cf.participante_1}${cf.cpf_1 ? ` (CPF ${String(cf.cpf_1).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')})` : ''}`,
    cf.participante_2 && `2) ${cf.participante_2}${cf.cpf_2 ? ` (CPF ${String(cf.cpf_2).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')})` : ''}`,
  ].filter(Boolean).join('\n') || `1) ${leadName}`;
  return `${todayContextLine()}\nParticipantes do card:\n${parts}\n\nConfira este arquivo.`;
}

/** Regras que a equipe já ensinou respondendo dúvidas de documento (balão "Dúvidas da IA"): as mais recentes que a IA marcou como regra geral e que ninguém desfez. */
export async function learnedDocRules(accountId: string): Promise<string> {
  const rows = await prisma.aiTeamQuestion.findMany({
    where: { accountId, kind: 'DOC_QUESTION', status: 'ANSWERED', knowledgeTitle: { not: null } },
    orderBy: { answeredAt: 'desc' }, take: 25, select: { knowledgeTitle: true, question: true, answer: true },
  });
  return rows.map((r) => `- ${r.knowledgeTitle} (dúvida: ${cleanText(r.question, 200)} → equipe: ${cleanText(r.answer, 300)})`).join('\n');
}

/** A equipe respondeu a dúvida de um documento: a IA reconfere o MESMO arquivo com a resposta e grava o veredito no card (cache). Devolve o veredito (undefined = não deu pra reler). */
export async function resolveDocDoubt(accountId: string, leadId: string, attachmentId: string, pergunta: string, resposta: string): Promise<DocReview | undefined> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  const att = await prisma.messageAttachment.findFirst({ where: { id: attachmentId, leadId }, select: { id: true, driveFileId: true, data: true, mimeType: true, fileName: true, createdAt: true } });
  if (!lead || !att) return undefined;
  const cf0 = (lead.customFields || {}) as Record<string, any>;
  const r = await reviewAttachment(accountId, att, participantsContext(cf0, lead.name), { teamAnswer: { pergunta, resposta }, learned: await learnedDocRules(accountId).catch(() => '') });
  if (!r) return undefined;
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cache = { ...((((fresh?.customFields || {}) as any)._docReview as Record<string, DocReview>) || {}), [attachmentId]: r };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _docReview: cache, _docProblemSig: null } } });
  return r;
}

export interface ReviewSummary {
  /** Revisões novas desta rodada (pra nota no card). */
  novas: { arquivo: string; r: DocReview }[];
  /** Problemas que valem agora (a revisão MAIS RECENTE de cada tipo+titular; frente/verso de RG/CNH somados). */
  problemas: { doc: string; texto: string[] }[];
  /** Documentos em DÚVIDA (a IA levou a pergunta pra equipe, no balão): seguram o card até a equipe responder. */
  duvidas: { attachmentId: string; arquivo: string; doc: string; pergunta: string }[];
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
  })).filter((a) => !/^(audio|video)\//.test(a.mimeType) && !isStickerAttachment(a));
  if (!atts.length) return null;

  const info = await getDocInfo(accountId, leadId, atts); // classificação barata: pula o que não é documento
  const cf0 = (lead.customFields || {}) as Record<string, any>;
  const cache: Record<string, DocReview> = { ...((cf0._docReview as Record<string, DocReview>) || {}) };
  const context = participantsContext(cf0, lead.name);
  const learned = await learnedDocRules(accountId).catch(() => '');
  const novas: ReviewSummary['novas'] = [];
  for (const a of atts) {
    if (cache[a.id] || info[a.id] === null || info[a.id] === undefined) continue;
    const r = await reviewAttachment(accountId, a, context, { learned });
    if (!r) continue;
    cache[a.id] = r;
    novas.push({ arquivo: a.fileName || a.id, r });
    if (r.resultado === 'DUVIDA') {
      // Não chuta: leva o documento e a pergunta pra equipe (balão "Dúvidas da IA"); uma pergunta por arquivo.
      const { createDocQuestion } = require('./ai-team-question.service') as typeof import('./ai-team-question.service');
      await createDocQuestion({ accountId, leadId, attachmentId: a.id, fileName: a.fileName || 'documento', docType: r.tipo, question: r.duvida || 'Não tenho segurança se este documento serve.' }).catch((e) => console.error('[DocReview] não abriu a dúvida:', e?.message || e));
    }
  }
  if (novas.length) {
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _docReview: cache } } });
  }

  // Situação atual: a leitura mais recente de cada tipo+titular (reenviou corrigido → o problema antigo some); RG/CNH somam os lados.
  const ordered = atts.map((a) => cache[a.id]).filter((r): r is DocReview => !!r && r.resultado !== 'NAO_DOCUMENTO' && r.resultado !== 'DUVIDA');
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
  const duvidas = atts.filter((a) => cache[a.id]?.resultado === 'DUVIDA').map((a) => ({ attachmentId: a.id, arquivo: a.fileName || a.id, doc: cache[a.id].tipo || 'documento', pergunta: cache[a.id].duvida || '' }));
  return { novas, problemas, duvidas, ok };
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
  const linhas = [...latest.values()].map((r) => `- ${docLabel(r)}: ${r.resultado === 'OK' ? 'OK' : r.resultado === 'DUVIDA' ? 'EM ANÁLISE PELA EQUIPE (não diga que está certo nem errado; diga que a equipe está conferindo e retorna)' : `PROBLEMA — ${r.problemas.join('; ')}`}${r.emissao ? ` (emissão ${r.emissao})` : ''}${r.lado ? ` [${r.lado}]` : ''}`);
  const falta = cf._docsFaltando ? `\nAinda falta (lista do banco): ${cf._docsFaltando}` : '';
  return `DOCUMENTOS DESTE CLIENTE (a IA LEU os arquivos que ele mandou — frente/verso, legibilidade, validade e titular):\n${linhas.join('\n')}${falta}`;
}

export const DOCS_REVIEW_RULES = `DOCUMENTOS — quando o bloco "DOCUMENTOS DESTE CLIENTE" aparecer abaixo, ele traz o que a IA leu dos arquivos que o cliente mandou. Use SÓ ele pra dizer se um documento está certo ou o que falta corrigir ("tá certo?", "faltou alguma coisa?"): nunca diga que um documento está OK se ele não está no bloco como OK, e nunca invente defeito. Se o cliente perguntar de um documento que NÃO está no bloco, diga que ainda não chegou/ainda está sendo conferido. Quando houver PROBLEMA, peça só o ajuste que o bloco descreve, em 1 frase curta. A conferência automática já avisa o cliente do que precisa corrigir quando ele manda os arquivos — não repita a mesma cobrança se ela já está na conversa.`;

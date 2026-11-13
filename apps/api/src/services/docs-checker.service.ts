import { cachedSystem } from '../lib/anthropic-usage';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { nomeSocialNota } from '../lib/text';
import { fixedRule } from './fixed-rules.service';
import { getDocInfo, isStickerAttachment, isScreenshotAttachment, isDescritivoParcela, vendedoresDoImovel, mesmaPessoa } from './received-docs.service';
import { moveLeadToContracting } from './contracting.service';
import { sendOutboundWhatsApp } from './message.service';
import { logActivity } from './activity.service';
import { todayContextLine } from './ai-shared.service';
import { reviewReceivedDocs, buildDocProblemsMessage } from './doc-review.service';
import { marcarConferencia, desmarcarConferencia } from './docs-check-resume.service';


/* A IA confere se a documentação chegou completa (pedido do Fabio: a skill só
 * roda o crédito; documentação é da IA do CRM). Card em "Aguardando
 * Documentação" (IA ligada ou não): a cada DOCUMENTO que o cliente manda
 * (foto/arquivo — não roda de tempos em tempos, pra não gastar crédito),
 * espera ele parar de mandar arquivo, lê o que chegou (cache em customFields._docInfo, o
 * mesmo do organizador de pasta), compara com a lista de documentos certa
 * (Respostas Rápidas "Documentos ...") e, se estiver completo, leva o card pra
 * "Documentação Recebida" e avisa o cliente. Incompleto: não faz nada — a IA
 * de conversa continua atendendo normalmente. */

/** Fabio 15/10: cliente mandando documento → ESPERA 10 min sem arquivo novo (cada arquivo reinicia a contagem) pra ele mandar tudo; se não mandou tudo, confere o que chegou e COBRA o que falta.
 *  O horário da conferência fica gravado no card (`_docsCheckDue`) e um poller (processDocsChecks, 1 min) executa — o setTimeout antigo se perdia a cada deploy. */
/** Anotação que registra o OK do cliente pra A&F emitir a certidão (Fabio 15/10: sem campo — o CRM anota e lê). */
export const AUTORIZOU_EMISSAO = '🏛️ CLIENTE AUTORIZOU A EMISSÃO DA CERTIDÃO';
const CHECK_DELAY_MS = 5 * 60_000; // Fabio 15/10: 10 min → 5 min

/** Item que a conferência cobra quando o imóvel ainda tem financiamento (Fabio 30/10: além do print do saldo devedor, o banco pede o descritivo da parcela). */
export const ITEM_DESCRITIVO = 'Descritivo da parcela do financiamento — o PDF com as últimas prestações, que o próprio app do banco gera';

export const DOCS_COMPLETE_MESSAGE = 'Recebi toda a documentação, obrigada! Já vou seguir com a análise. Se o banco achar necessário, pode pedir algum documento a mais, aí te aviso por aqui.';

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// ─── Mesmo erro reenviado (Fabio 07/11) ─────────────────────────────────────────────────────────────────────────────────────────────
// "No caso de vir certidão de matrícula errada ou cortada ou algo assim, e o cliente mandar novamente, não solicitar novamente se vier com o mesmo erro" + "vou colocar um
// colaborador para conferir quando a documentação for para Documentação Recebida". A IA descreve o mesmo erro com outras palavras em cada arquivo, então a comparação é por
// FAMÍLIA do documento e CATEGORIA do erro, não pelo texto. Mesmo erro reenviado = não pede de novo, vira ressalva (`_docRessalvas`) e deixa de segurar o card.

const semAcento = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Família do documento: a certidão reenviada pode vir com outro rótulo (MATRÍCULA ↔ CERTIDÃO DE ÔNUS ↔ INTEIRO TEOR). RG/CNH ficam por pessoa. Pura. */
export function familiaDoc(doc: string): string {
  const n = semAcento(doc).toUpperCase();
  const titular = (/\(([^)]*)\)/.exec(n)?.[1] || '').replace(/[^A-Z ]/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
  const base = n.replace(/\([^)]*\)/g, ' ').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bMATRICULA\b|\bONUS\b|INTEIRO TEOR/.test(base)) return 'MATRICULA';
  if (/^ESCRITURA\b/.test(base)) return 'ESCRITURA';
  if (/IPTU|CADASTRO IMOBILIARIO|INSCRICAO IMOBILIARIA/.test(base)) return 'IPTU';
  if (/^(RG|CNH|CIN|CARTEIRA DE IDENTIDADE|DOCUMENTO DE IDENTIDADE|IDENTIDADE)\b/.test(base)) return `ID:${titular}`;
  return `${base.split(' ').slice(0, 2).join(' ')}${titular ? `:${titular}` : ''}`;
}

const CATEGORIAS_ERRO: [string, RegExp][] = [
  ['CORTADO', /cortad|incomplet|pela metade|falt(a|am|ou|aram|ando)\b[^.;]{0,50}\b(folha|pagina|parte|verso|frente|capa|lado|final|inicio|continuacao)|comeca e termina no meio|termina no meio|comeca no meio|folhas? (anterior|seguinte)|todas as (folhas|paginas)|so (a frente|o verso|um lado)|sem (o )?verso|sem a (frente|capa)|chegou so/],
  ['ILEGIVEL', /ilegivel|borrad|desfocad|escur|tremid|reflexo|baixa (qualidade|resolucao)|nao (da|consigo|deu) (pra |para )?(ler|enxergar)|sem nitidez|pouco nitid/],
  ['ANTIGO', /antig|desatualizad|vencid|validade|emitid[ao] ha mais|mais de \d+ dias|ultimos \d+ dias|mais recente|atualizad/],
  ['OUTRA_PESSOA', /nome d[eao] outr|outra pessoa|nao e (do|da) (cliente|participante|titular)|titular diferente|nao e participante/],
  ['OUTRO_IMOVEL', /outro imovel|imovel diferente|endereco diferente|matricula diferente|numero diferente/],
  ['DOC_ERRADO', /nao e (a|o|uma|um) (certidao|matricula|documento|iptu|escritura)|documento errado|em vez d|no lugar d|outro documento/],
  ['FORMATO', /\bpdf\b|print|captura de tela|foto da tela/],
];

/** Categorias do erro pelas palavras (sem categoria = o próprio texto normalizado, aí só o texto igual conta como mesmo erro). Pura. */
export function categoriasDoErro(textos: string[]): string[] {
  const t = semAcento(textos.join(' ')).toLowerCase().replace(/\s+/g, ' ').trim();
  const cats = CATEGORIAS_ERRO.filter(([, rx]) => rx.test(t)).map(([c]) => c);
  return cats.length ? cats : [t.slice(0, 120)];
}

/** Chave de um problema já dito ao cliente (`_docProblemsTold`): "DOC:texto1/texto2" sem acento, em maiúsculas. */
export const chaveProblema = (p: { doc: string; texto: string[] }) => semAcento(`${p.doc}:${p.texto.join('/')}`).toUpperCase().replace(/\s+/g, ' ');

/** Achado que ENCERRA a conferência: o imóvel não serve de garantia em nenhum banco (hoje: cessão de direitos — Fabio 28/10 e 12/11). Pura. */
export function problemaSemGarantia(problemas: { doc: string; texto: string[] }[]): { doc: string; texto: string[] } | null {
  return problemas.find((p) => /^cessao de direito/i.test(semAcento(p.doc).trim()) || p.texto.some((t) => /nao serve de garantia em nenhum banco/i.test(semAcento(t)))) || null;
}
type Duvida = { attachmentId: string; arquivo: string; doc: string; pergunta: string };
/** Quem segura a conferência: pura. `perguntas` = as DOC_QUESTION do card (uma por anexo). Aberta → segura; fechada (qualquer status) → ressalva; nenhuma → 'abrir' (nunca chegou ao balão);
 *  dono menor de idade (regra de todos os bancos) segura sempre. */
export function classificarDuvidas(duvidas: Duvida[], perguntas: { attachmentId: string | null; status: string }[], leituras: Record<string, any>): { seguram: Duvida[]; ressalvas: (Duvida & { fechada: string })[]; abrir: Duvida[] } {
  const out = { seguram: [] as Duvida[], ressalvas: [] as (Duvida & { fechada: string })[], abrir: [] as Duvida[] };
  for (const d of duvidas) {
    const doAnexo = perguntas.filter((q) => q.attachmentId === d.attachmentId);
    if (leituras?.[d.attachmentId]?.donoMenor) out.seguram.push(d);
    else if (!doAnexo.length) out.abrir.push(d);
    else if (doAnexo.some((q) => q.status === 'OPEN')) out.seguram.push(d);
    else out.ressalvas.push({ ...d, fechada: doAnexo.some((q) => q.status === 'ANSWERED') ? 'ANSWERED' : 'DISMISSED' });
  }
  return out;
}

/** Separa as dúvidas que ainda estão com a equipe (seguram) das que foram fechadas sem resposta (ressalva); a que nunca chegou ao balão é aberta agora e segura. */
async function separarDuvidas(accountId: string, leadId: string, duvidas: Duvida[], leituras: Record<string, any>, io: Io): Promise<{ seguram: Duvida[]; ressalvas: (Duvida & { fechada: string })[] }> {
  const perguntas = await prisma.aiTeamQuestion.findMany({ where: { accountId, leadId, kind: 'DOC_QUESTION', attachmentId: { in: duvidas.map((d) => d.attachmentId) } }, select: { attachmentId: true, status: true } });
  const c = classificarDuvidas(duvidas, perguntas, leituras);
  const { createDocQuestion } = require('./ai-team-question.service') as typeof import('./ai-team-question.service');
  for (const d of c.abrir) {
    await createDocQuestion({ accountId, leadId, attachmentId: d.attachmentId, fileName: d.arquivo || 'documento', docType: d.doc, question: d.pergunta || 'Não tenho segurança se este documento serve.', io: io as any }).catch((e: any) => console.error('[Docs] não abriu a dúvida:', e?.message || e));
  }
  return { seguram: [...c.seguram, ...c.abrir], ressalvas: c.ressalvas };
}

/** Algum dos rótulos é matrícula/certidão de ônus do imóvel? Pura. */
export const temMatricula = (docs: string[]) => docs.some((d) => /^(MATRICULA|CERTIDAO DE ONUS)/.test(semAcento(d).toUpperCase().trim()));
const TEXTO_CESSAO = 'Obrigado pelos documentos! 😊 Pelo que vi, esse imóvel é de cessão de direitos, sem matrícula registrada em cartório, e assim ele não serve de garantia em nenhum banco. Você tem outro imóvel com certidão de matrícula pra colocar em garantia?';

export type DocRessalva = { doc: string; fam: string; cats: string[]; texto: string; at: string };

/** Problemas atuais que são o MESMO erro de um já dito e que o cliente REENVIOU (arquivo da mesma família lido nesta rodada, depois do aviso). Pura.
 *  `reenviados`: rótulos (TIPO (Titular)) dos arquivos lidos agora com problema e a hora em que chegaram; `toldAt`: quando cada chave foi dita (chave antiga sem hora = dita antes). */
export function mesmoErroReenviado(
  problemas: { doc: string; texto: string[] }[],
  reenviados: { doc: string; at: Date }[],
  ditos: string[],
  toldAt: Record<string, string> = {},
): { doc: string; texto: string[]; cats: string[] }[] {
  const out: { doc: string; texto: string[]; cats: string[] }[] = [];
  for (const p of problemas) {
    const fam = familiaDoc(p.doc);
    const cats = categoriasDoErro(p.texto);
    const novosDaFamilia = reenviados.filter((r) => familiaDoc(r.doc) === fam);
    if (!novosDaFamilia.length) continue; // o cliente não reenviou nada desta família nesta rodada: segue como hoje
    const mesmo = ditos.some((k) => {
      const i = k.indexOf(':');
      if (i < 0 || familiaDoc(k.slice(0, i)) !== fam) return false;
      const quando = toldAt[k] ? new Date(toldAt[k]).getTime() : 0;
      if (quando && !novosDaFamilia.some((r) => r.at.getTime() > quando)) return false; // o arquivo novo chegou ANTES do aviso: não é reenvio
      const catsDito = categoriasDoErro([k.slice(i + 1)]);
      return catsDito.some((c) => cats.includes(c));
    });
    if (mesmo) out.push({ ...p, cats });
  }
  return out;
}

/** O problema já virou ressalva (mesmo erro reenviado antes): não segura o card nem é pedido de novo. Pura. */
export function cobertoPorRessalva(p: { doc: string; texto: string[] }, ressalvas: DocRessalva[]): boolean {
  if (!ressalvas.length) return false;
  const fam = familiaDoc(p.doc);
  const cats = categoriasDoErro(p.texto);
  return ressalvas.some((r) => r.fam === fam && r.cats.some((c) => cats.includes(c)));
}

/** Etapas em que a conferência roda: Aguardando Documentação e, pra quem PEDIU a CAIXA, a Pré-Análise (Fabio 01/11: "O CADASTRO NA CAIXA DEVE OCORRER EM PRÉ-ANÁLISE AINDA" —
 *  o card volta pra lá e a documentação da CAIXA é conferida antes da análise dela; caixa-screening.entrarRotaCaixa). */
export function etapaConfere(stageName: string, cf: Record<string, any>): boolean {
  const n = norm(stageName);
  return n.includes('aguardando documentacao') || /^analise\s+caixa/.test(n) || (!!cf?._caixaRota && /pre.?analise/.test(n)); // Análise CAIXA: etapa própria (Fabio 11/11)
}

type Io = Parameters<typeof moveLeadToContracting>[2];

/** "Se o menor estiver na certidão de ônus, o banco não aceita prosseguir — isso é uma regra para todos os bancos" (Fabio 12/11). A leitura do documento do imóvel
 *  marca `donoMenor` e devolve DÚVIDA (a pergunta vai pro balão da equipe e a conferência para); aqui a equipe ganha a anotação e o push, uma vez por nome.
 *  Nada é dito ao cliente. */
async function avisarDonoMenor(accountId: string, leadId: string, leadName: string): Promise<void> {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (fresh?.customFields || {}) as Record<string, any>;
  const nomes = [...new Set(Object.values((cf._docReview || {}) as Record<string, any>).map((r: any) => String(r?.donoMenor || '').trim()).filter(Boolean))];
  const ja: string[] = Array.isArray(cf._donoMenorAvisado) ? cf._donoMenorAvisado : [];
  const novos = nomes.filter((n) => !ja.includes(n));
  if (!novos.length) return;
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || ${JSON.stringify({ _donoMenorAvisado: [...ja, ...novos] })}::jsonb WHERE id = ${leadId}`;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🚫 Proprietário MENOR de idade no documento do imóvel: ${novos.join('; ')}. Nenhum banco segue com menor entre os donos do imóvel (regra do Fabio, 12/11). A conferência parou e a dúvida está com a equipe; nada foi dito ao cliente.` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `🚫 ${leadName}: dono do imóvel menor de idade`, body: `${novos.join('; ')} — nenhum banco segue com menor entre os donos.`.slice(0, 160), leadId }).catch(() => {});
}

/** Só a documentação do COMPRADOR (lista enxuta da CAIXA): pediu a CAIXA (Fabio 01/11, HE e FH) ou Financiamento Habitacional que optou pela CAIXA/BRB ou ainda sem banco escolhido (Fabio 29/10). */
export function soDocsDoComprador(cf: Record<string, any>, departmentName: string | null | undefined, stageName?: string | null): boolean {
  return naRotaCaixa(cf, stageName) || (/habitacional/i.test(departmentName || '') && (!!cf?._optouCaixa?.banco || !cf?._fhChosen));
}

/** Rota da CAIXA pra conferência: o cliente pediu a CAIXA (`_caixaRota`) OU o card está na etapa "Análise CAIXA" — a equipe também põe o card lá à mão, sem a marca
 *  (Fabio 11/11: cadastro sozinho com a documentação completa). Sem isso, o Home Equity colocado na etapa era conferido pela lista comum (matrícula, IPTU…) e, completo,
 *  ia pra contratação em vez de seguir pro cadastro da CAIXA. */
export function naRotaCaixa(cf: Record<string, any> | null | undefined, stageName?: string | null): boolean {
  return !!cf?._caixaRota || /^analise\s+caixa/.test(norm(stageName || ''));
}

/** Renda dispensada neste card (nenhum banco pediu renda; fora da lista do comprador): problema/dúvida em documento de RENDA não segura o card nem gera cobrança (Fabio 20/10, caso Luiz). Tira da lista. */
export async function filtrarRendaDispensada(leadId: string, fhSoComprador: boolean, review: { problemas: { doc: string }[]; duvidas: { doc: string }[] }): Promise<void> {
  const { bancosEmJogo } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const jogo = await bancosEmJogo(prisma, leadId).catch(() => null);
  if (jogo && !jogo.rendaNecessaria && !fhSoComprador) {
    const RENDA_RX = /EXTRATO BANCARIO|CONTRACHEQUE|HOLERITE|IMPOSTO DE RENDA|DECLARACAO DE RENDA|COMPROVANTE DE RENDA|PRO.?LABORE|DECORE/;
    review.problemas = review.problemas.filter((p) => !RENDA_RX.test(String(p.doc).toUpperCase()));
    review.duvidas = review.duvidas.filter((d) => !RENDA_RX.test(String(d.doc).toUpperCase()));
  }
}

/** Dúvida de documento fechada sem resposta (descartada/assumida — Fabio 12/11): agenda a mesma conferência de quando chega documento, mas sem apagar o "te mando depois"
 *  (`_docsLater`: o cliente não mandou nada) e gravando só a chave. Nas etapas que conferem, a conferência normal; depois delas, a releitura silenciosa (sem mensagem ao cliente). */
export async function reconferirSemADuvida(leadId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, stage: { select: { name: true } } } });
  if (!lead) return;
  const cf0 = (lead.customFields || {}) as Record<string, any>;
  const quando = JSON.stringify(new Date(Date.now() + CHECK_DELAY_MS).toISOString());
  if (etapaConfere(lead.stage.name, cf0)) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsCheckDue}', ${quando}::jsonb, true) WHERE id = ${leadId}`;
  else if (cf0._docsFaltando || cf0._docProblemsTold) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsRelerDue}', ${quando}::jsonb, true) WHERE id = ${leadId}`;
}

export async function scheduleDocsCheck(accountId: string, leadId: string, io: Io): Promise<void> {
  // Roda com a IA ligada OU desligada (Fabio 29/09: o Ângelo mandou os
  // documentos depois que ele respondeu pela Inbox — a IA estava desligada,
  // ninguém conferiu, o card não andou e a pasta no Drive não foi criada).
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, stage: { select: { name: true } } } });
  if (!lead) return;
  const cf0 = (lead.customFields || {}) as Record<string, any>;
  if (!etapaConfere(lead.stage.name, cf0)) {
    // Card que JÁ PASSOU da Aguardando Documentação com pendência anotada (Fabio 05/11, Milena: foi pra Documentação Recebida com "matrícula incompleta", ela mandou
    // as folhas 3 vezes, ninguém leu e a IA pediu de novo): documento novo → a mesma conferência do botão "Conferir documentos" (sem mensagem ao cliente, sem mover
    // o card), 10 min depois do último arquivo — atualiza o "o que falta" que a IA lê.
    if (cf0._docsFaltando || cf0._docProblemsTold) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsRelerDue}', ${JSON.stringify(new Date(Date.now() + CHECK_DELAY_MS).toISOString())}::jsonb, true) WHERE id = ${leadId}`;
    return;
  }
  // Só as chaves, por SQL (customfields-write-race): regravar o objeto inteiro apagava marcas gravadas no meio (ex.: `_iaEsperaConferencia` da IA, Fabio 13/11).
  // `_docsLater` sai: mandou documento, a cobrança do "te mando depois" não é mais necessária.
  const due = JSON.stringify(new Date(Date.now() + CHECK_DELAY_MS).toISOString());
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsCheckDue}', ${due}::jsonb, true) - '_docsLater' WHERE id = ${leadId}`;
}

/** Fim de uma conferência (Fabio 13/11, Vicente: a IA calou porque "o cliente ainda está mandando documento — a conferência avisa depois"; a conferência rodou, não falou
 *  nada, e a resposta dele à pergunta da IA ficou no vácuo). Grava `_docsConferidoAt` (os arquivos até aqui não calam mais a IA) e, se a IA tinha calado esperando a
 *  conferência (`_iaEsperaConferencia`) e a conferência NÃO falou com o cliente, a IA responde agora o que ele mandou — se ele ainda for o último a falar. */
export async function depoisDaConferencia(accountId: string, leadId: string, falou: boolean, io: Io, inicio?: string): Promise<void> {
  // Corte = INÍCIO da conferência: arquivo que chegou enquanto ela rodava (a leitura leva minutos) ainda cala a IA — a próxima conferência é que confere ele.
  if (inicio) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsConferidoAt}', to_jsonb(${inicio}::text), true) WHERE id = ${leadId}`;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const espera = String(((l?.customFields || {}) as Record<string, any>)._iaEsperaConferencia || '');
  if (!espera) return;
  const pegou = await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_iaEsperaConferencia' WHERE id = ${leadId} AND "customFields"->>'_iaEsperaConferencia' = ${espera}`;
  if (!pegou) return;
  // Não confia só no "falou": a conferência às vezes devolve true sem mandar nada novo (ex.: a pergunta do dono já tinha sido feita). Quem decide é a conversa — se o cliente
  // ainda é o último a falar, a IA responde (responderClienteSeUltimo confere).
  await (require('./whatsapp.service') as typeof import('./whatsapp.service')).responderClienteSeUltimo(accountId, leadId, io, `a conferência de documentos terminou${falou ? '' : ' sem falar com o cliente'}`);
}

/** Poller (1 min, junto com a análise automática): confere os cards cujo prazo de 10 min sem documento novo venceu. */
export async function processDocsChecks(accountId: string, io: Io): Promise<void> {
  const due = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND ("customFields"->>'_docsCheckDue') IS NOT NULL AND ("customFields"->>'_docsCheckDue')::timestamptz <= now() LIMIT 10`;
  for (const { id } of due) {
    // Só a chave (customfields-write-race) — e só quem tirou a marca confere (dois servidores durante um deploy).
    const pegou = await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_docsCheckDue' WHERE id = ${id} AND ("customFields"->>'_docsCheckDue') IS NOT NULL`;
    if (!pegou) continue;
    // Marca de "conferindo" (Fabio 12/11): reinício do servidor no meio → a conferência roda de novo ao subir (docs-check-resume.service).
    const inicio = new Date().toISOString();
    const marca = await marcarConferencia(id, 'auto');
    const falou = await checkDocsComplete(accountId, id, io).catch((err) => { console.error(`[Docs] Falha ao conferir documentação do lead ${id}:`, err?.message || err); return false; });
    await desmarcarConferencia(id, 'auto', marca);
    await depoisDaConferencia(accountId, id, falou, io, inicio).catch((e: any) => console.error('[Docs] depois da conferência:', e?.message || e));
  }
  // IA calada esperando a conferência que não veio (sem conferência agendada há 20 min — ex.: a etapa não confere, a conferência caiu): a IA responde o que ficou parado.
  // Marca de mais de 6 h: só sai (responder agora uma conversa de horas atrás seria fora de hora).
  const esperando = await prisma.$queryRaw<{ id: string; velha: boolean }[]>`SELECT id, ("customFields"->>'_iaEsperaConferencia')::timestamptz < now() - interval '6 hours' AS velha FROM "Lead"
    WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
    AND ("customFields"->>'_iaEsperaConferencia') IS NOT NULL AND ("customFields"->>'_iaEsperaConferencia')::timestamptz <= now() - interval '20 minutes'
    AND ("customFields"->>'_docsCheckDue') IS NULL LIMIT 5`;
  for (const { id, velha } of esperando) {
    if (velha) { await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_iaEsperaConferencia' WHERE id = ${id}`.catch(() => {}); continue; }
    await depoisDaConferencia(accountId, id, false, io).catch((e: any) => console.error('[Docs] IA esperando a conferência:', e?.message || e));
  }
  // Documento novo depois da Aguardando Documentação com pendência anotada (05/11): conferência silenciosa, igual à do botão.
  const reler = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND ("customFields"->>'_docsRelerDue') IS NOT NULL AND ("customFields"->>'_docsRelerDue')::timestamptz <= now() LIMIT 5`;
  for (const { id } of reler) {
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_docsRelerDue' WHERE id = ${id}`;
    await conferirDocumentosAgora(accountId, id, 'CRM — documento novo depois da Aguardando Documentação', io).catch((err) => console.error(`[Docs] releitura ${id}:`, err?.message || err));
  }
}

// ─── "Te mando mais tarde / amanhã": a IA cobra ANTES da janela de 24 h fechar (Fabio 15/10, Francisco Nascimento) ───────────────────────────────
// Card em "Aguardando Documentação" (crédito aprovado) e o cliente avisa que manda depois: o card FICA na etapa (nada de Follow Up/Venda Futura) e o CRM agenda uma cobrança curta
// ("conseguiu separar a documentação?") pro horário que ele prometeu, mas nunca depois de (fim da janela de 24 h − 90 min) — fora da janela só com template, e a conversa abre de novo se ele responder.

const WINDOW_MS = 23 * 3_600_000;
const BRT = -3 * 3_600_000; // Brasília = UTC−3 (sem horário de verão)
export const TIME_RX = /((?<![a-zà-ú])[àa]s \d{1,2}(?:\s*(?:h|hs|hrs?|horas?)\b|:\d{2}\b|(?=\s*(?:$|[.,!?)]|pra |para |eu |e |que |da (?:tarde|manh[ãa]|noite)|hoje|amanh)))|\b\d{1,2}\s?(?:h|hs|hrs|horas)\b|\b\d{1,2}:\d{2}\b|(?<!bo)[àa] tarde|\bdia \d{1,2}\b|\b\d{1,2}\/\d{1,2}\b|fim d[oa] m[êe]s|final d[oa] m[êe]s|amanh[ãa]|mais tarde|\bdepois\b|hoje (à|a) noite|(?<!bo)[àa] noite|daqui (a )?(pouco|uns?|\d+)|logo mais|\bsegunda\b|\bter[çc]a\b|\bquarta\b|\bquinta\b|\bsexta\b|s[áa]bado|domingo|semana que vem|fim de semana|quando (chegar|sair|puder|conseguir|tiver)|assim que (puder|conseguir|chegar|sair|tiver)|estou no trabalho|n[ãa]o (tenho como|consigo|posso) (enviar|mandar|encaminhar)( agora)?|agora n[ãa]o|depois do (trabalho|expediente)|quando eu (chegar|sair|puder))/i;
const SEND_RX = /(mand|envi|encaminh|pass(o|ar)|trag|junt|separ|entreg|forne|te dou|consigo|tir(o|ar)|escane|fotograf)/i;
const NEGATIVE_RX = /(n[ãa]o (tenho|quero|vou) (mais )?(interesse|seguir|continuar)|desist|cancel)/i;

/** Quando o cliente prometeu mandar, em horário de Brasília → Date (UTC). */
export function promisedAt(text: string, now: Date): Date {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const local = new Date(now.getTime() + BRT); // "relógio de parede" de Brasília lido com getUTC*
  // Horário dito pelo cliente (Fabio 04/11, Milena: "me manda msg às 16 pra eu me lembrar" — a IA respondeu "te chamo às 16h" e ninguém chamou):
  // vale no dia combinado; sem dia, hoje (ou amanhã, se a hora já passou). "às 2" sem "da manhã" = 14h.
  const hm = /\bas (\d{1,2})(?::(\d{2}))?(?:\s*(?:h|hs|hrs?|horas?)\b|(?=\s*(?:$|[.,!?)]|pra |para |eu |e |que |da (?:tarde|manha|noite)|hoje|amanh)))|\b(\d{1,2})(?::(\d{2}))?\s?(?:h|hs|hrs|horas)\b|\b(\d{1,2}):(\d{2})\b/.exec(t);
  // "daqui a 2h", "em 3 horas": é prazo, não horário.
  const dur = /\b(?:daqui|em|dentro de)\s*(?:a\s*|umas?\s*|uns\s*)?(\d{1,2})\s?(?:h|hs|hrs|horas)\b/.exec(t);
  let hora: number | null = null, minuto = 0;
  if (hm && !dur) {
    let h = Number(hm[1] ?? hm[3] ?? hm[5]);
    minuto = Number(hm[2] ?? hm[4] ?? hm[6] ?? 0) || 0;
    if (/da (tarde|noite)/.test(t) && h < 12) h += 12;
    else if (h >= 1 && h <= 6 && !/da manha|madrugada/.test(t)) h += 12;
    if (h >= 0 && h <= 23 && minuto < 60) hora = h;
  }
  const at = (days: number, hour: number) => { const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hora ?? hour, hora === null ? 0 : minuto, 0)); return new Date(d.getTime() - BRT); };
  const wd = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'].findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
  // Data dita pelo cliente (Fabio 28/10: o CRM pergunta o prazo e espera até essa data): "dia 5", "05/11", "fim do mês".
  const dm = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  if (dm) { const d = new Date(Date.UTC(local.getUTCFullYear(), Number(dm[2]) - 1, Number(dm[1]), 11) - BRT); return d.getTime() > now.getTime() ? d : new Date(Date.UTC(local.getUTCFullYear() + 1, Number(dm[2]) - 1, Number(dm[1]), 11) - BRT); }
  const dia = /\bdia (\d{1,2})\b/.exec(t);
  if (dia) { const n = Number(dia[1]); const mes = n > local.getUTCDate() ? local.getUTCMonth() : local.getUTCMonth() + 1; return new Date(Date.UTC(local.getUTCFullYear(), mes, n, 11) - BRT); }
  if (/(fim|final) d[oa] mes/.test(t)) return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0, 11) - BRT);
  if (/depois de amanha/.test(t)) return at(2, 11);
  if (/amanha/.test(t)) return at(1, 11);
  if (wd >= 0) { const diff = ((wd - local.getUTCDay()) + 7) % 7 || 7; return at(diff, 11); }
  if (/semana que vem|proxima semana/.test(t)) return at(5, 11);
  if (dur && Number(dur[1]) <= 12) return new Date(now.getTime() + Number(dur[1]) * 3_600_000);
  if (/hoje a noite|(?<!bo)a noite/.test(t)) return at(local.getUTCHours() >= 18 ? 1 : 0, local.getUTCHours() >= 18 ? 11 : 19);
  if (hora !== null) { const hoje = at(0, hora); return hoje.getTime() > now.getTime() ? hoje : at(1, hora); }
  if (/(?<!bo)a tarde/.test(t)) return local.getUTCHours() < 14 ? at(0, 15) : new Date(now.getTime() + 2 * 3_600_000);
  // "estou no trabalho", "não tenho como enviar agora", "assim que puder" (Vicente Paulo 21/10): à noite do mesmo dia (19h); depois das 17h, amanhã de manhã.
  if (/trabalho|expediente|servico|agora nao|assim que (puder|conseguir|chegar|sair|tiver)|nao (tenho como|consigo|posso)/.test(t)) return at(local.getUTCHours() >= 17 ? 1 : 0, local.getUTCHours() >= 17 ? 11 : 19);
  if (/mais tarde|logo mais|daqui/.test(t)) return new Date(now.getTime() + 3 * 3_600_000);
  return at(1, 11); // "depois", "quando conseguir…": amanhã de manhã
}

/** Hook do WhatsApp: o cliente respondeu (texto) depois de perguntarmos de quem é o imóvel → reabre a conferência dos documentos. */
export async function maybeRecheckOwnerAnswer(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId, status: 'OPEN' }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  // Respondeu a pergunta do habite-se (Fabio 06/11): grava a resposta na hora e, se mudou, a conferência segue (falta/problemas/contratação).
  const h = cf._habiteSe;
  if (h && (h.status === 'PERGUNTADO' || h.status === 'NAO_SABE')) {
    const r = await (require('./habite-se.service') as typeof import('./habite-se.service')).lerRespostaHabite(accountId, leadId).catch(() => null);
    if (r && r !== h.status && !(cf._donoAskedAt && !cf._donoResolvedAt)) await scheduleDocsCheck(accountId, leadId, io);
  }
  if (!cf._donoAskedAt || cf._donoResolvedAt) return;
  await scheduleDocsCheck(accountId, leadId, io);
}

/** Hook do WhatsApp: texto do cliente num card em Aguardando Documentação. */
export async function maybeScheduleDocsFollowUp(accountId: string, leadId: string, text: string): Promise<void> {
  const t = (text || '').trim();
  if (!t || t.length > 220 || NEGATIVE_RX.test(t) || !TIME_RX.test(t) || !SEND_RX.test(t)) return;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId, status: 'OPEN' }, select: { customFields: true, stage: { select: { name: true } } } });
  if (!lead || !norm(lead.stage.name).includes('aguardando documentacao')) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused) return;
  const now = new Date();
  const lastIn = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const windowEnd = (lastIn?.createdAt.getTime() || now.getTime()) + WINDOW_MS;
  const promised = promisedAt(t, now);
  let due = Math.min(promised.getTime(), windowEnd - 90 * 60_000);
  due = Math.max(due, now.getTime() + 30 * 60_000);
  // Só entre 07h e 21h de Brasília: fora disso vai pras 08h seguintes (se couber na janela) ou volta pras 20h30.
  const dl = new Date(due + BRT);
  const hh = dl.getUTCHours();
  if (hh < 7 || hh >= 21) {
    const next8 = Date.UTC(dl.getUTCFullYear(), dl.getUTCMonth(), dl.getUTCDate() + (hh >= 21 ? 1 : 0), 8, 0, 0) - BRT;
    due = next8 <= windowEnd - 90 * 60_000 ? next8 : Math.max(now.getTime() + 30 * 60_000, Date.UTC(dl.getUTCFullYear(), dl.getUTCMonth(), dl.getUTCDate() + (hh >= 21 ? 0 : -1), 20, 30, 0) - BRT);
  }
  const beyond = promised.getTime() > due + 60 * 60_000; // prometeu algo além do que a janela permite
  // _docsPrazo: a data que o cliente deu — o loop de lembretes (docs-loop.service) espera até ela.
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _docsLater: { at: new Date(due).toISOString(), said: t.slice(0, 120), setAt: now.toISOString(), beyond }, _docsPrazo: promised.toISOString() } as any } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⏰ Cliente avisou que manda os documentos depois ("${t.slice(0, 120)}"). O card fica em Aguardando Documentação; a IA cobra ${new Date(due).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })} — antes da janela de 24 h do WhatsApp fechar.` } }).catch(() => {});
}

/** Poller (1 min): manda a cobrança combinada. */
export async function processDocsFollowUps(accountId: string, io: Io): Promise<void> {
  const due = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND ("customFields"->'_docsLater'->>'at') IS NOT NULL AND ("customFields"->'_docsLater'->>'at')::timestamptz <= now() LIMIT 10`;
  for (const { id } of due) {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, stage: { select: { name: true } } } });
    if (!lead) continue;
    const cf = { ...((lead.customFields || {}) as Record<string, any>) };
    const st = cf._docsLater as { at: string; said: string; setAt: string; beyond?: boolean } | undefined;
    if (!st) continue;
    const limpa = async () => { const f = await prisma.lead.findUnique({ where: { id }, select: { customFields: true } }); const c = { ...((f?.customFields || {}) as Record<string, any>) }; delete c._docsLater; await prisma.lead.update({ where: { id }, data: { customFields: c as any } }); };
    if (!norm(lead.stage.name).includes('aguardando documentacao') || cf._autoPaused || cf._imovelSemGarantia) { await limpa(); continue; } // imóvel que não serve de garantia: não cobra documento (Fabio 12/11)
    const docs = await prisma.messageAttachment.count({ where: { leadId: id, message: { direction: 'INBOUND' }, createdAt: { gt: new Date(st.setAt) } } });
    if (docs) { await limpa(); continue; } // já mandou
    const hh = new Date(Date.now() + BRT).getUTCHours();
    if (hh < 7 || hh >= 21) continue; // fora do horário: tenta na próxima rodada dentro do horário
    const lastIn = await prisma.message.findFirst({ where: { leadId: id, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const aberta = !!lastIn && Date.now() - lastIn.createdAt.getTime() < WINDOW_MS;
    if (!lead.aiAutoReplyActive || !aberta) {
      await limpa();
      if (!lead.aiAutoReplyActive) await (require('./ia-pendencias.service') as typeof import('./ia-pendencias.service')).guardarPendenciaIa(id, 'docsPrometidos', `cobrar os documentos que o cliente disse que mandaria ("${st.said}")`);
      await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: `⏰ Hora de cobrar os documentos que o cliente prometeu ("${st.said}") — ${!lead.aiAutoReplyActive ? 'a IA está desligada neste card, então NÃO mandei' : 'a janela de 24 h do WhatsApp já fechou, então NÃO mandei'}. Chame o cliente.` } }).catch(() => {});
      try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(accountId, { title: lead.name, body: 'Cobrar os documentos que ele prometeu mandar', leadId: id }).catch(() => {}); } catch { /* push opcional */ }
      continue;
    }
    const { conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
    const nome = String(cf.nome_social_1 || cf.participante_1 || lead.name || '').trim().split(/\s+/)[0] || '';
    const oi = (await conversationActive(id)) ? '' : `Oi${nome ? `, ${nome}` : ''}! `;
    const pediuLembrete = /lembr/i.test(st.said);
    const texto = st.beyond
      ? `${oi}Só pra manter nossa conversa aberta: continua tudo certo pra você me mandar a documentação? Me responde por aqui.`
      : pediuLembrete
      ? `${oi}Passando pra te lembrar da documentação, como você pediu. 😊 Quando tiver, pode mandar por aqui mesmo.`
      : `${oi}Conseguiu separar a documentação? Se já tiver, pode mandar por aqui mesmo.`;
    const sent = await sendOutboundWhatsApp({ accountId, leadId: id, content: texto, io: io || undefined });
    await limpa();
    await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: `⏰ A IA cobrou os documentos que o cliente tinha prometido ("${st.said}")${sent.success ? '' : ' — mas o envio falhou'}. O card continua em Aguardando Documentação.` } }).catch(() => {});
  }
}

const RULES = `Você confere se um cliente de crédito imobiliário já mandou TODA a documentação pedida. Responda SOMENTE com JSON:
{"complete": <true ou false>, "listaUsada": "<nome da lista>", "faltando": ["<item que falta>", ...], "emitir": ["<documento do imóvel que a A&F vai emitir>", ...], "autorizouEmissao": <true se na CONVERSA o atendente ofereceu emitir a certidão (custo de R$ 40 a R$ 100) e o cliente ACEITOU; senão false>}

Como decidir:
0. Se a CONVERSA já tem uma lista de documentos enviada pela equipe pra esse cliente, ELA é a referência (vale mais que as listas abaixo).
1. Senão, escolha a lista certa entre as listas abaixo: Home Equity pessoa física → "Documentos Home Equity"; crédito no nome de empresa (PJ) → "Documentos comprador PJ"; Financiamento Habitacional → a lista do perfil de renda (empresário/autônomo/profissional liberal → empresário; assalariado/CLT → setor privado; servidor público → servidor público).
2. Documentos pessoais e de renda valem pra CADA participante listado.
3. Itens marcados "se usar" ou "se houver" não são obrigatórios.
4. RG ou CNH servem como documento de identificação; certidão de nascimento ou de casamento servem como comprovante de estado civil. HOME EQUITY (Fabio 27/10): de cada participante só se pedem RG/CNH e comprovante de residência (+ os documentos do imóvel) — NUNCA ponha certidão de nascimento/casamento, CPF ou renda em "faltando" na lista "Documentos Home Equity", mesmo que uma versão antiga da lista cite. A documentação completa é só da CAIXA (e das listas do Financiamento Habitacional).
5. Cônjuges/companheiros: um comprovante de residência e uma certidão de casamento servem para os dois (moram juntos), a não ser que a conversa diga que moram em endereços diferentes.
6. Se o cliente disse na conversa que algo não se aplica a ele, considere.
7. CERTIDÃO DE ÔNUS REAIS e MATRÍCULA do imóvel é ITEM ESSENCIAL (sem ela a contratação não conclui). A "Certidão de Cadastro Imobiliário" da PREFEITURA (inscrição imobiliária, proprietários, endereço) NÃO é certidão de ônus nem matrícula: não conta como recebida pra este item (ela só ajuda com a "Inscrição Imobiliária"). Qualquer arquivo de matrícula/ônus do CARTÓRIO recebido (mesmo consulta, antigo ou parcial) conta como recebido; se o cliente JÁ trouxe a certidão/matrícula, ela basta — a A&F NÃO emite outra. Escritura pública ou contrato de compra e venda NÃO substituem a certidão, mas trazem o número da matrícula (normalmente a escritura pública) e permitem à A&F emiti-la, SE o cliente autorizar. Se NÃO chegou, ponha em "faltando" ("Certidão de ônus/matrícula — ou escritura/documento com o número da matrícula") — a menos que a linha "Cliente autorizou a A&F a emitir a certidão" seja Sim: aí vai em "emitir" e não em "faltando". O que sobra do imóvel (o item do IPTU: inscrição imobiliária OU capa do IPTU) continua obrigatório.
8c. "autorizouEmissao": true SÓ se na CONVERSA RECENTE o atendente ofereceu emitir a certidão de ônus/matrícula (o custo só é dito se o cliente perguntar) e o cliente aceitou/autorizou; caso contrário false.
8d. Se a linha "A matrícula da certidão que o cliente enviou foi ENCERRADA" aparecer, a certidão recebida NÃO vale (o imóvel ganhou matrícula nova): trate como não recebida e coloque a certidão da MATRÍCULA NOVA em "emitir" (a A&F emite pelo número novo) — NÃO em "faltando" e NUNCA peça ao cliente que tire outra no cartório.
8b. Se a linha "O banco NÃO aceitou a certidão que o cliente enviou" aparecer (a equipe anotou isso no card), a certidão recebida NÃO vale (muito antiga ou só consulta): trate como não recebida — "faltando" (ou "emitir", se o cliente autorizou a emissão).
8a. O cliente respondeu no formulário se POSSUI certidão de ônus/matrícula (linha "Cliente informou…" abaixo): é só contexto. "Não possui"/"Não sei" NÃO tira a certidão de "faltando" (a conversa vai apurar o que ele tem); "Sim, possui" e nenhum arquivo: falta mesmo.
8. IPTU (Fabio 27/10 — inscrição e capa viraram UM item só: "Inscrição Imobiliária/IPTU ou Capa do IPTU com as metragens"): QUALQUER documento da PREFEITURA com a inscrição imobiliária atende — capa, carnê ou guia do IPTU, CND de IPTU, certidão de cadastro imobiliário, declaração/certidão de isenção de IPTU (imóvel isento manda a inscrição). As metragens NÃO são obrigatórias pra esse item: sem a capa, a inscrição basta. Se a lista usada ainda trouxer os dois itens separados ("Inscrição Imobiliária/IPTU" e "Capa do IPTU com as metragens"), o MESMO documento da prefeitura atende os dois — nunca cobre a capa de quem já mandou a inscrição.
8e. Matrícula, escritura e outros documentos de cartório NÃO contam como o item do IPTU (não são da prefeitura).
8f. RENDA (Fabio 20/10 e 27/10 — renda SÓ quando o banco pede): a linha "Comprovação de renda" diz se ela é necessária. Se disser que NÃO é necessária, NÃO coloque nenhum item de renda em "faltando" e considere-os atendidos, mesmo que não tenham chegado.
8g. OPERADORA (Fabio 20/10): documento de operadora/concessionária (Claro, Vivo, TIM, Oi, energia, água, gás, internet) vale como COMPROVANTE DE RESIDÊNCIA, inclusive o protegido por senha que não pôde ser lido: conte como recebido.
8i. PROTEGIDO (Fabio 21/10): arquivo do tipo PROTEGIDO (senha) não conta como nenhum item da lista e NÃO impede de completar se o resto chegou — a IA pergunta ao cliente o que é e a equipe confere depois (fica na pasta como "VERIFICAR").
8h. ESCRITURA (Fabio 20/10): se só chegou a escritura (com o número da matrícula), a certidão de ônus/matrícula NÃO é pedida ao cliente: ponha em "emitir" (a A&F pede pelo ONR com o OK dele), nunca em "faltando".
9. Seja rigoroso: "complete": true só se tiver certeza de que todos os itens obrigatórios chegaram. Se houver arquivos que não puderam ser lidos e algum item obrigatório puder estar entre eles, responda false.`;

/** Só avalia (não move nem manda nada). null = nada pra avaliar. */
export async function evaluateDocs(accountId: string, leadId: string): Promise<{ leadName: string; complete: boolean; listaUsada?: string; faltando: string[]; emitir: string[]; emitirPendente: string[]; receivedText: string } | null> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { stage: true, pipeline: { include: { department: true } } },
  });
  if (!lead) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const atts = (await prisma.messageAttachment.findMany({
    where: { leadId, message: { direction: 'INBOUND' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, driveFileId: true, data: true, mimeType: true, fileName: true },
  })).filter((a) => !/^(audio|video)\//.test(a.mimeType) && !isStickerAttachment(a) && !isScreenshotAttachment(a));
  if (!atts.length) return null;

  const info = await getDocInfo(accountId, leadId, atts);
  const received = atts.map((a) => info[a.id]).filter((d): d is NonNullable<typeof d> => !!d);
  if (!received.length) return null;
  // 28/10 (Wagner): um PDF com os RGs do casal e outro com escritura + matrícula — a classificação rápida guarda UM tipo e UM titular por arquivo ("RG|MARIA CRISTINA",
  // "ESCRITURA") e o cliente foi cobrado do RG dele e da matrícula que já tinham chegado. Soma o que a leitura completa (_docReview) achou no mesmo arquivo: cada titular e os "outros".
  const revAll = ((((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as any)._docReview || {}) as Record<string, { tipo?: string; titular?: string; outros?: string[]; resultado?: string }>;
  const counts: Record<string, number> = {};
  for (const a of atts) {
    const d = info[a.id];
    if (!d) continue;
    const doArquivo = new Map<string, string>(); // chave normalizada → como aparece
    const add = (tipo: string, quem?: string) => { const t = quem ? `${tipo} — de ${quem}` : tipo; doArquivo.set(t.toUpperCase(), doArquivo.get(t.toUpperCase()) || t); };
    const nomes = (x?: string) => String(x || '').split(/\s*;\s*/).filter(Boolean);
    if (nomes(d.holder).length) nomes(d.holder).forEach((h) => add(d.type, h)); else add(d.type);
    const r = revAll[a.id];
    if (r && r.tipo && r.resultado !== 'NAO_DOCUMENTO') {
      nomes(r.titular).forEach((h) => add(r.tipo!, h));
      if (!nomes(r.titular).length && r.tipo.toUpperCase() !== d.type.toUpperCase()) add(r.tipo);
      (r.outros || []).forEach((o) => add(o));
    }
    for (const k of doArquivo.values()) counts[k] = (counts[k] || 0) + 1;
  }
  const receivedText = Object.entries(counts).map(([t, n]) => (n > 1 ? `${t} (${n} arquivos)` : t)).join('\n');
  const unread = atts.filter((a) => info[a.id] === undefined).map((a) => a.fileName);

  const lists = await prisma.messageTemplate.findMany({
    where: {
      accountId,
      name: { startsWith: 'Documentos', mode: 'insensitive' },
      OR: [{ departmentId: lead.pipeline.departmentId }, { departmentId: null }],
    },
    select: { name: true, body: true },
  });
  const cf = (lead.customFields || {}) as Record<string, string>;
  const cfAll = cf as Record<string, any>;
  // Financiamento Habitacional tem fluxo de documentos PRÓPRIO (Fabio 29/10, Taynara: a conferência cobrou matrícula/ônus e IPTU, que são do Home Equity).
  // Sem banco privado escolhido (ou optou pela CAIXA/BRB): a documentação do comprador — RG, CPF, comprovante de endereço, último contracheque e certidão de estado civil.
  const ehFh = /habitacional/i.test(lead.pipeline.department?.name || '');
  const caixaRota = naRotaCaixa(cfAll, lead.stage?.name); // pediu a CAIXA (Fabio 01/11, HE e FH) ou está na etapa Análise CAIXA (11/11): lista enxuta do comprador, a mesma do FH
  const fhSoComprador = soDocsDoComprador(cfAll, lead.pipeline.department?.name, lead.stage?.name);
  // FH com banco escolhido: os VENDEDORES são os proprietários atuais da certidão de ônus/matrícula (Fabio 11/11: "temos vendedor que deve bater com os mesmos da ônus").
  const vendedoresOnus = ehFh && !fhSoComprador ? vendedoresDoImovel(cfAll) : [];
  const listas = ehFh || caixaRota ? lists.filter((l) => !/home equity/i.test(l.name)) : lists;
  if (!listas.length && !fhSoComprador) return null;
  // CAIXA (ou ainda sem banco): lista ENXUTA pra rodar na CAIXA. BRB: documentação COMPLETA pela profissão (lista do perfil) — Fabio 29/10.
  const { perfilTemplate } = require('./fh-approval.service') as typeof import('./fh-approval.service');
  const blocoFh = !ehFh && !caixaRota ? '' : fhSoComprador && cfAll._optouCaixa?.banco === 'BRB'
    ? `FINANCIAMENTO HABITACIONAL — BRB (Fabio 29/10): o BRB analisa com a documentação COMPLETA do comprador pela profissão — a referência é a lista "${perfilTemplate(cfAll)}" abaixo (pessoais + renda). NÃO cobre nada do imóvel nem do vendedor nesta fase: "emitir" vazio e "autorizouEmissao" false.\n\n`
    : fhSoComprador
    ? `${caixaRota && !ehFh ? 'CAIXA (o cliente pediu a CAIXA — Fabio 01/11)' : 'FINANCIAMENTO HABITACIONAL'} — LISTA QUE VALE (acima de TODAS as listas abaixo; Fabio 29/10 — lista ENXUTA pra rodar na CAIXA): de cada ${caixaRota && !ehFh ? 'participante' : 'comprador'}: RG, CPF (a CNH vale pelos dois), comprovante de endereço, último contracheque e certidão de estado civil (nascimento; casamento; casamento com averbação do divórcio/viuvez). Se for casado, RG e CPF do cônjuge. NÃO cobre NADA do imóvel (certidão de ônus/matrícula, escritura, IPTU) nem do vendedor nesta fase: "emitir" vazio e "autorizouEmissao" false. Na "listaUsada" escreva "${caixaRota && !ehFh ? 'CAIXA — participantes' : 'Financiamento Habitacional — comprador'}".\n\n`
    : `FINANCIAMENTO HABITACIONAL (banco ${cfAll._fhChosen?.bank || 'escolhido'}): a referência é a lista que o CRM mandou na conversa depois da escolha do banco. NUNCA use a lista "Documentos Home Equity".\n\n`;
  // Autorização da emissão da certidão: SEM campo (Fabio 15/10) — fica registrada numa ANOTAÇÃO do card (marcador abaixo) e o CRM mesmo lê.
  const jaAutorizou = !!(await prisma.note.findFirst({ where: { leadId, content: { startsWith: AUTORIZOU_EMISSAO } }, select: { id: true } }));
  const bancoRecusou = await (require('./doc-review.service') as typeof import('./doc-review.service')).bancoRecusouCertidao(leadId).catch(() => false); // anotação da equipe no card
  const matriculaEncerrada = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }).then((l) => { const m = ((l?.customFields || {}) as any)._matriculaEncerrada; return m ? ((m.novas || []).join('; ') || 'número novo') : ''; }).catch(() => '');
  const { bancosEmJogo } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const jogo = await bancosEmJogo(prisma, leadId).catch(() => ({ emJogo: [] as string[], rendaNecessaria: true, texto: 'sem leitura' }));
  const bancosTxt = jogo.texto || 'sem leitura';
  const rendaNecessaria = fhSoComprador || jogo.rendaNecessaria; // FH: o último contracheque faz parte da lista do comprador
  const comMetragens = Array.from(new Set(Object.values((cfAll._docReview || {}) as Record<string, any>).filter((r: any) => r && r.metragens === true).map((r: any) => String(r.tipo)))) as string[];
  // Imóvel com FINANCIAMENTO ATIVO (proposta "Imóvel quitado: Não"; Home Equity): o banco pede o DESCRITIVO DA PARCELA em PDF (Fabio 30/10). Só o PDF conta — a foto/print
  // vira problema na leitura (doc-review) e o cliente é avisado que precisa do PDF.
  const precisaDescritivo = !ehFh && !caixaRota && (await (require('./saldo-devedor.service') as typeof import('./saldo-devedor.service')).proposalFinancing(leadId).catch(() => null))?.quitado === false;
  const temDescritivo = atts.some((a) => a.mimeType === 'application/pdf' && revAll[a.id]?.resultado !== 'PROBLEMA' && (isDescritivoParcela(info[a.id]?.type) || isDescritivoParcela(revAll[a.id]?.tipo)));
  const participants = [
    cf.participante_1 && `1) ${cf.participante_1}${cf.vinculo_1 ? ` — ${cf.vinculo_1}` : ''}${nomeSocialNota(cf, 1)}`,
    cf.participante_2 && `2) ${cf.participante_2}${cf.vinculo_2 ? ` — ${cf.vinculo_2}` : ''}${nomeSocialNota(cf, 2)}`,
  ].filter(Boolean).join('\n') || `1) ${lead.name}`;
  const history = (await prisma.message.findMany({
    where: { leadId, callWaCallId: null }, orderBy: { createdAt: 'desc' }, take: 25, select: { content: true, direction: true },
  })).reverse().map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Atendente'}: ${(m.content || '').replace(/\s+/g, ' ').slice(0, 200).replace(/[\ud800-\udbff]$/, '')}`).join('\n');

  const estadoCrm = await (require('./ai-shared.service') as typeof import('./ai-shared.service')).aiCardState(leadId).catch(() => '');
  const prompt = `${todayContextLine()}
Setor/produto: ${lead.pipeline.department?.name || '?'}
Participantes:
${participants}

BANCOS EM JOGO: ${bancosTxt}
${vendedoresOnus.length ? `VENDEDORES (proprietários atuais na certidão de ônus/matrícula — Fabio 11/11): ${vendedoresOnus.join('; ')}. Os documentos do VENDEDOR têm que ser DESSAS pessoas (de cada uma); documento pessoal de quem não é comprador nem está na ônus NÃO conta como do vendedor.\n` : ''}Comprovação de renda: ${rendaNecessaria ? 'necessária (o banco pediu documento de renda)' : 'NÃO é necessária (nenhum banco pediu renda — Fabio 27/10: renda só quando o banco pede — ou a equipe dispensou)'}
Documentos da PREFEITURA recebidos que MOSTRAM as metragens do imóvel: ${comMetragens.length ? comMetragens.join(', ') : 'nenhum'}
${precisaDescritivo ? `Imóvel com FINANCIAMENTO ATIVO: o banco pede o DESCRITIVO DA PARCELA (PDF do app do banco do financiamento, com as últimas prestações) — ${temDescritivo ? 'JÁ RECEBIDO: não cobre.' : `NÃO recebido: ponha em "faltando" o item "${ITEM_DESCRITIVO}".`}
` : ''}
${blocoFh}LISTAS DE DOCUMENTOS:
${listas.map((l) => `--- ${l.name} ---\n${l.body}`).join('\n\n')}

${bancoRecusou ? 'O banco NÃO aceitou a certidão que o cliente enviou (muito antiga ou só consulta): Sim\n\n' : ''}${matriculaEncerrada ? `A matrícula da certidão que o cliente enviou foi ENCERRADA (matrícula nova: ${matriculaEncerrada}): Sim\n\n` : ''}${jaAutorizou ? 'Cliente autorizou a A&F a emitir a certidão de ônus/matrícula (custo de R$ 40 a R$ 100 pro cliente): Sim\n\n' : ''}${String(cfAll.possui_certidao || '').trim() ? `Cliente informou no formulário que possui certidão de ônus/matrícula: ${String(cfAll.possui_certidao).trim()}\n\n` : ''}DOCUMENTOS RECEBIDOS (lidos dos arquivos que o cliente mandou; "de FULANO" = titular do documento):
${receivedText}
${unread.length ? `\nArquivos que não puderam ser lidos: ${unread.length}` : ''}

${estadoCrm ? `\nESTADO DO CARD NO CRM (fatos reais do sistema — análise de crédito, contratação e agenda; não contradiga):\n${estadoCrm}\n` : ''}
CONVERSA RECENTE:
${history}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4000, system: cachedSystem(await fixedRule(accountId, 'DOCS_CHECKER_RULES', RULES)), messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    console.error('[Docs] Erro Anthropic:', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const raw = data.content?.find((b) => b.type === 'text')?.text || '';
  let verdict: { complete?: boolean; listaUsada?: string; faltando?: string[]; emitir?: string[]; autorizouEmissao?: boolean } = {};
  try { verdict = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return null; }
  let autorizou = jaAutorizou;
  if (!autorizou && verdict.autorizouEmissao === true) {
    autorizou = true;
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `${AUTORIZOU_EMISSAO} — o cliente aceitou na conversa que a A&F emita a certidão de ônus/matrícula pelo ONR (custo de R$ 40 a R$ 100 pra ele).` } }).catch(() => {});
  }
  // Descritivo da parcela: decide o CRM (o PDF chegou ou não), não o modelo.
  if (precisaDescritivo) {
    verdict.faltando = (verdict.faltando || []).filter((f) => !/descritivo|prestac/i.test(String(f)));
    if (!temDescritivo) { verdict.faltando.push(ITEM_DESCRITIVO); verdict.complete = false; }
  }
  // Vendedor da ônus sem documento de identificação recebido: decide o CRM, não o modelo (Pedro 10/11: "completo" sem nenhum documento dos vendedores).
  if (vendedoresOnus.length) {
    const semAc = (x: unknown) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    const ID_RX = /^(RG|CNH|CIN|CPF|IDENTIDADE|CARTEIRA DE IDENTIDADE|DOCUMENTO DE IDENTIFICACAO|RNE|CRNM)\b/;
    const temId = (v: string) => atts.some((a) => {
      const d = info[a.id], r = revAll[a.id];
      const quem = [...(d && ID_RX.test(semAc(d.type)) ? String(d.holder || '').split(/\s*;\s*/) : []), ...(r && r.resultado !== 'NAO_DOCUMENTO' && ID_RX.test(semAc(r.tipo)) ? String(r.titular || '').split(/\s*;\s*/) : [])];
      return quem.some((h) => mesmaPessoa(h, v));
    });
    const semDoc = vendedoresOnus.filter((v) => !temId(v));
    const nomeBonito = (v: string) => v.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, e, l) => e + l.toUpperCase()).replace(/\s(Da|De|Do|Das|Dos|E)(?=\s)/g, (m) => m.toLowerCase());
    for (const v of semDoc) {
      if ((verdict.faltando || []).some((f) => /VENDEDOR/.test(semAc(f)) && semAc(f).includes(semAc(v).split(' ')[0]))) continue; // o modelo já cobrou essa pessoa
      verdict.faltando = [...(verdict.faltando || []), `Documentos do vendedor ${nomeBonito(v)} (está na certidão de ônus): documento de identificação (RG ou CNH), comprovante de residência e certidão de estado civil`];
    }
    if (semDoc.length) verdict.complete = false;
  }
  const emitirBruto = fhSoComprador ? [] : Array.isArray(verdict.emitir) ? verdict.emitir.map((x) => String(x).slice(0, 120)) : [];
  if (fhSoComprador) verdict.faltando = (verdict.faltando || []).filter((f) => !/[ôo]nus|matr[ií]cula|escritura|iptu|inscri[cç][aã]o imobili|vendedor/i.test(String(f)));
  // Sem a permissão do cliente a A&F NÃO emite (custo de R$ 40 a R$ 100 pra ele): o que o modelo pôs em "emitir" volta pra "faltando" e a certidão trava a conclusão.
  // Escritura com a matrícula identificada (Fabio 20/10): a certidão NÃO é cobrada do cliente — a IA se OFERECE pra emitir pelo ONR (certidao-offer.service) e só emite quando ele aceita.
  const { certidaoFromDocs, enderecoDoImovel } = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
  // Sem matrícula (Fabio 30/10): com o endereço completo do imóvel a IA também se oferece (pelo endereço) em vez de cobrar a certidão do cliente.
  const ofertavel = !autorizou && emitirBruto.length > 0 && (!!certidaoFromDocs(cfAll) || !!(await enderecoDoImovel(leadId, cfAll).catch(() => null)));
  const faltandoFinal = [...(verdict.faltando || []), ...(autorizou || ofertavel ? [] : emitirBruto)];
  const out = { leadName: lead.name, complete: verdict.complete === true && (autorizou || !emitirBruto.length), listaUsada: verdict.listaUsada, faltando: faltandoFinal, emitir: autorizou ? emitirBruto : [], emitirPendente: ofertavel ? emitirBruto : [], receivedText };
  // Painel de documentos do card (Fabio 03/11): guarda o resultado desta conferência (só a chave, jsonb_set) — o painel mostra o que falta sem chamar a IA de novo.
  const snap = { em: new Date().toISOString(), listaUsada: out.listaUsada || '', completo: out.complete, faltando: out.faltando, emitir: out.emitir, emitirPendente: out.emitirPendente };
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsConferencia}', ${JSON.stringify(snap)}::jsonb, true) WHERE id = ${leadId}`.catch(() => {});
  return out;
}

/** O cliente AVISOU que já mandou os documentos (botão "Já enviei os documentos" do lembrete, ou texto equivalente)? */
export function isDocsSentClaim(text: string): boolean {
  const t = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\b(ja\s+)?(enviei|mandei|encaminhei|anexei)\b.{0,40}\b(document|tudo|papeis|arquivos|certidoes)/.test(t) || /\bja\s+(foi|foram|esta|estao)\s+(tudo\s+)?(enviad|mandad|encaminhad)/.test(t);
}

/** `force` = o cliente disse "já enviei": confere AGORA e responde com a situação atual (o que falta / o que está com problema), mesmo que já tenha avisado o mesmo antes. Devolve true se falou com o cliente (ou concluiu a documentação). */
/** Arquivos que não abrem (senha): UMA mensagem ao cliente perguntando o que são (Fabio 21/10). Só com IA do card ligada, 07h–21h e janela de 24 h aberta; senão tenta de novo na próxima conferência. */
async function perguntarProtegidos(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { aiAutoReplyActive: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const prot = (cf._docsProtegidos || {}) as Record<string, { fileName?: string; guess?: string; askedAt?: string }>;
  const pend = Object.entries(prot).filter(([, v]) => !v.askedAt);
  if (!lead || !lead.aiAutoReplyActive || cf._autoPaused || !pend.length) return;
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow() || !(await whatsappWindowOpen(leadId))) return;
  const nomes = pend.map(([, v]) => `• ${v.fileName}`).join('\n');
  const texto = `${pend.length > 1 ? 'Os arquivos abaixo estão protegidos' : 'O arquivo abaixo está protegido'} por senha e eu não consigo abrir:\n${nomes}\n\nPode me dizer que documento ${pend.length > 1 ? 'é cada um' : 'é esse'}? Se der, manda de novo sem senha.`;
  const sent = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined });
  if (!sent.success) return;
  const next: Record<string, any> = {};
  for (const [id, v] of Object.entries(prot)) next[id] = v.askedAt ? v : { ...v, askedAt: new Date().toISOString() };
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _docsProtegidos: next } as any } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔒 Perguntei ao cliente o que são os arquivos protegidos por senha (${pend.map(([, v]) => v.fileName).join('; ')}). Eles ficam na pasta do Drive como "VERIFICAR - …" pra você conferir depois.` } }).catch(() => {});
}

export async function checkDocsComplete(accountId: string, leadId: string, io: Io, opts: { force?: boolean } = {}): Promise<boolean> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, aiAutoReplyActive: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
  const cfLead = (lead?.customFields || {}) as Record<string, any>;
  if (!lead || !etapaConfere(lead.stage.name, cfLead)) return false;
  // Pediu a CAIXA (Fabio 01/11, HE e FH): mesma lista enxuta do comprador do FH; completa → ficha e cadastro, o card não vai pra contratação.
  const caixaRota = naRotaCaixa(cfLead, lead.stage.name);
  const fhSoComprador = soDocsDoComprador(cfLead, lead.pipeline?.department?.name, lead.stage.name);
  if ((lead.customFields as any)?._autoPaused) return false; // Stop total do cliente: não confere, não move, não avisa

  // Conferência de CONTEÚDO (Fabio 14/10): a IA LÊ cada arquivo e vê se está legível, atualizado e no nome certo (RG/CNH com frente e verso). Documento com
  // problema NÃO deixa o card avançar, mesmo que "chegou tudo": o cliente é avisado do que corrigir (uma vez por conjunto de problemas).
  const review = await reviewReceivedDocs(accountId, leadId).catch((err) => { console.error(`[Docs] leitura dos documentos falhou (${leadId}):`, err?.message || err); return null; });
  // Renda dispensada PELA EQUIPE neste card (marca _rendaDispensada; Fabio 20/10, caso Luiz): problema/dúvida em documento de RENDA não segura o card nem gera cobrança.
  if (review) await filtrarRendaDispensada(leadId, fhSoComprador, review);
  if (review?.novas.length) {
    const linhas = review.novas.map(({ arquivo, r }) => `${r.resultado === 'OK' ? '✅' : r.resultado === 'PROBLEMA' ? '⚠️' : r.resultado === 'DUVIDA' ? '❓' : '•'} ${r.tipo}${r.titular ? ` (${r.titular})` : ''}${r.resultado === 'PROBLEMA' ? ` — ${r.problemas.join('; ')}` : ''}${r.observacao ? ` [${r.observacao}]` : ''} — ${arquivo}`);
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 A IA leu ${review.novas.length > 1 ? 'os documentos novos' : 'o documento novo'}:\n${linhas.join('\n')}` } }).catch(() => {});
  }
  if (review?.atendidos?.length) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 Conferindo a documentação inteira, NÃO pedi de novo:\n${review.atendidos.map((a) => `• ${a.doc}: "${a.texto}" — já atendido por ${a.por}`).join('\n')}` } }).catch(() => {});
  }
  await perguntarProtegidos(accountId, leadId, io).catch((e: any) => console.error('[Docs] arquivos protegidos:', e?.message || e));
  // Proprietário MENOR de idade no documento do imóvel (Fabio 12/11): a leitura já levou a dúvida pro balão; o card ganha a anotação e o push, uma vez por nome.
  await avisarDonoMenor(accountId, leadId, lead.name).catch((e: any) => console.error('[Docs] dono menor:', e?.message || e));

  // IMÓVEL QUE NÃO SERVE DE GARANTIA (cessão de direitos; Fabio 12/11: "a IA estava indo bem, aí do nada ela mandou um retorno da documentação nada a ver"): a conversa já tinha dito
  // que o imóvel não serve e perguntado por outro com matrícula; minutos depois a conferência mandou o retorno padrão — ajuste em outro documento, oferta de emitir certidão de imóvel sem
  // matrícula e "ainda falta mandar RG, comprovante…". Esse achado ENCERRA a conferência: nenhum outro documento é pedido; sai só a constatação com a pergunta do outro imóvel, e NADA
  // se a conversa já disse. O lembrete de documentação também para (`_imovelSemGarantia`), até a leitura deixar de apontar o problema.
  let semGarantia = review ? problemaSemGarantia(review.problemas) : null;
  // Chegou MATRÍCULA/certidão de ônus (o cliente respondeu com outro imóvel): o papel da cessão continua na pasta, mas deixa de ser a garantia — não segura mais a documentação
  // (sem isto a leitura da cessão ficaria como problema pra sempre e o card nunca concluiria). A equipe é avisada uma vez pra conferir se é mesmo outro imóvel.
  if (review && semGarantia && temMatricula([...review.ok, ...review.problemas.filter((p) => p !== semGarantia).map((p) => p.doc)])) {
    const cessao = semGarantia;
    review.problemas = review.problemas.filter((p) => p !== cessao);
    semGarantia = null;
    if (!cfLead._cessaoComMatriculaAt) {
      await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_cessaoComMatriculaAt}', ${JSON.stringify(new Date().toISOString())}::jsonb, true) WHERE id = ${leadId}`;
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '📎 Há um documento de CESSÃO DE DIREITOS na pasta, mas também chegou matrícula/certidão de ônus: a conferência segue pela matrícula. Confira se é mesmo outro imóvel (o de cessão não serve de garantia).' } }).catch(() => {});
    }
  }
  if (review && !semGarantia && cfLead._imovelSemGarantia) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_imovelSemGarantia' WHERE id = ${leadId}`;
  if (semGarantia) {
    const freshS = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const cfS = (freshS?.customFields || {}) as Record<string, any>;
    const chaveS = chaveProblema(semGarantia);
    const ditosS: string[] = Array.isArray(cfS._docProblemsTold) ? cfS._docProblemsTold : [];
    if (cfS._imovelSemGarantia && ditosS.includes(chaveS)) return false; // já tratado: quem conversa daqui em diante é a IA, com o contexto da cessão
    const jaDito = await prisma.message.findFirst({
      where: { leadId, direction: 'OUTBOUND', status: { not: 'FAILED' }, createdAt: { gt: new Date(Date.now() - 30 * 86_400_000) }, OR: [{ content: { contains: 'cessão de direito', mode: 'insensitive' } }, { content: { contains: 'cessao de direito', mode: 'insensitive' } }] },
      select: { id: true },
    });
    const sentS = jaDito ? { success: false } : lead.aiAutoReplyActive ? await sendOutboundWhatsApp({ accountId, leadId, content: TEXTO_CESSAO, io: io || undefined }) : { success: false };
    const agoraS = new Date().toISOString();
    const marca = JSON.stringify({ motivo: 'cessão de direitos', at: cfS._imovelSemGarantia?.at || agoraS });
    // Só as chaves (jsonb_set): regravar o card inteiro apaga o que outro processo gravou no meio (corrida no customFields, 29/10).
    if (jaDito || sentS.success) {
      await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(jsonb_set(jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_imovelSemGarantia}', ${marca}::jsonb, true), '{_docProblemsTold}', ${JSON.stringify(Array.from(new Set([...ditosS, chaveS])))}::jsonb, true), '{_docProblemsToldAt}', COALESCE("customFields"->'_docProblemsToldAt', '{}'::jsonb) || ${JSON.stringify({ [chaveS]: agoraS })}::jsonb, true) WHERE id = ${leadId}`;
    } else {
      await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_imovelSemGarantia}', ${marca}::jsonb, true) WHERE id = ${leadId}`;
    }
    if (!cfS._imovelSemGarantia || sentS.success) {
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🚫 Conferência de documentos: imóvel de CESSÃO DE DIREITOS (sem matrícula registrada) — não serve de garantia em nenhum banco. ${jaDito ? 'A conversa já tinha dito isso ao cliente: não mandei o retorno da conferência.' : sentS.success ? 'Avisei o cliente e perguntei se ele tem outro imóvel com matrícula.' : 'IA desligada: avise o cliente.'} Não pedi ajuste em documento nem os documentos que faltam, e o lembrete de documentação fica parado neste card.` } }).catch(() => {});
    }
    if (!cfS._imovelSemGarantia) (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `🚫 ${lead.name}: imóvel de cessão de direitos`, body: 'Não serve de garantia em nenhum banco. Veja se o cliente tem outro imóvel com matrícula.', leadId }).catch(() => {});
    console.log(`[Docs] ${lead.name} (${leadId}): imóvel de cessão de direitos — conferência encerrada (${jaDito ? 'conversa já disse' : sentS.success ? 'cliente avisado' : 'IA desligada'})`);
    return !!sentS.success;
  }

  // DÚVIDA QUE SAIU DO BALÃO (Fabio 12/11: "dúvida de documento some do balão e trava a conferência" — 12 cards com leitura em dúvida e nenhuma pergunta aberta): só segura a
  // conferência a dúvida que AINDA está com a equipe. Pergunta descartada, assumida ou respondida sem a releitura dar veredito → o documento vira ressalva (conta como recebido,
  // a equipe confere no painel de Documentos / em Documentação Recebida) e a conferência segue. Dúvida que nunca chegou ao balão é aberta agora. Dono menor de idade continua segurando.
  if (review?.duvidas.length) {
    // Estado FRESCO (a leitura acima demora e grava `_docReview`): `donoMenor` recém-lido e as ressalvas que outra conferência já anotou.
    const cfD = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
    const sep = await separarDuvidas(accountId, leadId, review.duvidas, (cfD._docReview || {}) as Record<string, any>, io).catch((e: any) => { console.error('[Docs] dúvidas sem pergunta:', e?.message || e); return null; });
    if (sep) {
      review.duvidas = sep.seguram;
      const ja = new Set<string>(Array.isArray(cfD._duvidasSemResposta) ? cfD._duvidasSemResposta : []);
      const novas = sep.ressalvas.filter((d) => !ja.has(d.attachmentId));
      if (novas.length) {
        await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_duvidasSemResposta}', COALESCE("customFields"->'_duvidasSemResposta', '[]'::jsonb) || ${JSON.stringify(novas.map((d) => d.attachmentId))}::jsonb, true) WHERE id = ${leadId}`;
        const porque = (d: (typeof novas)[number]) => d.fechada === 'ANSWERED' ? 'a equipe já respondeu a dúvida deste arquivo, mas a leitura continua em dúvida' : 'a dúvida da IA foi fechada sem resposta';
        await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ Conferir em Documentação Recebida: ${novas.map((d) => `${d.doc} (${d.arquivo}) — ${porque(d)}: "${String(d.pergunta || '').slice(0, 220)}"`).join(' | ')}. O documento conta como recebido e não segura mais a conferência; pra marcar como OK ou com problema, use o painel de Documentos do card.` } }).catch(() => {});
        console.log(`[Docs] ${lead.name} (${leadId}): ${novas.length} dúvida(s) fechada(s) sem resposta — viraram ressalva, a conferência segue`);
      }
    }
  }
  // Documento em DÚVIDA (a pergunta está com a equipe no balão): não avança o card nem cobra nada até a equipe responder.
  if (review?.duvidas.length && !review.problemas.length) {
    console.log(`[Docs] ${lead.name} (${leadId}): ${review.duvidas.length} documento(s) em dúvida com a equipe — conferência pausada`);
    return false;
  }

  // Documento do imóvel em nome de OUTRA pessoa (Fabio 15/10): a IA pergunta ao cliente de quem é o imóvel (uma vez por proprietário) e o card espera a resposta; com a resposta a conferência reabre.
  if (review?.donoPendente.length) {
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const cfd = { ...((fresh?.customFields || {}) as Record<string, any>) };
    const ja = new Set<string>(((cfd._donoAskedFor as string[]) || []).map((x) => String(x).toUpperCase()));
    const novos = review.donoPendente.filter((d) => !ja.has(d.dono.toUpperCase()));
    if (novos.length) {
      // Empresa (loteadora/construtora, matrícula-mãe) ≠ pessoa (Fabio 27/10, Diego: a IA perguntou se a "JARDIM DO MARQUES EMPREENDIMENTOS LTDA" era pai/mãe dele).
      const pessoas = novos.filter((d) => !d.empresa), empresas = novos.filter((d) => d.empresa);
      const docNome = (tipo: string) => /^IPTU|IPTU$|CADASTRO/.test(tipo) ? 'esse IPTU' : /^ESCRITURA/.test(tipo) ? 'essa escritura' : 'essa matrícula';
      const partes = [
        pessoas.length && `Vi na matrícula que o imóvel está no nome de ${pessoas.map((d) => `*${d.dono}*`).join(' e ')}. Quem é essa pessoa pra você (pai, mãe, cônjuge, filho…)? Preciso saber pra seguir com a documentação. 🙏`,
        empresas.length && `Vi que ${docNome(empresas[0].doc)} ainda está no nome da empresa ${empresas.map((d) => `*${d.dono}*`).join(' e ')}, e não no seu. Você tem a matrícula individual do seu imóvel, já no seu nome? 🙏`,
      ].filter(Boolean) as string[];
      const texto = partes.join('\n\n');
      const sent = lead.aiAutoReplyActive ? await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined }) : { success: false, error: 'IA desligada no card' };
      // Só marca "perguntado" se a pergunta SAIU (Fabio 05/11): com a IA desligada, ao religar a conferência pergunta (retomarComIa).
      if (sent.success) await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cfd, _donoAskedFor: [...ja, ...novos.map((d) => d.dono.toUpperCase())], _donoAskedAt: new Date().toISOString(), _donoResolvedAt: null } as any } });
      if (pessoas.length) await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏠 O imóvel está em nome de ${pessoas.map((d) => d.dono).join(' e ')}, que não é participante. ${sent.success ? 'Perguntei ao cliente quem é essa pessoa pra ele (precisa ser parente de 1º grau ou participante); o card espera a resposta.' : lead.aiAutoReplyActive ? 'A pergunta ao cliente não saiu — pergunte de quem é o imóvel.' : 'IA desligada: pergunte ao cliente de quem é o imóvel (precisa ser parente de 1º grau ou participante).'}` } }).catch(() => {});
      if (empresas.length) await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏢 O documento do imóvel está no nome da EMPRESA ${empresas.map((d) => d.dono).join(' e ')} (pessoa jurídica — em geral a loteadora/construtora, venda ainda não registrada, ou a matrícula-mãe do empreendimento). ${sent.success ? 'Perguntei ao cliente se ele tem a matrícula individual já no nome dele; o card espera. Se ele disser que o imóvel ainda não está no nome dele ou que a empresa é dele, a pergunta vai pro balão Dúvidas da IA.' : lead.aiAutoReplyActive ? 'A pergunta ao cliente não saiu — pergunte se ele tem a matrícula individual no nome dele.' : 'IA desligada: pergunte ao cliente se ele tem a matrícula individual no nome dele.'}` } }).catch(() => {});
    }
    // O dono em aberto NÃO esconde os outros ajustes (Fabio 13/11, Vicente: "era pra o CRM ter solicitado essa CNH dele antes" — a conferência parava na pergunta do dono e a CNH
    // ilegível, o contracheque claro demais e as folhas faltando nunca foram pedidos). O que ainda não foi dito sai numa mensagem à parte, uma vez cada (mesma marca do caminho normal).
    if (review.problemas.length && lead.aiAutoReplyActive) {
      const frP = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
      const cfP = (frP?.customFields || {}) as Record<string, any>;
      const ditosP = new Set<string>(Array.isArray(cfP._docProblemsTold) ? cfP._docProblemsTold : []);
      const naoDitos = review.problemas.filter((p) => !ditosP.has(chaveProblema(p)));
      if (naoDitos.length) {
        const textoP = buildDocProblemsMessage({ ...review, problemas: naoDitos });
        const sentP = await sendOutboundWhatsApp({ accountId, leadId, content: textoP, io: io || undefined });
        if (sentP.success) {
          const quandoP = Object.fromEntries(naoDitos.map((p) => [chaveProblema(p), new Date().toISOString()]));
          await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docProblemsTold}', ${JSON.stringify(Array.from(new Set([...ditosP, ...naoDitos.map(chaveProblema)])))}::jsonb, true), '{_docProblemsToldAt}', COALESCE("customFields"->'_docProblemsToldAt', '{}'::jsonb) || ${JSON.stringify(quandoP)}::jsonb, true) WHERE id = ${leadId}`;
          await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 Junto com a pergunta do dono do imóvel, pedi ao cliente os ajustes nos documentos: ${naoDitos.map((p) => `${p.doc} — ${p.texto.join('; ')}`).join(' | ')}.` } }).catch(() => {});
        }
      }
    }
    return true; // card espera o dono do imóvel ser esclarecido (a pergunta ao cliente já foi feita)
  }
  if ((lead.customFields as any)?._donoAskedAt && !(lead.customFields as any)?._donoResolvedAt) {
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _donoResolvedAt: new Date().toISOString() } as any } });
  }

  // HABITE-SE (Fabio 06/11: "Santander e Creditas só fazem Home Equity para imóveis com habite-se"): certidão de ônus/matrícula que mostra só TERRENO/LOTE e o cliente disse
  // CASA → o CRM pergunta UMA vez se a casa tem habite-se (certidão antiga: avisa que pode ter saído depois). Perguntou agora = a conferência para aqui (o resto segue quando ele responder).
  if (!caixaRota) {
    const passoHabite = await (require('./habite-se.service') as typeof import('./habite-se.service')).habiteNaConferencia(accountId, leadId, io, { podeFalar: true }).catch((e: any) => { console.error('[Habite-se] conferência:', e?.message || e); return null; });
    if (passoHabite === 'PERGUNTOU') return true;
  }

  // Imóvel com financiamento ativo (gravame vigente na matrícula + proposta com saldo): pede o print do saldo devedor (1 vez). Se pediu, o "recebi tudo" vai junto nessa mensagem.
  const pediuSaldo = caixaRota ? false // a CAIXA confere só a documentação pessoal agora (o saldo devedor fica pra depois do resultado dela)
    : await (require('./saldo-devedor.service') as typeof import('./saldo-devedor.service')).maybeAskSaldoDevedor(accountId, leadId, io, { docsReceived: true }).catch((e: any) => { console.error('[Saldo] pedido:', e?.message || e); return false; });

  // Sem matrícula e sem cartório nos documentos: o CRM acha o cartório pelo endereço (Mapa do ONR) e grava no card (Fabio 29/10).
  // DESLIGADO 29/10 21h (Fabio: "para ela agora") — religar quando a consulta ao mapa/web estiver estável:
  // void (require('./cartorio-regiao.service') as typeof import('./cartorio-regiao.service')).ensureCartorioPorEndereco(accountId, leadId);

  const verdict = await evaluateDocs(accountId, leadId);
  // Certidão pelo ONR: autorizada → aciona a extensão (cria o pedido, 1 vez por matrícula); só escritura e ainda sem OK → a IA oferece (1 vez por matrícula).
  if (verdict) {
    const offer = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
    if (verdict.emitir.length) await offer.ensureCertidaoRequest(accountId, leadId).catch((e: any) => console.error('[Certidão] pedido ONR:', e?.message || e));
    else if (verdict.emitirPendente.length) await offer.maybeOfferCertidao(accountId, leadId, io, { porEnderecoOk: true }).catch((e: any) => console.error('[Certidão] oferta:', e?.message || e));
  }
  const faltando = verdict && !verdict.complete ? verdict.faltando : [];
  const faltaTxt = faltando.length ? `\n\nAinda falta mandar:\n${faltando.map((f) => `• ${f}`).join('\n')}` : '';

  // MESMO ERRO REENVIADO (Fabio 07/11): o cliente mandou de novo o documento da mesma família com o mesmo tipo de erro (certidão cortada de novo…) → não pede outra vez;
  // vira ressalva pro colaborador conferir em Documentação Recebida e deixa de segurar o card (nesta e nas próximas conferências).
  let ressalvasAtivas: { doc: string; texto: string[] }[] = [];
  if (review?.problemas.length) {
    const freshR0 = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const cfR0 = (freshR0?.customFields || {}) as Record<string, any>;
    const ressalvas: DocRessalva[] = Array.isArray(cfR0._docRessalvas) ? cfR0._docRessalvas : [];
    const novasProb = review.novas.filter((n) => n.r.resultado === 'PROBLEMA');
    const ids = novasProb.map((n) => n.attId).filter((x): x is string => !!x);
    const horas = ids.length ? await prisma.messageAttachment.findMany({ where: { id: { in: ids } }, select: { id: true, createdAt: true } }) : [];
    const reenviados = novasProb.map((n) => ({ doc: n.r.titular ? `${n.r.tipo} (${n.r.titular})` : n.r.tipo, at: horas.find((h) => h.id === n.attId)?.createdAt || new Date() }));
    const ditos0: string[] = Array.isArray(cfR0._docProblemsTold) ? cfR0._docProblemsTold : [];
    const repetidos = mesmoErroReenviado(review.problemas.filter((p) => !cobertoPorRessalva(p, ressalvas)), reenviados, ditos0, (cfR0._docProblemsToldAt || {}) as Record<string, string>);
    if (repetidos.length) {
      const agora = new Date().toISOString();
      const novasR: DocRessalva[] = repetidos.map((p) => ({ doc: p.doc, fam: familiaDoc(p.doc), cats: p.cats, texto: p.texto.join('; '), at: agora }));
      // Só a chave (jsonb_set): regravar o card inteiro apaga o que outro processo gravou no meio (corrida no customFields, 29/10).
      await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docRessalvas}', ${JSON.stringify([...ressalvas, ...novasR])}::jsonb, true) WHERE id = ${leadId}`;
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ Conferir em Documentação Recebida: ${repetidos.map((p) => `${p.doc} reenviado com o mesmo problema (${p.texto.join('; ')})`).join(' | ')}. O CRM não pediu de novo ao cliente e esse documento não segura mais a documentação.` } }).catch(() => {});
      console.log(`[Docs] ${lead.name} (${leadId}): mesmo erro reenviado — ${repetidos.map((p) => p.doc).join(', ')} virou ressalva`);
      ressalvas.push(...novasR);
    }
    ressalvasAtivas = review.problemas.filter((p) => cobertoPorRessalva(p, ressalvas));
    if (ressalvasAtivas.length) review.problemas = review.problemas.filter((p) => !cobertoPorRessalva(p, ressalvas));
  }

  if (review?.problemas.length) {
    // Um aviso só, e CADA problema é dito UMA vez (Fabio 21/10, Luiz: a IA repetiu "me mande a matrícula e a capa do IPTU" 3 vezes — texto velho de um documento que não serve — depois de ele já ter mandado). O que já foi dito
    // não volta; o card continua parado esperando o cliente (ou o que ainda falta é cobrado pelo caminho normal abaixo).
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const cf = (fresh?.customFields || {}) as Record<string, any>;
    const chave = chaveProblema;
    const ditos = new Set<string>(Array.isArray(cf._docProblemsTold) ? cf._docProblemsTold : []);
    const novos = review.problemas.filter((p) => !ditos.has(chave(p)));
    if (novos.length || opts.force) {
      const alvo = novos.length ? novos : review.problemas;
      const texto = `${buildDocProblemsMessage({ ...review, problemas: alvo }).replace(/\n\nAssim que você reenviar, eu confiro de novo!$/, '')}${faltaTxt}\n\nAssim que você mandar, eu confiro de novo!`;
      const sent = lead.aiAutoReplyActive ? await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined }) : { success: false, error: 'IA desligada no card' };
      // "Já dito" só quando SAIU (Fabio 05/11): com a IA desligada, ao religar a conferência avisa (retomarComIa).
      // Com a hora de cada aviso (`_docProblemsToldAt`): o "mesmo erro reenviado" só conta arquivo que chegou DEPOIS do aviso (Fabio 07/11).
      if (sent.success) {
        const quando = Object.fromEntries(alvo.map((p) => [chave(p), new Date().toISOString()]));
        await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docProblemsTold}', ${JSON.stringify(Array.from(new Set([...ditos, ...alvo.map(chave)])))}::jsonb, true), '{_docProblemsToldAt}', COALESCE("customFields"->'_docProblemsToldAt', '{}'::jsonb) || ${JSON.stringify(quando)}::jsonb, true) WHERE id = ${leadId}`;
      }
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 A IA achou problema em documento: ${alvo.map((p) => `${p.doc} — ${p.texto.join('; ')}`).join(' | ')}.${faltando.length ? ` Ainda falta: ${faltando.join('; ')}.` : ''} ${sent.success ? 'Cliente avisado do que corrigir.' : lead.aiAutoReplyActive ? 'O aviso ao cliente não saiu.' : 'IA desligada: avise o cliente.'}` } }).catch(() => {});
    }
    return !!lead.aiAutoReplyActive;
  }

  if (!verdict) return false;
  const { receivedText } = verdict;
  if (!verdict.complete) {
    console.log(`[Docs] ${lead.name} (${leadId}): ainda falta — ${verdict.faltando.join('; ') || 'sem detalhe'}`);
    let falouFalta = false;
    if (verdict.faltando.length) {
      const resumo = verdict.faltando.join('; ');
      const cf = (lead.customFields || {}) as Record<string, unknown>;
      if (cf._docsFaltando !== resumo || opts.force) {
        // Só a chave, por SQL: `cf` é de ANTES do pedido do saldo devedor lá em cima — regravar o card inteiro apagava o `_saldoDevedor` e o `troco` que ele acabou de gravar
        // (01/11: o troco sumiu e o saldo foi somado de novo ao valor aprovado, que já incluía a quitação).
        // IA ligada: cobra o que falta (uma vez por lista); desligada: quem conversa é a equipe — só nota no card (a lista só fica "dita" quando sai: ao religar, cobra).
        let cobrou = false;
        if (lead.aiAutoReplyActive) {
          // Fabio 15/10: não lista o que chegou — só o que falta (depois da espera de 10 min sem arquivo novo).
          const texto = `Pra fechar a documentação ainda falta:${faltaTxt.replace(/^\n\nAinda falta mandar:/, '')}\n\nPode mandar por aqui mesmo que eu confiro!`;
          const sent = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined });
          cobrou = !!sent.success;
          falouFalta = cobrou;
        }
        if (cobrou) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsFaltando}', ${JSON.stringify(resumo)}::jsonb, true) WHERE id = ${leadId}`;
        await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 A IA conferiu os documentos recebidos (lista "${verdict.listaUsada || '?'}"). Ainda falta:\n- ${verdict.faltando.join('\n- ')}\n${cobrou ? 'Cliente avisado do que falta.' : lead.aiAutoReplyActive ? 'O aviso ao cliente não saiu.' : 'IA desligada: cobre o cliente.'}` } }).catch(() => {});
      }
    }
    return falouFalta;
  }

  // Só a documentação do COMPRADOR (FH com CAIXA/BRB ou sem banco escolhido; ou quem PEDIU a CAIXA, HE e FH — Fabio 01/11): ainda não é contratação — é a vez da análise da
  // CAIXA/BRB. O card fica onde está (quem pediu a CAIXA: na Pré-Análise); o cliente é avisado e o CRM gera a ficha do cadastro (Fabio 29/10, Taynara).
  if (fhSoComprador) {
    if (caixaRota ? cfLead._caixaDocsAt : cfLead._fhDocsCompradorAt) return false;
    const banco: string | null = cfLead._optouCaixa?.banco || (caixaRota ? 'CAIXA' : null);
    const agora = new Date().toISOString();
    // Só a chave (jsonb_set): regravar o card inteiro apaga o que outro processo gravou no meio (corrida no customFields, 29/10).
    if (caixaRota) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaDocsAt}', ${JSON.stringify(agora)}::jsonb, true) WHERE id = ${leadId}`;
    else await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_fhDocsCompradorAt}', ${JSON.stringify(agora)}::jsonb, true) WHERE id = ${leadId}`;
    const sentFh = lead.aiAutoReplyActive
      ? await sendOutboundWhatsApp({ accountId, leadId, content: banco ? `Recebi toda a documentação, obrigada! Já vou dar entrada na análise da ${banco} e te aviso por aqui assim que sair o resultado.` : 'Recebi toda a documentação, obrigada! Já vou dar andamento e te aviso por aqui assim que tiver novidade.', io: io || undefined })
      : { success: false };
    if (!lead.aiAutoReplyActive) await (require('./ia-pendencias.service') as typeof import('./ia-pendencias.service')).guardarPendenciaIa(leadId, 'docsCompletos', `avisar que recebeu toda a documentação${banco ? ` e que vai dar entrada na análise da ${banco}` : ''} e que avisa por aqui quando sair o resultado`);
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 Documentação do comprador COMPLETA (${caixaRota ? (cfLead._caixaRota ? 'o cliente pediu a CAIXA' : 'card na etapa Análise CAIXA') : `Financiamento Habitacional${banco ? ` — ${banco}` : ''}`}):\n${verdict.receivedText}\n\n👉 ${caixaRota ? 'O CRM gera a ficha e a extensão faz o cadastro na CAIXA.' : banco ? `Rodar a análise na ${banco} com esses documentos.` : 'Nenhum banco escolhido ainda.'}${sentFh.success ? ' Cliente avisado.' : ' Cliente NÃO avisado (IA desligada).'}` } }).catch(() => {});
    (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `🏦 ${lead.name}: documentação completa`, body: caixaRota ? 'Ficha e cadastro da CAIXA a caminho' : banco ? `Rodar a análise na ${banco}` : 'Documentação do comprador completa', leadId }).catch(() => {});
    return true;
  }
  // Habite-se em aberto, ou imóvel sem habite-se com proposta do Santander/Creditas em jogo (Fabio 06/11): o card não vai sozinho pra contratação — a equipe decide (nota + push).
  const seguraHabite = await (require('./habite-se.service') as typeof import('./habite-se.service')).segurarContratacaoHabite(accountId, leadId).catch((e: any) => { console.error('[Habite-se] segurar:', e?.message || e); return null; });
  if (seguraHabite) {
    console.log(`[Docs] ${lead.name} (${leadId}): documentação completa, contratação segurada — ${seguraHabite}`);
    return false;
  }
  const moved = await moveLeadToContracting(accountId, leadId, io, 'a IA conferiu que a documentação chegou completa');
  if (!moved) {
    console.warn(`[Docs] ${lead.name} (${leadId}): documentação completa, mas o funil de contratação do setor não foi encontrado`);
    return false;
  }
  // Com a IA desligada a equipe está conversando com o cliente — não manda
  // o aviso automático por cima dela.
  // Matrícula/ônus aceita COM RESSALVA (só consulta ou antiga): a A&F aceita, mas deixa a observação ao cliente (Fabio 15/10) — o banco decide e pode pedir uma nova.
  const freshR = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cfR = (freshR?.customFields || {}) as Record<string, any>;
  const ressalvas = Object.values((cfR._docReview || {}) as Record<string, any>).map((r: any) => r?.ressalva).filter(Boolean) as string[];
  const obsCertidao = ressalvas.length && !cfR._ressalvaCertidaoAt
    ? `\n\nSobre a matrícula/certidão do imóvel que você enviou: ela veio ${ressalvas.includes('CONSULTA') ? 'como "consulta" (não é a certidão oficial)' : 'com mais de 30 dias'}. A gente aceita, mas quem decide é o banco: se ele não aceitar essa versão, a gente emite uma nova pra você pelo cartório digital. Se isso acontecer, eu te aviso. 🙂`
    : '';
  if (obsCertidao && lead.aiAutoReplyActive) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_ressalvaCertidaoAt}', ${JSON.stringify(new Date().toISOString())}::jsonb, true) WHERE id = ${leadId}`;
  // IA desligada (Fabio 05/11): a equipe está na conversa — ao religar, a IA retoma o aviso de documentação completa (e a escolha da proposta, se houver mais de uma aprovada).
  if (!lead.aiAutoReplyActive) await (require('./ia-pendencias.service') as typeof import('./ia-pendencias.service')).guardarPendenciaIa(leadId, 'docsCompletos', `avisar que recebeu toda a documentação e que segue com a contratação (próximos passos: vistoria do imóvel); se houver mais de uma proposta aprovada e nenhuma escolhida, NÃO pergunte por escrito: o CRM manda as propostas com o botão "Seguir com esta" logo depois (Fabio 12/11) — só diga que já vai mandar as propostas pra ele escolher${obsCertidao ? '; observação sobre a certidão: ' + obsCertidao.replace(/\s+/g, ' ').trim() : ''}`);
  // Mais de um banco aprovado e nenhuma proposta escolhida: o "recebi tudo" vai junto da pergunta de com qual proposta seguir (Fabio 28/10).
  const perguntouEscolha = !pediuSaldo && lead.aiAutoReplyActive
    ? await (require('./approval-notice.service') as typeof import('./approval-notice.service')).askProposalChoice(accountId, leadId, io, `Recebi toda a documentação, obrigada!${obsCertidao ? obsCertidao.replace(/^\n\n/, ' ') : ''}`).catch((e: any) => { console.error('[Docs] escolha da proposta:', e?.message); return false; })
    : false;
  const sent = pediuSaldo || perguntouEscolha
    ? { success: true } // a mensagem do saldo devedor (ou a da escolha da proposta) já disse que a documentação chegou
    : lead.aiAutoReplyActive
    ? await sendOutboundWhatsApp({ accountId, leadId, content: `${DOCS_COMPLETE_MESSAGE}${obsCertidao}`, io: io || undefined })
    : { success: false, error: 'IA desligada no card (a equipe avisa o cliente)' };
  if (!sent.success && lead.aiAutoReplyActive) console.error(`[Docs] ${lead.name}: aviso ao cliente não foi enviado:`, sent.error);

  await prisma.note.create({
    data: {
      leadId,
      type: 'COMMENT',
      content: [
        `🤖 A IA conferiu a documentação (lista "${verdict.listaUsada || '?'}") e considerou completa:`,
        receivedText,
        '',
        ...(ressalvasAtivas.length ? ['', `⚠️ CONFERIR (o cliente reenviou com o mesmo problema e o CRM não pediu de novo — Fabio 07/11): ${ressalvasAtivas.map((p) => `${p.doc} — ${p.texto.join('; ')}`).join(' | ')}`] : []),
        ...(verdict.emitir.length ? ['', `⚠️ A&F precisa EMITIR (o cliente autorizou; custo de R$ 40 a R$ 100 pra ele): ${verdict.emitir.join('; ')} — pelo endereço completo com CEP (conferir com o da proposta) ou pelo número da matrícula.`] : []),
        '',
        `Card movido para "${moved.pipelineName}" (${moved.stageName}).${sent.success ? ' Cliente avisado de que o banco pode pedir algum documento a mais.' : lead.aiAutoReplyActive ? '' : ' Cliente NÃO foi avisado automaticamente (IA desligada no card) — avise pela conversa.'}`,
      ].join('\n'),
    },
  });
  logActivity({
    accountId, userId: null, userName: 'Assistente IA', action: 'lead_stage_changed', leadId, leadName: lead.name,
    summary: `conferiu a documentação completa e moveu pra "${moved.stageName}" (${moved.pipelineName})`,
  });
  console.log(`[Docs] ${lead.name} (${leadId}): documentação completa → ${moved.pipelineName} / ${moved.stageName}`);
  return true;
}


// ─── "Conferir documentos" (botão do card, Fabio 28/10) ───────────────────────────────────────────────────────────────────────────────────
// A conferência automática só roda em "Aguardando Documentação" e só quando chega arquivo novo: o Alexandre mandou 12 arquivos em 14/10 que nunca foram lidos, e o
// Wagner foi movido pra contratação com a lista velha do que faltava. O botão roda a MESMA leitura e conferência no servidor, em QUALQUER etapa, SEM mensagem ao cliente
// e SEM mover o card: o resultado vira anotação no card (e atualiza o "o que falta" que a IA da conversa usa). Roda em segundo plano (12 PDFs levam minutos).
const conferindoAgora = new Set<string>();
export const conferenciaEmAndamento = (leadId: string) => conferindoAgora.has(leadId);

export async function conferirDocumentosAgora(accountId: string, leadId: string, userName: string, io?: Io, opts: { tentativa?: number } = {}): Promise<{ completo: boolean; faltando: string[] } | null> {
  if (conferindoAgora.has(leadId)) return null;
  conferindoAgora.add(leadId);
  const marca = await marcarConferencia(leadId, 'botao', { n: opts.tentativa, por: userName }); // reinício no meio → roda de novo ao subir (docs-check-resume)
  try {
    const review = await reviewReceivedDocs(accountId, leadId, { releCertidao: true }).catch((e) => { console.error(`[Docs] botão — leitura falhou (${leadId}):`, e?.message || e); return null; });
    // Habite-se (Fabio 06/11): lê a certidão e anota pra equipe — pelo botão nada vai pro cliente.
    await (require('./habite-se.service') as typeof import('./habite-se.service')).habiteNaConferencia(accountId, leadId, io, { podeFalar: false }).catch((e: any) => console.error('[Habite-se] botão:', e?.message || e));
    const verdict = await evaluateDocs(accountId, leadId).catch((e) => { console.error(`[Docs] botão — conferência falhou (${leadId}):`, e?.message || e); return null; });
    // Arquivos que continuam sem leitura (protegido, grande demais, erro): ficam listados pra alguém olhar.
    const atts = (await prisma.messageAttachment.findMany({ where: { leadId, message: { direction: 'INBOUND' } }, select: { id: true, fileName: true, mimeType: true, driveFileId: true, data: true } }))
      .filter((a) => !/^(audio|video)\//.test(a.mimeType) && !isStickerAttachment(a) && !isScreenshotAttachment(a));
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
    const naoLidos = atts.filter((a) => !(cf._docInfo || {})[a.id]).map((a) => a.fileName || a.id);
    const semConferencia = atts.filter((a) => { const i = (cf._docInfo || {})[a.id]; return i && i !== 'IGNORAR' && !(cf._docReview || {})[a.id]; }).map((a) => `${String((cf._docInfo || {})[a.id]).split('|')[0]} (${a.fileName || a.id})`);
    const quem = userName ? `, por ${userName}` : '';
    if (!verdict) {
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📄 Conferência de documentos (botão${quem}): ${atts.length ? 'não consegui conferir — nenhum arquivo foi lido ou não há lista "Documentos …" pro setor do card.' : 'o cliente não mandou nenhum arquivo.'}${naoLidos.length ? `\nSem leitura: ${naoLidos.join('; ')}` : ''}` } }).catch(() => {});
      return null;
    }
    // Só a chave (Fabio 03/11): regravar o card inteiro apagava o que outro processo gravou no meio — inclusive a correção que a equipe fez no painel de documentos (corrida no customFields, 29/10).
    if (verdict.complete) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) - '_docsFaltando' WHERE id = ${leadId}`;
    else if (verdict.faltando.length) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsFaltando}', ${JSON.stringify(verdict.faltando.join('; '))}::jsonb, true) WHERE id = ${leadId}`;
    const ressalvasCard: DocRessalva[] = Array.isArray(cf._docRessalvas) ? cf._docRessalvas : [];
    const problemas = (review?.problemas || []).map((p) => `${p.doc} — ${p.texto.join('; ')}${cobertoPorRessalva(p, ressalvasCard) ? ' (reenviado com o mesmo problema: o CRM não pede de novo — conferir)' : ''}`);
    const duvidas = (review?.duvidas || []).map((d) => `${d.doc} (${d.arquivo})`);
    await prisma.note.create({
      data: {
        leadId, type: 'COMMENT',
        content: [
          `📄 Conferência de documentos (botão${quem}) — lista "${verdict.listaUsada || '?'}": ${verdict.complete && !problemas.length ? 'COMPLETA ✅' : verdict.complete ? 'chegou tudo, mas tem documento com problema ⚠️' : 'INCOMPLETA'}`,
          `Recebido:\n${verdict.receivedText}`,
          ...(verdict.faltando.length ? [`Falta:\n- ${verdict.faltando.join('\n- ')}`] : []),
          ...(problemas.length ? [`Com problema:\n- ${problemas.join('\n- ')}`] : []),
          ...(duvidas.length ? [`Em dúvida (balão Dúvidas da IA): ${duvidas.join('; ')}`] : []),
          ...(verdict.emitir.length ? [`A&F precisa emitir: ${verdict.emitir.join('; ')}`] : []),
          ...(naoLidos.length ? [`Sem leitura (confira à mão): ${naoLidos.join('; ')}`] : []),
          ...(semConferencia.length ? [`Classificados mas SEM conferência (a leitura não saiu — confira à mão): ${semConferencia.join('; ')}`] : []),
          'Nenhuma mensagem foi enviada ao cliente e o card não foi movido.',
        ].join('\n\n'),
      },
    }).catch(() => {});
    // Pasta do Drive já montada: reorganiza com o que foi lido agora (folhas da matrícula PAG 1, 2…; repetidos e sem uso em DESNECESSARIO — Fabio 05/11).
    // A pasta dos anexos só LIGADA ao card pro cadastro da CAIXA não é pasta montada: não vai pra LEADS ATIVOS por causa do botão (Fabio 12/11).
    if (cf._driveOrganizedAt || (cf.link_pasta_drive && !(require('./ficha-cadastral.service') as typeof import('./ficha-cadastral.service')).pastaDoCadastroCrua(cf))) {
      const { organizeLeadDocsNow } = require('./received-docs.service') as typeof import('./received-docs.service');
      await organizeLeadDocsNow(leadId).catch((e: any) => console.error(`[Docs] botão — não reorganizei a pasta (${leadId}):`, e?.message || e));
    }
    if (io) io.to(`lead:${leadId}`).emit('lead_updated', { leadId });
    return { completo: verdict.complete, faltando: verdict.faltando };
  } finally {
    conferindoAgora.delete(leadId);
    await desmarcarConferencia(leadId, 'botao', marca);
  }
}

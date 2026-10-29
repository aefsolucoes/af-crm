import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { fixedRule } from './fixed-rules.service';
import { buildSharedAiContext, buildContextBlocks, aiEmailsContext, EMAIL_RELAY_RULES, CORE_RULES, stripOpeningInterjection } from './ai-shared.service';


/**
 * Sugestão de resposta pro COLABORADOR (não confundir com ai-auto-reply.
 * service.ts, que conversa direto com o cliente sozinho quando ligado numa
 * conversa). Aqui é sob demanda — o colaborador clica "Sugerir resposta"
 * quando trava numa objeção — e a IA nunca envia nada sozinha: só sugere um
 * texto, que fica no balão até o colaborador clicar "Usar" (coloca no campo
 * de digitar) e revisar/enviar ele mesmo.
 *
 * Usa o MESMO "cérebro" (ai-shared.service.ts) que o auto-reply — mesma
 * Base de Conhecimento, mesmas regras de confiança/tom. A única diferença
 * estrutural é que aqui NUNCA precisa decidir "chamar um humano" (o
 * vendedor já é o humano revisando), então não tem regras de handoff nem
 * formato JSON — só o texto puro da sugestão.
 */

const ROLE_FRAMING = `Você é um coach de vendas ajudando um vendedor da A&F Soluções Financeiras a responder um cliente pelo WhatsApp. Sugira o que ELE deveria escrever agora — você não fala com o cliente, o vendedor vai revisar e decidir se manda.`;

const OUTPUT_FORMAT = `FORMATO DE RESPOSTA — OBRIGATÓRIO:
Responda SOMENTE com o texto da mensagem sugerida — sem aspas, sem explicação, sem markdown.`;

export interface ReplySuggestion {
  suggestion: string;
}

/** Gera 1 sugestão de resposta pro colaborador, com base no histórico recente
 *  da conversa + Base de Conhecimento + Respostas Rápidas do setor do lead
 *  (mesmo material que o auto-reply usa). Retorna null se faltar configuração,
 *  não houver histórico, ou algo der errado. */
export async function generateReplySuggestion(accountId: string, leadId: string): Promise<ReplySuggestion | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    // Última mensagem do CLIENTE — é o foco da busca na Base de
    // Conhecimento (o que o vendedor está tentando responder/contornar
    // agora). Busca leve só pra achar esse foco e confirmar que existe
    // histórico; buildSharedAiContext monta o resto formatado.
    const recent = await prisma.message.findMany({ where: { leadId, channel: { not: 'EMAIL' } }, orderBy: { createdAt: 'desc' }, take: 12 });
    if (!recent.length) return null;
    const lastClientMsg = recent.find((m) => m.direction === 'INBOUND')?.content || '';

    const ctx = await buildSharedAiContext(accountId, leadId, lastClientMsg, {
      fullHistory: true,
      historyRoleLabels: { inbound: 'Cliente', outbound: 'Vendedor' },
    });
    if (!ctx) return null;

    const emailsProcesso = await aiEmailsContext(leadId).catch(() => '');
    const coreRules = await fixedRule(accountId, 'CORE_RULES', CORE_RULES);
    const roleFraming = await fixedRule(accountId, 'SUGGESTION_ROLE_FRAMING', ROLE_FRAMING);
    const relayRules = emailsProcesso ? await fixedRule(accountId, 'EMAIL_RELAY_RULES', EMAIL_RELAY_RULES) : '';
    const systemPrompt = `${roleFraming}

${coreRules}
${emailsProcesso ? `\n${relayRules}\n` : ''}${OUTPUT_FORMAT}

${buildContextBlocks(ctx)}${emailsProcesso ? `\n\n${emailsProcesso}` : ''}`;

    // Achado real (2026-09-24): "às vezes" a sugestão falhava com o erro
    // genérico "sem histórico ou IA indisponível" mesmo numa conversa cheia
    // de mensagens -- confirmado via log que a chamada de verdade batia na
    // Anthropic (~5s, tempo de round-trip real), só que às vezes ela volta
    // 200 OK só que sem nenhum bloco de texto usável (raw vazio), e esse
    // caminho não logava nada, então não dava pra saber a causa real na
    // próxima vez que acontecesse. Uma segunda tentativa automática (sem
    // pedir pro usuário clicar de novo) resolve a maior parte dos casos
    // transitórios sozinha; se as duas falharem, agora fica registrado o
    // motivo de verdade (status, stop_reason, tipos de bloco devolvidos).
    // Chave de economia (página Medição, Fabio 19/10): a sugestão passa sempre pela revisão da equipe, então pode usar o modelo menor (Haiku 4.5 ≈ 70% mais barato). Desligada = Sonnet, como antes.
    const { getAiCostSettings } = require('./ai-cost-setting.service') as typeof import('./ai-cost-setting.service');
    const modelo = (await getAiCostSettings(accountId)).suggestHaiku ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-5';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: modelo,
          // 300 acabava no raciocínio do modelo e a sugestão vinha vazia (o
          // erro intermitente do "Sugerir resposta").
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: 'user', content: 'Sugira a próxima resposta.' }],
        }),
      });
      if (!response.ok) {
        console.error(`[AI Suggest-reply] Erro Anthropic (tentativa ${attempt}/2):`, response.status, (await response.text()).slice(0, 300));
        if (attempt === 2) return null;
        continue;
      }
      const data = await response.json() as { content: { type: string; text?: string }[]; stop_reason?: string };
      const raw = data.content?.find((b) => b.type === 'text')?.text?.trim() || '';
      if (!raw) {
        console.error(`[AI Suggest-reply] Resposta sem texto usável (tentativa ${attempt}/2): stop_reason=${data.stop_reason}, blocos=${JSON.stringify(data.content?.map((b) => b.type))}`);
        if (attempt === 2) return null;
        continue;
      }
      return { suggestion: stripOpeningInterjection(raw) };
    }
    return null;
  } catch (err) {
    console.error('[AI Suggest-reply] Erro ao gerar sugestão:', err);
    return null;
  }
}


// ─── Sugestão de TEMPLATE pra conversa FECHADA (Fabio 22/10: "preciso que dê sugestão de template também, para conversas fechadas" + "que venha escrito os que são de marketing e os que são de utilidade") ───
// Com a janela de 24 h do WhatsApp fechada só sai template aprovado pela Meta. Em 22/10 (caso Pedro) o template genérico era de Marketing, já tinha sido mandado 3 vezes e a Meta recusou (131049): a escolha precisa
// olhar a categoria (Utilidade pra assunto do processo em andamento; Marketing só pra reativar interesse) e o que já foi mandado a esse cliente.
export interface TemplateSuggestion {
  template: { name: string; status: string; category: string; language: string; components: { type: string; text?: string }[] } | null;
  categoryLabel: string | null;
  vars: Record<string, string>;
  preview: string;
  reason: string;
  alternatives: { name: string; categoryLabel: string }[];
  warnings: string[];
  noneFits: boolean;
  missing: string;
  candidates: number;
}

export const categoryLabel = (c: string): string => (c === 'UTILITY' ? 'Utilidade' : c === 'MARKETING' ? 'Marketing' : c === 'AUTHENTICATION' ? 'Autenticação' : c || '—');
const bodyOf = (t: { components?: { type: string; text?: string }[] }) => t.components?.find((c) => c.type === 'BODY')?.text || '';
const fillVars = (text: string, vars: Record<string, string>) => text.replace(/\{\{(\d+)\}\}/g, (_, n) => vars[n] || `{{${n}}}`);

const TEMPLATE_ROLE = `Você ajuda o vendedor da A&F Soluções Financeiras a escolher o TEMPLATE de WhatsApp certo pra reabrir uma conversa FECHADA (a janela de 24 h do WhatsApp fechou: só template aprovado pela Meta pode ser enviado; texto livre não sai).

REGRAS:
- Escolha UM template da lista de CANDIDATOS que combine com o momento do cliente (etapa do funil, histórico, e-mails recentes). Nunca invente template nem mude o texto dele.
- UTILIDADE: mensagem sobre algo que já está em andamento (processo de crédito, documentos, vistoria, análise, contrato, atualização). Custa bem menos e NÃO sofre o limite de "engajamento saudável" da Meta (erro 131049). Quando o cliente já está em atendimento/contratação e o assunto é o processo dele, PREFIRA Utilidade.
- MARKETING: só pra reativar o interesse de quem esfriou (follow-up, remarketing, boas-vindas, venda futura, condições de crédito). É mais caro e a Meta recusa quando o mesmo template (ou parecido) foi mandado há pouco a esse cliente sem ele responder. NÃO sugira Marketing repetido: se um template de Marketing foi mandado a este cliente nos últimos 7 dias (lista abaixo), escolha outro, prefira Utilidade ou diga que nenhum serve.
- {{1}} é o primeiro nome do cliente. Outras variáveis: preencha só se der pra tirar da conversa; senão deixe vazio e avise em "missing".
- Se nenhum candidato serve bem, "noneFits": true e, em "missing", diga o tipo de template que faria falta (Utilidade ou Marketing) e o assunto.

FORMATO — OBRIGATÓRIO: responda SOMENTE com um JSON, sem markdown:
{"template":"nome_exato","vars":{"1":"Nome"},"reason":"1 a 2 frases curtas dizendo por que esse","alternatives":["outro_nome"],"noneFits":false,"missing":""}`;

export async function generateTemplateSuggestion(accountId: string, leadId: string): Promise<TemplateSuggestion | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true, pipeline: { select: { departmentId: true } } } });
    if (!lead) return null;
    const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
    const all = await listMetaTemplates(accountId, lead.pipeline?.departmentId || null);
    const candidates = all.filter((t: any) => t.status === 'APPROVED' && (t.category === 'UTILITY' || t.category === 'MARKETING') && !/^permissao_ligar/.test(t.name));
    if (!candidates.length) return { template: null, categoryLabel: null, vars: {}, preview: '', reason: '', alternatives: [], warnings: [], noneFits: true, missing: 'Nenhum template aprovado de Utilidade ou Marketing.', candidates: 0 };

    const ctx = await buildSharedAiContext(accountId, leadId, '', { fullHistory: true, historyRoleLabels: { inbound: 'Cliente', outbound: 'Vendedor' } });
    if (!ctx) return null;
    const since30 = new Date(Date.now() - 30 * 86_400_000);
    const sentTpl = await prisma.message.findMany({ where: { leadId, direction: 'OUTBOUND', templateName: { not: null }, createdAt: { gte: since30 } }, orderBy: { createdAt: 'desc' }, take: 15, select: { templateName: true, createdAt: true, status: true, statusError: true } });
    const catOf = new Map<string, string>(all.map((t: any) => [t.name, t.category]));
    const dias = (d: Date) => Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
    const sentTxt = sentTpl.length
      ? sentTpl.map((m) => `- ${m.templateName} [${categoryLabel(catOf.get(m.templateName || '') || '')}] há ${dias(m.createdAt)} dia(s)${m.status === 'FAILED' ? ` — FALHOU${/131049/.test(m.statusError || '') || /engajamento saudável/i.test(m.statusError || '') ? ' (limite de engajamento saudável da Meta)' : ''}` : ''}`).join('\n')
      : '(nenhum template foi enviado a este cliente nos últimos 30 dias)';
    const lastIn = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const emails = await prisma.message.findMany({ where: { leadId, channel: 'EMAIL', createdAt: { gte: new Date(Date.now() - 10 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 4, select: { direction: true, content: true, createdAt: true } });
    const emailsTxt = emails.length ? emails.reverse().map((m) => `- ${m.direction === 'INBOUND' ? 'recebido' : 'enviado'} em ${m.createdAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}: ${m.content.replace(/\s+/g, ' ').slice(0, 380)}`).join('\n') : '(sem e-mails recentes)';
    const candTxt = candidates.map((t: any) => {
      const body = bodyOf(t).replace(/\n+/g, ' ');
      const nv = [...new Set((body.match(/\{\{(\d+)\}\}/g) || []))].length;
      return `- ${t.name} [${categoryLabel(t.category).toUpperCase()}] (${nv} variável(is)): ${body.slice(0, 420)}`;
    }).join('\n');

    const templateRole = await fixedRule(accountId, 'TEMPLATE_ROLE', TEMPLATE_ROLE);
    const system = `${templateRole}

--- ${todayLine()} ---

--- NOME DO CLIENTE ---
${ctx.nomeTexto}

--- ETAPA ATUAL DO CARD (funil → etapa) ---
${ctx.etapaTexto}
${ctx.bancoTexto ? `Banco do processo: ${ctx.bancoTexto}\n` : ''}
--- ÚLTIMA MENSAGEM DO CLIENTE NO WHATSAPP ---
${lastIn ? `há ${dias(lastIn.createdAt)} dia(s) (janela de 24 h fechada)` : 'o cliente nunca respondeu por WhatsApp'}

--- TEMPLATES JÁ ENVIADOS A ESTE CLIENTE (últimos 30 dias) ---
${sentTxt}

--- E-MAILS RECENTES DO PROCESSO ---
${emailsTxt}

--- HISTÓRICO RECENTE DA CONVERSA (WhatsApp) ---
${ctx.historicoTexto}

--- CANDIDATOS (templates aprovados) ---
${candTxt}`;

    const { getAiCostSettings } = require('./ai-cost-setting.service') as typeof import('./ai-cost-setting.service');
    const modelo = (await getAiCostSettings(accountId)).suggestHaiku ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-5';
    let raw = '';
    for (let attempt = 1; attempt <= 2 && !raw; attempt++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelo, max_tokens: 2048, system, messages: [{ role: 'user', content: 'Qual template devo usar agora com este cliente?' }] }),
      });
      if (!response.ok) { console.error(`[AI Suggest-template] Erro Anthropic (${attempt}/2):`, response.status, (await response.text()).slice(0, 300)); continue; }
      const data = await response.json() as { content: { type: string; text?: string }[] };
      raw = data.content?.find((b) => b.type === 'text')?.text?.trim() || '';
    }
    if (!raw) return null;
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return null;
    let j: any;
    try { j = JSON.parse(m[0]); } catch { return null; }

    const byName = new Map<string, any>(candidates.map((t: any) => [t.name, t]));
    const chosen = typeof j.template === 'string' ? byName.get(j.template) : null;
    const vars: Record<string, string> = {};
    if (chosen && j.vars && typeof j.vars === 'object') for (const [k, v] of Object.entries(j.vars)) if (/^\d+$/.test(k) && typeof v === 'string') vars[k] = v.trim().slice(0, 120);
    const firstName = ctx.nomeTexto.split(' (')[0].trim();
    if (chosen && bodyOf(chosen).includes('{{1}}') && !vars['1'] && firstName && !/NÃO é um nome/.test(ctx.nomeTexto)) vars['1'] = firstName;
    const warnings: string[] = [];
    if (chosen) {
      const rec = sentTpl.filter((x) => x.templateName === chosen.name && Date.now() - x.createdAt.getTime() < 14 * 86_400_000);
      if (rec.length) warnings.push(`Este template já foi enviado a este cliente há ${dias(rec[0].createdAt)} dia(s)${rec.length > 1 ? ` (${rec.length} vezes)` : ''}.`);
      if (chosen.category === 'MARKETING') {
        const mk = sentTpl.filter((x) => catOf.get(x.templateName || '') === 'MARKETING' && Date.now() - x.createdAt.getTime() < 7 * 86_400_000);
        if (mk.length) warnings.push(`Já foi mandado Marketing a este cliente há ${dias(mk[0].createdAt)} dia(s): a Meta pode recusar (limite de engajamento saudável, erro 131049).`);
      }
      const faltando = [...new Set((bodyOf(chosen).match(/\{\{(\d+)\}\}/g) || []).map((x: string) => x.replace(/\D/g, '')))].filter((n) => !vars[n]);
      if (faltando.length) warnings.push(`Preencha ${faltando.map((n) => `{{${n}}}`).join(', ')} antes de enviar.`);
    }
    const alternatives = (Array.isArray(j.alternatives) ? j.alternatives : []).filter((n: unknown) => typeof n === 'string' && byName.has(n) && n !== chosen?.name).slice(0, 3).map((n: string) => ({ name: n, categoryLabel: categoryLabel(byName.get(n).category) }));
    return {
      template: chosen ? { name: chosen.name, status: chosen.status, category: chosen.category, language: chosen.language, components: chosen.components } : null,
      categoryLabel: chosen ? categoryLabel(chosen.category) : null,
      vars,
      preview: chosen ? fillVars(bodyOf(chosen), vars) : '',
      reason: String(j.reason || '').slice(0, 400),
      alternatives,
      warnings,
      noneFits: !chosen || j.noneFits === true,
      missing: String(j.missing || '').slice(0, 300),
      candidates: candidates.length,
    };
  } catch (err) {
    console.error('[AI Suggest-template] Erro ao sugerir template:', err);
    return null;
  }
}

function todayLine(): string {
  const { todayContextLine } = require('./ai-shared.service') as typeof import('./ai-shared.service');
  return todayContextLine();
}

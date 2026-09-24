import { PrismaClient } from '@prisma/client';
import { getOrCreateInboxPipeline } from './department.service';
import { generateAiAutoReply } from './ai-auto-reply.service';
import { applyAiExtractedActions } from './ai-shared.service';
import { logActivity } from './activity.service';
import { normalizeClientName } from '../lib/text';
// maybeSalesBotStep/runAutomations/maybeMessageReceivedAutomations: require()
// tardio (dentro da função, não aqui em cima) — salesbot.service.ts e
// automation.service.ts importam de volta este arquivo (pra mandar
// mensagem), um import estático nos dois sentidos criaria dependência
// circular.

const prisma = new PrismaClient();

/**
 * Config da API Oficial. Um WhatsAppConfig por DEPARTAMENTO agora (não mais
 * por conta) — cada setor pode ter seu próprio número (ex: Financiamento
 * Habitacional e Consórcio).
 * - departmentId informado (setor de verdade): tenta achar a config EXATA
 *   desse setor; se esse setor ainda não tiver um número próprio (comum —
 *   nem toda conta configura um número por setor), cai pra config
 *   "genérica" ou a única que a conta tiver, em vez de simplesmente falhar.
 * - departmentId ausente/null: direto pra "genérica ou a única".
 */
export async function getWhatsAppConfig(accountId: string, departmentId?: string | null) {
  if (departmentId) {
    const exact = await prisma.whatsAppConfig.findFirst({ where: { accountId, departmentId } });
    if (exact) return exact;
  }
  return (
    (await prisma.whatsAppConfig.findFirst({ where: { accountId, departmentId: null } })) ||
    (await prisma.whatsAppConfig.findFirst({ where: { accountId } }))
  );
}

export async function saveWhatsAppConfig(accountId: string, departmentId: string | null, data: {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  active: boolean;
}) {
  // upsert() exigiria a chave composta accountId_departmentId, que o Prisma
  // não deixa usar com NULL — faz o "upsert" na mão via id.
  if (departmentId) {
    const existing = await prisma.whatsAppConfig.findFirst({ where: { accountId, departmentId } });
    if (existing) return prisma.whatsAppConfig.update({ where: { id: existing.id }, data });
    return prisma.whatsAppConfig.create({ data: { accountId, departmentId, ...data } });
  }
  // Sem setor escolhido no seletor: atualiza a config "genérica" se existir;
  // senão, se a conta já tiver QUALQUER config (ex: migrada pra um setor na
  // hora que os departamentos foram criados), atualiza essa mesma — evita
  // criar uma config duplicada só porque salvou sem trocar o seletor de setor.
  const generic = await prisma.whatsAppConfig.findFirst({ where: { accountId, departmentId: null } });
  if (generic) return prisma.whatsAppConfig.update({ where: { id: generic.id }, data });
  const anyExisting = await prisma.whatsAppConfig.findFirst({ where: { accountId } });
  if (anyExisting) return prisma.whatsAppConfig.update({ where: { id: anyExisting.id }, data });
  return prisma.whatsAppConfig.create({ data: { accountId, departmentId: null, ...data } });
}

// ─── Templates do WhatsApp (Meta) ────────────────────────────────────────────
// Templates precisam ser aprovados pela Meta antes de poder enviar mensagem
// fora da janela de 24h de atendimento. Usam o WABA ID salvo em WhatsAppConfig.
// Compartilhado entre a tela de Configurações (settings.ts) e o assistente de
// IA (ai.ts) — a lógica de chamar a Graph API mora só aqui.

/** Nome técnico do template exigido pela Meta: minúsculo, só letras/números/_. */
export function slugifyTemplateName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 512);
  return slug || 'template';
}

export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

/** Lista os templates da conta na Meta, com status de aprovação. Lança erro
 *  (Error) com mensagem pronta para mostrar ao usuário/colaborador em caso de
 *  falha (WABA/token não configurado, erro da Graph API etc). */
export async function listMetaTemplates(accountId: string, departmentId?: string | null): Promise<any[]> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config?.accessToken) throw new Error('Configure o Access Token primeiro (aba API Oficial).');
  if (!config.wabaId) throw new Error('Informe o WABA ID em "Ativar recebimento" primeiro.');

  // Incidente real: essa chamada pra Meta não tinha limite de tempo nenhum —
  // se a Meta demorasse/travasse, o pedido ficava pendurado pra sempre, e
  // como o front só tenta buscar 1x por sessão, o colaborador ficava
  // travado sem conseguir nem tentar de novo (nem recarregando a tela
  // resolvia sozinho). Grave porque template é a ÚNICA forma de mandar
  // mensagem quando a janela de 24h fecha. Agora desiste depois de 15s com
  // um erro claro, em vez de travar pra sempre.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let r: Response;
  try {
    r = await fetch(
      `https://graph.facebook.com/v20.0/${config.wabaId}/message_templates?fields=name,status,category,language,components,rejected_reason&limit=100`,
      { headers: { Authorization: `Bearer ${config.accessToken}` }, signal: controller.signal },
    );
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('A Meta demorou demais pra responder (mais de 15s) — tente de novo em instantes.');
    throw new Error(`Falha de conexão com a Meta: ${err?.message || err}`);
  } finally {
    clearTimeout(timeout);
  }
  const j = await r.json() as any;
  if (!r.ok || j.error) {
    const code = j.error?.code ?? r.status;
    const msg = j.error?.error_user_msg || j.error?.message || 'Erro desconhecido';
    throw new Error(`${msg} (código: ${code})`);
  }
  return j.data || [];
}

/** Botões de um template MARKETING/UTILITY (AUTHENTICATION tem o próprio
 *  botão fixo de copiar código, ver abaixo — não usa isto). Mesmo limite
 *  "seguro" que o próprio WhatsApp Business App oferece: até 3 de resposta
 *  rápida, 1 de link e 1 de telefone (misturar tipos além disso a Meta pode
 *  rejeitar). O texto do link pode terminar em "{{1}}" pra um sufixo
 *  dinâmico (ex.: "https://af.com.br/proposta/{{1}}") — por isso a URL não é
 *  validada como link estrito, só como texto não vazio. */
export interface MetaTemplateButtons {
  quickReplies?: string[];
  url?: { text: string; url: string } | null;
  phone?: { text: string; phoneNumber: string } | null;
}

function buildButtonsComponent(buttons?: MetaTemplateButtons): Record<string, unknown> | null {
  if (!buttons) return null;
  const list: Record<string, unknown>[] = [];
  for (const label of (buttons.quickReplies || []).map((s) => s.trim()).filter(Boolean).slice(0, 3)) {
    list.push({ type: 'QUICK_REPLY', text: label });
  }
  if (buttons.url?.text?.trim() && buttons.url?.url?.trim()) {
    const url = buttons.url.url.trim();
    // URL com variável ({{1}} no fim, pra sufixo dinâmico) exige um "example"
    // com a URL completa — sem isso a Meta rejeita com INVALID_FORMAT, do
    // mesmo jeito que o corpo. A tela ainda não coleta esse exemplo, então
    // bloqueia com uma mensagem clara em vez de deixar a Meta recusar.
    if (url.includes('{{')) {
      throw new Error('Botão de link com variável ({{1}}) ainda não é suportado aqui — use uma URL fixa.');
    }
    list.push({ type: 'URL', text: buttons.url.text.trim(), url });
  }
  if (buttons.phone?.text?.trim() && buttons.phone?.phoneNumber?.trim()) {
    list.push({ type: 'PHONE_NUMBER', text: buttons.phone.text.trim(), phone_number: buttons.phone.phoneNumber.trim() });
  }
  return list.length ? { type: 'BUTTONS', buttons: list } : null;
}

/**
 * Monta o "example.body_text" que a Meta exige quando o corpo tem {{1}}, {{2}}…
 * Sem esse exemplo, TODO template com variável é rejeitado com INVALID_FORMAT.
 * Valida também que as variáveis são sequenciais (1,2,3… sem pular) e que os
 * exemplos não têm quebra de linha / espaços demais (a Meta recusa).
 * Retorna null quando o corpo não tem variável (aí nem manda "example").
 */
function buildBodyExample(bodyText: string, rawExamples?: string[]): { body_text: string[][] } | null {
  const nums = [...bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  if (nums.length === 0) return null;

  const unique = [...new Set(nums)].sort((a, b) => a - b);
  const sequential = unique.every((n, i) => n === i + 1);
  if (!sequential) {
    throw new Error(`As variáveis do corpo precisam ser {{1}}, {{2}}, {{3}}… em sequência, sem pular número (achei: ${unique.map((n) => `{{${n}}}`).join(', ')}).`);
  }

  const maxVar = unique[unique.length - 1];
  const examples = (rawExamples || []).slice(0, maxVar).map((s) => (s ?? '').trim());
  if (examples.length < maxVar || examples.some((s) => !s)) {
    throw new Error(`Dê um exemplo pra cada variável do corpo ({{1}}…{{${maxVar}}}) — a Meta rejeita template com variável e sem exemplo (INVALID_FORMAT).`);
  }
  const bad = examples.find((s) => /[\n\t]/.test(s) || /\s{5,}/.test(s));
  if (bad) {
    throw new Error(`O exemplo "${bad}" tem quebra de linha ou espaços demais — a Meta não aceita isso num exemplo de variável.`);
  }
  return { body_text: [examples] };
}

/** Envia um novo template para aprovação da Meta. Lança erro (Error) com
 *  mensagem pronta para mostrar em caso de falha. */
export async function createMetaTemplate(accountId: string, params: {
  name: string;
  category: TemplateCategory;
  language?: string;
  body?: string;
  footer?: string;
  /** Só usado em AUTHENTICATION: minutos até o código expirar (padrão 10). */
  codeExpirationMinutes?: number;
  /** Botões (MARKETING/UTILITY) — ver buildButtonsComponent. */
  buttons?: MetaTemplateButtons;
  /** Exemplo de cada variável do corpo ({{1}}, {{2}}…), na ordem. Obrigatório
   *  quando o corpo tem variável — ver buildBodyExample. */
  bodyExamples?: string[];
}, departmentId?: string | null): Promise<any> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config?.accessToken) throw new Error('Configure o Access Token primeiro (aba API Oficial).');
  if (!config.wabaId) throw new Error('Informe o WABA ID em "Ativar recebimento" primeiro.');

  const { name, category, language = 'pt_BR', body, footer, codeExpirationMinutes } = params;

  let components: Record<string, unknown>[];
  if (category === 'AUTHENTICATION') {
    // Autenticação: a Meta gera o texto do código sozinha — o componente BODY
    // não pode ter "text" (é rejeitado com código 100). Só dá pra configurar a
    // recomendação de segurança, a expiração do código e o botão de copiar.
    components = [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: codeExpirationMinutes ?? 10 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
    ];
  } else {
    if (!body?.trim()) throw new Error('Corpo da mensagem é obrigatório para esta categoria.');
    const bodyText = body.trim();
    const bodyComponent: Record<string, unknown> = { type: 'BODY', text: bodyText };
    const example = buildBodyExample(bodyText, params.bodyExamples);
    if (example) bodyComponent.example = example;
    components = [bodyComponent];
    if (footer?.trim()) components.push({ type: 'FOOTER', text: footer.trim() });
    const buttonsComponent = buildButtonsComponent(params.buttons);
    if (buttonsComponent) components.push(buttonsComponent);
  }

  const r = await fetch(`https://graph.facebook.com/v20.0/${config.wabaId}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: slugifyTemplateName(name), category, language, components }),
  });
  const j = await r.json() as any;
  if (!r.ok || j.error) {
    const code = j.error?.code ?? r.status;
    const msg = j.error?.error_user_msg || j.error?.message || 'Erro desconhecido';
    throw new Error(`${msg} (código: ${code})`);
  }
  return j;
}

/** Exclui um template já criado (aprovado, rejeitado ou pendente) na Meta —
 *  a Graph API apaga pelo NOME do template, não por id. Lança erro (Error)
 *  com mensagem pronta para mostrar em caso de falha. */
export async function deleteMetaTemplate(accountId: string, name: string, departmentId?: string | null): Promise<void> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config?.accessToken) throw new Error('Configure o Access Token primeiro (aba API Oficial).');
  if (!config.wabaId) throw new Error('Informe o WABA ID em "Ativar recebimento" primeiro.');

  const r = await fetch(
    `https://graph.facebook.com/v20.0/${config.wabaId}/message_templates?name=${encodeURIComponent(name)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${config.accessToken}` } },
  );
  const j = await r.json() as any;
  if (!r.ok || j.error) {
    const code = j.error?.code ?? r.status;
    const msg = j.error?.error_user_msg || j.error?.message || 'Erro desconhecido';
    throw new Error(`${msg} (código: ${code})`);
  }
}

/** Garante DDI 55 e o 9º dígito do celular brasileiro (ex: 556184549012 → 5561984549012). */
/** Normaliza um telefone BR pra E.164 (com DDI 55) — inclui o 9º dígito
 *  quando falta (número móvel sem ele, ex.: "6182667819" → "556198266
 *  7819"): DDD + 8 dígitos locais começando em 6-9 é celular sem o 9º
 *  dígito (fixo começa em 2-5, não leva 9). Exportada porque tanto o envio
 *  quanto o cadastro de telefone (routes/leads.ts) precisam da MESMA regra
 *  — sem isso, o mesmo número gravado com/sem o 9 vira dois contatos
 *  diferentes pro sistema (já aconteceu: telefone_1 salvo sem essa
 *  normalização criou um Contact duplicado). */
export function normalizeBrazilianWhatsAppPhone(to: string): string {
  let phone = to.replace(/\D/g, '');

  if (phone.length === 10 || phone.length === 11) {
    phone = `55${phone}`;
  }

  if (phone.length === 12 && phone.startsWith('55')) {
    const local = phone.slice(4); // 8 dígitos locais (ex: 84549012)
    const first = parseInt(local[0], 10);
    if (first >= 6 && first <= 9) {
      phone = phone.slice(0, 4) + '9' + local; // 5561 + 9 + 84549012
    }
  }

  return phone;
}

/** Traduz/explica os erros mais comuns que a Meta devolve — o texto original
 *  vem cru, em inglês, cheio de jargão da API, sem dizer o que fazer a
 *  respeito. Usado tanto na falha síncrona (parseGraphError, abaixo) quanto
 *  na falha assíncrona reportada depois por webhook (processWhatsAppStatus).
 *  null = código ainda não mapeado; quem chama decide o que fazer nesse caso
 *  (mostra o texto original da Meta, não perde a informação). */
function friendlyWhatsAppError(code: number | undefined): string | null {
  switch (code) {
    case 190:
      return 'Token de acesso inválido ou expirado. Acesse Configurações → API Oficial e gere um novo token.';
    case 131047:
      return 'Não é possível enviar texto livre: já se passaram mais de 24h desde a última mensagem do cliente. Envie um template aprovado pela Meta (aba Templates) para reabrir a conversa.';
    case 131026:
      return 'Esse número não tem WhatsApp (ou está em formato inválido) — confira o telefone cadastrado no card.';
    case 131031:
      return 'A conta do WhatsApp Business está restrita pela Meta no momento — não é possível enviar mensagens até a Meta liberar.';
    case 131048:
    case 130429:
      return 'Limite de envio da Meta atingido (muitas mensagens em pouco tempo) — espere um pouco e tente de novo.';
    case 133010:
      return 'O número configurado na API Oficial não está registrado/ativo na Meta — confira em Configurações → API Oficial.';
    case 131042:
      return 'A Meta bloqueou o envio de mensagens por pendência de pagamento na conta do WhatsApp Business (fatura em aberto ou forma de pagamento com problema) — acesse o Gerenciador de Negócios da Meta (business.facebook.com), aba Pagamentos, e regularize pra voltar a enviar.';
    case 131049:
      return 'A Meta bloqueou só esta mensagem por um limite de "engajamento saudável" — acontece quando várias mensagens parecidas são mandadas pro mesmo número em pouco tempo sem ele responder. Não é a conta toda bloqueada, só essa tentativa: espere algumas horas e tente de novo, evitando repetir a mesma mensagem várias vezes seguidas pro mesmo contato.';
    case 131053:
      return 'O arquivo de áudio enviado não é um áudio válido de verdade (o conteúdo não bate com o formato declarado) — tente gravar de novo. Se continuar acontecendo, tente enviar o áudio como um arquivo comum em vez de gravar pelo microfone.';
    default:
      return null;
  }
}

/** Interpreta o erro da Graph API num formato consistente. */
function parseGraphError(json: { error?: { message: string; code: number } }, res: Response, phone: string): string {
  const errMsg  = json.error?.message || 'Erro desconhecido';
  const errCode = json.error?.code ?? res.status;
  const friendly = friendlyWhatsAppError(errCode);
  return `${friendly || errMsg} (código: ${errCode}, número: ${phone})`;
}

export async function sendWhatsAppMessage(
  to: string,
  message: string,
  accountId: string,
  departmentId?: string | null,
  replyToWamid?: string | null
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  console.log(`[WA Send] accountId=${accountId} config exists=${!!config} active=${config?.active} phoneNumberId=${config?.phoneNumberId}`);

  if (!config) {
    return { success: false, error: 'WhatsApp não configurado. Acesse Configurações → API Oficial e salve suas credenciais.' };
  }
  if (!config.active) {
    return { success: false, error: 'WhatsApp inativo. Acesse Configurações → API Oficial e ative a integração.' };
  }

  const phone = normalizeBrazilianWhatsAppPhone(to);
  console.log(`[WA Send] to="${to}" → phone="${phone}" (${phone.length} digits) phoneNumberId="${config.phoneNumberId}"`);
  const url = `https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: message },
        // Citação: a Meta só aceita responder a uma mensagem que também tenha
        // vindo/ido por este mesmo canal (id no formato "wamid...").
        ...(replyToWamid?.startsWith('wamid') ? { context: { message_id: replyToWamid } } : {}),
      }),
    });

    const json = await res.json() as {
      messages?: { id: string }[];
      error?: { message: string; code: number };
    };

    if (!res.ok || json.error) {
      console.error(`[WhatsApp] Send error para "${phone}":`, json.error);
      return { success: false, error: parseGraphError(json, res, phone) };
    }

    return { success: true, externalId: json.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] Fetch error:', err);
    return { success: false, error: 'Falha na conexão com a API do WhatsApp' };
  }
}

/** Envia um arquivo (imagem/vídeo/áudio/documento) pela API Oficial — a
 *  Graph API exige 2 passos: 1) sobe o binário pro endpoint de mídia
 *  (devolve um media_id), 2) manda a mensagem referenciando esse id. */
export async function sendWhatsAppMedia(
  to: string,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  caption: string,
  accountId: string,
  departmentId?: string | null
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config) return { success: false, error: 'WhatsApp não configurado. Acesse Configurações → API Oficial e salve suas credenciais.' };
  if (!config.active) return { success: false, error: 'WhatsApp inativo. Acesse Configurações → API Oficial e ative a integração.' };

  const phone = normalizeBrazilianWhatsAppPhone(to);
  const mediaType = mimeType.startsWith('image/') ? 'image'
    : mimeType.startsWith('video/') ? 'video'
    : mimeType.startsWith('audio/') ? 'audio'
    : 'document';

  try {
    // 1) upload do binário — endpoint separado, devolve só um media_id.
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([buffer], { type: mimeType }), fileName);
    const uploadRes = await fetch(`https://graph.facebook.com/v19.0/${config.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}` },
      body: form as any,
    });
    const uploadJson = await uploadRes.json() as { id?: string; error?: { message: string; code: number } };
    if (!uploadRes.ok || uploadJson.error || !uploadJson.id) {
      console.error(`[WhatsApp] Erro no upload de mídia para "${phone}":`, uploadJson.error);
      return { success: false, error: parseGraphError(uploadJson, uploadRes, phone) };
    }

    // 2) manda a mensagem de verdade, referenciando o media_id do passo 1.
    const mediaObj: Record<string, unknown> = { id: uploadJson.id };
    if (mediaType === 'document') mediaObj.filename = fileName;
    if (caption && mediaType !== 'audio') mediaObj.caption = caption; // áudio não aceita legenda na API

    const sendRes = await fetch(`https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: mediaType, [mediaType]: mediaObj }),
    });
    const sendJson = await sendRes.json() as { messages?: { id: string }[]; error?: { message: string; code: number } };
    if (!sendRes.ok || sendJson.error) {
      console.error(`[WhatsApp] Erro ao mandar mídia para "${phone}":`, sendJson.error);
      return { success: false, error: parseGraphError(sendJson, sendRes, phone) };
    }
    return { success: true, externalId: sendJson.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] Fetch error (mídia):', err);
    return { success: false, error: 'Falha na conexão com a API do WhatsApp' };
  }
}

/** Reage com um emoji a uma mensagem (nossa ou do cliente) — `emoji: ''`
 *  remove a reação. Só reage, não manda mensagem nova nenhuma. `wamid` é o
 *  id (com prefixo "wamid.") da mensagem alvo, sempre no formato que a Meta
 *  usa nesse canal. */
export async function sendWhatsAppReaction(
  to: string,
  wamid: string,
  emoji: string,
  accountId: string,
  departmentId?: string | null
): Promise<{ success: boolean; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config) return { success: false, error: 'WhatsApp não configurado.' };
  if (!config.active) return { success: false, error: 'WhatsApp inativo.' };

  const phone = normalizeBrazilianWhatsAppPhone(to);
  const url = `https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'reaction',
        reaction: { message_id: wamid, emoji },
      }),
    });
    const json = await res.json() as { error?: { message: string; code: number } };
    if (!res.ok || json.error) {
      console.error(`[WhatsApp] Erro ao reagir para "${phone}":`, json.error);
      return { success: false, error: parseGraphError(json, res, phone) };
    }
    return { success: true };
  } catch (err) {
    console.error('[WhatsApp] Fetch error (reação):', err);
    return { success: false, error: 'Falha na conexão com a API do WhatsApp' };
  }
}

/** Envia uma mensagem com até 3 botões de resposta rápida (interactive reply
 *  buttons) — usado pelo SalesBot (ex.: "Sim"/"Não" clicáveis). Diferente de
 *  template, NÃO precisa aprovação da Meta (é uma mensagem de texto comum
 *  com botões). */
export async function sendWhatsAppButtonsMessage(
  to: string,
  body: string,
  buttons: string[],
  accountId: string,
  departmentId?: string | null
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config) return { success: false, error: 'WhatsApp não configurado. Acesse Configurações → API Oficial e salve suas credenciais.' };
  if (!config.active) return { success: false, error: 'WhatsApp inativo. Acesse Configurações → API Oficial e ative a integração.' };

  const phone = normalizeBrazilianWhatsAppPhone(to);
  const url = `https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`;
  // Meta permite no máximo 3 botões e 20 caracteres por título.
  const trimmedButtons = buttons.slice(0, 3);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: {
            buttons: trimmedButtons.map((label, i) => ({
              type: 'reply',
              reply: { id: `salesbot_btn_${i}`, title: label.slice(0, 20) },
            })),
          },
        },
      }),
    });

    const json = await res.json() as {
      messages?: { id: string }[];
      error?: { message: string; code: number };
    };

    if (!res.ok || json.error) {
      console.error(`[WhatsApp] Send buttons error para "${phone}":`, json.error);
      return { success: false, error: parseGraphError(json, res, phone) };
    }

    return { success: true, externalId: json.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] Fetch error (buttons):', err);
    return { success: false, error: 'Falha na conexão com a API do WhatsApp' };
  }
}

/** Envia mensagem avulsa com UM botão de link (interactive "cta_url") — a API
 *  do WhatsApp não deixa combinar com botões de resposta rápida na mesma
 *  mensagem (isso só existe em template aprovado). Só funciona na API
 *  Oficial; no QR o link vai como texto puro (o WhatsApp já sublinha
 *  sozinho). */
export async function sendWhatsAppCtaUrlMessage(
  to: string,
  body: string,
  buttonText: string,
  url: string,
  accountId: string,
  departmentId?: string | null
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config) return { success: false, error: 'WhatsApp não configurado. Acesse Configurações → API Oficial e salve suas credenciais.' };
  if (!config.active) return { success: false, error: 'WhatsApp inativo. Acesse Configurações → API Oficial e ative a integração.' };

  const phone = normalizeBrazilianWhatsAppPhone(to);
  const graphUrl = `https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`;

  try {
    const res = await fetch(graphUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: body },
          action: {
            name: 'cta_url',
            parameters: { display_text: buttonText.slice(0, 20), url },
          },
        },
      }),
    });

    const json = await res.json() as {
      messages?: { id: string }[];
      error?: { message: string; code: number };
    };

    if (!res.ok || json.error) {
      console.error(`[WhatsApp] Send cta_url error para "${phone}":`, json.error);
      return { success: false, error: parseGraphError(json, res, phone) };
    }

    return { success: true, externalId: json.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] Fetch error (cta_url):', err);
    return { success: false, error: 'Falha na conexão com a API do WhatsApp' };
  }
}

/** Envia uma mensagem de TEMPLATE (aprovado pela Meta) — único jeito de reabrir
 *  conversa fora da janela de 24h de atendimento gratuito. */
export async function sendWhatsAppTemplateMessage(
  to: string,
  templateName: string,
  language: string,
  bodyParams: string[],
  accountId: string,
  departmentId?: string | null
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config) {
    return { success: false, error: 'WhatsApp não configurado. Acesse Configurações → API Oficial e salve suas credenciais.' };
  }
  if (!config.active) {
    return { success: false, error: 'WhatsApp inativo. Acesse Configurações → API Oficial e ative a integração.' };
  }

  const phone = normalizeBrazilianWhatsAppPhone(to);
  const url = `https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`;
  const components = bodyParams.length > 0
    ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
    : [];

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: { name: templateName, language: { code: language }, components },
      }),
    });

    const json = await res.json() as {
      messages?: { id: string }[];
      error?: { message: string; code: number };
    };

    if (!res.ok || json.error) {
      console.error(`[WhatsApp] Template send error para "${phone}":`, json.error);
      return { success: false, error: parseGraphError(json, res, phone) };
    }

    return { success: true, externalId: json.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] Template fetch error:', err);
    return { success: false, error: 'Falha na conexão com a API do WhatsApp' };
  }
}

// Funil de entrada dos leads de WhatsApp (e da importação). Agora é sempre a
// Caixa de Entrada global única — ver getOrCreateInboxPipeline em
// department.service.ts. `departmentId` fica na assinatura só pra não mexer
// nos callers; é ignorado (não existe mais uma Caixa por setor).
export async function getOrCreateWhatsAppPipeline(accountId: string, _departmentId?: string | null) {
  return getOrCreateInboxPipeline(accountId);
}

// Format phone for display: "5561999990000" → "(61) 99999-0000"
function formatPhoneDisplay(raw: string): string {
  const d = raw.replace(/\D/g, '');
  // Remove country code 55 if present
  const local = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
  if (local.length === 11) return `(${local.slice(0,2)}) ${local.slice(2,7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0,2)}) ${local.slice(2,6)}-${local.slice(6)}`;
  return `+${raw}`;
}

// Processa callbacks de status (sent → delivered → read)
export async function processWhatsAppStatus(body: any, io: any) {
  try {
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        const statuses = change?.value?.statuses;
        if (!statuses?.length) continue;

        for (const s of statuses) {
          const externalId = s.id as string;             // wamid.XXX
          const rawStatus  = (s.status as string || '').toUpperCase(); // sent/delivered/read

          // Mapeia para enum do banco
          const statusMap: Record<string, string> = {
            SENT:      'SENT',
            DELIVERED: 'DELIVERED',
            READ:      'READ',
            FAILED:    'FAILED',
          };
          const newStatus = statusMap[rawStatus];
          if (!newStatus || !externalId) continue;

          // Quando falha, a Meta manda o motivo em s.errors — sem guardar isso,
          // a mensagem só aparecia "falhou" sem nenhuma explicação do porquê.
          // O texto cru da Meta vem em inglês; friendlyWhatsAppError traduz os
          // casos mais comuns (ex.: janela de 24h fechada), com fallback pro
          // original + código pra qualquer erro ainda não mapeado.
          let statusError: string | null = null;
          if (newStatus === 'FAILED' && Array.isArray(s.errors) && s.errors.length > 0) {
            const e = s.errors[0];
            const details = e?.error_data?.details;
            const raw = [e?.title || e?.message, details].filter(Boolean).join(' — ');
            statusError = friendlyWhatsAppError(e?.code) || raw;
            if (e?.code) statusError = `${statusError} (código: ${e.code})`;
            console.error(`[WA Status] Falha ao entregar ${externalId}:`, JSON.stringify(s.errors));
          }

          // Atualiza mensagem pelo externalId
          const updated = await prisma.message.updateMany({
            where: { externalId },
            data:  { status: newStatus as any, ...(statusError ? { statusError } : {}) },
          });

          if (updated.count > 0) {
            console.log(`[WA Status] ${externalId} → ${newStatus}${statusError ? ` (${statusError})` : ''}`);
            // Busca a mensagem para emitir via socket
            const msg = await prisma.message.findFirst({ where: { externalId } });
            if (msg && io) {
              io.to(`lead:${msg.leadId}`).emit('message_status', {
                id: msg.id,
                status: newStatus,
                statusError: msg.statusError,
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[WA Status] Erro:', err);
  }
}

/** Extrai metadados de uma mídia recebida pela Cloud API (image/audio/video/document/sticker).
 *  Retorna null para texto e para tipos sem mídia (location, contacts, reaction, etc.). */
function getCloudApiMediaInfo(msg: any): { mediaId: string; fileName: string; mimeType: string; caption?: string } | null {
  const node = msg?.[msg?.type];
  const mediaId = node?.id;
  if (!mediaId) return null;
  // O WhatsApp às vezes manda "audio/ogg; codecs=opus" — guardamos só o mime base.
  const mimeType = (node.mime_type || 'application/octet-stream').split(';')[0].trim();
  let fileName: string;
  switch (msg.type) {
    case 'image':    fileName = `foto-${Date.now()}.${mimeType.includes('png') ? 'png' : 'jpg'}`; break;
    case 'video':    fileName = `video-${Date.now()}.${mimeType.includes('3gpp') ? '3gp' : 'mp4'}`; break;
    case 'audio':    fileName = `audio-${Date.now()}.${mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('ogg') ? 'ogg' : 'm4a'}`; break;
    case 'sticker':  fileName = `sticker-${Date.now()}.webp`; break;
    case 'document': fileName = node.filename || `documento-${Date.now()}`; break;
    default: return null;
  }
  return { mediaId, fileName, mimeType, caption: node.caption };
}

/** Baixa a mídia da Cloud API: 1) resolve a URL temporária pelo media-id, 2) baixa os bytes.
 *  Os dois passos exigem o token. Retorna null (sem derrubar o recebimento) se algo falhar. */
async function downloadCloudApiMedia(mediaId: string, token: string): Promise<Buffer | null> {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meta = await metaRes.json() as { url?: string; error?: { message?: string } };
    if (!meta.url) {
      console.error('[WA Media] sem URL para media', mediaId, meta.error?.message);
      return null;
    }
    const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!fileRes.ok) {
      console.error('[WA Media] download falhou:', fileRes.status);
      return null;
    }
    return Buffer.from(await fileRes.arrayBuffer());
  } catch (err) {
    console.error('[WA Media] erro ao baixar:', (err as any)?.message);
    return null;
  }
}

/** Acha (ou cria) o Contact + Lead correspondente a um número de telefone que
 *  chegou pela API Oficial — mensagem OU ligação, mesma lógica de dedupe e
 *  roteamento pros dois casos. Extraído de dentro de processIncomingWhatsApp
 *  (mesmo comportamento, só fatorado) pra ser reaproveitado pela Calling API
 *  sem duplicar a lógica de matching de telefone uma terceira vez.
 *  `textForCampaignDetection` só faz sentido pra mensagem de texto (usado pra
 *  rotear a ficha de campanha do site); ligação não tem texto, passa vazio —
 *  detectCampaignRoute simplesmente não acha nenhuma assinatura e segue o
 *  roteamento normal por setor do número. */
export async function resolveContactAndLeadByPhone(
  accountId: string,
  from: string,
  profileName: string,
  io: any,
  departmentId?: string | null,
  textForCampaignDetection: string = ''
): Promise<{ contact: any; leadId: string; formattedPhone: string }> {
  const formattedPhone = formatPhoneDisplay(from);

  // ── Find or create contact ──────────────────────────────────────────
  // Incidente real: cliente já tinha Contact/Lead criado pelo webhook do
  // site (Contact.whatsappPhone SEMPRE normalizado com o 9º dígito, ver
  // normalizeBrazilianWhatsAppPhone) — mas a Meta às vezes manda `from`
  // SEM o 9º dígito (bug conhecido da Cloud API pra número brasileiro).
  // Comparar `from` cru contra um valor sempre normalizado nunca batia,
  // e o fallback por `phone.contains(...)` também não ajudava (o
  // Contact.phone fica formatado "(DD) 9XXXX-XXXX" — o traço cai bem no
  // meio dos últimos 8 dígitos, então NUNCA é substring de verdade).
  // Resultado: um card novo nascia pra cada variação, cliente duplicado.
  // Agora compara pelas DUAS formas (com e sem o 9º dígito).
  const normalizedFrom = normalizeBrazilianWhatsAppPhone(from);
  const withoutNinthDigit = normalizedFrom.length === 13 && normalizedFrom.startsWith('55')
    ? normalizedFrom.slice(0, 4) + normalizedFrom.slice(5)
    : normalizedFrom;
  let contact = await prisma.contact.findFirst({
    where: {
      accountId,
      OR: [
        { whatsappPhone: normalizedFrom },
        { whatsappPhone: withoutNinthDigit },
        { phone: { contains: from.slice(-8) } },
      ],
    },
    include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
  });

  if (!contact) {
    // Grava sempre normalizado (com o 9º dígito) — mesmo formato que o
    // webhook do site usa (site-lead.service.ts) — pra não perpetuar o
    // mesmo desencontro na direção oposta (cliente manda WhatsApp
    // primeiro, preenche o site depois).
    contact = await prisma.contact.create({
      data: {
        name: profileName,
        whatsappPhone: normalizedFrom,
        phone: formattedPhone,
        accountId,
      },
      include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
    });
    console.log(`[WhatsApp] Contato criado: ${contact.id} — ${profileName}`);
  } else if (!contact.whatsappPhone) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { whatsappPhone: normalizedFrom, phone: contact.phone || formattedPhone },
    });
  }

  // ── Find or create lead ─────────────────────────────────────────────
  let leadId: string;

  if (contact.leads.length > 0) {
    // Existing lead — update customFields if telefone_1 is missing
    const existingLead = contact.leads[0];
    const cf = (existingLead as any).customFields as Record<string, string> | null;
    if (!cf?.telefone_1) {
      await prisma.lead.update({
        where: { id: existingLead.id },
        data: {
          customFields: {
            ...((cf as any) || {}),
            participante_1: cf?.participante_1 || profileName,
            telefone_1: formattedPhone,
          } as any,
        },
      });
    }
    leadId = existingLead.id;
  } else {
    // Lead de campanha (ficha do site preenchida) já nasce no funil/estágio
    // certo, com os campos da ficha pré-preenchidos — em vez da Caixa de
    // Entrada genérica. Só na criação do lead (1ª mensagem do contato);
    // sem match, segue o roteamento normal por setor do número.
    const { detectCampaignRoute } = require('./campaign-detection.service') as typeof import('./campaign-detection.service');
    const campaignRoute = await detectCampaignRoute(accountId, textForCampaignDetection).catch(() => null);

    // Get dedicated WhatsApp pipeline (do setor deste número/config, se houver)
    const pipeline = campaignRoute ? null : await getOrCreateWhatsAppPipeline(accountId, departmentId);
    const admin =
      (departmentId && await prisma.user.findFirst({ where: { accountId, departmentIds: { has: departmentId } }, orderBy: { createdAt: 'asc' } })) ||
      (await prisma.user.findFirst({ where: { accountId }, orderBy: { createdAt: 'asc' } }));

    if ((!campaignRoute && !pipeline!.stages.length) || !admin) {
      throw new Error('Pipeline sem estágios ou sem usuário admin');
    }

    const lead = await prisma.lead.create({
      data: {
        name: profileName,
        accountId,
        pipelineId: campaignRoute ? campaignRoute.pipelineId : pipeline!.id,
        stageId: campaignRoute ? campaignRoute.stageId : pipeline!.stages[0].id,
        userId: admin.id,
        contactId: contact.id,
        status: 'OPEN',
        tags: campaignRoute ? ['WhatsApp', 'Campanha'] : ['WhatsApp'],
        // Auto-fill participant fields — ficha de campanha tem prioridade
        // sobre o nome/telefone do perfil do WhatsApp quando os dois existem.
        customFields: {
          participante_1: profileName,
          telefone_1: formattedPhone,
          ...(campaignRoute?.fields || {}),
        } as any,
      },
    });
    if (campaignRoute) console.log(`[Campanha] Lead roteado por "${campaignRoute.signature}": ${lead.id}`);
    leadId = lead.id;
    console.log(`[WhatsApp] Lead criado: ${lead.id} — ${profileName} (${formattedPhone})`);
    const { runAutomations } = require('./automation.service') as typeof import('./automation.service');
    runAutomations({ accountId, trigger: 'NEW_LEAD', leadId: lead.id, io }).catch(() => {});
    // Ficha completa (campaignRoute) nasce DIRETO no estágio-alvo (ex.:
    // Pré-Análise) — nunca passa pela rota de mudança de estágio de
    // verdade, então uma automação STAGE_CHANGE configurada pra esse
    // estágio nunca disparava (mesma lacuna já corrigida antes pro
    // FORM_SUBMITTED/"Ativar IA" — aqui é o caminho de criação via
    // WhatsApp, não o webhook do site). Dispara manualmente como se
    // tivesse "mudado" pro estágio de nascimento.
    if (campaignRoute) {
      runAutomations({ accountId, trigger: 'STAGE_CHANGE', leadId: lead.id, io, context: { newStageId: campaignRoute.stageId } }).catch(() => {});
    }
  }

  return { contact, leadId, formattedPhone };
}

export async function processIncomingWhatsApp(body: any, accountId: string, io: any, departmentId?: string | null) {
  try {
    const config = await getWhatsAppConfig(accountId, departmentId);
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) return;

    for (const msg of value.messages) {
      const mediaInfo = getCloudApiMediaInfo(msg);
      // Clique em botão de resposta rápida (ex.: Sim/Não do SalesBot) — antes
      // disto, uma resposta assim era descartada inteira (nem virava Message),
      // por não ser nem "text" nem mídia suportada.
      const buttonReplyTitle: string | undefined = msg.type === 'interactive'
        ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title)
        : undefined;

      // Reação (emoji) do cliente numa mensagem existente — não vira Message
      // nova, só atualiza a mensagem alvo. Precisa vir ANTES do filtro de
      // descarte abaixo (reaction não é texto/botão/mídia, cairia fora sem isso).
      if (msg.type === 'reaction') {
        const targetWamid = msg.reaction?.message_id as string | undefined;
        const emoji = (msg.reaction?.emoji as string | undefined) || '';
        if (targetWamid) {
          try {
            const existing = await prisma.message.findFirst({
              where: { externalId: targetWamid, lead: { accountId } },
              select: { id: true, leadId: true, reactions: true },
            });
            if (existing) {
              const current = (Array.isArray(existing.reactions) ? existing.reactions : []) as { emoji: string; fromMe: boolean; at: string }[];
              const withoutReactor = current.filter((r) => r.fromMe); // reação do cliente: sempre fromMe:false
              const next = emoji ? [...withoutReactor, { emoji, fromMe: false, at: new Date().toISOString() }] : withoutReactor;
              await prisma.message.update({ where: { id: existing.id }, data: { reactions: next as any } });
              io.to(`lead:${existing.leadId}`).emit('message_reaction', { id: existing.id, reactions: next });
            }
          } catch (err) {
            console.error('[WhatsApp] Erro ao processar reação recebida:', err);
          }
        }
        continue;
      }

      // Resposta do cliente a um pedido de permissão pra ligar (Fase 2 da
      // Calling API) — também chega por aqui (campo `messages`, não
      // `calls`), como um `interactive` de tipo próprio. Mesmo motivo do
      // require() tardio usado pros outros services deste arquivo: evita
      // import circular (whatsapp-calling.service.ts já importa daqui).
      const { handleCallPermissionReply } = require('./whatsapp-calling.service') as typeof import('./whatsapp-calling.service');
      if (await handleCallPermissionReply(msg, accountId, io)) continue;

      // Processa texto, clique em botão, OU mídia suportada (imagem/áudio/
      // vídeo/documento/sticker). Ignora location, contacts, etc. — mas
      // loga o que for descartado por tipo desconhecido (não 'text'), pra
      // não repetir o incidente do call_permission_reply que sumia sem
      // nenhum rastro por causa de um match exato que não bateu.
      if (msg.type !== 'text' && !buttonReplyTitle && !mediaInfo) {
        if (msg.type && msg.type !== 'unknown') {
          console.log(`[WhatsApp] Mensagem tipo="${msg.type}" descartada (não tratada):`, JSON.stringify(msg));
        }
        continue;
      }

      const from = msg.from as string; // e.g. "5561999990001"
      const text = mediaInfo
        ? `📎 ${mediaInfo.fileName}${mediaInfo.caption ? ` — ${mediaInfo.caption}` : ''}`
        : buttonReplyTitle || (msg.text?.body as string) || '';
      const externalId = msg.id as string;
      const profileName = normalizeClientName(value.contacts?.[0]?.profile?.name || `+${from}`);

      console.log(`[WhatsApp] Incoming from=${from} name="${profileName}"`);

      let leadId: string;
      let formattedPhone: string;
      try {
        const resolved = await resolveContactAndLeadByPhone(accountId, from, profileName, io, departmentId, text);
        leadId = resolved.leadId;
        formattedPhone = resolved.formattedPhone;
      } catch (err) {
        console.error('[WhatsApp] Erro ao resolver contato/lead:', err);
        continue;
      }

      // ── Avoid duplicate messages ────────────────────────────────────────
      const existing = await prisma.message.findFirst({ where: { externalId } });
      if (existing) continue;

      // ── Baixa a mídia, se houver (não bloqueia o texto se falhar) ────────
      let mediaBuffer: Buffer | null = null;
      if (mediaInfo && config?.accessToken) {
        mediaBuffer = await downloadCloudApiMedia(mediaInfo.mediaId, config.accessToken);
      }

      // ── Citação (cliente respondeu citando uma mensagem, dele ou nossa) ──
      // A Meta manda `context.id` com o wamid da mensagem citada. Só existia
      // o caminho contrário (agente cita ao responder, via replyTo* no envio
      // — ver sendOutboundWhatsApp) — aqui a citação chegava e sumia: a
      // mensagem em si salvava normal, só sem o balãozinho de "respondendo
      // a...". Mesmos 3 campos, preenchidos igual pro lado de cá.
      let replyToExternalId: string | undefined;
      let replyToContent: string | undefined;
      let replyToSender: string | undefined;
      const quotedWamid = msg.context?.id as string | undefined;
      if (quotedWamid) {
        const quoted = await prisma.message.findFirst({
          where: { externalId: quotedWamid, leadId },
          select: { content: true, direction: true, senderName: true, sentBy: { select: { name: true } } },
        });
        if (quoted) {
          replyToExternalId = quotedWamid;
          replyToContent = quoted.content;
          replyToSender = quoted.direction === 'OUTBOUND' ? (quoted.sentBy?.name || 'Você') : (quoted.senderName || profileName);
        }
      }

      // ── Save message ────────────────────────────────────────────────────
      const message = await prisma.message.create({
        data: {
          content: text,
          direction: 'INBOUND',
          channel: 'WHATSAPP',
          leadId,
          read: false,
          externalId,
          status: 'DELIVERED',
          ...(replyToExternalId ? { replyToExternalId, replyToContent, replyToSender } : {}),
          ...(mediaBuffer && mediaInfo ? {
            attachments: {
              create: { leadId, fileName: mediaInfo.fileName, mimeType: mediaInfo.mimeType, data: mediaBuffer },
            },
          } : {}),
        },
        include: { attachments: true },
      });

      // Anexo sobe pro Drive na hora e os bytes saem do banco. Sem isso o
      // Postgres enchia (incidentes de 2026-08-05 e 2026-08-26 — disco 100%,
      // CRM fora do ar). Fire-and-forget: falha/Drive desconectado não pode
      // atrapalhar o recebimento — nesse caso os bytes ficam no banco mesmo, e
      // o arquivamento periódico pega depois. A rota do anexo já sabe servir do
      // Drive quando `data` está vazio.
      for (const att of message.attachments || []) {
        const { autoUploadAttachmentToDrive } = require('./google.service') as typeof import('./google.service');
        autoUploadAttachmentToDrive(accountId, leadId, att.id).catch((err: any) =>
          console.error('[Drive] Auto-upload do anexo falhou:', err?.message));
      }

      // ── Emit via Socket.io ──────────────────────────────────────────────
      if (io) {
        // Para quem está com o lead aberto (atualiza o chat em tempo real)
        io.to(`lead:${leadId}`).emit('new_message', message);
        // Para o dashboard inteiro — evento SEPARADO só para som/badge (sem duplicar mensagem)
        io.to(`account_${accountId}`).emit('new_notification', { leadId, message });
      }
      const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
      sendPushToAccount(accountId, { title: profileName || 'Nova mensagem', body: text || '📎 Anexo recebido', leadId }).catch(() => {});

      // Gatilho automático (Templates → "Disparar automaticamente") e
      // assistente de IA (Inbox → botão de IA na conversa) — só para texto de
      // verdade, não mídia. Template tem prioridade sobre a resposta de IA.
      if ((msg.type === 'text' || buttonReplyTitle) && text) {
        // SalesBot tem prioridade — se uma resposta continua um fluxo em
        // andamento (ou dispara um novo por palavra-chave), template/IA não
        // entram em cima da mesma mensagem (mesma regra de exclusividade que
        // já existe entre template e IA logo abaixo).
        const { maybeSalesBotStep } = require('./salesbot.service') as typeof import('./salesbot.service');
        const botHandled = await maybeSalesBotStep(accountId, leadId, text, io);
        if (!botHandled) {
          const templateDisparou = await maybeAutoReplyCloudApi(accountId, leadId, text, from, io, departmentId);
          if (!templateDisparou) {
            const { maybeMessageReceivedAutomations } = require('./automation.service') as typeof import('./automation.service');
            const automationHandled = await maybeMessageReceivedAutomations(accountId, leadId, text, io);
            if (!automationHandled) {
              await maybeAiAutoReplyCloudApi(accountId, leadId, text, from, io, departmentId);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[WhatsApp] Process incoming error:', err);
  }
}

/** Verifica se algum template com gatilho automático ativo bate com o início
 *  da mensagem recebida e, se achar, envia o corpo dele como resposta pela
 *  API Oficial. Implementado aqui (não em message.service) de propósito, pra
 *  não criar import circular. Retorna true se disparou. */
async function maybeAutoReplyCloudApi(accountId: string, leadId: string, incomingText: string, phone: string, io: any, departmentId?: string | null): Promise<boolean> {
  try {
    const norm = incomingText.trim().toLowerCase();
    if (!norm) return false;
    // Só considera gatilhos do MESMO setor do número que recebeu (ou
    // "compartilhados", sem setor) — evita um gatilho de Consórcio disparar
    // numa conversa de Financiamento, por exemplo.
    const templates = await prisma.messageTemplate.findMany({
      where: {
        accountId,
        triggerActive: true,
        ...(departmentId ? { OR: [{ departmentId }, { departmentId: null }] } : {}),
      },
    });
    const match = templates.find((t: any) => t.triggerText && norm.startsWith(String(t.triggerText).trim().toLowerCase()));
    if (!match) return false;

    const alreadySent = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', content: match.body } });
    if (alreadySent) return false;

    const result = await sendWhatsAppMessage(phone, match.body, accountId, departmentId);
    if (!result.success) {
      console.error(`[WhatsApp] Gatilho automático "${match.name}" falhou ao enviar:`, result.error);
      return false;
    }
    const sent = await prisma.message.create({
      data: { content: match.body, direction: 'OUTBOUND', channel: 'WHATSAPP', leadId, read: true, externalId: result.externalId, status: 'SENT' },
    });
    if (io) io.to(`lead:${leadId}`).emit('new_message', sent);
    console.log(`[WhatsApp] Gatilho automático "${match.name}" disparado para lead ${leadId}`);
    return true;
  } catch (err) {
    console.error('[WhatsApp] Erro no gatilho automático:', err);
    return false;
  }
}

/** Assistente de IA respondendo o cliente sozinho (Inbox → botão de IA na
 *  conversa, Lead.aiAutoReplyActive) — só entra se o gatilho de template
 *  acima não disparou pra essa mensagem. Toda resposta enviada vira uma
 *  Note no card, pra equipe acompanhar/poder desligar se algo sair errado. */
async function maybeAiAutoReplyCloudApi(accountId: string, leadId: string, incomingText: string, phone: string, io: any, departmentId?: string | null): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { aiAutoReplyActive: true } });
    if (!lead?.aiAutoReplyActive) return;

    const genResult = await generateAiAutoReply(accountId, leadId, incomingText);
    if (!genResult) return;
    const { reply, handoff, moveToStage, markLost, stopFollowUp, extractedFields } = genResult;

    if (genResult.noReply) {
      if (moveToStage || markLost || stopFollowUp || (extractedFields && Object.keys(extractedFields).length)) {
        await applyAiExtractedActions(accountId, leadId, { moveToStage, markLost, stopFollowUp, extractedFields }, io);
      }
      return;
    }

    const result = await sendWhatsAppMessage(phone, reply, accountId, departmentId);
    if (!result.success) {
      console.error('[WhatsApp] Resposta de IA falhou ao enviar:', result.error);
      return;
    }
    const sent = await prisma.message.create({
      data: { content: reply, direction: 'OUTBOUND', channel: 'WHATSAPP', leadId, read: true, externalId: result.externalId, status: 'SENT' },
    });
    if (io) io.to(`lead:${leadId}`).emit('new_message', sent);
    await prisma.note.create({ data: { leadId, content: `Resposta automática da IA: "${reply}"`, type: 'COMMENT' } }).catch(() => {});
    logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_replied', leadId, summary: 'a IA respondeu o cliente', channel: 'WHATSAPP' });
    console.log(`[WhatsApp] Resposta de IA enviada automaticamente para lead ${leadId}`);

    // Mover etapa / marcar Perdido / preencher dados do card — independente
    // do handoff (pode marcar Perdido no mesmo turno em que encerra, por ex.).
    if (moveToStage || markLost || stopFollowUp || (extractedFields && Object.keys(extractedFields).length)) {
      await applyAiExtractedActions(accountId, leadId, { moveToStage, markLost, stopFollowUp, extractedFields }, io);
    }

    if (handoff) await handleAiHandoffCloudApi(leadId, io);
  } catch (err) {
    console.error('[WhatsApp] Erro na resposta automática de IA:', err);
  }
}

/** Cliente pediu atendimento humano (ou saiu do escopo do setor) — desliga a
 *  IA nessa conversa sozinha e avisa o colaborador responsável (som + toast). */
async function handleAiHandoffCloudApi(leadId: string, io: any) {
  try {
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { aiAutoReplyActive: false },
      select: { id: true, name: true, userId: true, accountId: true },
    });
    await prisma.note.create({ data: { leadId, content: 'Atendimento automático encerrado — cliente pediu atendimento humano (ou pergunta fora do escopo deste chat). Repassado para a equipe.', type: 'COMMENT' } }).catch(() => {});
    logActivity({ accountId: lead.accountId, userId: null, userName: 'Assistente IA', action: 'ai_handoff', leadId, leadName: lead.name, summary: 'encerrou o atendimento automático e repassou pra equipe' });
    if (io) {
      io.to(`lead:${leadId}`).emit('lead_ai_toggled', { leadId, active: false });
      if (lead.userId) io.to(`user_${lead.userId}`).emit('ai_handoff', { leadId, leadName: lead.name });
    }
  } catch (err) {
    console.error('[WhatsApp] Erro ao processar handoff da IA:', err);
  }
}

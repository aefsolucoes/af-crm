import { PrismaClient } from '@prisma/client';
import { getWhatsAppConfig, resolveContactAndLeadByPhone, listMetaTemplates, sendWhatsAppTemplateMessage, normalizeBrazilianWhatsAppPhone } from './whatsapp.service';
import { sendPushToAccount } from './push.service';

const prisma = new PrismaClient();

const GRAPH_VERSION = 'v20.0';

/** POST genérico pro endpoint de chamadas da Graph API — mesmo padrão de
 *  fetch()+Bearer usado em sendWhatsAppMessage (whatsapp.service.ts). */
async function waCallsRequest(
  phoneNumberId: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; json: any }> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/calls`;
  const action = body.action as string;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      console.error(`[Calling] Graph API error (action=${action}):`, JSON.stringify(json?.error || json));
      return { ok: false, json };
    }
    console.log(`[Calling] Graph API ok (action=${action}):`, JSON.stringify(json));
    return { ok: true, json };
  } catch (err) {
    console.error(`[Calling] Fetch error (action=${action}):`, err);
    return { ok: false, json: { error: { message: 'Falha na conexão com a API de chamadas' } } };
  }
}

type CallCredentials = { phoneNumberId: string; accessToken: string };

/** Inbound: estabelece a mídia antes de formalizar a atendida (opcional, mas
 *  recomendado pela Meta pra reduzir o tempo até o áudio conectar). Recebe o
 *  config já resolvido (não accountId/departmentId) — o Call já sabe exatamente
 *  qual WhatsAppConfig recebeu a ligação, não precisa re-adivinhar por setor. */
export async function preAcceptCall(config: CallCredentials, waCallId: string, sdpAnswer: string) {
  return waCallsRequest(config.phoneNumberId, config.accessToken, {
    call_id: waCallId,
    action: 'pre_accept',
    session: { sdp_type: 'answer', sdp: sdpAnswer },
  });
}

/** Inbound: atende de fato a ligação. */
export async function acceptCall(config: CallCredentials, waCallId: string, sdpAnswer: string) {
  return waCallsRequest(config.phoneNumberId, config.accessToken, {
    call_id: waCallId,
    action: 'accept',
    session: { sdp_type: 'answer', sdp: sdpAnswer },
  });
}

/** Recusa uma ligação recebida, sem atender. */
export async function rejectCall(config: CallCredentials, waCallId: string) {
  return waCallsRequest(config.phoneNumberId, config.accessToken, { call_id: waCallId, action: 'reject' });
}

/** Encerra uma ligação em andamento (atendida por nós ou pelo cliente, nas duas direções). */
export async function terminateCall(config: CallCredentials, waCallId: string) {
  return waCallsRequest(config.phoneNumberId, config.accessToken, { call_id: waCallId, action: 'terminate' });
}

/** Outbound: liga pro cliente. O SDP offer já vem com os candidatos ICE
 *  coletados (mesma exigência já corrigida no lado inbound — ver
 *  incoming-call-ringer.tsx). Meta responde com o call_id; a resposta SDP
 *  (a Meta aceitando a ligação) chega depois, como um novo evento `connect`
 *  pro MESMO call_id via webhook — ver processIncomingWhatsAppCall. */
export async function connectCall(config: CallCredentials, toPhone: string, sdpOffer: string) {
  return waCallsRequest(config.phoneNumberId, config.accessToken, {
    to: toPhone,
    action: 'connect',
    session: { sdp_type: 'offer', sdp: sdpOffer },
  });
}

type CallPermissionState = {
  /** true = pode ligar agora (permanente ou temporária ainda não vencida). */
  permitted: boolean;
  /** true = pode mandar um NOVO pedido de permissão agora (dentro do limite
   *  de 1/24h e 2/7dias da Meta). Default true quando a resposta não vem no
   *  formato esperado — prefere deixar tentar e a Meta recusar com um erro
   *  claro, a bloquear silenciosamente por um parsing errado daqui. */
  canRequest: boolean;
  raw: any;
};

/** Consulta ao vivo se o cliente já autorizou receber ligação — fonte de
 *  verdade é a Meta, não um cache local (o CallPermission salvo no banco é
 *  só auditoria/histórico, não decide nada aqui). Formato exato da resposta
 *  ainda não confirmado contra tráfego real (documentação da Meta é vaga
 *  nos nomes de campo) — por isso o parsing tenta os caminhos mais prováveis
 *  e sempre loga o corpo cru, pra ajustar rápido se vier diferente. */
export async function getCallPermissionState(config: CallCredentials, userWaId: string): Promise<CallPermissionState> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/call_permissions?user_wa_id=${encodeURIComponent(userWaId)}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.accessToken}` } });
    const json: any = await res.json().catch(() => ({}));
    console.log('[Calling] call_permissions raw:', JSON.stringify(json));
    if (!res.ok || json?.error) {
      console.error('[Calling] Erro ao consultar call_permissions:', JSON.stringify(json?.error || json));
      return { permitted: false, canRequest: true, raw: json };
    }
    const perm = json?.permission || json;
    const status = perm?.status as string | undefined;
    const permitted = status === 'permanent' || status === 'temporary';
    const actions: any[] = perm?.actions || json?.actions || [];
    const requestAction = actions.find((a) => a?.action_type === 'send_call_permission_request' || a?.name === 'send_call_permission_request');
    const canRequest = requestAction ? requestAction.can_perform !== false : true;
    return { permitted, canRequest, raw: json };
  } catch (err) {
    console.error('[Calling] Fetch error em call_permissions:', err);
    return { permitted: false, canRequest: true, raw: null };
  }
}

/** Acha, entre os templates já aprovados da conta, um com o componente
 *  especial de pedido de permissão de ligação (CALL_PERMISSION_REQUEST) —
 *  não precisa de um nome fixo, só que exista um aprovado com esse tipo de
 *  componente (criado via createCallPermissionTemplate, abaixo, ou manual
 *  no Business Manager). */
export async function findCallPermissionTemplate(accountId: string, departmentId?: string | null): Promise<{ name: string; language: string } | null> {
  const templates = await listMetaTemplates(accountId, departmentId);
  const approved = templates.find((t: any) =>
    t.status === 'APPROVED' &&
    Array.isArray(t.components) &&
    t.components.some((c: any) => c.type === 'CALL_PERMISSION_REQUEST')
  );
  return approved ? { name: approved.name, language: approved.language } : null;
}

/** Cria (na Meta) o template de pedido de permissão de ligação — mesmo
 *  padrão de createMetaTemplate (whatsapp.service.ts), mas com o componente
 *  especial CALL_PERMISSION_REQUEST em vez de BUTTONS normal. Fica pendente
 *  de aprovação como qualquer template novo (pode levar minutos/horas). */
export async function createCallPermissionTemplate(accountId: string, departmentId: string | null | undefined, bodyText: string): Promise<{ ok: boolean; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config?.accessToken) return { ok: false, error: 'Configure o Access Token primeiro (aba API Oficial).' };
  if (!config.wabaId) return { ok: false, error: 'Informe o WABA ID em "Ativar recebimento" primeiro.' };

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${config.wabaId}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'permissao_ligar_af_crm',
      category: 'UTILITY',
      language: 'pt_BR',
      components: [
        { type: 'BODY', text: bodyText },
        { type: 'CALL_PERMISSION_REQUEST' },
      ],
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const code = json.error?.code ?? res.status;
    const msg = json.error?.error_user_msg || json.error?.message || 'Erro desconhecido';
    return { ok: false, error: `${msg} (código: ${code})` };
  }
  return { ok: true };
}

/** `Contact.whatsappPhone` às vezes é um identificador `@lid` (Baileys/Meta
 *  — ver [[whatsapp-lid-baileys7]] na memória do projeto) em vez de um
 *  telefone de verdade, quando a última mensagem desse contato chegou por
 *  um canal que só identifica por @lid. Um @lid nunca serve pra Graph API
 *  (nem pra mandar mensagem, nem pra Calling) — incidente real
 *  (2026-09-24): o botão "Ligar" e o pedido de permissão usavam
 *  `whatsappPhone || phone` cegamente, então quando `whatsappPhone` virava
 *  um @lid, a Meta era consultada por um número bogus e sempre dizia
 *  "no_permission" mesmo com o cliente já tendo aceitado de verdade no
 *  telefone certo. Prefere `whatsappPhone` normalmente (mais confiável
 *  quando é telefone de verdade), mas pula pro `phone` se for @lid. */
export function pickRealPhone(contact: { whatsappPhone?: string | null; phone?: string | null } | null | undefined): string | null {
  const wa = contact?.whatsappPhone;
  if (wa && !wa.includes('@lid')) return wa;
  return contact?.phone || null;
}

/** Manda o template de pedido de permissão pro cliente — reaproveita
 *  sendWhatsAppTemplateMessage (whatsapp.service.ts), sem parâmetros de
 *  corpo (o template de permissão não costuma ter variável). Grava/atualiza
 *  o CallPermission (auditoria — a decisão de "pode ligar" nunca usa isso,
 *  sempre consulta getCallPermissionState ao vivo). */
export async function sendCallPermissionRequest(accountId: string, departmentId: string | null | undefined, contactId: string): Promise<{ ok: boolean; error?: string }> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  const phone = pickRealPhone(contact);
  if (!phone) return { ok: false, error: 'Contato sem telefone de WhatsApp' };

  const template = await findCallPermissionTemplate(accountId, departmentId);
  if (!template) {
    return { ok: false, error: 'Nenhum template de "pedido de permissão pra ligar" aprovado ainda. Crie um em Configurações → API Oficial.' };
  }

  const result = await sendWhatsAppTemplateMessage(phone, template.name, template.language, [], accountId, departmentId);
  if (!result.success) return { ok: false, error: result.error };

  await prisma.callPermission.create({
    data: { accountId, contactId, status: 'PENDING' },
  });

  return { ok: true };
}

/** Trata a resposta do cliente a um pedido de permissão de ligação — chega
 *  pelo campo `messages` do webhook (não `calls`), como um objeto
 *  `interactive`. Chamado de dentro do loop de processIncomingWhatsApp
 *  (whatsapp.service.ts) via require() tardio (mesmo motivo dos outros:
 *  evita import circular, esse arquivo já importa de lá).
 *
 *  Incidente real (2026-09-24): o primeiro teste com um aceite de verdade
 *  não deixou NENHUM rastro nos logs — o match exato por
 *  `type === 'call_permission_reply'` provavelmente não bate com o nome
 *  real que a Meta usa (documentação é vaga nos nomes de campo), e como o
 *  log só disparava DEPOIS do match, a mensagem sumia em silêncio (nem
 *  virava texto normal nem deixava pista nenhuma). Corrigido em duas
 *  frentes: (1) loga QUALQUER `interactive` não reconhecido, sempre, antes
 *  de decidir se é isso ou não; (2) o match agora é tolerante (qualquer
 *  `type` contendo "call_permission", em vez do nome exato) — ajustar pro
 *  nome certo assim que o log real aparecer.
 *  Retorna true se tratou a mensagem (quem chama deve dar `continue`, não
 *  processar como mensagem de texto normal). */
export async function handleCallPermissionReply(msg: any, accountId: string, io: any): Promise<boolean> {
  if (msg?.type !== 'interactive') return false;

  const interactiveType = String(msg.interactive?.type || '');
  const looksLikeCallPermission = /call_permission/i.test(interactiveType) || msg.interactive?.call_permission_reply;

  // Sempre loga um `interactive` que a gente não processa em nenhum outro
  // lugar (botão de resposta rápida já é tratado antes, no loop principal)
  // — mesmo se não bater com "call_permission", ajuda a identificar o nome
  // real do campo na próxima resposta de permissão.
  if (!looksLikeCallPermission) {
    console.log('[Calling] interactive não reconhecido (pode ser call_permission_reply com nome diferente):', JSON.stringify(msg.interactive));
    return false;
  }

  console.log('[Calling] call_permission_reply raw:', JSON.stringify(msg.interactive));

  try {
    const reply = msg.interactive?.call_permission_reply || msg.interactive;
    const accepted = reply?.response === 'accept' || reply?.status === 'accept' || reply?.action === 'accept';
    const isPermanent = !!reply?.is_permanent;
    const expirationTimestamp = reply?.expiration_timestamp as number | string | undefined;

    const from = msg.from as string;
    const normalizedFrom = normalizeBrazilianWhatsAppPhone(from);
    const contact = await prisma.contact.findFirst({
      where: { accountId, OR: [{ whatsappPhone: normalizedFrom }, { phone: { contains: from.slice(-8) } }] },
    });
    if (!contact) {
      console.warn('[Calling] call_permission_reply de telefone sem Contact:', from);
      return true;
    }

    await prisma.callPermission.create({
      data: {
        accountId,
        contactId: contact.id,
        status: accepted ? 'GRANTED' : 'DENIED',
        grantedAt: accepted ? new Date() : null,
        expiresAt: accepted && !isPermanent && expirationTimestamp
          ? new Date(Number(expirationTimestamp) * 1000)
          : null,
      },
    });

    io.to(`account_${accountId}`).emit(accepted ? 'call_permission_granted' : 'call_permission_denied', { contactId: contact.id });
  } catch (err) {
    console.error('[Calling] Erro ao processar call_permission_reply:', err);
  }

  return true;
}

/** Webhook handler — campo `calls` (sinalização de chamada). Mesmo padrão dos
 *  irmãos processWhatsAppStatus/processIncomingWhatsApp: no-op silencioso se
 *  a chave esperada não existir no payload (a rota chama os três sempre).
 *  Fase 1 (só chamada recebida): trata `connect` (chamada nova chegando,
 *  dedupe por waCallId) e `terminate` (encerrada, pelo cliente ou pela Meta
 *  por timeout). Qualquer evento fora desses dois é só logado — inclui
 *  qualquer coisa relacionada a permissão de ligar, que é Fase 2 e ainda
 *  não tem o formato do payload confirmado contra tráfego real. */
export async function processIncomingWhatsAppCall(body: any, accountId: string, io: any, departmentId?: string | null) {
  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.calls?.length) return;

    const config = await getWhatsAppConfig(accountId, departmentId);
    if (!config) {
      console.warn('[Calling] Webhook de chamada sem WhatsAppConfig — accountId:', accountId);
      return;
    }

    for (const call of value.calls) {
      const waCallId = call.id as string | undefined;
      const event = call.event as string | undefined;
      if (!waCallId || !event) continue;

      if (event === 'connect') {
        const existing = await prisma.call.findUnique({ where: { waCallId } });
        if (existing) {
          // Resposta SDP de uma chamada OUTBOUND que nós iniciamos (o
          // primeiro connect foi o nosso POST; este é a Meta respondendo
          // com o SDP de resposta pra completar a negociação WebRTC).
          const sdp = call.session?.sdp as string | undefined;
          if (existing.direction === 'OUTBOUND' && existing.status !== 'CONNECTED' && sdp) {
            await prisma.call.update({
              where: { waCallId },
              data: { status: 'CONNECTED', connectedAt: new Date() },
            });
            if (existing.answeredByUserId) {
              console.log(`[Calling] SDP de resposta (outbound) recebido -- repassando pro user_${existing.answeredByUserId}, sdp ${sdp.length} bytes:`, waCallId);
              io.to(`user_${existing.answeredByUserId}`).emit('call_answered', { waCallId, sdp });
            } else {
              console.warn('[Calling] SDP de resposta (outbound) recebido mas sem answeredByUserId -- ninguém vai receber:', waCallId);
            }
          } else {
            console.log('[Calling] connect repetido sem ação clara (dedupe de webhook?):', waCallId, JSON.stringify(call));
          }
          continue;
        }

        const from = call.from as string;
        const to = call.to as string;
        const sdp = call.session?.sdp as string | undefined;
        if (!from || !sdp) {
          console.warn('[Calling] Payload de connect sem from/sdp:', JSON.stringify(call));
          continue;
        }

        const profileName = value.contacts?.[0]?.profile?.name || `+${from}`;
        let leadId: string | null = null;
        let leadName = profileName;
        try {
          const resolved = await resolveContactAndLeadByPhone(accountId, from, profileName, io, departmentId);
          leadId = resolved.leadId;
          leadName = resolved.contact?.name || profileName;
        } catch (err) {
          console.error('[Calling] Erro ao resolver contato/lead da chamada:', err);
        }

        const created = await prisma.call.create({
          data: {
            accountId,
            whatsappConfigId: config.id,
            leadId,
            waCallId,
            direction: 'INBOUND',
            status: 'RINGING',
            fromPhone: from,
            toPhone: to || config.phoneNumberId,
          },
        });

        const payload = { callId: created.id, waCallId, leadId, leadName, contactPhone: from, sdp };
        io.to(`account_${accountId}`).emit('incoming_call', payload);
        if (leadId) io.to(`lead:${leadId}`).emit('incoming_call', payload);

        sendPushToAccount(accountId, { title: 'Ligação recebida', body: leadName, leadId: leadId || undefined, type: 'call' }).catch(() => {});
        continue;
      }

      if (event === 'terminate') {
        const existing = await prisma.call.findUnique({ where: { waCallId } });
        if (!existing) continue; // encerrou algo que não rastreamos (ex.: chamada de teste anterior a este deploy)

        const wasConnected = existing.status === 'CONNECTED';
        const endReason = (call.status || call.termination_reason || 'terminated') as string;
        const updated = await prisma.call.update({
          where: { waCallId },
          data: {
            status: wasConnected ? 'ENDED' : 'MISSED',
            endedAt: new Date(),
            endReason,
          },
        });

        const payload = { waCallId, status: updated.status, endReason };
        io.to(`account_${accountId}`).emit('call_ended', payload);
        if (existing.leadId) io.to(`lead:${existing.leadId}`).emit('call_ended', payload);
        continue;
      }

      console.log(`[Calling] Evento de chamada não tratado (event="${event}"):`, JSON.stringify(call));
    }
  } catch (err) {
    console.error('[Calling] Erro no processamento do webhook de chamada:', err);
  }
}

import { PrismaClient } from '@prisma/client';
import { getWhatsAppConfig, resolveContactAndLeadByPhone } from './whatsapp.service';
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
      console.error('[Calling] Graph API error:', JSON.stringify(json?.error || json));
      return { ok: false, json };
    }
    return { ok: true, json };
  } catch (err) {
    console.error('[Calling] Fetch error:', err);
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
          // Fase 2 (resposta SDP de uma chamada outbound que nós iniciamos)
          // vai cair aqui — fora de escopo por ora, só loga pra referência
          // futura em vez de ignorar silenciosamente.
          console.log('[Calling] connect repetido pra call_id existente (provável resposta SDP outbound — Fase 2):', waCallId);
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

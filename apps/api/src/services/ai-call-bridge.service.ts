import dgram from 'dgram';
import crypto from 'crypto';
import WebSocket from 'ws';
import OpusScript from 'opusscript';
import { RTCPeerConnection, RTCRtpCodecParameters, RTCRtpTransceiver, RtpPacket, RtpHeader } from 'werift';
import { PrismaClient } from '@prisma/client';
import {
  connectCall, terminateCall, createCallMessage, finalizeCallMessage, getCallPermissionState, pickRealPhone,
} from './whatsapp-calling.service';
import { getWhatsAppConfig, normalizeBrazilianWhatsAppPhone } from './whatsapp.service';

const prisma = new PrismaClient();

/* Ligação feita pela IA (SDR de voz): o próprio servidor liga pro cliente
 * pelo WhatsApp do CRM (mesma Graph API das ligações humanas) e faz a ponte
 * do áudio entre a Meta (WebRTC/Opus 48k) e o agente da ElevenLabs
 * (WebSocket, PCM 16-bit 48k nos dois sentidos -- sem reamostrar). */

const ELEVEN_API = 'https://api.elevenlabs.io/v1';
const AGENT_NAME = 'AF CRM — SDR Ligação';
const RATE = 48000;
const FRAME = 960; // 20ms
const USER_CHUNK_BYTES = (RATE / 10) * 2; // 100ms por mensagem pro agente
const RING_TIMEOUT_MS = 75_000;
const OPENING_SILENCE_MS = 3_000;
const SILENCE_MARKER = '[silêncio]';
const SPEECH_RMS = 700;
const PRE_BUFFER_MAX_BYTES = 4 * RATE * 2; // 4s

type CallConfig = { id: string; phoneNumberId: string; accessToken: string };
type TranscriptLine = { role: 'IA' | 'Cliente'; text: string };

interface AiCallSession {
  waCallId: string;
  accountId: string;
  leadId: string;
  config: CallConfig;
  io: any;
  pc: RTCPeerConnection;
  transceiver: RTCRtpTransceiver;
  decoder: OpusScript;
  encoder: OpusScript;
  dynamicVariables: Record<string, string>;
  ws: WebSocket | null;
  agentReady: boolean;
  conversationId: string | null;
  inChunks: Buffer[];
  inBytes: number;
  outQueue: Buffer[];
  outOffset: number;
  outBytes: number;
  pacer: NodeJS.Timeout | null;
  pacerStart: number;
  sentFrames: number;
  seq: number;
  ts: number;
  sdpApplied: boolean;
  answered: boolean;
  answeredAt: number;
  userSpoke: boolean;
  loudFrames: number;
  silenceTimer: NodeJS.Timeout | null;
  preBuffer: Buffer[];
  preBytes: number;
  ending: boolean;
  ringTimeout: NodeJS.Timeout | null;
  transcript: TranscriptLine[];
}

const sessions = new Map<string, AiCallSession>();
let cachedAgentId: string | null = null;

async function resolveAgentId(): Promise<string | null> {
  if (process.env.ELEVENLABS_AGENT_ID) return process.env.ELEVENLABS_AGENT_ID;
  if (cachedAgentId) return cachedAgentId;
  const res = await fetch(`${ELEVEN_API}/convai/agents?page_size=100`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! } });
  const json: any = await res.json().catch(() => ({}));
  cachedAgentId = json?.agents?.find((a: any) => a.name === AGENT_NAME)?.agent_id || null;
  return cachedAgentId;
}

function productFromLead(lead: { pipeline?: { name: string; department?: { name: string } | null } | null }): string {
  const text = `${lead.pipeline?.department?.name || ''} ${lead.pipeline?.name || ''}`;
  if (/home\s*equity|garantia/i.test(text)) return 'Home Equity';
  if (/habita|financiamento/i.test(text)) return 'Financiamento Habitacional';
  return 'crédito imobiliário';
}

async function buildLeadContext(leadId: string, stageName: string | undefined, customFields: unknown): Promise<string> {
  const parts: string[] = [];
  if (stageName) parts.push(`Etapa no CRM: ${stageName}.`);
  if (customFields && typeof customFields === 'object') {
    const filled = Object.entries(customFields as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
      .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`);
    if (filled.length) parts.push(`Dados do card: ${filled.join('; ')}.`);
  }
  const msgs = await prisma.message.findMany({
    where: { leadId, callWaCallId: null },
    orderBy: { createdAt: 'desc' },
    take: 12,
    select: { content: true, direction: true },
  });
  if (msgs.length) {
    const lines = msgs.reverse().map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'A&F'}: ${(m.content || '').replace(/\s+/g, ' ').slice(0, 160)}`);
    parts.push(`Últimas mensagens no WhatsApp:\n${lines.join('\n')}`);
  }
  return parts.join('\n').slice(0, 2500) || 'nada ainda';
}

function waitIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') { clearTimeout(timer); resolve(); }
    });
  });
}

export async function startAiCall(accountId: string, leadId: string, io: any): Promise<{ ok: true; waCallId: string } | { ok: false; error: string; needsPermission?: boolean }> {
  if (!process.env.ELEVENLABS_API_KEY) return { ok: false, error: 'ElevenLabs não configurada no servidor' };

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: {
      contact: true,
      stage: { select: { name: true } },
      pipeline: { select: { name: true, departmentId: true, department: { select: { name: true } } } },
    },
  });
  const phoneRaw = pickRealPhone(lead?.contact);
  if (!lead || !phoneRaw) return { ok: false, error: 'Lead sem telefone de WhatsApp' };
  if ([...sessions.values()].some((s) => s.leadId === leadId)) return { ok: false, error: 'A IA já está numa ligação com esse cliente' };

  const config = await getWhatsAppConfig(accountId, lead.pipeline?.departmentId || null);
  if (!config) return { ok: false, error: 'WhatsApp não configurado' };
  const phone = normalizeBrazilianWhatsAppPhone(phoneRaw);

  const perm = await getCallPermissionState(config, phone);
  if (!perm.permitted) return { ok: false, needsPermission: true, error: 'O cliente ainda não autorizou receber ligação' };

  const agentId = await resolveAgentId();
  if (!agentId) return { ok: false, error: 'Agente de voz não encontrado na ElevenLabs' };

  const pc = new RTCPeerConnection({
    codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: RATE, channels: 2 })] },
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  await pc.setLocalDescription(await pc.createOffer());
  await waitIceGathering(pc, 3000);
  const sdp = pc.localDescription?.sdp;
  if (!sdp) { await pc.close(); return { ok: false, error: 'Falha ao preparar o áudio da ligação' }; }

  const result = await connectCall(config, phone, sdp);
  const waCallId: string | undefined = result.json?.calls?.[0]?.id || result.json?.id;
  if (!result.ok || !waCallId) {
    await pc.close();
    return { ok: false, error: result.json?.error?.message || 'Falha ao iniciar a ligação' };
  }

  await prisma.call.create({
    data: {
      accountId, whatsappConfigId: config.id, leadId, waCallId,
      direction: 'OUTBOUND', status: 'CONNECTING', fromPhone: config.phoneNumberId, toPhone: phone,
    },
  });

  const s: AiCallSession = {
    waCallId, accountId, leadId, config, io, pc, transceiver,
    decoder: new OpusScript(RATE, 1, OpusScript.Application.VOIP),
    encoder: new OpusScript(RATE, 1, OpusScript.Application.VOIP),
    dynamicVariables: {
      nome_cliente: (lead.contact?.name || lead.name || '').split(' ')[0] || 'tudo bem',
      produto: productFromLead(lead),
      contexto: await buildLeadContext(leadId, lead.stage?.name, lead.customFields),
    },
    ws: null, agentReady: false, conversationId: null,
    inChunks: [], inBytes: 0,
    outQueue: [], outOffset: 0, outBytes: 0,
    pacer: null, pacerStart: 0, sentFrames: 0,
    seq: crypto.randomInt(0, 0xffff), ts: crypto.randomInt(0, 0x7fffffff),
    sdpApplied: false, answered: false, answeredAt: 0, userSpoke: false, loudFrames: 0, silenceTimer: null, preBuffer: [], preBytes: 0,
    ending: false, ringTimeout: null,
    transcript: [],
  };
  sessions.set(waCallId, s);

  transceiver.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => onInboundRtp(s, rtp.payload));
  });
  pc.connectionStateChange.subscribe((state) => {
    console.log(`[AI-Call] ${waCallId} connectionState=${state}`);
    if (state === 'connected' && !s.pacer) startPacer(s);
    if (state === 'failed') endSession(s, 'media_failed', true);
  });
  s.ringTimeout = setTimeout(() => { if (!s.answered) endSession(s, 'no_answer', true); }, RING_TIMEOUT_MS);

  await createCallMessage(leadId, 'OUTBOUND', waCallId, io, accountId);
  console.log(`[AI-Call] ligando ${waCallId} lead=${leadId} produto="${s.dynamicVariables.produto}"`);
  return { ok: true, waCallId };
}

/** Chamado pelo webhook quando a Meta manda o SDP de resposta (cliente
 *  atendeu). Retorna false se a ligação não é da IA (segue o fluxo humano). */
export async function handleAiCallAnswer(waCallId: string, sdp: string): Promise<boolean> {
  const s = sessions.get(waCallId);
  if (!s) return false;
  if (s.sdpApplied || s.ending) return true;
  s.sdpApplied = true;
  // O SDP chega quando o celular começa a TOCAR: só prepara o áudio. A IA
  // começa quando a Meta manda o status ACCEPTED (handleAiCallAccepted).
  try {
    await s.pc.setRemoteDescription({ type: 'answer', sdp });
  } catch (err) {
    console.error(`[AI-Call] ${waCallId} SDP de resposta inválido:`, err);
    endSession(s, 'sdp_error', true);
  }
  return true;
}

/** Status ACCEPTED da Meta: o cliente atendeu de verdade. Retorna false se a
 *  ligação não é da IA (segue o fluxo humano). */
export function handleAiCallAccepted(waCallId: string): boolean {
  const s = sessions.get(waCallId);
  if (!s) return false;
  if (s.answered || s.ending) return true;
  s.answered = true;
  s.answeredAt = Date.now();
  if (s.ringTimeout) clearTimeout(s.ringTimeout);
  console.log(`[AI-Call] ${waCallId} cliente atendeu, ligando o agente`);
  openAgentSocket(s).catch((err) => {
    console.error(`[AI-Call] ${waCallId} falha ao abrir o agente:`, err);
    endSession(s, 'agent_error', true);
  });
  return true;
}

/** Chamado pelo webhook `terminate` (cliente desligou, não atendeu, recusou). */
export function handleAiCallEnded(waCallId: string): void {
  const s = sessions.get(waCallId);
  if (s) endSession(s, 'ended_by_meta', false);
}

async function openAgentSocket(s: AiCallSession): Promise<void> {
  const agentId = await resolveAgentId();
  const res = await fetch(`${ELEVEN_API}/convai/conversation/get-signed-url?agent_id=${agentId}`, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
  });
  const { signed_url } = (await res.json()) as { signed_url?: string };
  if (!signed_url) throw new Error(`sem signed_url (HTTP ${res.status})`);
  if (s.ending) return;

  const ws = new WebSocket(signed_url);
  s.ws = ws;
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'conversation_initiation_client_data', dynamic_variables: s.dynamicVariables }));
  });
  ws.on('message', (raw) => {
    let m: any;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    switch (m.type) {
      case 'conversation_initiation_metadata': {
        const meta = m.conversation_initiation_metadata_event || {};
        s.conversationId = meta.conversation_id || null;
        s.agentReady = true;
        console.log(`[AI-Call] ${s.waCallId} agente pronto ${((Date.now() - s.answeredAt) / 1000).toFixed(1)}s após atender`);
        // Áudio que o cliente falou enquanto o agente conectava (o "Alô?"
        // logo ao atender) -- sem isso ele se perdia.
        if (s.preBytes) {
          const pre = Buffer.concat(s.preBuffer);
          s.preBuffer = []; s.preBytes = 0;
          for (let i = 0; i < pre.length; i += USER_CHUNK_BYTES) {
            ws.send(JSON.stringify({ user_audio_chunk: pre.subarray(i, i + USER_CHUNK_BYTES).toString('base64') }));
          }
        }
        // O agente não tem fala de abertura: espera o cliente. Se ele ficar
        // calado ~3s depois de atender, a IA diz "Alô?" (regra no prompt do
        // agente -- scripts/elevenlabs-sdr-agent.ts).
        s.silenceTimer = setTimeout(() => {
          if (!s.userSpoke && s.ws?.readyState === WebSocket.OPEN) {
            console.log(`[AI-Call] ${s.waCallId} cliente calado ${((Date.now() - s.answeredAt) / 1000).toFixed(1)}s após atender, IA vai dizer "Alô?"`);
            s.ws.send(JSON.stringify({ type: 'user_message', text: SILENCE_MARKER }));
          }
        }, Math.max(0, OPENING_SILENCE_MS - (Date.now() - s.answeredAt)));
        if (meta.agent_output_audio_format !== 'pcm_48000' || meta.user_input_audio_format !== 'pcm_48000') {
          console.warn(`[AI-Call] ${s.waCallId} formato de áudio inesperado:`, JSON.stringify(meta));
        }
        break;
      }
      case 'audio': {
        const b = Buffer.from(m.audio_event?.audio_base_64 || '', 'base64');
        if (b.length) { s.outQueue.push(b); s.outBytes += b.length; }
        break;
      }
      case 'interruption':
        s.outQueue = []; s.outOffset = 0; s.outBytes = 0;
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', event_id: m.ping_event?.event_id }));
        break;
      case 'agent_response':
        if (m.agent_response_event?.agent_response) s.transcript.push({ role: 'IA', text: m.agent_response_event.agent_response });
        break;
      case 'user_transcript': {
        const text = m.user_transcription_event?.user_transcript;
        if (text && text !== SILENCE_MARKER) {
          s.userSpoke = true;
          s.transcript.push({ role: 'Cliente', text });
        }
        break;
      }
    }
  });
  ws.on('close', (code) => {
    s.ws = null;
    if (!s.ending) {
      console.log(`[AI-Call] ${s.waCallId} agente encerrou a conversa (ws ${code})`);
      finishAfterDrain(s);
    }
  });
  ws.on('error', (err) => console.error(`[AI-Call] ${s.waCallId} erro no WebSocket do agente:`, err.message));
}

function onInboundRtp(s: AiCallSession, payload: Buffer): void {
  if (!s.answered || s.ending || !payload.length) return;
  let pcm: Buffer;
  try { pcm = s.decoder.decode(payload); } catch { return; }

  // Detector simples de voz só pro "Alô?" de abertura: 100ms seguidos com
  // volume de fala contam como o cliente ter falado (a transcrição da
  // ElevenLabs chega depois, e o aviso de silêncio não pode atropelar).
  if (!s.userSpoke) {
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    let sum = 0;
    for (const v of samples) sum += v * v;
    s.loudFrames = Math.sqrt(sum / Math.max(samples.length, 1)) > SPEECH_RMS ? s.loudFrames + 1 : 0;
    if (s.loudFrames >= 5) s.userSpoke = true;
  }

  if (!s.agentReady || !s.ws || s.ws.readyState !== WebSocket.OPEN) {
    s.preBuffer.push(pcm);
    s.preBytes += pcm.length;
    while (s.preBytes > PRE_BUFFER_MAX_BYTES && s.preBuffer.length > 1) s.preBytes -= s.preBuffer.shift()!.length;
    return;
  }
  s.inChunks.push(pcm);
  s.inBytes += pcm.length;
  if (s.inBytes >= USER_CHUNK_BYTES) {
    const chunk = Buffer.concat(s.inChunks);
    s.inChunks = []; s.inBytes = 0;
    s.ws.send(JSON.stringify({ user_audio_chunk: chunk.toString('base64') }));
  }
}

function takeFrame(s: AiCallSession): Buffer {
  const need = FRAME * 2;
  const out = Buffer.alloc(need);
  let filled = 0;
  while (filled < need && s.outQueue.length) {
    const head = s.outQueue[0];
    const n = Math.min(head.length - s.outOffset, need - filled);
    head.copy(out, filled, s.outOffset, s.outOffset + n);
    filled += n;
    s.outOffset += n;
    s.outBytes -= n;
    if (s.outOffset >= head.length) { s.outQueue.shift(); s.outOffset = 0; }
  }
  return out;
}

// Manda um frame Opus de 20ms a cada 20ms (silêncio quando o agente não está
// falando) -- o relógio é o tempo real, não o setInterval, pra não acumular atraso.
function startPacer(s: AiCallSession): void {
  s.pacerStart = Date.now();
  s.sentFrames = 0;
  s.pacer = setInterval(() => {
    const due = Math.floor((Date.now() - s.pacerStart) / 20);
    let n = Math.min(due - s.sentFrames, 50);
    while (n-- > 0) {
      s.sentFrames++;
      let payload: Buffer;
      try { payload = s.encoder.encode(takeFrame(s), FRAME); } catch { continue; }
      const pkt = new RtpPacket(new RtpHeader({ sequenceNumber: s.seq, timestamp: s.ts, payloadType: 111 }), payload);
      s.seq = (s.seq + 1) & 0xffff;
      s.ts = (s.ts + FRAME) >>> 0;
      s.transceiver.sender.sendRtp(pkt).catch(() => {});
    }
  }, 10);
}

// O agente fechou a conversa (despediu-se e usou end_call): deixa a fala
// terminar de tocar pro cliente antes de desligar.
function finishAfterDrain(s: AiCallSession): void {
  const deadline = Date.now() + 15_000;
  const check = setInterval(() => {
    if (s.ending) { clearInterval(check); return; }
    if (s.outBytes <= 0 || Date.now() > deadline) {
      clearInterval(check);
      setTimeout(() => endSession(s, 'agent_finished', true), 400);
    }
  }, 100);
}

async function endSession(s: AiCallSession, reason: string, terminateOnMeta: boolean): Promise<void> {
  if (s.ending) return;
  s.ending = true;
  sessions.delete(s.waCallId);
  if (s.ringTimeout) clearTimeout(s.ringTimeout);
  if (s.pacer) clearInterval(s.pacer);
  if (s.silenceTimer) clearTimeout(s.silenceTimer);
  try { s.ws?.close(); } catch { /* já fechado */ }
  console.log(`[AI-Call] ${s.waCallId} encerrando (${reason}), ${s.transcript.length} falas`);

  if (terminateOnMeta) {
    await terminateCall(s.config, s.waCallId).catch(() => {});
    // A Meta costuma mandar o webhook `terminate` (que finaliza a Call e a
    // mensagem na conversa); se não vier, finaliza aqui mesmo.
    setTimeout(() => finalizeIfStillOpen(s, reason).catch(() => {}), 8000);
  }
  await s.pc.close().catch(() => {});

  if (s.answered) setTimeout(() => saveCallNote(s).catch((err) => console.error('[AI-Call] falha ao salvar resumo:', err)), 20_000);
}

async function finalizeIfStillOpen(s: AiCallSession, reason: string): Promise<void> {
  const call = await prisma.call.findUnique({ where: { waCallId: s.waCallId } });
  if (!call || (call.status !== 'CONNECTED' && call.status !== 'CONNECTING' && call.status !== 'RINGING')) return;
  const status = call.status === 'CONNECTED' ? 'ENDED' : 'MISSED';
  const endedAt = new Date();
  await prisma.call.update({ where: { waCallId: s.waCallId }, data: { status, endedAt, endReason: `ai_${reason}` } });
  const durationSec = call.connectedAt ? Math.max(0, Math.round((endedAt.getTime() - call.connectedAt.getTime()) / 1000)) : 0;
  const payload = { waCallId: s.waCallId, status, endReason: `ai_${reason}` };
  s.io?.to(`account_${s.accountId}`).emit('call_ended', payload);
  s.io?.to(`lead:${s.leadId}`).emit('call_ended', payload);
  await finalizeCallMessage(s.waCallId, status, durationSec, s.io, s.accountId, s.leadId);
}

const FIELD_LABELS: Record<string, string> = {
  valor_imovel: 'Valor do imóvel', valor_entrada: 'Entrada', valor_credito: 'Valor do crédito', usa_fgts: 'Usa FGTS',
  renda_mensal: 'Renda mensal', perfil_renda: 'Perfil de renda', data_nascimento: 'Nascimento', restricao_nome: 'Restrição no nome',
  cidade_imovel: 'Cidade do imóvel', tipo_imovel: 'Tipo do imóvel', imovel_quitado: 'Imóvel quitado', objetivo_credito: 'Objetivo do crédito',
  melhor_horario_retorno: 'Melhor horário pra retorno',
};
const MONEY_FIELDS = new Set(['valor_imovel', 'valor_entrada', 'valor_credito', 'renda_mensal']);

function formatValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (MONEY_FIELDS.has(key) && typeof value === 'number') return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  return String(value);
}

async function fetchConversation(conversationId: string): Promise<any | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${ELEVEN_API}/convai/conversations/${conversationId}`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! } });
    const json: any = await res.json().catch(() => null);
    if (json && json.status === 'done' && json.analysis) return json;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return null;
}

async function saveCallNote(s: AiCallSession): Promise<void> {
  const conv = s.conversationId ? await fetchConversation(s.conversationId) : null;
  const results: Record<string, { value: unknown }> = conv?.analysis?.data_collection_results || {};
  const get = (k: string) => results[k]?.value;
  const durationSec: number | undefined = conv?.metadata?.call_duration_secs;

  const lines: string[] = [`🤖 Ligação feita pela IA${durationSec ? ` — ${Math.floor(durationSec / 60)}min ${String(durationSec % 60).padStart(2, '0')}s` : ''}`];
  if (get('interesse')) lines.push(`Interesse: ${get('interesse')}`);
  const resumo = get('resumo') || conv?.analysis?.transcript_summary;
  if (resumo) lines.push(`Resumo: ${resumo}`);
  if (get('proximo_passo')) lines.push(`Próximo passo: ${get('proximo_passo')}`);

  const collected = Object.keys(FIELD_LABELS)
    .filter((k) => get(k) !== null && get(k) !== undefined && String(get(k)).trim() !== '')
    .map((k) => `• ${FIELD_LABELS[k]}: ${formatValue(k, get(k))}`);
  if (collected.length) lines.push('', 'Dados que o cliente informou:', ...collected);

  const transcript: TranscriptLine[] = conv?.transcript?.length
    ? conv.transcript.filter((t: any) => t.message && t.message.trim() !== SILENCE_MARKER).map((t: any) => ({ role: t.role === 'agent' ? 'IA' : 'Cliente', text: t.message }))
    : s.transcript;
  if (transcript.length) lines.push('', 'Transcrição:', ...transcript.map((t) => `${t.role}: ${t.text}`));

  await prisma.note.create({ data: { leadId: s.leadId, type: 'CALL', content: lines.join('\n').slice(0, 20000) } });
  console.log(`[AI-Call] ${s.waCallId} resumo salvo no card (${collected.length} dados, ${transcript.length} falas)`);
}

type StunResult = { server: string; mapped: string | null; error?: string };

function stunBinding(socket: dgram.Socket, host: string, port: number, timeoutMs = 4000): Promise<StunResult> {
  const server = `${host}:${port}`;
  return new Promise((resolve) => {
    const tid = crypto.randomBytes(12);
    const msg = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), tid]);
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve({ server, mapped: null, error: 'timeout' });
    }, timeoutMs);
    function onMessage(m: Buffer) {
      if (m.length < 20 || !m.subarray(8, 20).equals(tid)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      let i = 20;
      let mapped: string | null = null;
      while (i + 4 <= m.length) {
        const type = m.readUInt16BE(i);
        const len = m.readUInt16BE(i + 2);
        if (type === 0x0020 && len >= 8) {
          const p = m.readUInt16BE(i + 6) ^ 0x2112;
          const ip = [0, 1, 2, 3].map((k) => m[i + 8 + k] ^ [0x21, 0x12, 0xa4, 0x42][k]).join('.');
          mapped = `${ip}:${p}`;
        }
        i += 4 + len + ((4 - (len % 4)) % 4);
      }
      resolve({ server, mapped });
    }
    socket.on('message', onMessage);
    socket.send(msg, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve({ server, mapped: null, error: err.message });
      }
    });
  });
}

// Diagnóstico de boot: a ligação feita pela IA precisa que o servidor troque
// áudio com a Meta por UDP (WebRTC). Confirma se o Railway deixa sair UDP e
// se o NAT mantém a mesma porta pra destinos diferentes.
export async function probeUdpEgress(): Promise<void> {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve) => socket.bind(0, resolve));
    const a = await stunBinding(socket, 'stun.l.google.com', 19302);
    const b = await stunBinding(socket, 'stun.cloudflare.com', 3478);
    const natType = a.mapped && b.mapped ? (a.mapped === b.mapped ? 'mesma porta (NAT amigável)' : 'porta muda por destino (NAT simétrico)') : 'indeterminado';
    console.log(`[AI-Call][UDP] ${a.server} -> ${a.mapped || a.error} | ${b.server} -> ${b.mapped || b.error} | ${natType}`);
  } catch (err) {
    console.error('[AI-Call][UDP] falha no diagnóstico:', err);
  } finally {
    socket.close();
  }
}

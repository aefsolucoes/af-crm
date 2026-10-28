import api from '@/lib/api';
import { useSendLocationNoticeStore } from '@/store/send-location-notice.store';

/* De onde a equipe mandou cada mensagem (Fabio 27/10). Sem a chave do pop-up, só lê o GPS se o aparelho JÁ permitiu a localização pro CRM — nunca
 * abre o pedido (Fabio: "não precisa mandar pop pedindo autorização ainda"); sem permissão a mensagem sai normal e o relatório (Configurações →
 * Localização) marca "não autorizou". Com a chave ligada pra pessoa (Fabio 28/10), na 1ª vez no aparelho aparece o aviso do CRM e depois o pedido
 * do aparelho; "Não Permitir" = "negou". */

export type SendLocationReading = {
  status: 'OK' | 'NAO_AUTORIZOU' | 'NEGOU' | 'INDISPONIVEL' | 'ERRO';
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  detail?: string;
};

const NOTICE_KEY = 'afcrm.sendLocationNotice';

async function permissionState(): Promise<PermissionState | 'unsupported'> {
  try {
    if (typeof navigator === 'undefined' || !navigator.geolocation || !navigator.permissions?.query) return 'unsupported';
    return (await navigator.permissions.query({ name: 'geolocation' as PermissionName })).state;
  } catch {
    return 'unsupported';
  }
}

// A chave muda pouco: consulta no máximo a cada 5 min.
let promptCache: { value: boolean; at: number } | null = null;
async function promptAllowed(): Promise<boolean> {
  if (promptCache && Date.now() - promptCache.at < 5 * 60_000) return promptCache.value;
  const value = await api.get('/api/messages/send-location-config').then((r) => !!r.data?.prompt).catch(() => false);
  promptCache = { value, at: Date.now() };
  return value;
}

function noticeSeen(): boolean {
  try { return localStorage.getItem(NOTICE_KEY) === '1'; } catch { return false; }
}
function markNoticeSeen() {
  try { localStorage.setItem(NOTICE_KEY, '1'); } catch { /* sem storage: o aviso só volta a aparecer */ }
}

function readGps(denied: SendLocationReading): Promise<SendLocationReading> {
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ status: 'OK', latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => resolve(err.code === err.PERMISSION_DENIED
        ? denied
        : { status: 'ERRO', detail: err.code === err.TIMEOUT ? 'GPS demorou demais' : 'GPS sem sinal' }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
}

// Vários envios seguidos enquanto o aviso/pedido está na tela usam o mesmo pedido (um pop-up só).
let asking: Promise<SendLocationReading> | null = null;

async function askPermission(state: PermissionState | 'unsupported'): Promise<SendLocationReading> {
  if (!noticeSeen()) {
    await useSendLocationNoticeStore.getState().ask();
    markNoticeSeen();
  }
  return readGps({ status: 'NEGOU', detail: state === 'prompt' ? 'tocou em Não Permitir' : 'negou a localização' });
}

export async function readSendLocation(): Promise<SendLocationReading> {
  const state = await permissionState();
  if (state === 'granted') return readGps({ status: 'NAO_AUTORIZOU', detail: 'localização negada' });
  if (!(await promptAllowed())) {
    // Sem como saber se já foi permitido: não arrisca chamar o GPS (abriria o pop-up).
    if (state === 'unsupported') return { status: 'INDISPONIVEL', detail: 'aparelho não informa a permissão' };
    return { status: 'NAO_AUTORIZOU', detail: state === 'denied' ? 'localização bloqueada' : 'localização nunca permitida' };
  }
  // Bloqueada antes (no pedido ou nos ajustes): o aparelho não pergunta de novo.
  if (state === 'denied') return { status: 'NEGOU', detail: 'bloqueada no aparelho' };
  if (!asking) asking = askPermission(state).finally(() => { asking = null; });
  return asking;
}

/** Começa a ler JÁ no clique de enviar (em paralelo com o envio) e grava em cada mensagem que saiu. Nunca atrapalha o envio: erro é ignorado. */
export function startSendLocation(): (messageIds: (string | null | undefined)[]) => void {
  const reading = readSendLocation().catch((): SendLocationReading => ({ status: 'ERRO', detail: 'falha ao ler' }));
  return (messageIds) => {
    const ids = messageIds.filter((id): id is string => !!id);
    if (!ids.length) return;
    reading.then((l) => Promise.all(ids.map((id) => api.post(`/api/messages/${id}/send-location`, l)))).catch(() => {});
  };
}

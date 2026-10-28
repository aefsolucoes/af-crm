import api from '@/lib/api';

/* De onde a equipe mandou cada mensagem (Fabio 27/10). Só lê o GPS se o aparelho JÁ permitiu a localização pro CRM — NUNCA abre o pop-up pedindo
 * (Fabio: "não precisa mandar pop pedindo autorização ainda"). Sem permissão a mensagem sai normal e o relatório (Configurações → Localização)
 * marca "não autorizou". */

export type SendLocationReading = {
  status: 'OK' | 'NAO_AUTORIZOU' | 'INDISPONIVEL' | 'ERRO';
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  detail?: string;
};

async function permissionState(): Promise<PermissionState | 'unsupported'> {
  try {
    if (typeof navigator === 'undefined' || !navigator.geolocation || !navigator.permissions?.query) return 'unsupported';
    return (await navigator.permissions.query({ name: 'geolocation' as PermissionName })).state;
  } catch {
    return 'unsupported';
  }
}

export async function readSendLocation(): Promise<SendLocationReading> {
  const state = await permissionState();
  // Sem como saber se já foi permitido: não arrisca chamar o GPS (abriria o pop-up).
  if (state === 'unsupported') return { status: 'INDISPONIVEL', detail: 'aparelho não informa a permissão' };
  if (state !== 'granted') return { status: 'NAO_AUTORIZOU', detail: state === 'denied' ? 'localização bloqueada' : 'localização nunca permitida' };
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ status: 'OK', latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => resolve(err.code === err.PERMISSION_DENIED
        ? { status: 'NAO_AUTORIZOU', detail: 'localização negada' }
        : { status: 'ERRO', detail: err.code === err.TIMEOUT ? 'GPS demorou demais' : 'GPS sem sinal' }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
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

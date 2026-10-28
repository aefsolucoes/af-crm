'use client';
import { useEffect } from 'react';
import api from '@/lib/api';

/* Localizador da equipe (Fabio 28/10: "saber se está fazendo as rotas de visitar clientes"). Marca um ponto quando a pessoa ABRE o CRM e, enquanto
 * ficar com o CRM aberto, de 1 em 1 minuto. NUNCA abre pop-up: só lê o GPS se o aparelho já está em "Permitir". Quem não está aparece como "sem
 * localização" no relatório (registrado espaçado, pra não encher). Para quando o app fecha — iPhone não roda site de fundo. */

const LAST_OK = 'afcrm.locPing.ok'; // última marcação com GPS (ms)
const LAST_SKIP = 'afcrm.locPing.skip'; // último registro "sem permissão" (ms)
const GAP_OK = 55_000; // ~1 min entre pontos
const GAP_SKIP = 60 * 60_000; // 1 h entre os "sem localização"

const getN = (k: string) => { try { return Number(localStorage.getItem(k)) || 0; } catch { return 0; } };
const setN = (k: string) => { try { localStorage.setItem(k, String(Date.now())); } catch { /* sem storage */ } };

async function permissionState(): Promise<PermissionState | 'unsupported'> {
  try {
    if (typeof navigator === 'undefined' || !navigator.geolocation || !navigator.permissions?.query) return 'unsupported';
    return (await navigator.permissions.query({ name: 'geolocation' as PermissionName })).state;
  } catch {
    return 'unsupported';
  }
}

function readGps(): Promise<{ status: string; latitude?: number; longitude?: number; accuracy?: number; detail?: string }> {
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ status: 'OK', latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => resolve({ status: e.code === e.PERMISSION_DENIED ? 'NEGOU' : 'ERRO', detail: e.code === e.TIMEOUT ? 'GPS demorou demais' : 'GPS sem sinal' }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
}

async function maybePing() {
  if (typeof document !== 'undefined' && document.hidden) return; // app em segundo plano: não marca
  const st = await permissionState();
  if (st === 'granted') {
    if (Date.now() - getN(LAST_OK) < GAP_OK) return;
    setN(LAST_OK);
    api.post('/api/messages/location-ping', await readGps()).catch(() => {});
    return;
  }
  // "cada aparelho em Permitir": não pede permissão; só anota, espaçado, que está sem localização.
  if (Date.now() - getN(LAST_SKIP) < GAP_SKIP) return;
  setN(LAST_SKIP);
  const detail = st === 'unsupported' ? 'aparelho não informa a permissão' : st === 'denied' ? 'localização bloqueada' : 'localização nunca permitida';
  api.post('/api/messages/location-ping', { status: st === 'unsupported' ? 'INDISPONIVEL' : 'NAO_AUTORIZOU', detail }).catch(() => {});
}

/** Liga o localizador enquanto o CRM está aberto (passar `enabled` só com usuário logado). */
export function useLocationPing(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    maybePing();
    const iv = setInterval(maybePing, 30_000); // confere a cada 30 s; a marcação real respeita o intervalo de 1 min
    const onVis = () => { if (!document.hidden) maybePing(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, [enabled]);
}

'use client';
import { useCallback, useEffect, useState } from 'react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';

/** VAPID public key vem em base64url — o Push API do navegador exige
 *  Uint8Array. Conversão padrão recomendada pela spec. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

type PushStatus = 'unsupported' | 'loading' | 'subscribed' | 'unsubscribed' | 'denied';

// Desativou de propósito neste aparelho: a sincronização ao abrir o app não recria a inscrição.
const PUSH_OFF_KEY = 'af-crm:push:desativado';
function readPushOff(): boolean {
  try { return localStorage.getItem(PUSH_OFF_KEY) === '1'; } catch { return false; }
}
function storePushOff(off: boolean) {
  try {
    if (off) localStorage.setItem(PUSH_OFF_KEY, '1');
    else localStorage.removeItem(PUSH_OFF_KEY);
  } catch { /* modo privado etc. */ }
}

async function createSubscription(reg: ServiceWorkerRegistration): Promise<PushSubscription | null> {
  const { data } = await api.get('/api/push/vapid-public-key');
  if (!data?.publicKey) return null;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    // Cast: a lib DOM do TS exige BufferSource com ArrayBuffer "não-compartilhado"
    // em sentido estrito; Uint8Array normal (não SharedArrayBuffer) funciona em
    // todo navegador real, é só o tipo que é overzealous aqui.
    applicationServerKey: urlBase64ToUint8Array(data.publicKey) as BufferSource,
  });
}

async function saveSubscription(sub: PushSubscription) {
  const json = sub.toJSON();
  await api.post('/api/push/subscribe', {
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    userAgent: navigator.userAgent,
  });
}

let syncing: Promise<void> | null = null;

/** Ao abrir o app com a permissão já dada: reenvia a inscrição deste aparelho pro servidor e, se o aparelho perdeu a inscrição, recria sem perguntar nada.
 *  Antes a inscrição só era gravada no clique em "Ativar": se o servidor a apagasse (provedor devolveu 410) a tela seguia dizendo "ativadas" e nada chegava
 *  (Fabio 08/11, "não estou recebendo no meu"). */
export function syncPushSubscription(): Promise<void> {
  if (!syncing) {
    syncing = (async () => {
      if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
      if (Notification.permission !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub && !readPushOff()) sub = await createSubscription(reg);
      if (sub) await saveSubscription(sub);
    })().finally(() => { syncing = null; });
  }
  return syncing;
}

/** Notificação push de verdade (chega com o app fechado/em 2º plano) — em
 *  cima do Service Worker do PWA já registrado em layout.tsx. Só pede
 *  permissão sob gesto explícito do usuário (subscribe()), nunca sozinho ao
 *  montar a página. */
export function usePushSubscription() {
  const [status, setStatus] = useState<PushStatus>('loading');
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setStatus('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setStatus('denied');
      return;
    }
    try {
      await syncPushSubscription().catch(() => {}); // sem rede ou sem gesto no iPhone: a tela mostra o que o aparelho tem e o botão "Ativar" resolve
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setEndpoint(sub?.endpoint || null);
      setStatus(sub ? 'subscribed' : 'unsubscribed');
    } catch {
      setStatus('unsubscribed');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const subscribe = useCallback(async () => {
    if (status === 'unsupported') return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'unsubscribed');
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      const sub = await createSubscription(reg);
      if (!sub) {
        // Chaves VAPID ainda não configuradas no servidor — antes falhava
        // 100% silencioso (parecia que o botão não fazia nada); agora avisa.
        toast('Notificação push ainda não configurada no servidor — fale com o admin.', 'error');
        setStatus('unsubscribed');
        return;
      }

      await saveSubscription(sub);
      storePushOff(false);
      setEndpoint(sub.endpoint);
      setStatus('subscribed');
    } catch (err) {
      console.error('[Push] Falha ao ativar notificações:', err);
      toast('Não consegui ativar as notificações push. Tente de novo.', 'error');
    } finally {
      setBusy(false);
    }
  }, [status]);

  const unsubscribe = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.delete('/api/push/subscribe', { data: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      storePushOff(true);
      setEndpoint(null);
      setStatus('unsubscribed');
    } catch (err) {
      console.error('[Push] Falha ao desativar notificações:', err);
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, endpoint, subscribe, unsubscribe };
}

'use client';
import { useCallback, useEffect, useState } from 'react';
import api from '@/lib/api';

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

/** Notificação push de verdade (chega com o app fechado/em 2º plano) — em
 *  cima do Service Worker do PWA já registrado em layout.tsx. Só pede
 *  permissão sob gesto explícito do usuário (subscribe()), nunca sozinho ao
 *  montar a página. */
export function usePushSubscription() {
  const [status, setStatus] = useState<PushStatus>('loading');
  const [busy, setBusy] = useState(false);

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
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
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

      const { data } = await api.get('/api/push/vapid-public-key');
      if (!data?.publicKey) {
        // Chaves VAPID ainda não configuradas no servidor — nada a fazer.
        setStatus('unsubscribed');
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast: a lib DOM do TS exige BufferSource com ArrayBuffer "não-compartilhado"
        // em sentido estrito; Uint8Array normal (não SharedArrayBuffer) funciona em
        // todo navegador real, é só o tipo que é overzealous aqui.
        applicationServerKey: urlBase64ToUint8Array(data.publicKey) as BufferSource,
      });

      const json = sub.toJSON();
      await api.post('/api/push/subscribe', {
        endpoint: sub.endpoint,
        keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        userAgent: navigator.userAgent,
      });
      setStatus('subscribed');
    } catch (err) {
      console.error('[Push] Falha ao ativar notificações:', err);
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
      setStatus('unsubscribed');
    } catch (err) {
      console.error('[Push] Falha ao desativar notificações:', err);
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, subscribe, unsubscribe };
}

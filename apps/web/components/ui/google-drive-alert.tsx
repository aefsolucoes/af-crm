'use client';
import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/store/auth.store';
import { Modal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { HardDrive } from 'lucide-react';

/**
 * Popup que avisa quando o Google Drive desconecta (token recusado pelo
 * Google — invalid_grant). Enquanto quebrado, os anexos do WhatsApp param de
 * subir pro Drive. Só aparece pra ADMIN ("apenas pro Fabio"). Fica montado no
 * layout do dashboard, então cobre qualquer tela.
 */
const POLL_MS = 5 * 60 * 1000;
// sessionStorage: o "Agora não" vale só pra sessão da aba — volta a avisar no
// próximo login/reload enquanto não reconectar.
const SNOOZE_KEY = 'af:drive-alert-snoozed';

export function GoogleDriveAlert() {
  const me = useAuthStore((s) => s.user);
  const isAdmin = me?.role === 'ADMIN';
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [snoozed, setSnoozed] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try { setSnoozed(sessionStorage.getItem(SNOOZE_KEY) === '1'); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    async function check() {
      try {
        const { data } = await api.get('/api/google/health');
        if (alive) setNeedsReconnect(!!data?.needsReconnect);
      } catch { /* rede — ignora, tenta de novo na próxima */ }
    }
    check();
    timer.current = setInterval(check, POLL_MS);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
      window.removeEventListener('focus', onFocus);
    };
  }, [isAdmin]);

  // Quando o popup do OAuth avisa que reconectou, reconfere e some com o alerta.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data?.type !== 'google-oauth') return;
      setTimeout(async () => {
        try {
          const { data } = await api.get('/api/google/health');
          const still = !!data?.needsReconnect;
          setNeedsReconnect(still);
          if (!still) {
            try { sessionStorage.removeItem(SNOOZE_KEY); } catch { /* ignore */ }
            setSnoozed(false);
            toast('Google Drive reconectado.');
          }
        } catch { /* ignore */ }
      }, 800);
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  async function handleReconnect() {
    setReconnecting(true);
    try {
      const { data } = await api.get('/api/google/oauth/start');
      window.open(data.url, 'google-oauth', 'width=520,height=680');
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao iniciar a reconexão', 'error');
    } finally {
      setReconnecting(false);
    }
  }

  function snooze() {
    try { sessionStorage.setItem(SNOOZE_KEY, '1'); } catch { /* ignore */ }
    setSnoozed(true);
  }

  if (!isAdmin || !needsReconnect || snoozed) return null;

  return (
    <Modal title="Google Drive desconectado" onClose={snooze} size="sm">
      <div className="space-y-3 text-sm text-slate-600">
        <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <HardDrive size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <p className="text-amber-800">
            O acesso ao Google Drive expirou ou foi revogado. Enquanto não reconectar, os{' '}
            <strong>anexos do WhatsApp param de subir</strong> pro Drive e ficam acumulando no banco.
          </p>
        </div>
        <p>Clique em <strong>Reconectar</strong> e faça o login do Google de novo (conta da empresa).</p>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button onClick={snooze} className="text-sm px-3 py-1.5 rounded-lg text-slate-500 hover:text-slate-700">
          Agora não
        </button>
        <button
          onClick={handleReconnect}
          disabled={reconnecting}
          className="text-sm px-4 py-1.5 rounded-lg text-white font-medium disabled:opacity-50"
          style={{ backgroundColor: '#2261a8' }}
        >
          {reconnecting ? 'Abrindo…' : 'Reconectar'}
        </button>
      </div>
    </Modal>
  );
}

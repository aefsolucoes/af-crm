'use client';
import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { getSocket } from '@/lib/socket';
import api from '@/lib/api';

/**
 * Faixa vermelha no topo de TODAS as telas (só pra ADMIN) quando a Meta trava o
 * envio do WhatsApp — pagamento pendente, conta restrita, acesso expirado
 * (Fabio 13/10). O servidor liga/desliga o aviso (whatsapp-alert.service.ts);
 * aqui só consulta, escuta o socket e deixa esconder por 1 hora (o aviso volta
 * se o problema continuar).
 */
interface Alert { active: boolean; code?: number; title?: string; message?: string; since?: string }
const SNOOZE_KEY = 'af:whatsapp-alert-snoozed-until';
const POLL_MS = 5 * 60 * 1000;

function snoozedNow(): boolean {
  try { return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now(); } catch { return false; }
}

export function WhatsAppAlertBanner() {
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const [alert, setAlert] = useState<Alert>({ active: false });
  const [snoozed, setSnoozed] = useState(false);

  useEffect(() => { setSnoozed(snoozedNow()); }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    const load = async () => {
      try {
        const { data } = await api.get('/api/settings/whatsapp/alert');
        if (alive) setAlert(data || { active: false });
      } catch { /* rede — tenta de novo na próxima */ }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    const socket = getSocket();
    const onAlert = () => { try { localStorage.removeItem(SNOOZE_KEY); } catch { /* ignore */ } setSnoozed(false); load(); };
    const onCleared = () => setAlert({ active: false });
    socket.on('whatsapp_alert', onAlert);
    socket.on('whatsapp_alert_cleared', onCleared);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      clearInterval(timer);
      socket.off('whatsapp_alert', onAlert);
      socket.off('whatsapp_alert_cleared', onCleared);
      window.removeEventListener('focus', load);
    };
  }, [isAdmin]);

  if (!isAdmin || !alert.active || snoozed) return null;

  function snooze() {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + 60 * 60 * 1000)); } catch { /* ignore */ }
    setSnoozed(true);
  }
  const since = alert.since ? new Date(alert.since).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div role="alert" className="flex items-start gap-3 bg-red-600 text-white px-4 py-2.5 text-sm flex-shrink-0">
      <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="font-bold">{alert.title || 'Problema no WhatsApp'}{since ? <span className="font-normal opacity-80"> · desde {since}</span> : null}</p>
        <p className="opacity-95 leading-snug">{alert.message}</p>
        <p className="opacity-80 text-xs mt-0.5">Enquanto isso, as mensagens do WhatsApp podem não estar saindo. Este aviso some sozinho quando a Meta voltar a entregar.</p>
      </div>
      <button onClick={snooze} className="flex-shrink-0 flex items-center gap-1 text-xs bg-white/15 hover:bg-white/25 rounded-lg px-2.5 py-1.5" title="Esconde por 1 hora; volta se o problema continuar">
        <X size={13} /> Esconder 1h
      </button>
    </div>
  );
}

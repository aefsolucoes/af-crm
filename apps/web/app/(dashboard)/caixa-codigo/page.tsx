'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';

/* WhatsApp do código da CAIXA (Fabio 12/11): um número comum conectado por QR SÓ pra receber o código de verificação do simulador da CAIXA (a API Oficial não lê
 * essa mensagem). Tudo oculto — não grava conversa, não cria card, não liga IA, não aparece na Inbox. Aqui só dá pra ver se está conectado e escanear de novo. */
interface Estado { status: 'desconectado' | 'conectando' | 'qr' | 'conectado'; qr: string | null; numero: string | null }

export default function CaixaCodigoPage() {
  const [busy, setBusy] = useState(false);
  const { data: e, refetch } = useQuery<Estado>({
    queryKey: ['caixa-codigo-qr'],
    queryFn: async () => (await api.get('/api/caixa-codigo-qr/status')).data,
    refetchInterval: 3000,
  });
  async function acao(qual: 'conectar' | 'desconectar') {
    if (qual === 'desconectar' && !window.confirm('Desconectar o WhatsApp do código da CAIXA? A simulação da CAIXA para até escanear de novo.')) return;
    setBusy(true);
    try { await api.post(`/api/caixa-codigo-qr/${qual}`); refetch(); } catch (err: any) { toast(err?.response?.data?.error || 'Não consegui agora', 'error'); } finally { setBusy(false); }
  }
  const st = e?.status || 'desconectado';
  return (
    <div className="flex flex-col h-full">
      <Topbar title="Código da CAIXA" subtitle="WhatsApp por QR que só recebe o código do simulador da CAIXA" />
      <div className="p-6 max-w-xl space-y-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600 space-y-3">
          <p>
            <b>Situação:</b>{' '}
            {st === 'conectado' ? <span className="text-emerald-700">✅ conectado{e?.numero ? ` — final ${e.numero.slice(-4)}` : ''}</span>
              : st === 'qr' ? <span className="text-amber-700">esperando a leitura do QR</span>
              : st === 'conectando' ? 'conectando…' : <span className="text-red-700">desconectado</span>}
          </p>
          <p className="text-xs text-slate-500">Só serve pra captar o código de verificação da CAIXA: nenhuma conversa desse número é gravada nem aparece na Inbox, e não tem IA.</p>
          {st === 'qr' && e?.qr && (
            <div className="space-y-2">
              <p>No celular que vai receber o código: WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b> → aponte para o QR (ele troca sozinho).</p>
              <img src={e.qr} alt="QR do WhatsApp" className="w-72 h-72 rounded-lg border border-slate-200 bg-white p-2" />
            </div>
          )}
          <div className="flex gap-2">
            {st === 'desconectado' && <button onClick={() => acao('conectar')} disabled={busy} className="text-sm px-4 py-2 rounded-lg bg-[#005CA9] text-white disabled:opacity-50">Conectar (mostrar QR)</button>}
            {st === 'conectado' && <button onClick={() => acao('desconectar')} disabled={busy} className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-600 disabled:opacity-50">Desconectar</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

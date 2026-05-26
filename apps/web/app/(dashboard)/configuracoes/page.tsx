'use client';
import { useState, useEffect } from 'react';
import { Topbar } from '@/components/ui/topbar';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { CheckCircle2, XCircle, Copy, ExternalLink, Info } from 'lucide-react';

interface WAConfig {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  active: boolean;
  webhookUrl: string;
}

export default function ConfiguracoesPage() {
  const [config, setConfig] = useState<WAConfig>({
    phoneNumberId: '',
    accessToken: '',
    verifyToken: 'af_crm_verify',
    active: false,
    webhookUrl: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isNew, setIsNew] = useState(true);

  useEffect(() => {
    api.get('/api/settings/whatsapp').then(({ data }) => {
      if (data) {
        setConfig(data);
        setIsNew(false);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/api/settings/whatsapp', {
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        verifyToken: config.verifyToken,
        active: config.active,
      });
      toast('Configurações salvas!');
      setIsNew(false);
    } catch {
      toast('Erro ao salvar configurações', 'error');
    } finally {
      setSaving(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast('Copiado!');
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <Topbar title="Configurações" subtitle="Integrações e canais" />
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin w-8 h-8 border-4 border-af-accent border-t-transparent rounded-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Topbar title="Configurações" subtitle="Integrações e canais" />
      <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
        <div className="max-w-2xl mx-auto space-y-6">

          {/* WhatsApp Card */}
          <div className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
            {/* Card header */}
            <div className="flex items-center gap-3 px-6 py-4 border-b border-af-border" style={{ backgroundColor: '#075e54' }}>
              <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center text-2xl">
                📱
              </div>
              <div>
                <h2 className="text-white font-bold text-base">WhatsApp Business API</h2>
                <p className="text-white/70 text-xs">Meta Cloud API (oficial)</p>
              </div>
              <div className="ml-auto">
                {config.active ? (
                  <span className="flex items-center gap-1 bg-green-400/20 text-green-200 text-xs px-3 py-1 rounded-full font-medium">
                    <CheckCircle2 size={12} /> Ativo
                  </span>
                ) : (
                  <span className="flex items-center gap-1 bg-white/10 text-white/60 text-xs px-3 py-1 rounded-full">
                    <XCircle size={12} /> Inativo
                  </span>
                )}
              </div>
            </div>

            <form onSubmit={handleSave} className="px-6 py-5 space-y-5">

              {/* Instructions */}
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <div className="flex items-start gap-2">
                  <Info size={16} className="text-blue-600 mt-0.5 flex-shrink-0" />
                  <div className="text-xs text-blue-700 space-y-1">
                    <p className="font-semibold">Como configurar:</p>
                    <ol className="list-decimal ml-4 space-y-1">
                      <li>Acesse <a href="https://developers.facebook.com" target="_blank" rel="noreferrer" className="underline font-medium">developers.facebook.com</a> e crie um app do tipo <strong>Business</strong></li>
                      <li>Adicione o produto <strong>WhatsApp</strong> ao seu app</li>
                      <li>Em <strong>WhatsApp → Configuração</strong>, copie o <strong>ID do número de telefone</strong> e o <strong>Token de acesso temporário</strong></li>
                      <li>Configure o webhook abaixo no painel do Meta</li>
                    </ol>
                  </div>
                </div>
              </div>

              {/* Phone Number ID */}
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">
                  ID do Número de Telefone <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={config.phoneNumberId}
                  onChange={(e) => setConfig((c) => ({ ...c, phoneNumberId: e.target.value }))}
                  placeholder="Ex: 123456789012345"
                  required
                  className="w-full px-4 py-2.5 text-sm border border-af-border rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-af-accent focus:bg-white"
                />
                <p className="text-xs text-slate-400 mt-1">Encontrado em: Meta for Developers → WhatsApp → Configuração API</p>
              </div>

              {/* Access Token */}
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">
                  Token de Acesso <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={config.accessToken}
                  onChange={(e) => setConfig((c) => ({ ...c, accessToken: e.target.value }))}
                  placeholder={isNew ? 'Cole seu token aqui' : 'Token salvo (••••••••)'}
                  required={isNew}
                  className="w-full px-4 py-2.5 text-sm border border-af-border rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-af-accent focus:bg-white"
                />
                <p className="text-xs text-slate-400 mt-1">Para produção, gere um token permanente via System Users no Business Manager</p>
              </div>

              {/* Verify Token */}
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">
                  Token de Verificação do Webhook
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={config.verifyToken}
                    onChange={(e) => setConfig((c) => ({ ...c, verifyToken: e.target.value }))}
                    className="flex-1 px-4 py-2.5 text-sm border border-af-border rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-af-accent"
                  />
                  <button
                    type="button"
                    onClick={() => copyToClipboard(config.verifyToken)}
                    className="px-3 py-2 border border-af-border rounded-xl hover:bg-af-light text-slate-500"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              {/* Webhook URL */}
              {config.webhookUrl && (
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">
                    URL do Webhook (configure no Meta)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={config.webhookUrl}
                      readOnly
                      className="flex-1 px-4 py-2.5 text-sm border border-af-border rounded-xl bg-slate-100 text-slate-600 font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => copyToClipboard(config.webhookUrl)}
                      className="px-3 py-2 border border-af-border rounded-xl hover:bg-af-light text-slate-500"
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Cole esta URL em: Meta → WhatsApp → Configuração → Webhook. Assine o campo <strong>messages</strong>.
                  </p>
                </div>
              )}

              {/* Active toggle */}
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border border-af-border">
                <div>
                  <p className="text-sm font-semibold text-slate-700">Ativar integração</p>
                  <p className="text-xs text-slate-400 mt-0.5">Mensagens serão enviadas e recebidas via WhatsApp Business API</p>
                </div>
                <button
                  type="button"
                  onClick={() => setConfig((c) => ({ ...c, active: !c.active }))}
                  className={`relative w-12 h-6 rounded-full transition-colors ${config.active ? 'bg-[#075e54]' : 'bg-slate-300'}`}
                >
                  <span
                    className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${config.active ? 'translate-x-7' : 'translate-x-1'}`}
                  />
                </button>
              </div>

              {/* Save */}
              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 py-3 rounded-xl text-white font-semibold text-sm transition-opacity disabled:opacity-50"
                  style={{ backgroundColor: '#075e54' }}
                >
                  {saving ? 'Salvando...' : 'Salvar configurações'}
                </button>
                <a
                  href="https://developers.facebook.com/apps"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 px-4 py-3 rounded-xl border border-af-border text-slate-600 text-sm hover:bg-af-light"
                >
                  <ExternalLink size={14} />
                  Meta
                </a>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

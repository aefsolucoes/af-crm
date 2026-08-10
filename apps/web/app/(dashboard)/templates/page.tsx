'use client';
import { useEffect, useState } from 'react';
import { Topbar } from '@/components/ui/topbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { Plus, Trash2, Edit2, Copy, Search, MessageSquare, Tag, Send, BadgeCheck, Clock, XCircle, ShieldCheck } from 'lucide-react';
import {
  MessageTemplate as Template, TemplateCategory as Category, CATEGORY_META,
  extractVariables, fillTemplate, getTemplates, saveTemplates,
} from '@/lib/templates';

const EMPTY_FORM = { name: '', category: 'geral' as Category, body: '' };

// ── Templates do WhatsApp (Meta) — precisam de aprovação antes de usar ───────
type MetaTemplateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | string;
interface MetaTemplate {
  name: string;
  status: MetaTemplateStatus;
  category: string;
  language: string;
  rejected_reason?: string;
  components: { type: string; text?: string }[];
}
const META_CATEGORY_LABEL: Record<string, string> = { MARKETING: 'Marketing', UTILITY: 'Utilidade', AUTHENTICATION: 'Autenticação' };
const META_STATUS_META: Record<string, { label: string; color: string; icon: typeof BadgeCheck }> = {
  APPROVED: { label: 'Aprovado', color: 'bg-emerald-50 text-emerald-600', icon: BadgeCheck },
  PENDING:  { label: 'Em análise', color: 'bg-amber-50 text-amber-600', icon: Clock },
  REJECTED: { label: 'Rejeitado', color: 'bg-red-50 text-red-500', icon: XCircle },
};
const META_EMPTY_FORM = { name: '', category: 'UTILITY', language: 'pt_BR', body: '', footer: '', codeExpirationMinutes: '10' };

function WhatsAppTemplatesTab() {
  const [items, setItems] = useState<MetaTemplate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(META_EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setErrorMsg('');
    try {
      const { data } = await api.get('/api/settings/whatsapp/templates');
      setItems(data.templates || []);
    } catch (err: any) {
      setItems(null);
      setErrorMsg(err?.response?.data?.error || 'Erro ao buscar templates');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const isAuth = form.category === 'AUTHENTICATION';

  async function handleSubmit() {
    if (!form.name.trim() || (!isAuth && !form.body.trim())) {
      toast(isAuth ? 'Preencha o nome do template.' : 'Preencha nome e corpo da mensagem.', 'warning');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/settings/whatsapp/templates', {
        ...form,
        codeExpirationMinutes: isAuth ? (parseInt(form.codeExpirationMinutes, 10) || 10) : undefined,
      });
      toast('Template enviado para aprovação da Meta!');
      setShowModal(false);
      setForm(META_EMPTY_FORM);
      load();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao enviar template', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-slate-500 max-w-xl">
          Templates precisam ser aprovados pela Meta antes de poder ser usados —
          é o único jeito de mandar mensagem pelo WhatsApp API depois de 24h sem
          resposta do cliente. A aprovação costuma levar de minutos a ~24h.
        </p>
        <Button onClick={() => setShowModal(true)}>
          <Plus size={15} /> Novo template
        </Button>
      </div>

      {loading && <p className="text-sm text-slate-400">Carregando...</p>}

      {!loading && errorMsg && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
          {errorMsg}
        </div>
      )}

      {!loading && !errorMsg && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {(items || []).map((t) => {
            const st = META_STATUS_META[t.status] || { label: t.status, color: 'bg-slate-100 text-slate-500', icon: Clock };
            const StatusIcon = st.icon;
            const body = t.components.find((c) => c.type === 'BODY')?.text || '';
            return (
              <div key={t.name} className="bg-white rounded-xl border border-af-border shadow-sm flex flex-col">
                <div className="p-4 flex-1">
                  <div className="flex items-start justify-between mb-2 gap-2">
                    <h3 className="text-sm font-semibold text-slate-900 truncate">{t.name}</h3>
                    <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${st.color}`}>
                      <StatusIcon size={11} /> {st.label}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mb-2">{META_CATEGORY_LABEL[t.category] || t.category} · {t.language}</p>
                  <div className="p-3 bg-slate-50 rounded-lg border border-af-border text-xs text-slate-600 whitespace-pre-wrap line-clamp-5 font-mono leading-relaxed">
                    {body}
                  </div>
                  {t.status === 'REJECTED' && t.rejected_reason && (
                    <p className="mt-2 text-xs text-red-500">Motivo: {t.rejected_reason}</p>
                  )}
                </div>
              </div>
            );
          })}
          {(items || []).length === 0 && (
            <div className="col-span-3 text-center py-16 text-slate-400">
              <MessageSquare size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Nenhum template enviado para a Meta ainda</p>
            </div>
          )}
        </div>
      )}

      {showModal && (
        <Modal title="Novo template (Meta)" onClose={() => setShowModal(false)}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Input label="Nome do template" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex: Lembrete de reunião" />
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700">Categoria</label>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                >
                  <option value="UTILITY">Utilidade</option>
                  <option value="MARKETING">Marketing</option>
                  <option value="AUTHENTICATION">Autenticação</option>
                </select>
              </div>
            </div>

            {isAuth ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
                  <ShieldCheck size={15} className="flex-shrink-0 mt-0.5" />
                  <span>
                    Templates de <strong>Autenticação</strong> usam uma mensagem de código de verificação
                    gerada automaticamente pela Meta (com recomendação de segurança e botão de
                    "copiar código") — não dá pra escrever o texto aqui.
                  </span>
                </div>
                <div className="w-40">
                  <Input
                    label="Código expira em (minutos)"
                    type="number"
                    min={1}
                    max={90}
                    value={form.codeExpirationMinutes}
                    onChange={(e) => setForm({ ...form, codeExpirationMinutes: e.target.value })}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-slate-700">Corpo da mensagem</label>
                    <span className="text-xs text-slate-400">Use {'{{1}}'}, {'{{2}}'}… para campos dinâmicos (a Meta usa número, não nome)</span>
                  </div>
                  <textarea
                    value={form.body}
                    onChange={(e) => setForm({ ...form, body: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent font-mono"
                    rows={6}
                    placeholder={'Olá, {{1}}!\n\nSua mensagem aqui...'}
                  />
                </div>

                <Input label="Rodapé (opcional)" value={form.footer} onChange={(e) => setForm({ ...form, footer: e.target.value })} placeholder="Ex: A&F Soluções Financeiras" />
              </>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-af-border">
            <Button variant="ghost" onClick={() => setShowModal(false)}>Cancelar</Button>
            <Button onClick={handleSubmit} disabled={saving}>
              <Send size={14} /> {saving ? 'Enviando...' : 'Enviar para aprovação'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function TemplatesPage() {
  const [tab, setTab] = useState<'local' | 'meta'>('local');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setTemplates(getTemplates());
  }, []);

  function persist(next: Template[]) {
    setTemplates(next);
    saveTemplates(next);
  }
  const [filterCategory, setFilterCategory] = useState<Category | 'all'>('all');
  const [showModal, setShowModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [previewVars, setPreviewVars] = useState<Record<string, string>>({});

  const filtered = templates.filter(t => {
    const matchSearch = t.name.toLowerCase().includes(search.toLowerCase()) || t.body.toLowerCase().includes(search.toLowerCase());
    const matchCat = filterCategory === 'all' || t.category === filterCategory;
    return matchSearch && matchCat;
  });

  const variables = extractVariables(form.body);

  function openNew() {
    setEditingTemplate(null);
    setForm(EMPTY_FORM);
    setPreviewVars({});
    setShowModal(true);
  }

  function openEdit(t: Template) {
    setEditingTemplate(t);
    setForm({ name: t.name, category: t.category, body: t.body });
    setPreviewVars(Object.fromEntries(t.variables.map(v => [v, v])));
    setShowModal(true);
  }

  function handleSave() {
    if (!form.name.trim() || !form.body.trim()) {
      toast('Preencha nome e conteúdo do template.', 'warning');
      return;
    }
    const vars = extractVariables(form.body);
    if (editingTemplate) {
      persist(templates.map(t => t.id === editingTemplate.id ? { ...t, ...form, variables: vars } : t));
      toast('Template atualizado!');
    } else {
      persist([...templates, { id: `t-${Date.now()}`, ...form, variables: vars, createdAt: new Date().toISOString().split('T')[0] }]);
      toast('Template criado!');
    }
    setShowModal(false);
  }

  function handleDelete(id: string) {
    persist(templates.filter(t => t.id !== id));
    toast('Template removido.');
  }

  function handleCopy(body: string) {
    navigator.clipboard?.writeText(body);
    toast('Template copiado!');
  }

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Templates de Mensagem" subtitle="Modelos prontos para envio no WhatsApp" />

      <div className="flex-1 overflow-y-auto p-6">
        {/* Abas: respostas rápidas (local) vs. templates aprovados pela Meta */}
        <div className="flex bg-slate-100 rounded-xl p-1 gap-1 mb-6 max-w-md">
          <button
            onClick={() => setTab('local')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${tab === 'local' ? 'bg-white shadow text-af-accent' : 'text-slate-500'}`}
          >
            Respostas rápidas
          </button>
          <button
            onClick={() => setTab('meta')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${tab === 'meta' ? 'bg-white shadow text-af-accent' : 'text-slate-500'}`}
          >
            WhatsApp (Meta)
          </button>
        </div>

        {tab === 'meta' && <WhatsAppTemplatesTab />}

        {tab === 'local' && <>
        {/* Filters */}
        <div className="flex items-center gap-3 mb-6">
          <div className="relative flex-1 max-w-xs">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar templates..."
              className="w-full pl-9 pr-4 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
            />
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            <button
              onClick={() => setFilterCategory('all')}
              className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${filterCategory === 'all' ? 'bg-af-accent text-white' : 'bg-af-light text-slate-600 hover:bg-af-border'}`}
            >
              Todos
            </button>
            {(Object.keys(CATEGORY_META) as Category[]).map(cat => (
              <button
                key={cat}
                onClick={() => setFilterCategory(cat)}
                className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${filterCategory === cat ? 'bg-af-accent text-white' : 'bg-af-light text-slate-600 hover:bg-af-border'}`}
              >
                {CATEGORY_META[cat].label}
              </button>
            ))}
          </div>
          <Button className="ml-auto" onClick={openNew}>
            <Plus size={15} /> Novo template
          </Button>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(t => {
            const cm = CATEGORY_META[t.category];
            return (
              <div key={t.id} className="bg-white rounded-xl border border-af-border shadow-sm hover:shadow-md transition-shadow flex flex-col">
                <div className="p-4 flex-1">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <MessageSquare size={15} className="text-af-accent flex-shrink-0" />
                      <h3 className="text-sm font-semibold text-slate-900">{t.name}</h3>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${cm.color}`}>
                      {cm.label}
                    </span>
                  </div>

                  <div className="mt-3 p-3 bg-slate-50 rounded-lg border border-af-border text-xs text-slate-600 whitespace-pre-wrap line-clamp-5 font-mono leading-relaxed">
                    {t.body}
                  </div>

                  {t.variables.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {t.variables.map(v => (
                        <span key={v} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
                          <Tag size={10} /> {v}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1 px-4 pb-4 pt-2 border-t border-af-border">
                  <Button size="sm" variant="secondary" className="flex-1" onClick={() => openEdit(t)}>
                    <Edit2 size={13} /> Editar
                  </Button>
                  <button onClick={() => handleCopy(t.body)} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors" title="Copiar">
                    <Copy size={14} />
                  </button>
                  <button onClick={() => handleDelete(t.id)} className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Excluir">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="col-span-3 text-center py-16 text-slate-400">
              <MessageSquare size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Nenhum template encontrado</p>
            </div>
          )}
        </div>

      {/* Modal */}
      {showModal && (
        <Modal title={editingTemplate ? 'Editar template' : 'Novo template'} onClose={() => setShowModal(false)}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Input label="Nome do template" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Ex: Boas-vindas inicial" />
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700">Categoria</label>
                <select
                  value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value as Category })}
                  className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                >
                  {(Object.keys(CATEGORY_META) as Category[]).map(cat => (
                    <option key={cat} value={cat}>{CATEGORY_META[cat].label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-700">Conteúdo da mensagem</label>
                <span className="text-xs text-slate-400">Use {'{{variavel}}'} para campos dinâmicos</span>
              </div>
              <textarea
                value={form.body}
                onChange={e => setForm({ ...form, body: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent font-mono"
                rows={7}
                placeholder={'Olá, {{nome}}!\n\nSua mensagem aqui...'}
              />
            </div>

            {variables.length > 0 && (
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-slate-700">Variáveis detectadas — preencha para preview</label>
                <div className="grid grid-cols-2 gap-2">
                  {variables.map(v => (
                    <Input
                      key={v}
                      label={`{{${v}}}`}
                      value={previewVars[v] || ''}
                      onChange={e => setPreviewVars({ ...previewVars, [v]: e.target.value })}
                      placeholder={`Valor de ${v}`}
                    />
                  ))}
                </div>
              </div>
            )}

            {form.body && (
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700">Preview</label>
                <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-slate-700 whitespace-pre-wrap font-mono leading-relaxed">
                  {fillTemplate(form.body, previewVars)}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-af-border">
            <Button variant="ghost" onClick={() => setShowModal(false)}>Cancelar</Button>
            <Button onClick={handleSave}>
              <Send size={14} /> {editingTemplate ? 'Salvar alterações' : 'Criar template'}
            </Button>
          </div>
        </Modal>
      )}
        </>}
      </div>
    </div>
  );
}

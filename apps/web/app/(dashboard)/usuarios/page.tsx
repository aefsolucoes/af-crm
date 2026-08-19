'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Avatar } from '@/components/ui/avatar';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth.store';
import api from '@/lib/api';
import { Plus, Trash2, Edit2, Shield, ShieldCheck, ShieldAlert, Smartphone, Check, Lock, Building2 } from 'lucide-react';
import { PERMISSION_KEYS, PERMISSION_LABELS, ROLE_DEFAULTS, effectivePermissions, PermissionMap } from '@/lib/permissions';

type Role = 'ADMIN' | 'MANAGER' | 'AGENT';

interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: Role;
  whatsAppNumberId: string | null;
  operatesApiOficial: boolean;
  departmentIds: string[];
  permissions: Record<string, boolean> | null;
}

interface WhatsNumber {
  id: string;
  label: string;
}

interface DepartmentOption {
  id: string;
  name: string;
}

const ROLE_META: Record<Role, { label: string; color: string; icon: React.ReactNode }> = {
  ADMIN: { label: 'Administrador', color: 'text-red-600 bg-red-50', icon: <ShieldAlert size={13} /> },
  MANAGER: { label: 'Gerente', color: 'text-purple-600 bg-purple-50', icon: <ShieldCheck size={13} /> },
  AGENT: { label: 'Agente', color: 'text-blue-600 bg-blue-50', icon: <Shield size={13} /> },
};

const EMPTY_FORM = {
  name: '', email: '', password: '', role: 'AGENT' as Role, whatsAppNumberId: '', departmentIds: [] as string[],
  permissions: { ...ROLE_DEFAULTS.AGENT } as PermissionMap,
};

function errMsg(e: unknown, fallback: string) {
  const r = e as { response?: { data?: { error?: string } } };
  return r?.response?.data?.error || fallback;
}

export default function UsuariosPage() {
  const me = useAuthStore((s) => s.user);
  const canManage = me?.role === 'ADMIN' || me?.role === 'MANAGER';
  const qc = useQueryClient();

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await api.get('/api/users')).data as UserRecord[],
  });
  const { data: numbers = [] } = useQuery({
    queryKey: ['whatsapp-qr-numbers'],
    queryFn: async () => (await api.get('/api/whatsapp-qr/numbers')).data as WhatsNumber[],
  });
  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => (await api.get('/api/departments')).data as DepartmentOption[],
  });
  // Rótulo do canal que o usuário opera — número QR ou "API Oficial".
  const channelLabel = (u: UserRecord) => {
    if (u.operatesApiOficial) return 'API Oficial';
    return numbers.find((n) => n.id === u.whatsAppNumberId)?.label;
  };
  const departmentName = (id: string | null) => departments.find((d) => d.id === id)?.name;
  const departmentNames = (ids: string[]) => ids.map((id) => departmentName(id)).filter(Boolean).join(', ');

  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name,
        email: form.email,
        role: form.role,
        whatsAppNumberId: form.whatsAppNumberId || null,
        departmentIds: form.departmentIds,
        // Admin sempre tem tudo (guardamos null = usa o padrão do papel).
        permissions: form.role === 'ADMIN' ? null : form.permissions,
        ...(form.password ? { password: form.password } : {}),
      };
      if (editingUser) return (await api.patch(`/api/users/${editingUser.id}`, payload)).data;
      return (await api.post('/api/users', payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast(editingUser ? 'Usuário atualizado!' : 'Usuário criado!');
      setShowModal(false);
    },
    onError: (e) => toast(errMsg(e, 'Não foi possível salvar.'), 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/users/${id}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast('Usuário removido.');
    },
    onError: (e) => toast(errMsg(e, 'Não foi possível excluir.'), 'error'),
  });

  function openNew() {
    setEditingUser(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
  }

  function openEdit(u: UserRecord) {
    setEditingUser(u);
    setForm({
      name: u.name, email: u.email, password: '', role: u.role,
      whatsAppNumberId: u.operatesApiOficial ? 'API' : (u.whatsAppNumberId || ''),
      departmentIds: u.departmentIds || [],
      permissions: effectivePermissions(u.role, u.permissions),
    });
    setShowModal(true);
  }

  // Ao trocar a função, as caixinhas voltam ao padrão daquela função.
  function changeRole(role: Role) {
    setForm((f) => ({ ...f, role, permissions: effectivePermissions(role, null) }));
  }

  function togglePerm(key: string) {
    setForm((f) => ({ ...f, permissions: { ...f.permissions, [key]: !f.permissions[key as keyof PermissionMap] } as PermissionMap }));
  }

  function toggleDepartment(id: string) {
    setForm((f) => ({
      ...f,
      departmentIds: f.departmentIds.includes(id)
        ? f.departmentIds.filter((d) => d !== id)
        : [...f.departmentIds, id],
    }));
  }

  function handleSave() {
    if (!form.name.trim() || !form.email.trim()) {
      toast('Preencha nome e e-mail.', 'warning');
      return;
    }
    if (!editingUser && !form.password) {
      toast('Defina uma senha inicial para o novo usuário.', 'warning');
      return;
    }
    if (form.password && form.password.length < 6) {
      toast('A senha deve ter pelo menos 6 caracteres.', 'warning');
      return;
    }
    saveMutation.mutate();
  }

  function handleDelete(u: UserRecord) {
    if (u.id === me?.id) {
      toast('Você não pode excluir a sua própria conta.', 'warning');
      return;
    }
    if (confirm(`Excluir ${u.name}? Os leads e tarefas dele serão transferidos para você.`)) {
      deleteMutation.mutate(u.id);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Usuários" subtitle="Gerencie a equipe, funções e o número de WhatsApp de cada um" />

      <div className="flex-1 overflow-y-auto p-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[
            { label: 'Total', value: users.length, color: 'bg-af-light text-af-accent' },
            { label: 'Admins', value: users.filter((u) => u.role === 'ADMIN').length, color: 'bg-red-50 text-red-600' },
            { label: 'Com WhatsApp vinculado', value: users.filter((u) => u.whatsAppNumberId || u.operatesApiOficial).length, color: 'bg-green-50 text-green-700' },
          ].map((s) => (
            <div key={s.label} className={`rounded-xl p-4 ${s.color}`}>
              <p className="text-2xl font-bold">{s.value}</p>
              <p className="text-xs font-medium opacity-70 mt-1">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">Membros da equipe</h2>
          {canManage && (
            <Button onClick={openNew}>
              <Plus size={15} /> Adicionar usuário
            </Button>
          )}
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-af-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-af-light border-b border-af-border">
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Usuário</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Função</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Setor</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">WhatsApp</th>
                {canManage && <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Ações</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-af-border">
              {isLoading ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">Carregando…</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">Nenhum usuário ainda.</td></tr>
              ) : (
                users.map((u) => {
                  const rm = ROLE_META[u.role];
                  const label = channelLabel(u);
                  const deptNames = departmentNames(u.departmentIds || []);
                  return (
                    <tr key={u.id} className="hover:bg-af-light transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Avatar name={u.name} size="sm" />
                          <div>
                            <p className="font-medium text-slate-900">
                              {u.name}
                              {u.id === me?.id && <span className="ml-2 text-xs text-af-accent font-normal">(você)</span>}
                            </p>
                            <p className="text-xs text-slate-500">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full font-medium ${rm.color}`}>
                          {rm.icon} {rm.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {u.role === 'ADMIN' ? (
                          <span className="text-xs text-slate-400">Todos</span>
                        ) : deptNames ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                            <Building2 size={13} className="text-af-accent" /> {deptNames}
                          </span>
                        ) : (
                          <span className="text-xs text-amber-500">Sem setor</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {label ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                            <Smartphone size={13} className="text-af-accent" /> {label}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">Não vinculado</span>
                        )}
                      </td>
                      {canManage && (
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button onClick={() => openEdit(u)} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors" title="Editar">
                              <Edit2 size={14} />
                            </button>
                            <button
                              onClick={() => handleDelete(u)}
                              disabled={u.id === me?.id}
                              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                              title={u.id === me?.id ? 'Você não pode excluir a própria conta' : 'Excluir'}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {!canManage && (
          <p className="text-xs text-slate-400 mt-3">Somente administradores e gerentes podem adicionar ou editar usuários.</p>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <Modal title={editingUser ? 'Editar usuário' : 'Novo usuário'} onClose={() => setShowModal(false)}>
          <div className="space-y-4">
            <Input label="Nome completo" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Fábio Cardoso" />
            <Input label="E-mail (login)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="fabio@afsolucoes.com" />
            <Input
              label={editingUser ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial'}
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="••••••••"
            />

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Função</label>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(ROLE_META) as Role[]).map((role) => {
                  const rm = ROLE_META[role];
                  return (
                    <button
                      key={role}
                      type="button"
                      onClick={() => changeRole(role)}
                      className={`flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-lg border-2 text-xs font-medium transition-colors ${form.role === role ? 'border-af-accent bg-af-light' : 'border-af-border hover:border-af-mid'}`}
                    >
                      <span className={`p-1 rounded ${rm.color}`}>{rm.icon}</span>
                      {rm.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Setor</label>
              {form.role === 'ADMIN' ? (
                <div className="flex items-center gap-2 text-xs text-slate-500 bg-af-light rounded-lg p-3">
                  <Lock size={14} /> Administrador vê todos os setores — não precisa escolher.
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {departments.map((d) => {
                      const selected = form.departmentIds.includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => toggleDepartment(d.id)}
                          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border-2 text-xs font-medium transition-colors ${selected ? 'border-af-accent bg-af-light text-af-accent' : 'border-af-border hover:border-af-mid text-slate-600'}`}
                        >
                          <Building2 size={13} />
                          {d.name}
                        </button>
                      );
                    })}
                  </div>
                  {form.departmentIds.length === 0 && (
                    <p className="text-xs text-amber-500 mt-1">Sem setor selecionado — vê tudo, por enquanto.</p>
                  )}
                  <p className="text-xs text-slate-400 mt-1">Define o que ele enxerga: funil, Inbox/WhatsApp, tarefas e dashboard dos setores escolhidos. Pode marcar mais de um.</p>
                </>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Número de WhatsApp que ele opera</label>
              <select
                value={form.whatsAppNumberId}
                onChange={(e) => setForm({ ...form, whatsAppNumberId: e.target.value })}
                className="w-full border border-af-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-af-accent/30"
              >
                <option value="">Nenhum (não recebe clientes no relatório matinal)</option>
                <option value="API">API Oficial</option>
                {numbers.map((n) => (
                  <option key={n.id} value={n.id}>{n.label}</option>
                ))}
              </select>
              <p className="text-xs text-slate-400 mt-1">Usado no Relatório Matinal para mostrar os clientes desse número (ou os que falaram pela API Oficial do setor dele) para o usuário.</p>
            </div>

            {/* Permissões (as caixinhas) */}
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">O que este usuário pode acessar</label>
              {form.role === 'ADMIN' ? (
                <div className="flex items-center gap-2 text-xs text-slate-500 bg-af-light rounded-lg p-3">
                  <Lock size={14} /> Administrador tem acesso total ao sistema — não dá para restringir.
                </div>
              ) : (
                <>
                  <p className="text-xs text-slate-400 mb-1">A função já marca um padrão. Ajuste caixinha por caixinha se quiser.</p>
                  <div className="grid grid-cols-1 gap-1.5 max-h-64 overflow-y-auto pr-1">
                    {PERMISSION_KEYS.map((key) => {
                      const on = !!form.permissions[key];
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => togglePerm(key)}
                          className={`flex items-center gap-3 p-2.5 rounded-lg border text-left transition-colors ${on ? 'border-af-accent bg-af-light' : 'border-af-border hover:bg-slate-50'}`}
                        >
                          <div className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${on ? 'bg-af-accent border-af-accent' : 'border-slate-300'}`}>
                            {on && <Check size={12} className="text-white" />}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-slate-700">{PERMISSION_LABELS[key].label}</p>
                            <p className="text-xs text-slate-400">{PERMISSION_LABELS[key].hint}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-af-border">
            <Button variant="ghost" onClick={() => setShowModal(false)}>Cancelar</Button>
            <Button onClick={handleSave} loading={saveMutation.isPending}>
              {editingUser ? 'Salvar alterações' : 'Criar usuário'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

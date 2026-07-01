'use client';
import { useState } from 'react';
import { Topbar } from '@/components/ui/topbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Avatar } from '@/components/ui/avatar';
import { toast } from '@/components/ui/toast';
import { Plus, Trash2, Edit2, Shield, ShieldCheck, ShieldAlert, ToggleLeft, ToggleRight, X, Check } from 'lucide-react';

type Role = 'admin' | 'manager' | 'agent' | 'viewer';

interface Permission {
  key: string;
  label: string;
  description: string;
}

interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  permissions: Record<string, boolean>;
  createdAt: string;
}

const ALL_PERMISSIONS: Permission[] = [
  { key: 'view_leads', label: 'Ver Leads', description: 'Visualizar lista de leads' },
  { key: 'edit_leads', label: 'Editar Leads', description: 'Criar e editar leads' },
  { key: 'delete_leads', label: 'Excluir Leads', description: 'Remover leads do sistema' },
  { key: 'view_inbox', label: 'Ver Inbox', description: 'Acessar conversas no inbox' },
  { key: 'reply_inbox', label: 'Responder Inbox', description: 'Enviar mensagens no inbox' },
  { key: 'view_kanban', label: 'Ver Funil', description: 'Visualizar o funil de vendas' },
  { key: 'manage_kanban', label: 'Gerenciar Funil', description: 'Mover e editar cards no funil' },
  { key: 'view_reports', label: 'Ver Relatórios', description: 'Acessar relatórios e métricas' },
  { key: 'manage_salesbot', label: 'Gerenciar Salesbot', description: 'Criar e editar fluxos de bot' },
  { key: 'manage_templates', label: 'Gerenciar Templates', description: 'Criar e editar templates de mensagem' },
  { key: 'manage_automations', label: 'Gerenciar Automações', description: 'Configurar regras de automação' },
  { key: 'manage_users', label: 'Gerenciar Usuários', description: 'Adicionar e remover usuários' },
  { key: 'view_contacts', label: 'Ver Contatos', description: 'Visualizar lista de contatos' },
  { key: 'manage_contacts', label: 'Gerenciar Contatos', description: 'Criar e editar contatos' },
  { key: 'manage_settings', label: 'Configurações', description: 'Acessar configurações do sistema' },
];

const ROLE_DEFAULTS: Record<Role, Record<string, boolean>> = {
  admin: Object.fromEntries(ALL_PERMISSIONS.map(p => [p.key, true])),
  manager: Object.fromEntries(ALL_PERMISSIONS.map(p => [p.key, !['manage_users', 'manage_settings'].includes(p.key)])),
  agent: Object.fromEntries(ALL_PERMISSIONS.map(p => [p.key, ['view_leads', 'edit_leads', 'view_inbox', 'reply_inbox', 'view_kanban', 'manage_kanban', 'view_contacts'].includes(p.key)])),
  viewer: Object.fromEntries(ALL_PERMISSIONS.map(p => [p.key, ['view_leads', 'view_inbox', 'view_kanban', 'view_reports', 'view_contacts'].includes(p.key)])),
};

const ROLE_META: Record<Role, { label: string; color: string; icon: React.ReactNode }> = {
  admin: { label: 'Administrador', color: 'text-red-600 bg-red-50', icon: <ShieldAlert size={13} /> },
  manager: { label: 'Gerente', color: 'text-purple-600 bg-purple-50', icon: <ShieldCheck size={13} /> },
  agent: { label: 'Agente', color: 'text-blue-600 bg-blue-50', icon: <Shield size={13} /> },
  viewer: { label: 'Visualizador', color: 'text-slate-600 bg-slate-100', icon: <Shield size={13} /> },
};

const INITIAL_USERS: UserRecord[] = [
  { id: 'u1', name: 'Fábio Cardoso', email: 'fabio@afsolucoes.com', role: 'admin', active: true, permissions: ROLE_DEFAULTS.admin, createdAt: '2024-01-01' },
  { id: 'u2', name: 'Ana Lima', email: 'ana@afsolucoes.com', role: 'manager', active: true, permissions: ROLE_DEFAULTS.manager, createdAt: '2024-02-15' },
  { id: 'u3', name: 'Carlos Mendes', email: 'carlos@afsolucoes.com', role: 'agent', active: true, permissions: ROLE_DEFAULTS.agent, createdAt: '2024-03-10' },
];

const EMPTY_FORM = { name: '', email: '', role: 'agent' as Role, permissions: ROLE_DEFAULTS.agent };

export default function UsuariosPage() {
  const [users, setUsers] = useState<UserRecord[]>(INITIAL_USERS);
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [activeTab, setActiveTab] = useState<'info' | 'permissions'>('info');

  function openNew() {
    setEditingUser(null);
    setForm(EMPTY_FORM);
    setActiveTab('info');
    setShowModal(true);
  }

  function openEdit(u: UserRecord) {
    setEditingUser(u);
    setForm({ name: u.name, email: u.email, role: u.role, permissions: { ...u.permissions } });
    setActiveTab('info');
    setShowModal(true);
  }

  function handleRoleChange(role: Role) {
    setForm({ ...form, role, permissions: { ...ROLE_DEFAULTS[role] } });
  }

  function handlePermissionToggle(key: string) {
    setForm({ ...form, permissions: { ...form.permissions, [key]: !form.permissions[key] } });
  }

  function handleSave() {
    if (!form.name.trim() || !form.email.trim()) {
      toast('Preencha nome e e-mail.', 'warning');
      return;
    }
    if (editingUser) {
      setUsers(users.map(u => u.id === editingUser.id ? { ...u, ...form } : u));
      toast('Usuário atualizado!');
    } else {
      const newUser: UserRecord = {
        id: `u-${Date.now()}`,
        ...form,
        active: true,
        createdAt: new Date().toISOString().split('T')[0],
      };
      setUsers([...users, newUser]);
      toast('Usuário criado! Um convite será enviado por e-mail.');
    }
    setShowModal(false);
  }

  function handleDelete(id: string) {
    setUsers(users.filter(u => u.id !== id));
    toast('Usuário removido.');
  }

  function handleToggleActive(id: string) {
    setUsers(users.map(u => u.id === id ? { ...u, active: !u.active } : u));
  }

  const activeCount = users.filter(u => u.active).length;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Usuários" subtitle="Gerencie acessos e permissões da equipe" />

      <div className="flex-1 overflow-y-auto p-6">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          {[
            { label: 'Total', value: users.length, color: 'bg-af-light text-af-accent' },
            { label: 'Ativos', value: activeCount, color: 'bg-green-50 text-green-700' },
            { label: 'Inativos', value: users.length - activeCount, color: 'bg-slate-100 text-slate-500' },
            { label: 'Admins', value: users.filter(u => u.role === 'admin').length, color: 'bg-red-50 text-red-600' },
          ].map(s => (
            <div key={s.label} className={`rounded-xl p-4 ${s.color}`}>
              <p className="text-2xl font-bold">{s.value}</p>
              <p className="text-xs font-medium opacity-70 mt-1">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">Membros da equipe</h2>
          <Button onClick={openNew}>
            <Plus size={15} /> Adicionar usuário
          </Button>
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-af-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-af-light border-b border-af-border">
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Usuário</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Função</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Permissões</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-af-border">
              {users.map((u) => {
                const rm = ROLE_META[u.role];
                const permCount = Object.values(u.permissions).filter(Boolean).length;
                return (
                  <tr key={u.id} className="hover:bg-af-light transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.name} size="sm" />
                        <div>
                          <p className="font-medium text-slate-900">{u.name}</p>
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
                      <span className="text-xs text-slate-500">{permCount}/{ALL_PERMISSIONS.length} permissões</span>
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={() => handleToggleActive(u.id)} className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${u.active ? 'text-green-600 hover:text-green-800' : 'text-slate-400 hover:text-slate-600'}`}>
                        {u.active ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                        {u.active ? 'Ativo' : 'Inativo'}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEdit(u)} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors" title="Editar">
                          <Edit2 size={14} />
                        </button>
                        <button onClick={() => handleDelete(u.id)} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Excluir">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <Modal title={editingUser ? 'Editar usuário' : 'Novo usuário'} onClose={() => setShowModal(false)}>
          {/* Tabs */}
          <div className="flex border-b border-af-border mb-5">
            {(['info', 'permissions'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === tab ? 'border-af-accent text-af-accent' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
              >
                {tab === 'info' ? 'Informações' : 'Permissões'}
              </button>
            ))}
          </div>

          {activeTab === 'info' && (
            <div className="space-y-4">
              <Input label="Nome completo" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="João Silva" />
              <Input label="E-mail" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="joao@empresa.com" />
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700">Função</label>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(ROLE_META) as Role[]).map(role => {
                    const rm = ROLE_META[role];
                    return (
                      <button
                        key={role}
                        onClick={() => handleRoleChange(role)}
                        className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 text-sm font-medium transition-colors ${form.role === role ? 'border-af-accent bg-af-light' : 'border-af-border hover:border-af-mid'}`}
                      >
                        <span className={`p-1 rounded ${rm.color}`}>{rm.icon}</span>
                        {rm.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-slate-400 mt-1">Selecionar uma função preenche automaticamente as permissões padrão.</p>
              </div>
            </div>
          )}

          {activeTab === 'permissions' && (
            <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-slate-500">{Object.values(form.permissions).filter(Boolean).length}/{ALL_PERMISSIONS.length} ativas</p>
                <div className="flex gap-2">
                  <button onClick={() => setForm({ ...form, permissions: Object.fromEntries(ALL_PERMISSIONS.map(p => [p.key, true])) })} className="text-xs text-af-accent hover:underline">Selecionar tudo</button>
                  <button onClick={() => setForm({ ...form, permissions: Object.fromEntries(ALL_PERMISSIONS.map(p => [p.key, false])) })} className="text-xs text-slate-400 hover:underline">Remover tudo</button>
                </div>
              </div>
              {ALL_PERMISSIONS.map(p => (
                <div key={p.key} onClick={() => handlePermissionToggle(p.key)} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${form.permissions[p.key] ? 'border-af-accent bg-af-light' : 'border-af-border hover:bg-slate-50'}`}>
                  <div className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${form.permissions[p.key] ? 'bg-af-accent border-af-accent' : 'border-slate-300'}`}>
                    {form.permissions[p.key] && <Check size={12} className="text-white" />}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-700">{p.label}</p>
                    <p className="text-xs text-slate-400">{p.description}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-af-border">
            <Button variant="ghost" onClick={() => setShowModal(false)}>Cancelar</Button>
            <Button onClick={handleSave}>{editingUser ? 'Salvar alterações' : 'Criar usuário'}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

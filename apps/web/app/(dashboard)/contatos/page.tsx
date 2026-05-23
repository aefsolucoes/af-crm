'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { Contact } from '@/types';
import api from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { Phone, Mail, Building2, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';

async function fetchContacts(): Promise<Contact[]> {
  const { data } = await api.get('/api/contacts');
  return data;
}

export default function ContatosPage() {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();

  const { data: contacts, isLoading } = useQuery({ queryKey: ['contacts'], queryFn: fetchContacts });

  const filtered = (contacts || []).filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.email?.toLowerCase().includes(search.toLowerCase())
  );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/api/contacts', form);
      toast('Contato criado!');
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setShowModal(false);
      setForm({ name: '', email: '', phone: '' });
    } catch {
      toast('Erro ao criar contato', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Contatos" />
      <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-af-border">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar contatos..."
            className="pl-8 pr-4 py-1.5 text-sm border border-af-border rounded-lg w-64 focus:outline-none focus:ring-2 focus:ring-af-accent"
          />
        </div>
        <Button size="sm" onClick={() => setShowModal(true)}>
          <Plus size={14} />
          Novo Contato
        </Button>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 scrollbar-thin">
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-28" />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((contact) => (
              <div key={contact.id} className="bg-white rounded-xl border border-af-border p-4 hover:shadow-md transition-shadow">
                <div className="flex items-center gap-3 mb-3">
                  <Avatar name={contact.name} size="md" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">{contact.name}</p>
                    {contact.company && (
                      <div className="flex items-center gap-1 text-xs text-slate-500">
                        <Building2 size={10} />
                        <span className="truncate">{contact.company.name}</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="space-y-1">
                  {contact.phone && (
                    <div className="flex items-center gap-2 text-xs text-slate-600">
                      <Phone size={11} className="text-slate-400" />
                      {contact.phone}
                    </div>
                  )}
                  {contact.email && (
                    <div className="flex items-center gap-2 text-xs text-slate-600">
                      <Mail size={11} className="text-slate-400" />
                      <span className="truncate">{contact.email}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="text-center py-12 text-slate-400 text-sm">Nenhum contato encontrado</div>
        )}
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="Novo Contato">
        <form onSubmit={handleCreate} className="space-y-4">
          <Input label="Nome *" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} required placeholder="Nome completo" />
          <Input label="E-mail" type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} placeholder="email@exemplo.com" />
          <Input label="Telefone" value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} placeholder="(11) 99999-9999" />
          <div className="flex gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowModal(false)} className="flex-1">Cancelar</Button>
            <Button type="submit" loading={saving} className="flex-1">Criar Contato</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

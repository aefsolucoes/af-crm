'use client';
import { LeadDetail } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { Phone, Mail, Building2, User, Tag, Hash } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/utils';

interface LeadSidebarProps {
  lead: LeadDetail;
}

export function LeadSidebar({ lead }: LeadSidebarProps) {
  return (
    <aside className="w-72 flex-shrink-0 border-l border-af-border bg-white overflow-y-auto scrollbar-thin">
      {/* Contact */}
      {lead.contact && (
        <section className="px-4 py-4 border-b border-af-border">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Contato</p>
          <div className="flex items-center gap-3 mb-3">
            <Avatar name={lead.contact.name} size="md" />
            <p className="text-sm font-medium text-slate-900">{lead.contact.name}</p>
          </div>
          {lead.contact.phone && (
            <div className="flex items-center gap-2 text-xs text-slate-600 mb-1.5">
              <Phone size={12} className="text-slate-400" />
              {lead.contact.phone}
            </div>
          )}
          {lead.contact.email && (
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Mail size={12} className="text-slate-400" />
              <span className="truncate">{lead.contact.email}</span>
            </div>
          )}
        </section>
      )}

      {/* Company */}
      {lead.company && (
        <section className="px-4 py-4 border-b border-af-border">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Empresa</p>
          <div className="flex items-center gap-2 text-sm font-medium text-slate-800 mb-2">
            <Building2 size={14} className="text-af-mid" />
            {lead.company.name}
          </div>
          {lead.company.email && (
            <div className="flex items-center gap-2 text-xs text-slate-600 mb-1">
              <Mail size={11} className="text-slate-400" />
              <span className="truncate">{lead.company.email}</span>
            </div>
          )}
          {lead.company.phone && (
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Phone size={11} className="text-slate-400" />
              {lead.company.phone}
            </div>
          )}
        </section>
      )}

      {/* Responsible */}
      <section className="px-4 py-4 border-b border-af-border">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Responsável</p>
        <div className="flex items-center gap-2">
          <Avatar name={lead.user.name} size="sm" />
          <div>
            <p className="text-xs font-medium text-slate-800">{lead.user.name}</p>
            <p className="text-xs text-slate-400">{lead.user.email}</p>
          </div>
        </div>
      </section>

      {/* Info */}
      <section className="px-4 py-4 border-b border-af-border space-y-2">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Informações</p>
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Hash size={11} className="text-slate-400" />
          <span className="text-slate-400">Criado em</span>
          <span className="ml-auto font-medium">{formatDate(lead.createdAt)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Hash size={11} className="text-slate-400" />
          <span className="text-slate-400">Atualizado</span>
          <span className="ml-auto font-medium">{formatDate(lead.updatedAt)}</span>
        </div>
      </section>

      {/* Tags */}
      {lead.tags.length > 0 && (
        <section className="px-4 py-4 border-b border-af-border">
          <div className="flex items-center gap-1 mb-3">
            <Tag size={12} className="text-slate-400" />
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Tags</p>
          </div>
          <div className="flex flex-wrap gap-1">
            {lead.tags.map((tag) => (
              <Badge key={tag} className="bg-af-light text-af-mid text-xs">{tag}</Badge>
            ))}
          </div>
        </section>
      )}

      {/* Custom fields */}
      {lead.customFields && Object.keys(lead.customFields).length > 0 && (
        <section className="px-4 py-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Campos personalizados</p>
          {Object.entries(lead.customFields as Record<string, unknown>).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between text-xs py-1.5 border-b border-af-border/40 last:border-0">
              <span className="text-slate-500">{key}</span>
              <span className="font-medium text-slate-800">{String(value)}</span>
            </div>
          ))}
        </section>
      )}
    </aside>
  );
}

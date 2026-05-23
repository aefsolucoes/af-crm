'use client';
import { Lead } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatDate } from '@/lib/utils';
import { Phone, Mail, Building2, Tag, DollarSign, Calendar, ExternalLink } from 'lucide-react';
import Link from 'next/link';

interface LeadPanelProps {
  lead: Lead | null;
}

export function LeadPanel({ lead }: LeadPanelProps) {
  if (!lead) {
    return (
      <div className="w-72 border-l border-af-border bg-white flex items-center justify-center flex-shrink-0">
        <p className="text-slate-400 text-sm text-center px-4">Selecione uma conversa para ver os detalhes do lead</p>
      </div>
    );
  }

  return (
    <div className="w-72 border-l border-af-border bg-white flex-shrink-0 overflow-y-auto scrollbar-thin">
      <div className="px-4 py-4 border-b border-af-border">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Lead vinculado</p>
          <Link href={`/leads/${lead.id}`} className="text-af-mid hover:text-af-accent">
            <ExternalLink size={14} />
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <Avatar name={lead.name} size="lg" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900 truncate">{lead.name}</p>
            <span className="text-xs px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: lead.stage.color }}>
              {lead.stage.name}
            </span>
          </div>
        </div>
      </div>

      <div className="px-4 py-3 space-y-3 border-b border-af-border">
        {lead.value && (
          <div className="flex items-center gap-2 text-sm">
            <DollarSign size={14} className="text-slate-400 flex-shrink-0" />
            <span className="font-medium text-af-mid">{formatCurrency(lead.value)}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Calendar size={14} className="text-slate-400 flex-shrink-0" />
          {formatDate(lead.createdAt)}
        </div>
        {lead.company && (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Building2 size={14} className="text-slate-400 flex-shrink-0" />
            <span className="truncate">{lead.company.name}</span>
          </div>
        )}
      </div>

      {lead.contact && (
        <div className="px-4 py-3 border-b border-af-border">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Contato</p>
          <p className="text-sm font-medium text-slate-900 mb-1">{lead.contact.name}</p>
          {lead.contact.phone && (
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Phone size={12} className="text-slate-400" />
              {lead.contact.phone}
            </div>
          )}
          {lead.contact.email && (
            <div className="flex items-center gap-2 text-xs text-slate-600 mt-1">
              <Mail size={12} className="text-slate-400" />
              <span className="truncate">{lead.contact.email}</span>
            </div>
          )}
        </div>
      )}

      {lead.tags.length > 0 && (
        <div className="px-4 py-3">
          <div className="flex items-center gap-1 mb-2">
            <Tag size={12} className="text-slate-400" />
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Tags</p>
          </div>
          <div className="flex flex-wrap gap-1">
            {lead.tags.map((tag) => (
              <Badge key={tag} className="bg-af-light text-af-mid">{tag}</Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

'use client';
import { Lead } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { formatCurrency, formatDate } from '@/lib/utils';
import { Tag, DollarSign, Calendar, ExternalLink, User, Phone, MessageCircle, FileText, Hash } from 'lucide-react';
import Link from 'next/link';

interface LeadPanelProps {
  lead: Lead | null;
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 py-2 border-b border-slate-100 last:border-0">
      <span className="text-slate-400 flex-shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-400 leading-none mb-0.5">{label}</p>
        <p className="text-sm text-slate-800 font-medium leading-snug break-words">{value}</p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-af-border">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">{title}</p>
      {children}
    </div>
  );
}

export function LeadPanel({ lead }: LeadPanelProps) {
  if (!lead) {
    return (
      <div className="w-72 border-r border-af-border bg-white flex items-center justify-center flex-shrink-0">
        <p className="text-slate-400 text-sm text-center px-4">Selecione uma conversa</p>
      </div>
    );
  }

  const cf = ((lead as any).customFields || {}) as Record<string, string>;

  function cfVal(key: string) {
    const v = cf[key];
    return v && v.trim() ? v.trim() : undefined;
  }

  const p1     = cfVal('participante_1') || lead.contact?.name || lead.name;
  const p2     = cfVal('participante_2');
  const tel1   = cfVal('telefone_1') || lead.contact?.phone;
  const tel2   = cfVal('telefone_2');
  const cpf1   = cfVal('cpf_1');
  const nasc1  = cfVal('nascimento_1');
  const renda1 = cfVal('renda_1');
  const email1 = cfVal('email_1');
  const vin1   = cfVal('vinculo_1');
  const cpf2   = cfVal('cpf_2');
  const nasc2  = cfVal('nascimento_2');
  const renda2 = cfVal('renda_2');
  const email2 = cfVal('email_2');
  const vin2   = cfVal('vinculo_2');

  const vImovel  = cfVal('valor_imovel');
  const vCredito = cfVal('valor_credito');
  const vEntrada = cfVal('valor_entrada');

  function fmtCurrency(raw?: string) {
    if (!raw) return undefined;
    const n = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? raw : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  return (
    <div className="w-72 border-r border-af-border bg-white flex-shrink-0 overflow-y-auto scrollbar-thin flex flex-col">

      {/* Header */}
      <div className="px-4 py-4 border-b border-af-border bg-af-light/30">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Lead</p>
          <Link href={`/leads/${lead.id}`} className="text-af-mid hover:text-af-dark transition-colors" title="Abrir lead">
            <ExternalLink size={14} />
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <Avatar name={p1 || '?'} src={(lead.contact as any)?.avatar} size="lg" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-900 leading-snug">
              {p2 ? `${p1} / ${p2}` : p1}
            </p>
            <span className="inline-block text-xs px-2 py-0.5 rounded-full text-white mt-1" style={{ backgroundColor: lead.stage.color }}>
              {lead.stage.name}
            </span>
          </div>
        </div>
      </div>

      {/* Valores */}
      <Section title="Valores">
        <Row icon={<DollarSign size={13} />} label="Valor do imóvel"  value={fmtCurrency(vImovel)} />
        <Row icon={<DollarSign size={13} />} label="Valor do crédito" value={fmtCurrency(vCredito)} />
        <Row icon={<DollarSign size={13} />} label="Valor de entrada" value={fmtCurrency(vEntrada)} />
        {!vImovel && !vCredito && lead.value && (
          <Row icon={<DollarSign size={13} />} label="Valor" value={formatCurrency(lead.value)} />
        )}
        <Row icon={<Calendar size={13} />} label="Criado em" value={formatDate(lead.createdAt)} />
      </Section>

      {/* Participante 1 */}
      <Section title="Participante 1">
        <Row icon={<User size={13} />}        label="Nome"        value={p1} />
        <Row icon={<Phone size={13} />}       label="Telefone"    value={tel1} />
        <Row icon={<Hash size={13} />}        label="CPF"         value={cpf1} />
        <Row icon={<Calendar size={13} />}    label="Nascimento"  value={nasc1} />
        <Row icon={<DollarSign size={13} />}  label="Renda"       value={renda1 ? fmtCurrency(renda1) : undefined} />
        <Row icon={<FileText size={13} />}    label="E-mail"      value={email1} />
        <Row icon={<FileText size={13} />}    label="Vínculo"     value={vin1} />
      </Section>

      {/* Participante 2 (só se houver) */}
      {p2 && (
        <Section title="Participante 2">
          <Row icon={<User size={13} />}        label="Nome"        value={p2} />
          <Row icon={<Phone size={13} />}       label="Telefone"    value={tel2} />
          <Row icon={<Hash size={13} />}        label="CPF"         value={cpf2} />
          <Row icon={<Calendar size={13} />}    label="Nascimento"  value={nasc2} />
          <Row icon={<DollarSign size={13} />}  label="Renda"       value={renda2 ? fmtCurrency(renda2) : undefined} />
          <Row icon={<FileText size={13} />}    label="E-mail"      value={email2} />
          <Row icon={<FileText size={13} />}    label="Vínculo"     value={vin2} />
        </Section>
      )}

      {/* Tags */}
      {lead.tags.length > 0 && (
        <Section title="Tags">
          <div className="flex flex-wrap gap-1">
            {lead.tags.map((tag) => (
              <span key={tag} className="text-xs bg-af-light text-af-mid px-2 py-0.5 rounded-full font-medium">
                {tag}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* WhatsApp rápido */}
      {tel1 && (
        <div className="px-4 py-3 mt-auto border-t border-af-border">
          <a
            href={`https://wa.me/${tel1.replace(/\D/g, '')}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2 rounded-xl text-white text-sm font-medium transition-colors"
            style={{ backgroundColor: '#25D366' }}
          >
            <MessageCircle size={15} />
            Abrir no WhatsApp
          </a>
        </div>
      )}
    </div>
  );
}

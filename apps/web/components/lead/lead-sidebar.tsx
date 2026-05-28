'use client';
import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LeadDetail, FieldDefinition } from '@/types';
import api from '@/lib/api';
import { Plus, Trash2, Tag, Check, X, ExternalLink } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

interface LeadSidebarProps {
  lead: LeadDetail;
  onRefresh: () => void;
}

type FieldValue = string | number | null | undefined;

function maskPhone(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 10) return d.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3').replace(/-$/, '');
  return d.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3').replace(/-$/, '');
}

/** Converte string em número suportando formato BR (1.000.000,50) e EN (1000000.50) */
function parseBRNumber(raw: string): number {
  const clean = raw.trim()
    .replace(/\./g, '')   // remove pontos de milhar
    .replace(',', '.');   // vírgula decimal → ponto
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

function FieldEditor({
  fieldDef,
  value,
  onSave,
  onCancel,
}: {
  fieldDef: FieldDefinition;
  value: FieldValue;
  onSave: (v: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(String(value ?? ''));

  if (fieldDef.type === 'SELECT') {
    return (
      <select
        className="text-xs border border-af-border rounded px-2 py-1 w-full bg-white focus:outline-none focus:border-af-mid"
        value={val}
        onChange={e => { setVal(e.target.value); onSave(e.target.value); }}
        autoFocus
      >
        <option value="">Selecione</option>
        {fieldDef.options.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }

  const inputType =
    fieldDef.type === 'DATE' ? 'date' :
    fieldDef.type === 'EMAIL' ? 'email' :
    fieldDef.type === 'PHONE' ? 'tel' :
    'text'; // NUMBER usa text para aceitar formato BR (1.000.000)

  return (
    <div className="flex items-center gap-1 flex-1">
      <input
        type={inputType}
        inputMode={fieldDef.type === 'NUMBER' ? 'numeric' : undefined}
        placeholder={fieldDef.type === 'NUMBER' ? 'Ex: 250000' : undefined}
        className="text-xs border border-af-border rounded px-2 py-1 flex-1 bg-white focus:outline-none focus:border-af-mid min-w-0"
        value={val}
        onChange={e => setVal(fieldDef.type === 'PHONE' ? maskPhone(e.target.value) : e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onSave(val);
          if (e.key === 'Escape') onCancel();
        }}
        autoFocus
      />
      <button onClick={() => onSave(val)} className="text-green-600 hover:text-green-700 flex-shrink-0">
        <Check size={12} />
      </button>
      <button onClick={onCancel} className="text-slate-400 hover:text-slate-600 flex-shrink-0">
        <X size={12} />
      </button>
    </div>
  );
}

function DisplayValue({ fieldDef, value }: { fieldDef: FieldDefinition; value: FieldValue }) {
  if (value == null || value === '') {
    return <span className="text-slate-300 text-xs">...</span>;
  }
  if (fieldDef.type === 'LINK') {
    return (
      <a
        href={String(value)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-af-mid hover:underline flex items-center gap-1"
        onClick={e => e.stopPropagation()}
      >
        Abrir <ExternalLink size={10} />
      </a>
    );
  }
  if (fieldDef.type === 'NUMBER') {
    const n = parseBRNumber(String(value));
    return <span className="text-xs font-medium text-slate-800">{n.toLocaleString('pt-BR')}</span>;
  }
  if (fieldDef.type === 'DATE') {
    try {
      return <span className="text-xs font-medium text-slate-800">{new Date(String(value)).toLocaleDateString('pt-BR')}</span>;
    } catch { return <span className="text-xs font-medium text-slate-800">{String(value)}</span>; }
  }
  return <span className="text-xs font-medium text-slate-800 truncate max-w-[130px]">{String(value)}</span>;
}

export function LeadSidebar({ lead, onRefresh }: LeadSidebarProps) {
  const [activeTab, setActiveTab] = useState('Principal');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState(false);
  const [valueInput, setValueInput] = useState(String(lead.value ?? 0));
  const [customValues, setCustomValues] = useState<Record<string, FieldValue>>(
    (lead.customFields as Record<string, FieldValue>) || {}
  );
  const [showAddField, setShowAddField] = useState(false);
  const [showAddTab, setShowAddTab] = useState(false);
  const [newTabName, setNewTabName] = useState('');
  const [newField, setNewField] = useState({ name: '', type: 'TEXT', options: '' });
  const [saving, setSaving] = useState(false);
  const [tags, setTags] = useState<string[]>(lead.tags);
  const [tagInput, setTagInput] = useState('');

  const queryClient = useQueryClient();

  // ── Sincroniza estado local quando os dados do servidor chegam (refetch) ──
  const prevCustomFieldsRef = useRef(JSON.stringify(lead.customFields));
  useEffect(() => {
    const newStr = JSON.stringify(lead.customFields);
    if (prevCustomFieldsRef.current !== newStr && !editingKey) {
      prevCustomFieldsRef.current = newStr;
      setCustomValues((lead.customFields as Record<string, FieldValue>) || {});
    }
  });

  const saveTags = async (newTags: string[]) => {
    setTags(newTags);
    await api.put(`/api/leads/${lead.id}`, { tags: newTags });
    onRefresh();
  };

  const { data: fieldDefs = [] } = useQuery<FieldDefinition[]>({
    queryKey: ['fieldDefinitions'],
    queryFn: async () => {
      const { data } = await api.get('/api/fields');
      return data;
    },
  });

  // preserva a ordem de criação vinda da API
  const allTabs = ['Principal', ...fieldDefs
    .filter(f => f.tab !== 'Principal')
    .reduce<string[]>((acc, f) => { if (!acc.includes(f.tab)) acc.push(f.tab); return acc; }, [])];
  const fieldsForTab = fieldDefs.filter(f => f.tab === activeTab).sort((a, b) => a.order - b.order);

  const saveFieldValue = async (key: string, value: string) => {
    setSaving(true);
    const baseValues = { ...customValues, [key]: value };

    // ── Cálculo triangular: imóvel = crédito + entrada ──
    // Quaisquer dois campos preenchidos calculam o terceiro automaticamente
    let newValues = baseValues;
    if (key === 'valor_imovel' || key === 'valor_credito' || key === 'valor_entrada') {
      const imovel  = parseBRNumber(String(key === 'valor_imovel'  ? value : (customValues.valor_imovel  ?? '0')));
      const credito = parseBRNumber(String(key === 'valor_credito' ? value : (customValues.valor_credito ?? '0')));
      const entrada = parseBRNumber(String(key === 'valor_entrada' ? value : (customValues.valor_entrada ?? '0')));

      if (key === 'valor_imovel') {
        if (credito > 0) {
          newValues = { ...baseValues, valor_entrada: String(Math.max(0, imovel - credito)) };
        } else if (entrada > 0) {
          newValues = { ...baseValues, valor_credito: String(Math.max(0, imovel - entrada)) };
        }
      } else if (key === 'valor_credito') {
        if (imovel > 0) {
          newValues = { ...baseValues, valor_entrada: String(Math.max(0, imovel - credito)) };
        } else if (entrada > 0) {
          newValues = { ...baseValues, valor_imovel: String(entrada + credito) };
        }
      } else if (key === 'valor_entrada') {
        if (credito > 0) {
          newValues = { ...baseValues, valor_imovel: String(entrada + credito) };
        } else if (imovel > 0) {
          newValues = { ...baseValues, valor_credito: String(Math.max(0, imovel - entrada)) };
        }
      }
    }

    setCustomValues(newValues);
    setEditingKey(null);
    try {
      await api.patch(`/api/leads/${lead.id}/custom-fields`, { customFields: newValues });

      // Sincroniza: valor do crédito → valor da venda
      if (key === 'valor_credito') {
        const numeric = parseBRNumber(value);
        await api.put(`/api/leads/${lead.id}`, { value: numeric });
        setValueInput(String(numeric));
      }

      // Sincroniza nome do lead quando participante_1 ou participante_2 muda
      if (key === 'participante_1' || key === 'participante_2') {
        const p1 = String(key === 'participante_1' ? value : (customValues.participante_1 ?? '')).trim();
        const p2 = String(key === 'participante_2' ? value : (customValues.participante_2 ?? '')).trim();
        const newName = p2 ? `${p1} / ${p2}` : p1;
        if (newName) {
          await api.put(`/api/leads/${lead.id}`, { name: newName });
        }
      }

      onRefresh(); // sempre atualiza o lead após qualquer edição
    } finally {
      setSaving(false);
    }
  };

  const addFieldMutation = useMutation({
    mutationFn: async () => {
      if (!newField.name.trim()) return;
      await api.post('/api/fields', {
        name: newField.name.trim(),
        type: newField.type,
        tab: activeTab,
        options: newField.type === 'SELECT' ? newField.options.split(',').map(o => o.trim()).filter(Boolean) : [],
        order: fieldsForTab.length,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fieldDefinitions'] });
      setShowAddField(false);
      setNewField({ name: '', type: 'TEXT', options: '' });
    },
  });

  const deleteFieldMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/fields/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fieldDefinitions'] });
    },
  });

  const addTab = () => {
    if (!newTabName.trim()) return;
    // tabs are created implicitly when a field is added to them
    setActiveTab(newTabName.trim());
    setShowAddTab(false);
    setNewTabName('');
    setShowAddField(true);
  };

  return (
    <aside className="w-80 flex-shrink-0 border-r border-af-border bg-white overflow-y-auto flex flex-col">
      {/* Tab bar */}
      <div className="flex border-b border-af-border overflow-x-auto scrollbar-none flex-shrink-0">
        {allTabs.map(tab => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); setShowAddField(false); }}
            className={`px-3 py-2.5 text-xs font-medium whitespace-nowrap flex-shrink-0 border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-af-mid text-af-mid'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab}
          </button>
        ))}
        {showAddTab ? (
          <div className="flex items-center gap-1 px-2 py-1">
            <input
              autoFocus
              placeholder="Nome da aba"
              className="text-xs border border-af-border rounded px-2 py-0.5 w-24 focus:outline-none"
              value={newTabName}
              onChange={e => setNewTabName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addTab(); if (e.key === 'Escape') setShowAddTab(false); }}
            />
            <button onClick={addTab} className="text-green-600"><Check size={12} /></button>
            <button onClick={() => setShowAddTab(false)} className="text-slate-400"><X size={12} /></button>
          </div>
        ) : (
          <button
            onClick={() => setShowAddTab(true)}
            className="px-2 py-2.5 text-slate-400 hover:text-af-mid flex-shrink-0 transition-colors"
            title="Nova aba"
          >
            <Plus size={13} />
          </button>
        )}
      </div>

      {/* Fields list */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2 space-y-0">
          {/* Built-in fields only on Principal tab */}
          {activeTab === 'Principal' && (
            <>
              <div className="flex items-center justify-between py-2.5 border-b border-slate-100">
                <span className="text-xs text-slate-500 flex-shrink-0 w-36">Usuário responsável</span>
                <span className="text-xs font-medium text-slate-800 truncate">{lead.user.name}</span>
              </div>
              <div className="flex items-center justify-between py-2.5 border-b border-slate-100 gap-2">
                <span className="text-xs text-slate-500 flex-shrink-0 w-36">Valor da venda</span>
                {editingValue ? (
                  <div className="flex items-center gap-1 flex-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="Ex: 250000"
                      className="text-xs border border-af-border rounded px-2 py-1 flex-1 bg-white focus:outline-none focus:border-af-mid min-w-0"
                      value={valueInput}
                      onChange={e => setValueInput(e.target.value)}
                      onKeyDown={async e => {
                        if (e.key === 'Enter') {
                          const numeric = parseBRNumber(valueInput);
                          const newCF = { ...customValues, valor_credito: String(numeric) };
                          setCustomValues(newCF);
                          await Promise.all([
                            api.put(`/api/leads/${lead.id}`, { value: numeric }),
                            api.patch(`/api/leads/${lead.id}/custom-fields`, { customFields: newCF }),
                          ]);
                          setEditingValue(false);
                          onRefresh();
                        }
                        if (e.key === 'Escape') setEditingValue(false);
                      }}
                      autoFocus
                    />
                    <button onClick={async () => {
                      const numeric = parseBRNumber(valueInput);
                      const newCF = { ...customValues, valor_credito: String(numeric) };
                      setCustomValues(newCF);
                      await Promise.all([
                        api.put(`/api/leads/${lead.id}`, { value: numeric }),
                        api.patch(`/api/leads/${lead.id}/custom-fields`, { customFields: newCF }),
                      ]);
                      setEditingValue(false);
                      onRefresh();
                    }} className="text-green-600 hover:text-green-700 flex-shrink-0">
                      <Check size={12} />
                    </button>
                    <button onClick={() => setEditingValue(false)} className="text-slate-400 hover:text-slate-600 flex-shrink-0">
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setValueInput(String(lead.value ?? '')); setEditingValue(true); }}
                    className="text-xs font-medium text-slate-800 hover:text-af-mid transition-colors"
                  >
                    {lead.value ? formatCurrency(lead.value) : <span className="text-slate-300">...</span>}
                  </button>
                )}
              </div>
            </>
          )}

          {/* Custom fields for this tab */}
          {fieldsForTab.map(field => (
            <div
              key={field.id}
              className="group flex items-center justify-between py-2.5 border-b border-slate-100 gap-2"
            >
              <span className="text-xs text-slate-500 flex-shrink-0 w-36 leading-tight">{field.name}</span>
              <div className="flex items-center gap-1 flex-1 justify-end min-w-0">
                {editingKey === field.key ? (
                  <FieldEditor
                    fieldDef={field}
                    value={customValues[field.key]}
                    onSave={(v) => saveFieldValue(field.key, v)}
                    onCancel={() => setEditingKey(null)}
                  />
                ) : (
                  <>
                    <button
                      onClick={() => setEditingKey(field.key)}
                      className="flex-1 text-right hover:text-af-mid transition-colors min-w-0"
                    >
                      <DisplayValue fieldDef={field} value={customValues[field.key]} />
                    </button>
                    <button
                      onClick={() => deleteFieldMutation.mutate(field.id)}
                      className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 flex-shrink-0 transition-opacity ml-1"
                      title="Excluir campo"
                    >
                      <Trash2 size={10} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}

          {fieldsForTab.length === 0 && !showAddField && (
            <p className="text-xs text-slate-400 py-4 text-center">Nenhum campo nesta aba</p>
          )}

          {/* Add field form */}
          {showAddField ? (
            <div className="py-3 space-y-2">
              <input
                autoFocus
                placeholder="Nome do campo"
                className="w-full text-xs border border-af-border rounded px-2 py-1.5 focus:outline-none focus:border-af-mid"
                value={newField.name}
                onChange={e => setNewField(p => ({ ...p, name: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Escape') setShowAddField(false); }}
              />
              <select
                className="w-full text-xs border border-af-border rounded px-2 py-1.5 bg-white focus:outline-none"
                value={newField.type}
                onChange={e => setNewField(p => ({ ...p, type: e.target.value }))}
              >
                <option value="TEXT">Texto</option>
                <option value="NUMBER">Número</option>
                <option value="DATE">Data</option>
                <option value="SELECT">Seleção (dropdown)</option>
                <option value="EMAIL">E-mail</option>
                <option value="PHONE">Telefone</option>
                <option value="LINK">Link</option>
              </select>
              {newField.type === 'SELECT' && (
                <input
                  placeholder="Opções separadas por vírgula"
                  className="w-full text-xs border border-af-border rounded px-2 py-1.5 focus:outline-none focus:border-af-mid"
                  value={newField.options}
                  onChange={e => setNewField(p => ({ ...p, options: e.target.value }))}
                />
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => addFieldMutation.mutate()}
                  disabled={!newField.name.trim() || addFieldMutation.isPending}
                  className="flex-1 text-xs bg-af-mid text-white rounded py-1.5 hover:bg-af-dark disabled:opacity-50 transition-colors"
                >
                  {addFieldMutation.isPending ? 'Salvando...' : 'Adicionar'}
                </button>
                <button
                  onClick={() => { setShowAddField(false); setNewField({ name: '', type: 'TEXT', options: '' }); }}
                  className="text-xs text-slate-500 hover:text-slate-700 px-3 border border-af-border rounded"
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAddField(true)}
              className="flex items-center gap-1 text-xs text-af-mid hover:text-af-dark py-3 transition-colors"
            >
              <Plus size={12} />
              Adicionar campo
            </button>
          )}
        </div>
      </div>

      {/* Tags */}
      <div className="px-4 py-3 border-t border-af-border flex-shrink-0">
        <div className="flex items-center gap-1.5 mb-2">
          <Tag size={11} className="text-slate-400" />
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Tags</span>
        </div>
        <div className="flex flex-wrap gap-1 mb-2">
          {tags.map(tag => (
            <span
              key={tag}
              className="group flex items-center gap-1 text-xs bg-af-light text-af-mid px-2 py-0.5 rounded-full cursor-pointer hover:bg-red-50 hover:text-red-500 transition-colors"
              onClick={() => saveTags(tags.filter(t => t !== tag))}
              title="Clique para remover"
            >
              {tag}
              <X size={9} className="opacity-0 group-hover:opacity-100" />
            </span>
          ))}
          {tags.length === 0 && <span className="text-xs text-slate-300">Nenhuma tag</span>}
        </div>
        {/* Add tag input */}
        <div className="flex items-center gap-1">
          <input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const t = tagInput.trim();
                if (t && !tags.includes(t)) { saveTags([...tags, t]); setTagInput(''); }
              }
              if (e.key === 'Escape') setTagInput('');
            }}
            placeholder="+ Adicionar tag"
            className="flex-1 text-xs border border-dashed border-af-border rounded px-2 py-1 focus:outline-none focus:border-af-mid bg-transparent placeholder:text-slate-400"
          />
          {tagInput.trim() && (
            <button
              onClick={() => {
                const t = tagInput.trim();
                if (t && !tags.includes(t)) { saveTags([...tags, t]); setTagInput(''); }
              }}
              className="text-af-mid hover:text-af-dark"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

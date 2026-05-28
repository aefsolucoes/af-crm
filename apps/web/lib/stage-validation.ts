import { Lead } from '@/types';

/** Etapas que exigem preenchimento completo antes de mover */
const GATED_STAGES = ['aguardando documentação', 'aguardando documentação'];

export interface ValidationField {
  key: string;           // chave no customFields (ou '_value' para lead.value)
  label: string;
  section: string;
}

export const REQUIRED_FIELDS: ValidationField[] = [
  // Venda
  { key: '_value',        label: 'Valor da venda',        section: 'Venda'          },
  // Participante 1
  { key: 'participante_1',label: 'Nome',                  section: 'Participante 1' },
  { key: 'cpf_1',         label: 'CPF',                   section: 'Participante 1' },
  { key: 'nascimento_1',  label: 'Data de nascimento',    section: 'Participante 1' },
  { key: 'renda_1',       label: 'Renda',                 section: 'Participante 1' },
  { key: 'email_1',       label: 'E-mail',                section: 'Participante 1' },
  { key: 'vinculo_1',     label: 'Tipo de vínculo',       section: 'Participante 1' },
  { key: 'telefone_1',    label: 'Telefone',              section: 'Participante 1' },
  // Financiamento
  { key: 'finalidade',    label: 'Finalidade',            section: 'Financiamento'  },
  { key: 'indexador',     label: 'Indexador',             section: 'Financiamento'  },
  { key: 'valor_avaliacao',label: 'Valor de avaliação',   section: 'Financiamento'  },
  { key: 'valor_imovel',  label: 'Valor do imóvel',       section: 'Financiamento'  },
  { key: 'valor_credito', label: 'Valor do crédito',      section: 'Financiamento'  },
  { key: 'valor_entrada', label: 'Valor de entrada',      section: 'Financiamento'  },
  { key: 'primeira_parcela',label: 'Primeira parcela',    section: 'Financiamento'  },
  { key: 'ultima_parcela',label: 'Última parcela',        section: 'Financiamento'  },
  { key: 'instituicao',   label: 'Instituição',           section: 'Financiamento'  },
  { key: 'taxa_efetiva',  label: 'Taxa efetiva',          section: 'Financiamento'  },
  { key: 'prazo',         label: 'Prazo',                 section: 'Financiamento'  },
  { key: 'fgts',          label: 'FGTS',                  section: 'Financiamento'  },
];

/** Retorna os campos ausentes para a etapa-alvo */
export function getMissingFields(lead: Lead, targetStageName: string): ValidationField[] {
  const isGated = GATED_STAGES.some(g =>
    targetStageName.toLowerCase().includes(g.toLowerCase())
  );
  if (!isGated) return [];

  const cf = ((lead as any).customFields || {}) as Record<string, string>;

  return REQUIRED_FIELDS.filter(f => {
    if (f.key === '_value') return !lead.value;
    const v = cf[f.key];
    return !v || !v.trim();
  });
}

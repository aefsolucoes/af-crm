'use client';
import { FunilView } from '@/components/funil/funil-view';

export default function FunilHabitacaoPage() {
  return (
    <FunilView
      departmentName="Financiamento Habitacional"
      title="Funil de Vendas Habitação"
      storageKeySuffix="habitacao"
    />
  );
}

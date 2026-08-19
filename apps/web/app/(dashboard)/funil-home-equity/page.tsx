'use client';
import { FunilView } from '@/components/funil/funil-view';

export default function FunilHomeEquityPage() {
  return (
    <FunilView
      departmentName="Home Equity"
      title="Funil de Vendas Home Equity"
      storageKeySuffix="home-equity"
    />
  );
}

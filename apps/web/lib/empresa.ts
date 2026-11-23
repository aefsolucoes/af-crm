'use client';
import { useEffect, useState } from 'react';
import api from '@/lib/api';

// Nome da empresa nas telas (plano do piloto, Fabio 23/11: "abrir o CRM para outras pessoas"). Vem dos dados gravados na conta dona desta cópia do CRM
// (GET /api/empresa-publica — vale também no login, antes de entrar). SEM NADA GRAVADO, FICA SEM (Fabio 23/11): nunca cai no nome da A&F.
// Guarda a última resposta no navegador pra tela já abrir com o nome, sem piscar.
export type EmpresaTela = { nome: string; nomeCurto: string; marca: string };
const VAZIA: EmpresaTela = { nome: '', nomeCurto: '', marca: '' };
const KEY = 'af_empresa';
let memoria: EmpresaTela | null = null;
let pedido: Promise<EmpresaTela> | null = null;

function guardada(): EmpresaTela | null {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && typeof v === 'object' ? { ...VAZIA, ...v } : null; } catch { return null; }
}

function buscar(): Promise<EmpresaTela> {
  if (!pedido) {
    pedido = api.get('/api/empresa-publica')
      .then((r) => { const e = { ...VAZIA, ...(r.data || {}) } as EmpresaTela; memoria = e; try { localStorage.setItem(KEY, JSON.stringify(e)); } catch { /* aba anônima */ } return e; })
      .catch(() => memoria || guardada() || VAZIA)
      .finally(() => { setTimeout(() => { pedido = null; }, 60_000); });
  }
  return pedido;
}

export function useEmpresa(): EmpresaTela {
  const [e, setE] = useState<EmpresaTela>(() => memoria || VAZIA);
  useEffect(() => {
    let vivo = true;
    const g = memoria || guardada();
    if (g) setE(g);
    buscar().then((x) => { if (vivo) setE(x); });
    return () => { vivo = false; };
  }, []);
  return e;
}

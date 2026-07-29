'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Topbar } from '@/components/ui/topbar';
import { ReportSummary, ReportConversion, Task, Conversation } from '@/types';
import api from '@/lib/api';
import { formatCurrency, formatDate, isOverdue, cn } from '@/lib/utils';
import { TrendingUp, Users, Target, Clock, Trophy, Calendar, Download, AlertCircle, MessageCircle, Plus, Inbox, FileCheck } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { MorningReport } from '@/components/dashboard/morning-report';
import { useState } from 'react';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement,
  ArcElement, Title, Tooltip, Legend,
} from 'chart.js';
import { Bar, Doughnut, Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, Tooltip, Legend);

const CHART_OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
};

const FINALIDADE_COLORS: Record<string, string> = {
  'Aquisição de terreno + Construção': 'bg-indigo-50 text-indigo-600',
  'Construção': 'bg-orange-50 text-orange-600',
  'Lote': 'bg-yellow-50 text-yellow-700',
  'Residencial': 'bg-blue-50 text-blue-600',
  'Comercial': 'bg-purple-50 text-purple-600',
  'Crédito com garantia': 'bg-emerald-50 text-emerald-600',
};

// Datas padrão: primeiro e último dia do mês atual
function defaultFrom() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function defaultTo() {
  const d = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchSummary(): Promise<ReportSummary> {
  const { data } = await api.get('/api/reports/summary');
  return data;
}

async function fetchConversion(): Promise<ReportConversion> {
  const { data } = await api.get('/api/reports/conversion');
  return data;
}

async function fetchTasks(): Promise<Task[]> {
  const { data } = await api.get('/api/tasks');
  return data;
}

async function fetchConversations(): Promise<Conversation[]> {
  const { data } = await api.get('/api/messages');
  return data;
}

function KpiCard({ title, value, subtitle, icon: Icon, color }: { title: string; value: string; subtitle?: string; icon: React.ElementType; color: string }) {
  return (
    <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{title}</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
          {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: color + '22' }}>
          <Icon size={20} style={{ color }} />
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data: summary, isLoading: loadingSummary } = useQuery({ queryKey: ['reports-summary'], queryFn: fetchSummary });
  const { data: conversion, isLoading: loadingConversion } = useQuery({ queryKey: ['reports-conversion'], queryFn: fetchConversion });
  const { data: tasks, isLoading: loadingTasks } = useQuery({ queryKey: ['dashboard-tasks'], queryFn: fetchTasks });
  const { data: conversations, isLoading: loadingConversations } = useQuery({ queryKey: ['dashboard-conversations'], queryFn: fetchConversations });

  const overdueCount = (tasks || []).filter((t) => !t.done && isOverdue(t.dueAt)).length;
  const unreadCount = (conversations || []).reduce((sum, c) => sum + (c._count?.messages || 0), 0);

  // Relatório Fechados
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(defaultTo());
  const { data: fechados, isLoading: loadingFechados, refetch: refetchFechados } = useQuery({
    queryKey: ['reports-fechados', from, to],
    queryFn: async () => {
      const { data } = await api.get(`/api/reports/fechados?from=${from}&to=${to}`);
      return data as { leads: any[]; total: number; totalValue: number; missingPipeline?: boolean };
    },
  });

  // Relatório Documentação Enviada (etapa "Fechado" no funil Vendas)
  const [docFrom, setDocFrom] = useState(defaultFrom());
  const [docTo, setDocTo] = useState(defaultTo());
  const { data: documentacao, isLoading: loadingDocumentacao, refetch: refetchDocumentacao } = useQuery({
    queryKey: ['reports-documentacao', docFrom, docTo],
    queryFn: async () => {
      const { data } = await api.get(`/api/reports/documentacao?from=${docFrom}&to=${docTo}`);
      return data as { leads: any[]; total: number; totalValue: number; missingStage?: boolean };
    },
  });

  const isLoading = loadingSummary || loadingConversion;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Dashboard" subtitle="Visão geral e performance" />

      <div className="flex-1 overflow-auto px-6 py-5 space-y-6 scrollbar-thin">
        {/* Relatório Matinal — o que o usuário tem pra hoje */}
        <MorningReport />

        {/* Visão geral rápida */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {loadingTasks || loadingConversations ? (
            [1, 2].map((i) => <Skeleton key={i} className="h-28" />)
          ) : (
            <>
              <Link href="/tarefas">
                <KpiCard title="Tarefas Vencidas" value={String(overdueCount)} subtitle="Requerem atenção" icon={AlertCircle} color="#ef4444" />
              </Link>
              <Link href="/inbox">
                <KpiCard title="Mensagens Não Lidas" value={String(unreadCount)} subtitle="Na inbox" icon={MessageCircle} color="#2261a8" />
              </Link>
            </>
          )}
          <Link href="/funil" className="bg-af-navy rounded-xl p-5 shadow-sm flex flex-col items-center justify-center gap-1.5 text-white hover:bg-af-blue transition-colors">
            <Inbox size={20} />
            <span className="text-xs font-semibold">Ver Funil</span>
          </Link>
          <Link href="/funil" className="bg-af-mid rounded-xl p-5 shadow-sm flex flex-col items-center justify-center gap-1.5 text-white hover:bg-af-accent transition-colors">
            <Plus size={20} />
            <span className="text-xs font-semibold">Novo Lead</span>
          </Link>
        </div>

        {/* KPIs de performance */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-28" />)
          ) : (
            <>
              <KpiCard title="Receita Total" value={formatCurrency(summary?.totalRevenue)} subtitle="Leads ganhos" icon={TrendingUp} color="#10b981" />
              <KpiCard title="Novos Leads" value={String(summary?.newLeads || 0)} subtitle="Este mês" icon={Users} color="#2261a8" />
              <KpiCard title="Conversão" value={`${summary?.conversionRate || 0}%`} subtitle="Taxa geral" icon={Target} color="#8b5cf6" />
              <KpiCard title="Total de Leads" value={String(summary?.totalLeads || 0)} subtitle="Na base" icon={Clock} color="#f59e0b" />
            </>
          )}
        </div>

        {/* Charts row 1 */}
        <div className="grid grid-cols-3 gap-4">
          {/* Monthly Revenue Bar Chart */}
          <div className="col-span-2 bg-white rounded-xl border border-af-border p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">Receita Mensal (R$)</h3>
            <div className="h-52">
              {isLoading ? <Skeleton className="h-full" /> : summary?.monthlyRevenue ? (
                <Bar
                  options={{ ...CHART_OPTIONS, plugins: { ...CHART_OPTIONS.plugins, tooltip: { callbacks: { label: (ctx) => formatCurrency(ctx.parsed.y) } } } }}
                  data={{
                    labels: summary.monthlyRevenue.map((m) => m.month),
                    datasets: [{
                      label: 'Receita',
                      data: summary.monthlyRevenue.map((m) => m.revenue),
                      backgroundColor: '#2261a820',
                      borderColor: '#2261a8',
                      borderWidth: 2,
                      borderRadius: 6,
                    }],
                  }}
                />
              ) : null}
            </div>
          </div>

          {/* Donut Chart */}
          <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">Leads por Estágio</h3>
            <div className="h-52">
              {isLoading ? <Skeleton className="h-full" /> : conversion?.stages ? (
                <Doughnut
                  options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } } }}
                  data={{
                    labels: conversion.stages.map((s) => s.name),
                    datasets: [{
                      data: conversion.stages.map((s) => s.count),
                      backgroundColor: conversion.stages.map((s) => s.color + 'cc'),
                      borderWidth: 2,
                      borderColor: '#fff',
                    }],
                  }}
                />
              ) : null}
            </div>
          </div>
        </div>

        {/* Charts row 2 */}
        <div className="grid grid-cols-2 gap-4">
          {/* Line Chart */}
          <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">Taxa de Conversão Semanal (%)</h3>
            <div className="h-44">
              {isLoading ? <Skeleton className="h-full" /> : conversion?.weeklyData ? (
                <Line
                  options={{ ...CHART_OPTIONS, scales: { y: { min: 0, max: 100, ticks: { callback: (v) => v + '%' } } } }}
                  data={{
                    labels: conversion.weeklyData.map((w) => w.week),
                    datasets: [{
                      label: 'Conversão',
                      data: conversion.weeklyData.map((w) => w.rate),
                      borderColor: '#8b5cf6',
                      backgroundColor: '#8b5cf620',
                      tension: 0.4,
                      fill: true,
                    }],
                  }}
                />
              ) : null}
            </div>
          </div>

          {/* Top agents */}
          <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">Top Consultores</h3>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : (
              <div className="space-y-3">
                {conversion?.topAgents.map((agent, i) => {
                  const maxRevenue = Math.max(...(conversion.topAgents.map((a) => a.revenue)));
                  const pct = maxRevenue > 0 ? (agent.revenue / maxRevenue) * 100 : 0;
                  return (
                    <div key={agent.name}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-af-mid w-4">{i + 1}</span>
                          <span className="font-medium text-slate-700">{agent.name}</span>
                        </div>
                        <div className="text-right">
                          <span className="font-semibold text-slate-900">{formatCurrency(agent.revenue)}</span>
                          <span className="text-slate-400 ml-1">· {agent.leads} leads</span>
                        </div>
                      </div>
                      <div className="h-1.5 bg-af-light rounded-full overflow-hidden">
                        <div className="h-full bg-af-mid rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Relatório: Fechados em Vendas ── */}
        <div className="bg-white rounded-xl border border-af-border shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-af-border">
            <div className="flex items-center gap-2">
              <Trophy size={16} className="text-emerald-500" />
              <h3 className="text-sm font-semibold text-slate-700">Fechados em Vendas — por período</h3>
            </div>
            <div className="flex items-center gap-2">
              <Calendar size={13} className="text-slate-400" />
              <input
                type="date" value={from} onChange={e => setFrom(e.target.value)}
                className="text-xs px-2 py-1 border border-af-border rounded-lg focus:outline-none focus:ring-1 focus:ring-af-accent"
              />
              <span className="text-xs text-slate-400">até</span>
              <input
                type="date" value={to} onChange={e => setTo(e.target.value)}
                className="text-xs px-2 py-1 border border-af-border rounded-lg focus:outline-none focus:ring-1 focus:ring-af-accent"
              />
              <button
                onClick={() => refetchFechados()}
                className="text-xs px-3 py-1 bg-af-mid text-white rounded-lg hover:bg-af-dark"
              >
                Filtrar
              </button>
            </div>
          </div>

          {/* KPIs do período */}
          {!loadingFechados && fechados && (
            <div className="grid grid-cols-2 gap-px bg-af-border border-b border-af-border">
              <div className="bg-white px-5 py-3 text-center">
                <p className="text-2xl font-bold text-slate-900">{fechados.total}</p>
                <p className="text-xs text-slate-500 mt-0.5">clientes fechados</p>
              </div>
              <div className="bg-white px-5 py-3 text-center">
                <p className="text-2xl font-bold text-emerald-600">{formatCurrency(fechados.totalValue)}</p>
                <p className="text-xs text-slate-500 mt-0.5">em crédito total</p>
              </div>
            </div>
          )}

          {/* Tabela */}
          {loadingFechados ? (
            <div className="p-5 space-y-3">
              {[1,2,3].map(i => <Skeleton key={i} className="h-10" />)}
            </div>
          ) : fechados?.missingPipeline ? (
            <div className="flex flex-col items-center justify-center py-10 px-6 text-center gap-1">
              <p className="text-sm text-slate-500">O funil <strong>"Concluído"</strong> ainda não existe.</p>
              <p className="text-xs text-slate-400">Crie esse funil no Funil de Vendas (botão de "Novo funil" ao lado do seletor de pipeline) para este relatório passar a mostrar dados.</p>
            </div>
          ) : fechados?.leads.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-slate-400 text-sm">
              Nenhum lead concluído neste período
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-af-border text-xs text-slate-500 font-semibold uppercase tracking-wide">
                    <th className="text-left px-5 py-3">Cliente</th>
                    <th className="text-left px-4 py-3">Contato</th>
                    <th className="text-left px-4 py-3">Consultor</th>
                    <th className="text-right px-4 py-3">Valor</th>
                    <th className="text-right px-5 py-3">Data</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-af-border">
                  {fechados?.leads.map((lead: any) => (
                    <tr key={lead.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-3 font-medium text-slate-800">
                        {(lead.customFields as any)?.participante_1 || lead.name}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {lead.contact?.phone || lead.contact?.email || '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-500">{lead.user?.name || '—'}</td>
                      <td className="px-4 py-3 text-right font-semibold text-emerald-600">
                        {lead.value ? formatCurrency(lead.value) : '—'}
                      </td>
                      <td className="px-5 py-3 text-right text-slate-400 text-xs">
                        {formatDate(lead.enteredAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Relatório: Documentação Enviada ── */}
        <div className="bg-white rounded-xl border border-af-border shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-af-border">
            <div className="flex items-center gap-2">
              <FileCheck size={16} className="text-af-mid" />
              <h3 className="text-sm font-semibold text-slate-700">Documentação Enviada — por período</h3>
            </div>
            <div className="flex items-center gap-2">
              <Calendar size={13} className="text-slate-400" />
              <input
                type="date" value={docFrom} onChange={e => setDocFrom(e.target.value)}
                className="text-xs px-2 py-1 border border-af-border rounded-lg focus:outline-none focus:ring-1 focus:ring-af-accent"
              />
              <span className="text-xs text-slate-400">até</span>
              <input
                type="date" value={docTo} onChange={e => setDocTo(e.target.value)}
                className="text-xs px-2 py-1 border border-af-border rounded-lg focus:outline-none focus:ring-1 focus:ring-af-accent"
              />
              <button
                onClick={() => refetchDocumentacao()}
                className="text-xs px-3 py-1 bg-af-mid text-white rounded-lg hover:bg-af-dark"
              >
                Filtrar
              </button>
            </div>
          </div>

          {/* KPIs do período */}
          {!loadingDocumentacao && documentacao && !documentacao.missingStage && (
            <div className="grid grid-cols-2 gap-px bg-af-border border-b border-af-border">
              <div className="bg-white px-5 py-3 text-center">
                <p className="text-2xl font-bold text-slate-900">{documentacao.total}</p>
                <p className="text-xs text-slate-500 mt-0.5">clientes com documentação enviada</p>
              </div>
              <div className="bg-white px-5 py-3 text-center">
                <p className="text-2xl font-bold text-af-mid">{formatCurrency(documentacao.totalValue)}</p>
                <p className="text-xs text-slate-500 mt-0.5">em crédito total</p>
              </div>
            </div>
          )}

          {/* Cards */}
          {loadingDocumentacao ? (
            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-28" />)}
            </div>
          ) : documentacao?.missingStage ? (
            <div className="flex flex-col items-center justify-center py-10 px-6 text-center gap-1">
              <p className="text-sm text-slate-500">A etapa <strong>"Fechado"</strong> não foi encontrada no funil <strong>Vendas</strong>.</p>
              <p className="text-xs text-slate-400">Verifique se o funil "Vendas" tem uma etapa chamada exatamente "Fechado".</p>
            </div>
          ) : documentacao?.leads.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-slate-400 text-sm">
              Nenhum cliente enviou documentação neste período
            </div>
          ) : (
            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {documentacao?.leads.map((lead: any) => {
                const finalidade = lead.customFields?.finalidade as string | undefined;
                return (
                  <div key={lead.id} className="border border-af-border rounded-xl p-4">
                    <p className="text-sm font-semibold text-slate-800 truncate">
                      {(lead.customFields as any)?.participante_1 || lead.name}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {lead.contact?.phone || lead.contact?.email || '—'} · {lead.user?.name || '—'}
                    </p>
                    {finalidade && (
                      <span className={cn('inline-block mt-2 text-xs font-medium px-2 py-0.5 rounded-full', FINALIDADE_COLORS[finalidade] || 'bg-slate-100 text-slate-600')}>
                        {finalidade}
                      </span>
                    )}
                    <div className="flex items-center justify-between mt-3 pt-2 border-t border-af-border">
                      <span className="text-sm font-bold text-af-mid">{lead.value ? formatCurrency(lead.value) : '—'}</span>
                      <span className="text-xs text-slate-400">{formatDate(lead.enteredAt)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

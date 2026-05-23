'use client';
import { useQuery } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { ReportSummary, ReportConversion } from '@/types';
import api from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { TrendingUp, Users, Target, Clock } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
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

async function fetchSummary(): Promise<ReportSummary> {
  const { data } = await api.get('/api/reports/summary');
  return data;
}

async function fetchConversion(): Promise<ReportConversion> {
  const { data } = await api.get('/api/reports/conversion');
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

export default function RelatoriosPage() {
  const { data: summary, isLoading: loadingSummary } = useQuery({ queryKey: ['reports-summary'], queryFn: fetchSummary });
  const { data: conversion, isLoading: loadingConversion } = useQuery({ queryKey: ['reports-conversion'], queryFn: fetchConversion });

  const isLoading = loadingSummary || loadingConversion;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Relatórios" subtitle="Dashboard de performance" />

      <div className="flex-1 overflow-auto px-6 py-5 space-y-6 scrollbar-thin">
        {/* KPIs */}
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

        {/* Lead sources */}
        <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Distribuição por Estágio</h3>
          {isLoading ? <Skeleton className="h-24" /> : (
            <div className="space-y-3">
              {conversion?.stages.map((stage) => {
                const total = conversion.stages.reduce((s, st) => s + st.count, 0);
                const pct = total > 0 ? (stage.count / total) * 100 : 0;
                return (
                  <div key={stage.name} className="flex items-center gap-4">
                    <span className="text-xs text-slate-600 w-28 text-right">{stage.name}</span>
                    <div className="flex-1 h-2 bg-af-light rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: stage.color }} />
                    </div>
                    <span className="text-xs font-semibold text-slate-700 w-12">{stage.count} · {Math.round(pct)}%</span>
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

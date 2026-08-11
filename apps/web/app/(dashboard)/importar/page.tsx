'use client';
import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Topbar } from '@/components/ui/topbar';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { Upload, FileSpreadsheet, ArrowRight, ArrowLeft, AlertTriangle, CheckCircle2, X, Users } from 'lucide-react';

type Step = 'upload' | 'mapping' | 'review' | 'done';

// Campos do CRM que o importador sabe preencher. "name" é o único obrigatório
// — os demais viram customFields do lead (mesma nomenclatura usada no resto
// do CRM: participante_1/telefone_1/cpf_1/email_1/valor_credito).
const CRM_FIELDS: { key: CrmFieldKey; label: string; required?: boolean }[] = [
  { key: 'name', label: 'Nome', required: true },
  { key: 'phone', label: 'Telefone' },
  { key: 'cpf', label: 'CPF' },
  { key: 'email', label: 'E-mail' },
  { key: 'valorCredito', label: 'Valor do crédito' },
];
type CrmFieldKey = 'name' | 'phone' | 'cpf' | 'email' | 'valorCredito';

type RawRow = Record<string, string>;

interface ReviewRow {
  idx: number;
  name: string;
  phone?: string;
  cpf?: string;
  email?: string;
  valorCredito?: string;
  duplicateOf: { id: string; name: string } | null;
  skip: boolean;
}

export default function ImportarPage() {
  const [step, setStep] = useState<Step>('upload');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 1 — upload
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [parsing, setParsing] = useState(false);

  // Step 2 — mapping
  const [mapping, setMapping] = useState<Record<CrmFieldKey, string>>({
    name: '', phone: '', cpf: '', email: '', valorCredito: '',
  });

  // Step 3 — review
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [checkingDup, setCheckingDup] = useState(false);

  // Step 4 — commit
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);

  function resetAll() {
    setStep('upload');
    setFileName('');
    setHeaders([]);
    setRawRows([]);
    setMapping({ name: '', phone: '', cpf: '', email: '', valorCredito: '' });
    setReviewRows([]);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = ev.target?.result;
        const wb = XLSX.read(data, { type: 'binary' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: '', raw: false });
        if (!json.length) {
          toast('Arquivo vazio ou sem linhas reconhecíveis', 'error');
          setParsing(false);
          return;
        }
        const cols = Object.keys(json[0]);
        setHeaders(cols);
        setRawRows(json);

        // Tenta pré-selecionar colunas pelo nome (funciona para exports do
        // Kommo e da maioria dos CRMs — o usuário pode corrigir na tela seguinte)
        const guess = (patterns: RegExp[]) => cols.find((c) => patterns.some((p) => p.test(c))) || '';
        setMapping({
          name: guess([/nome/i, /name/i, /^contato$/i]),
          phone: guess([/telefone/i, /phone/i, /celular/i, /whatsapp/i]),
          cpf: guess([/cpf/i]),
          email: guess([/e-?mail/i]),
          valorCredito: guess([/valor.*cr[eé]dito/i, /cr[eé]dito/i, /valor/i]),
        });

        setStep('mapping');
      } catch (err) {
        console.error(err);
        toast('Não foi possível ler o arquivo. Confira se é um .csv ou .xlsx válido', 'error');
      } finally {
        setParsing(false);
      }
    };
    reader.onerror = () => {
      toast('Erro ao ler o arquivo', 'error');
      setParsing(false);
    };
    reader.readAsBinaryString(file);
  }

  async function handleMappingNext() {
    if (!mapping.name) {
      toast('Selecione a coluna que tem o nome do cliente', 'error');
      return;
    }
    const mapped = rawRows
      .map((r) => ({
        name: String(r[mapping.name] || '').trim(),
        phone: mapping.phone ? String(r[mapping.phone] || '').trim() : undefined,
        cpf: mapping.cpf ? String(r[mapping.cpf] || '').trim() : undefined,
        email: mapping.email ? String(r[mapping.email] || '').trim() : undefined,
        valorCredito: mapping.valorCredito ? String(r[mapping.valorCredito] || '').trim() : undefined,
      }))
      .filter((r) => r.name);

    if (!mapped.length) {
      toast('Nenhuma linha com nome preenchido foi encontrada', 'error');
      return;
    }

    setCheckingDup(true);
    try {
      const { data } = await api.post('/api/import/check-duplicates', { rows: mapped });
      setReviewRows(
        (data.rows as any[]).map((r) => ({ ...r, skip: !!r.duplicateOf }))
      );
      setStep('review');
    } catch {
      toast('Erro ao verificar duplicados', 'error');
    } finally {
      setCheckingDup(false);
    }
  }

  function toggleSkip(idx: number) {
    setReviewRows((rows) => rows.map((r) => (r.idx === idx ? { ...r, skip: !r.skip } : r)));
  }

  async function handleCommit() {
    setCommitting(true);
    try {
      const { data } = await api.post('/api/import/commit', {
        rows: reviewRows.map(({ idx, duplicateOf, ...rest }) => rest),
      });
      setResult({ created: data.created, skipped: data.skipped });
      setStep('done');
      toast(`${data.created} cliente(s) importado(s)!`);
    } catch {
      toast('Erro ao importar clientes', 'error');
    } finally {
      setCommitting(false);
    }
  }

  const duplicateCount = reviewRows.filter((r) => r.duplicateOf).length;
  const willImportCount = reviewRows.filter((r) => !r.skip).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Topbar title="Importar clientes" subtitle="Traga sua base de outro CRM (ex: Kommo) para o AF CRM" />
      <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
        <div className="max-w-3xl mx-auto space-y-5">

          {/* Stepper */}
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            {(['upload', 'mapping', 'review', 'done'] as Step[]).map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center ${step === s ? 'bg-af-mid text-white' : 'bg-slate-100 text-slate-400'}`}>
                  {i + 1}
                </span>
                <span className={step === s ? 'text-slate-900' : ''}>
                  {{ upload: 'Arquivo', mapping: 'Colunas', review: 'Revisão', done: 'Concluído' }[s]}
                </span>
                {i < 3 && <ArrowRight size={12} className="mx-1" />}
              </div>
            ))}
          </div>

          {/* Step 1 — Upload */}
          {step === 'upload' && (
            <div className="bg-white rounded-2xl border border-af-border shadow-sm p-8">
              <div className="flex flex-col items-center justify-center text-center gap-3 py-10 border-2 border-dashed border-af-border rounded-xl">
                <div className="w-12 h-12 rounded-xl bg-af-light flex items-center justify-center">
                  <Upload size={22} className="text-af-mid" />
                </div>
                <div>
                  <p className="font-semibold text-slate-800">Envie o arquivo exportado do Kommo</p>
                  <p className="text-xs text-slate-500 mt-1">Aceita .csv, .xlsx ou .xls — a primeira linha deve ter os títulos das colunas</p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleFile}
                  className="hidden"
                  id="import-file"
                />
                <Button onClick={() => fileInputRef.current?.click()} loading={parsing}>
                  <FileSpreadsheet size={16} /> Escolher arquivo
                </Button>
              </div>
            </div>
          )}

          {/* Step 2 — Mapping */}
          {step === 'mapping' && (
            <div className="bg-white rounded-2xl border border-af-border shadow-sm p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-slate-800">Mapear colunas</p>
                  <p className="text-xs text-slate-500 mt-0.5">{fileName} — {rawRows.length} linha(s) encontrada(s). Diga qual coluna do arquivo corresponde a cada campo do CRM.</p>
                </div>
              </div>

              <div className="space-y-3">
                {CRM_FIELDS.map((f) => (
                  <div key={f.key} className="flex items-center gap-3">
                    <label className="w-40 text-sm font-medium text-slate-700 flex-shrink-0">
                      {f.label} {f.required && <span className="text-red-500">*</span>}
                    </label>
                    <select
                      value={mapping[f.key]}
                      onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                      className="flex-1 px-3 py-2 text-sm border border-af-border rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-af-accent"
                    >
                      <option value="">— não importar —</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-af-border">
                <Button variant="ghost" onClick={resetAll}>
                  <ArrowLeft size={16} /> Trocar arquivo
                </Button>
                <Button onClick={handleMappingNext} loading={checkingDup}>
                  Verificar duplicados <ArrowRight size={16} />
                </Button>
              </div>
            </div>
          )}

          {/* Step 3 — Review */}
          {step === 'review' && (
            <div className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
              <div className="p-6 pb-4 space-y-2">
                <p className="font-semibold text-slate-800">Revisar antes de importar</p>
                <p className="text-xs text-slate-500">
                  {reviewRows.length} linha(s) no total{duplicateCount > 0 && <> — <span className="text-amber-600 font-medium">{duplicateCount} possível(is) duplicata(s)</span> já marcada(s) para pular. Decida caso a caso.</>}
                </p>
                {duplicateCount > 0 && (
                  <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700">
                    <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                    <span>Linhas com um possível cliente já cadastrado (mesmo telefone ou CPF) vêm marcadas como &quot;Pular&quot; por padrão. Desmarque para importar mesmo assim.</span>
                  </div>
                )}
              </div>
              <div className="max-h-[420px] overflow-y-auto scrollbar-thin border-t border-af-border">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr className="text-left text-xs text-slate-500">
                      <th className="px-4 py-2 font-medium">Nome</th>
                      <th className="px-4 py-2 font-medium">Telefone</th>
                      <th className="px-4 py-2 font-medium">CPF</th>
                      <th className="px-4 py-2 font-medium">Duplicata?</th>
                      <th className="px-4 py-2 font-medium text-right">Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewRows.map((r) => (
                      <tr key={r.idx} className={`border-t border-af-border ${r.skip ? 'opacity-50' : ''}`}>
                        <td className="px-4 py-2 text-slate-800">{r.name}</td>
                        <td className="px-4 py-2 text-slate-500">{r.phone || '—'}</td>
                        <td className="px-4 py-2 text-slate-500">{r.cpf || '—'}</td>
                        <td className="px-4 py-2">
                          {r.duplicateOf ? (
                            <span className="text-amber-600 text-xs">já existe: {r.duplicateOf.name}</span>
                          ) : (
                            <span className="text-slate-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button
                            onClick={() => toggleSkip(r.idx)}
                            className={`text-xs font-medium px-2.5 py-1 rounded-lg transition-colors ${r.skip ? 'bg-slate-100 text-slate-500 hover:bg-slate-200' : 'bg-green-50 text-green-700 hover:bg-green-100'}`}
                          >
                            {r.skip ? 'Pular' : 'Importar'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between p-6 pt-4 border-t border-af-border">
                <Button variant="ghost" onClick={() => setStep('mapping')}>
                  <ArrowLeft size={16} /> Voltar
                </Button>
                <Button onClick={handleCommit} loading={committing}>
                  <Users size={16} /> Importar {willImportCount} cliente(s)
                </Button>
              </div>
            </div>
          )}

          {/* Step 4 — Done */}
          {step === 'done' && result && (
            <div className="bg-white rounded-2xl border border-af-border shadow-sm p-10 text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-green-50 flex items-center justify-center mx-auto">
                <CheckCircle2 size={28} className="text-green-600" />
              </div>
              <div>
                <p className="font-semibold text-slate-800 text-lg">Importação concluída!</p>
                <p className="text-sm text-slate-500 mt-1">
                  {result.created} cliente(s) importado(s) para a Caixa de Entrada
                  {result.skipped > 0 && <> — {result.skipped} pulado(s)</>}
                </p>
              </div>
              <Button onClick={resetAll} variant="secondary">
                <X size={16} /> Importar outro arquivo
              </Button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

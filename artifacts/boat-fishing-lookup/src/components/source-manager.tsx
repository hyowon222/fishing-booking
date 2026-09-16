import { useState, type FormEvent } from 'react';
import { ArrowLeft, Check, FileSpreadsheet, Pencil, Plus, Save, Trash2, Upload, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import {
  useAddFishingSourceVessels,
  useClearFishingSourceVessels,
  getGetFishingFilterOptionsQueryKey,
  getListFishingSourcesQueryKey,
  getSearchFishingSchedulesQueryKey,
  useCreateFishingSource,
  useDeleteFishingSource,
  useListFishingSources,
  useUpdateFishingSource,
  type FishingSource,
  type FishingSourceInput,
} from '@workspace/api-client-react';

const blankForm: FishingSourceInput = {
  name: '',
  region: '',
  port: '',
  sourceUrl: '',
  enabled: true,
};

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-bold text-foreground">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required
        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition placeholder:text-muted-foreground/65 focus:border-primary focus:ring-2 focus:ring-primary/15"
      />
    </label>
  );
}

function SourceForm({
  editing,
  form,
  setForm,
  onSubmit,
  onCancel,
  isSaving,
  error,
}: {
  editing: FishingSource | null;
  form: FishingSourceInput;
  setForm: (form: FishingSourceInput) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  isSaving: boolean;
  error: string;
}) {
  return (
    <form onSubmit={onSubmit} className="rounded-2xl border border-border bg-card p-5 shadow-[0_8px_30px_hsl(214_42%_18%_/_0.04)]">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">
            {editing ? 'Edit source' : 'New source'}
          </p>
          <h2 className="mt-1 font-serif text-xl font-bold">{editing ? '예약처 수정' : '예약처 추가'}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            저장한 예약처는 출항 일정 조회와 항구 필터에 바로 반영됩니다.
          </p>
        </div>
        <button type="button" onClick={onCancel} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="폼 닫기">
          <X size={17} />
        </button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="예약처 이름" value={form.name} onChange={(name) => setForm({ ...form, name })} placeholder="예: 삼길포 헤르메스" />
        <Field label="지역" value={form.region} onChange={(region) => setForm({ ...form, region })} placeholder="예: 충남" />
        <Field label="출항 항구" value={form.port} onChange={(port) => setForm({ ...form, port })} placeholder="예: 삼길포" />
        <Field label="예약처 URL" value={form.sourceUrl} onChange={(sourceUrl) => setForm({ ...form, sourceUrl })} placeholder="https://example.com" type="url" />
      </div>
      <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={form.enabled ?? true}
          onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          className="h-4 w-4 accent-[hsl(var(--primary))]"
        />
        조회에 사용
      </label>
      {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-input px-4 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted">
          취소
        </button>
        <button type="submit" disabled={isSaving} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70">
          {editing ? <Save size={14} /> : <Plus size={14} />}
          {isSaving ? '저장 중' : editing ? '수정 저장' : '예약처 추가'}
        </button>
      </div>
    </form>
  );
}

type VesselUpload = {
  name: string;
  departurePort: string;
  address: string;
};

function normalizeCell(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function columnIndex(headers: string[], aliases: RegExp, fallback: number): number {
  const index = headers.findIndex((header) => aliases.test(header));
  return index >= 0 ? index : fallback;
}

function parseVesselRows(rows: unknown[][], fallbackPort: string): VesselUpload[] {
  const normalizedRows = rows.map((row) => row.map(normalizeCell)).filter((row) => row.some(Boolean));
  if (!normalizedRows.length) return [];
  const firstRow = normalizedRows[0];
  const hasHeader = firstRow.some((cell) => /선박|선명|배이름|vessel|boat|ship|출항|항구|주소|address/i.test(cell));
  const headers = hasHeader ? firstRow : [];
  const dataRows = hasHeader ? normalizedRows.slice(1) : normalizedRows;
  const nameIndex = columnIndex(headers, /선박|선명|배이름|vessel|boat|ship/i, 0);
  const portIndex = columnIndex(headers, /출항|항구|port|departure/i, 1);
  const addressIndex = columnIndex(headers, /주소|address|url|홈페이지/i, 2);
  const byName = new Map<string, VesselUpload>();
  for (const row of dataRows) {
    const name = normalizeCell(row[nameIndex]);
    if (!name || /^(선박|선박명|선명|배이름|vessel|boat|ship)$/i.test(name)) continue;
    byName.set(name, {
      name,
      departurePort: normalizeCell(row[portIndex]) || fallbackPort,
      address: normalizeCell(row[addressIndex]),
    });
  }
  return [...byName.values()];
}

async function parseVesselFile(file: File, fallbackPort: string): Promise<VesselUpload[]> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'txt' || extension === 'csv') {
    const text = await file.text();
    return parseVesselRows(text.split(/\r?\n/).map((line) => line.split(/[,\t;]/)), fallbackPort);
  }

  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
  if (!firstSheet) return [];
  return parseVesselRows(XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1, raw: false }), fallbackPort);
}

function downloadVesselTemplate() {
  const csv = '\uFEFF선박명,출항지,주소\n우리호,삼길포,https://example.com/reservation\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = '선박정보_업로드_양식.csv';
  link.click();
  URL.revokeObjectURL(url);
}

function VesselBulkImport({
  sources,
  selectedSourceId,
  onSourceChange,
  onChanged,
}: {
  sources: FishingSource[];
  selectedSourceId?: number;
  onSourceChange: (id: number) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState('');
  const addMutation = useAddFishingSourceVessels({
    mutation: {
      onSuccess: () => {
        setError('');
        onChanged();
      },
      onError: () => setError('선박 목록을 등록하지 못했습니다.'),
    },
  });
  const clearMutation = useClearFishingSourceVessels({
    mutation: {
      onSuccess: () => {
        setError('');
        onChanged();
      },
      onError: () => setError('선박 목록을 비우지 못했습니다.'),
    },
  });

  const source = sources.find((item) => item.id === selectedSourceId) ?? sources[0];

  async function handleFile(file: File | undefined) {
    if (!file) return;
    if (!source) {
      setError('먼저 업로드할 예약처를 선택해 주세요.');
      return;
    }
    setError('');
    try {
      const vessels = await parseVesselFile(file, source.port);
      if (vessels.length === 0) {
        setError('업로드 양식에서 선박명을 찾지 못했습니다.');
        return;
      }
      addMutation.mutate({ id: source.id, data: { vessels } });
    } catch {
      setError('Excel, CSV 또는 TXT 파일을 읽지 못했습니다.');
    }
  }

  return (
    <div className="mb-5 rounded-2xl border border-primary/20 bg-primary/[0.03] p-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold"><FileSpreadsheet size={16} className="text-primary" /> 선박 정보 일괄 업로드</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">예약처를 선택한 뒤 Excel, CSV 또는 TXT 파일을 업로드하세요.</p>
        </div>
        <button type="button" onClick={downloadVesselTemplate} className="text-left text-xs font-bold text-primary hover:underline">업로드 양식 다운로드</button>
      </div>
      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card text-xs">
        <div className="grid grid-cols-3 border-b border-border bg-muted/50 font-bold">
          <span className="px-3 py-2">선박명</span><span className="border-l border-border px-3 py-2">출항지</span><span className="border-l border-border px-3 py-2">주소</span>
        </div>
        <div className="grid grid-cols-3 text-muted-foreground">
          <span className="px-3 py-2">우리호</span><span className="border-l border-border px-3 py-2">삼길포</span><span className="truncate border-l border-border px-3 py-2">https://example.com</span>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,240px)_1fr]">
        <select
          value={source?.id ?? ''}
          onChange={(event) => onSourceChange(Number(event.target.value))}
          className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
          disabled={!sources.length}
        >
          {!sources.length && <option value="">등록된 예약처 없음</option>}
          {sources.map((item) => <option key={item.id} value={item.id}>{item.port} · {item.name}</option>)}
        </select>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2.5 text-xs font-bold text-primary-foreground transition hover:-translate-y-0.5">
          <Upload size={14} /> {addMutation.isPending ? '등록 중' : '파일 선택 및 업로드'}
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.txt,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="sr-only"
            disabled={!source || addMutation.isPending}
            onChange={(event) => {
              void handleFile(event.target.files?.[0]);
              event.currentTarget.value = '';
            }}
          />
        </label>
      </div>
      {source && source.vessels.length > 0 && (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>현재 등록된 선박 {source.vessels.length}척</span>
          <button type="button" onClick={() => clearMutation.mutate({ id: source.id })} disabled={clearMutation.isPending} className="font-semibold hover:text-destructive disabled:opacity-50">선택한 예약처 목록 비우기</button>
        </div>
      )}
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">첫 줄은 제목으로 인식합니다. 출항지를 비워두면 선택한 예약처의 항구를 사용합니다.</p>
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

function SourceCard({
  source,
  onEdit,
  onDelete,
}: {
  source: FishingSource;
  onEdit: (source: FishingSource) => void;
  onDelete: (source: FishingSource) => void;
}) {
  return (
    <article className={`rounded-2xl border bg-card p-4 transition ${source.enabled ? 'border-border' : 'border-dashed border-border/70 opacity-70'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold">{source.port}</h3>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold text-secondary-foreground">{source.region}</span>
            {source.enabled ? (
              <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary"><Check size={10} /> 사용 중</span>
            ) : (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">일시 중지</span>
            )}
          </div>
          <p className="mt-1 text-sm font-medium text-muted-foreground">{source.name}</p>
          <p className="mono mt-3 truncate text-[11px] text-muted-foreground">{source.sourceUrl}</p>
          {source.vessels.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-lg border border-border/70 text-[11px]">
              <div className="grid grid-cols-[1.1fr_0.9fr_1.4fr] border-b border-border/70 bg-muted/45 font-bold text-foreground">
                <span className="px-2 py-1.5">선박명</span>
                <span className="border-l border-border/70 px-2 py-1.5">출항지</span>
                <span className="border-l border-border/70 px-2 py-1.5">주소</span>
              </div>
              {source.vessels.map((vessel) => (
                <div key={vessel.id} className="grid grid-cols-[1.1fr_0.9fr_1.4fr] border-b border-border/50 last:border-0">
                  <span className="truncate px-2 py-1.5 font-medium">{vessel.name}</span>
                  <span className="truncate border-l border-border/70 px-2 py-1.5 text-muted-foreground">{vessel.departurePort || source.port}</span>
                  <span className="truncate border-l border-border/70 px-2 py-1.5 text-muted-foreground">{vessel.address || '-'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <button type="button" onClick={() => onEdit(source)} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`${source.port} 수정`}>
            <Pencil size={15} />
          </button>
          <button type="button" onClick={() => onDelete(source)} className="rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`${source.port} 삭제`}>
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </article>
  );
}

export default function SourceManager({ onBack }: { onBack: () => void }) {
  const queryClient = useQueryClient();
  const sourcesQuery = useListFishingSources();
  const [editing, setEditing] = useState<FishingSource | null>(null);
  const [form, setForm] = useState<FishingSourceInput>(blankForm);
  const [formError, setFormError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<number>();

  const refreshData = () => {
    queryClient.invalidateQueries({ queryKey: getListFishingSourcesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetFishingFilterOptionsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getSearchFishingSchedulesQueryKey() });
  };
  const createMutation = useCreateFishingSource({
    mutation: {
      onSuccess: () => {
        refreshData();
        closeForm();
      },
      onError: () => setFormError('예약처를 추가하지 못했습니다. URL이 이미 등록되어 있는지 확인해 주세요.'),
    },
  });
  const updateMutation = useUpdateFishingSource({
    mutation: {
      onSuccess: () => {
        refreshData();
        closeForm();
      },
      onError: () => setFormError('예약처를 수정하지 못했습니다. URL이 이미 등록되어 있는지 확인해 주세요.'),
    },
  });
  const deleteMutation = useDeleteFishingSource({
    mutation: {
      onSuccess: refreshData,
    },
  });

  function closeForm() {
    setEditing(null);
    setForm(blankForm);
    setFormError('');
    setShowForm(false);
  }
  function startCreate() {
    setEditing(null);
    setForm(blankForm);
    setFormError('');
    setShowForm(true);
  }
  function startEdit(source: FishingSource) {
    setEditing(source);
    setForm({
      name: source.name,
      region: source.region,
      port: source.port,
      sourceUrl: source.sourceUrl,
      enabled: source.enabled,
    });
    setFormError('');
    setShowForm(true);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');
    if (editing) {
      updateMutation.mutate({ id: editing.id, data: form });
    } else {
      createMutation.mutate({ data: form });
    }
  }
  function remove(source: FishingSource) {
    if (window.confirm(`"${source.port}" 예약처를 삭제할까요?`)) {
      deleteMutation.mutate({ id: source.id });
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const sources = sourcesQuery.data ?? [];

  return (
    <main className="mx-auto min-h-[calc(100dvh-72px)] max-w-[1080px] px-4 pb-12 pt-8 sm:px-6 lg:px-8">
      <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <button type="button" onClick={onBack} className="mb-4 flex items-center gap-1.5 text-xs font-bold text-primary hover:underline">
            <ArrowLeft size={14} /> 예약 조회로 돌아가기
          </button>
          <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-primary">Reservation sources</p>
          <h1 className="mt-1 font-serif text-3xl font-bold tracking-tight">출항 항구 관리</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            항구별 예약처를 등록하면 일정 검색과 출항 항구 필터에 자동으로 반영됩니다.
          </p>
        </div>
        {!showForm && (
          <button type="button" onClick={startCreate} className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground shadow-sm hover:-translate-y-0.5" data-testid="button-add-source">
            <Plus size={16} /> 항구 추가
          </button>
        )}
      </div>

      <VesselBulkImport
        sources={sources}
        selectedSourceId={selectedSourceId ?? sources[0]?.id}
        onSourceChange={setSelectedSourceId}
        onChanged={refreshData}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">등록된 예약처 <span className="ml-1 text-primary">{sources.length}</span></h2>
            {sourcesQuery.isLoading && <span className="text-xs text-muted-foreground">불러오는 중</span>}
          </div>
          {sourcesQuery.isError ? (
            <div className="rounded-2xl border border-destructive/25 bg-card p-6 text-sm text-destructive">예약처 목록을 불러오지 못했습니다.</div>
          ) : sources.length === 0 && !sourcesQuery.isLoading ? (
            <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center text-sm text-muted-foreground">등록된 예약처가 없습니다. 항구를 추가해 주세요.</div>
          ) : (
            <div className="space-y-3">
              {(sources ?? [])?.map((source) => (
                <SourceCard
                  key={source.id}
                  source={source}
                  onEdit={startEdit}
                  onDelete={remove}
                />
              ))}
            </div>
          )}
        </section>
        {showForm && (
          <SourceForm
            editing={editing}
            form={form}
            setForm={setForm}
            onSubmit={submit}
            onCancel={closeForm}
            isSaving={isSaving}
            error={formError}
          />
        )}
      </div>
    </main>
  );
}
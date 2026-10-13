import type { Filters, Overview, StudentDetail, UploadResult } from './types'

// Defaults to the Netlify Function served from the same origin; VITE_API_URL can point at an external API.
const API_BASE_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, init)
  } catch {
    throw new Error('Could not reach the analytics API. Check the backend status and CORS settings.')
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string; issues?: string[] }; detail?: string } | null
    const message = body?.error?.message ?? body?.detail ?? `Request failed (${response.status})`
    const issues = body?.error?.issues
    throw new Error(issues?.length ? `${message}: ${issues.join('; ')}` : message)
  }
  return response.json() as Promise<T>
}

function filterParams(filters: Filters, datasetId: string | null) {
  const params = new URLSearchParams()
  if (filters.department) params.set('department', filters.department)
  if (filters.year) params.set('year', filters.year)
  if (filters.risk) params.set('risk', filters.risk)
  if (filters.segment) params.set('segment', filters.segment)
  if (datasetId) params.set('dataset_id', datasetId)
  return params.toString()
}

function toReasons(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  return typeof value === 'string' && value ? value.split(/;\s*/).filter(Boolean) : []
}

function mapStudent(student: Record<string, unknown>) {
  return {
    ...student,
    student_id: String(student.student_id ?? ''),
    student_name: String(student.student_name ?? ''),
    department: String(student.department ?? ''),
    year: Number(student.year ?? 0),
    success_score: Number(student.success_score ?? 0),
    academic_index: Number(student.academic_index ?? 0),
    placement_index: Number(student.placement_index ?? 0),
    risk_level: String(student.risk_level ?? 'Low'),
    academic_risk: Boolean(student.academic_risk),
    placement_risk: Boolean(student.placement_risk),
    segment: String(student.segment ?? ''),
    academic_risk_reasons: toReasons(student.academic_risk_reasons),
    placement_risk_reasons: toReasons(student.placement_risk_reasons),
  }
}

export async function getOverview(filters: Filters, datasetId: string | null): Promise<Overview> {
  const query = filterParams(filters, datasetId)
  const [availableFilters, summary, trendData, roster] = await Promise.all([
    request<{ departments: string[]; years: number[]; risks: string[]; segments: string[] }>(
      `/filters${datasetId ? `?dataset_id=${encodeURIComponent(datasetId)}` : ''}`,
    ),
    request<Record<string, unknown>>(`/overview?${query}`),
    request<{ items: { month: string; attendance: number; lms_logins: number }[] }>(`/trends?${query}`),
    request<{ items: Record<string, unknown>[] }>(`/students?${query}${query ? '&' : ''}page_size=200`),
  ])

  const departmentStats = (summary.department_stats ?? []) as Overview['departments']
  const distribution = (summary.distribution ?? []) as Overview['distribution']
  return {
    filters: availableFilters,
    summary: {
      student_count: Number(summary.students ?? 0),
      avg_success_score: summary.average_success_score as number | null,
      high_risk_pct: summary.high_risk_rate == null ? null : Number(summary.high_risk_rate) * 100,
      academic_risk_pct: summary.academic_risk_rate == null ? null : Number(summary.academic_risk_rate) * 100,
      placement_risk_pct: summary.placement_risk_rate == null ? null : Number(summary.placement_risk_rate) * 100,
      segment_counts: (summary.segment_counts ?? {}) as Record<string, number>,
    },
    departments: departmentStats,
    trends: trendData.items ?? [],
    distribution,
    students: roster.items.map(mapStudent),
  }
}

export async function getStudent(studentId: string, datasetId: string | null): Promise<StudentDetail> {
  const query = datasetId ? `?dataset_id=${encodeURIComponent(datasetId)}` : ''
  const response = await request<Record<string, unknown>>(`/students/${encodeURIComponent(studentId)}${query}`)
  const student = response.student as Record<string, unknown>
  const risks = response.risks as {
    academic: { flagged: boolean; reasons: string }
    placement: { flagged: boolean; reasons: string }
  }
  const indicators = (response.indicators as Record<string, unknown>[]).map((indicator) => ({
    ...indicator,
    contribution: Number(indicator.score_contribution ?? 0),
    cohort_delta: Number(indicator.cohort_gap_points ?? 0),
  }))
  const topDrivers = [
    ...((response.top_drags as Record<string, unknown>[]) ?? []),
    ...((response.top_strengths as Record<string, unknown>[]) ?? []),
  ].map((driver) => ({ label: String(driver.label ?? ''), delta: Number(driver.cohort_gap_points ?? 0) }))
  const interventions = (response.suggested_interventions as Record<string, unknown>[]).map((item) => ({
    pillar: String(item.pillar ?? ''),
    action: String(item.action ?? ''),
  }))
  return {
    ...mapStudent({
      ...student,
      academic_risk: risks.academic.flagged,
      placement_risk: risks.placement.flagged,
      academic_risk_reasons: risks.academic.reasons,
      placement_risk_reasons: risks.placement.reasons,
    }),
    indicators: indicators as StudentDetail['indicators'],
    drivers: topDrivers,
    interventions,
  }
}

export async function uploadDataset(file: File): Promise<UploadResult> {
  const body = new FormData()
  body.append('file', file)
  const result = await request<{ dataset_id: string; rows: number; departments: string[]; years: number[] }>(
    '/datasets', { method: 'POST', body },
  )
  return {
    dataset_id: result.dataset_id,
    filename: file.name,
    student_count: result.rows,
    departments: result.departments,
    years: result.years,
  }
}

export function generateInterventionPlan(studentId: string, datasetId: string | null) {
  const query = datasetId ? `?dataset_id=${encodeURIComponent(datasetId)}` : ''
  return request<{ student_id: string; source: 'rules' | 'groq'; plan: string }>(
    `/students/${encodeURIComponent(studentId)}/intervention${query}`,
    { method: 'POST' },
  )
}
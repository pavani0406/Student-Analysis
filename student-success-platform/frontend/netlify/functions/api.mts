// Smart Campus Analytics API for Netlify. A TypeScript port of backend/main.py that keeps
// the same JSON contract. Uploaded CSV datasets are persisted in Netlify Blobs.
import { getStore } from '@netlify/blobs'
import type { Config } from '@netlify/functions'

type Indicator = [label: string, pillar: string, share: number, min: number, max: number, inverted: boolean]
type Row = Record<string, any>

const INDICATORS: Record<string, Indicator> = {
  cgpa: ['CGPA', 'Academic', 0.45, 0, 10, false],
  internal_marks: ['Internal marks %', 'Academic', 0.35, 0, 100, false],
  backlogs: ['Backlogs', 'Academic', 0.2, 0, 6, true],
  attendance: ['Attendance %', 'Attendance', 1.0, 0, 100, false],
  lms_logins_per_week: ['LMS logins / week', 'LMS', 0.4, 0, 15, false],
  assignment_completion: ['Assignment completion %', 'LMS', 0.6, 0, 100, false],
  events: ['Events attended', 'Engagement', 0.25, 0, 12, false],
  clubs: ['Clubs joined', 'Engagement', 0.15, 0, 4, false],
  hackathons: ['Hackathons', 'Engagement', 0.3, 0, 5, false],
  certifications: ['Certifications', 'Engagement', 0.3, 0, 8, false],
  aptitude: ['Aptitude score', 'Placement', 0.3, 0, 100, false],
  coding: ['Coding score', 'Placement', 0.4, 0, 100, false],
  mock_interview: ['Mock interview score', 'Placement', 0.3, 0, 100, false],
  tech_skill: ['Technical skill', 'Skills', 0.6, 0, 100, false],
  soft_skill: ['Soft skill', 'Skills', 0.4, 0, 100, false],
  student_satisfaction: ['Student satisfaction (1-5)', 'Feedback', 0.5, 1, 5, false],
  faculty_feedback: ['Faculty feedback (1-5)', 'Feedback', 0.5, 1, 5, false],
}
const INDICATOR_KEYS = Object.keys(INDICATORS)
const PILLARS = ['Academic', 'Attendance', 'LMS', 'Engagement', 'Placement', 'Skills', 'Feedback']
const DEFAULT_WEIGHTS: Record<string, number> = {
  Academic: 30, Attendance: 15, LMS: 12, Engagement: 8, Placement: 22, Skills: 8, Feedback: 5,
}
const WEIGHT_TOTAL = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)
const SEGMENT_ACTIONS: Record<string, string> = {
  'Star Performers': 'Stretch projects, advanced recruiter exposure, and peer-mentor roles.',
  'Academic Strong, Placement Gap': 'Coding bootcamp, aptitude drills, and mock interviews.',
  'Practical Achievers': 'Academic tutoring and a backlog plan that build on practical strengths.',
  'Needs Holistic Support': 'Assign a mentor and coordinate attendance, academic, and skills support.',
}
const PILLAR_ACTIONS: Record<string, string> = {
  Academic: 'Remedial classes or peer tutoring and a backlog-clearing plan.',
  Attendance: 'Mentor meeting and attendance recovery plan; alert guardian if below 65%.',
  LMS: 'Nudge on pending assignments, LMS onboarding, and weekly check-ins.',
  Engagement: 'Invite to a club, hackathon team, or technical event.',
  Placement: 'Coding and aptitude drills, mock interviews, and placement-cell mentoring.',
  Skills: 'Skill certification track and communication workshop.',
  Feedback: 'Counselling check-in and qualitative feedback on teaching and campus life.',
}
const REQUIRED_COLUMNS = ['student_id', 'department', 'year', ...INDICATOR_KEYS]
const NUMERIC_COLUMNS = ['year', ...INDICATOR_KEYS]
const WHOLE_NUMBER_COLUMNS = new Set(['backlogs', 'lms_logins_per_week', 'events', 'clubs', 'hackathons', 'certifications'])
const SYNTHETIC_DATASET_ID = 'synthetic'
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const MAX_UPLOAD_ROWS = 10_000

interface Dataset {
  scored: Row[]
  gaps: Record<string, number>[]
  pillars: Record<string, number>[]
  trends: { student_id: string; month: string; attendance: number; lms_logins: number }[] | null
}

class HttpError extends Error {
  constructor(public status: number, message: string, public issues?: string[]) {
    super(message)
  }
}

const round = (value: number, digits = 0) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const clip = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value))
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function makeRng(seed: number) {
  let state = seed >>> 0
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const normal = (mu = 0, sigma = 1) => {
    const u = 1 - uniform()
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform())
  }
  const poisson = (lambda: number) => {
    const limit = Math.exp(-lambda)
    let k = 0
    let p = uniform()
    while (p > limit) {
      k += 1
      p *= uniform()
    }
    return k
  }
  const choice = <T,>(items: T[], weights?: number[]) => {
    const w = weights ?? items.map(() => 1 / items.length)
    let r = uniform()
    for (let i = 0; i < items.length; i += 1) {
      r -= w[i]
      if (r < 0) return items[i]
    }
    return items[items.length - 1]
  }
  return { normal, poisson, choice }
}

function makeSyntheticData(count = 600, seed = 7) {
  const rng = makeRng(seed)
  const raw: Row[] = []
  const slopes: number[] = []
  for (let i = 1; i <= count; i += 1) {
    const ability = rng.normal()
    const engagement = rng.normal()
    const preparation = 0.25 * ability + rng.normal()
    const n = (scale = 1) => rng.normal(0, scale)
    const id = String(i).padStart(4, '0')
    raw.push({
      student_id: `S${id}`,
      student_name: `Student ${id}`,
      department: rng.choice(['CSE', 'ECE', 'EEE', 'MECH', 'CIVIL', 'IT'], [0.28, 0.17, 0.12, 0.13, 0.12, 0.18]),
      year: rng.choice([1, 2, 3, 4]),
      cgpa: round(clip(6.8 + 0.9 * ability + 0.3 * engagement + n(0.4), 4, 10), 2),
      internal_marks: round(clip(62 + 10 * ability + 3 * engagement + n(6), 20, 100), 2),
      backlogs: clip(rng.poisson(Math.max(0.05, 1.1 - 0.8 * ability)), 0, 6),
      attendance: round(clip(78 + 8 * engagement + 3 * ability + n(7), 40, 100), 2),
      lms_logins_per_week: clip(rng.poisson(Math.max(0.5, 5 + 3 * engagement)), 0, 15),
      assignment_completion: round(clip(70 + 14 * engagement + 4 * ability + n(10), 0, 100), 2),
      events: clip(rng.poisson(Math.max(0.2, 3 + 2 * engagement)), 0, 12),
      clubs: clip(rng.poisson(Math.max(0.1, 1 + 0.5 * engagement)), 0, 4),
      hackathons: clip(rng.poisson(Math.max(0.1, 1 + 0.8 * engagement + 0.3 * preparation)), 0, 5),
      certifications: clip(rng.poisson(Math.max(0.1, 2 + 1.2 * preparation + 0.3 * engagement)), 0, 8),
      aptitude: round(clip(55 + 8 * ability + 12 * preparation + n(8), 10, 100), 2),
      coding: round(clip(48 + 5 * ability + 16 * preparation + n(9), 5, 100), 2),
      mock_interview: round(clip(52 + 4 * ability + 10 * preparation + 4 * engagement + n(8), 10, 100), 2),
      tech_skill: round(clip(55 + 5 * ability + 14 * preparation + n(8), 10, 100), 2),
      soft_skill: round(clip(58 + 8 * engagement + 6 * preparation + n(8), 10, 100), 2),
      student_satisfaction: round(clip(3.5 + 0.4 * engagement + n(0.5), 1, 5), 2),
      faculty_feedback: round(clip(3.4 + 0.4 * ability + 0.3 * engagement + n(0.5), 1, 5), 2),
    })
    slopes.push(rng.normal(0.4 * engagement, 1.4))
  }

  const months = ['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov']
  const trends: NonNullable<Dataset['trends']> = []
  months.forEach((month, monthIndex) => {
    raw.forEach((student, i) => {
      const offset = slopes[i] * (monthIndex - 2.5)
      trends.push({
        student_id: student.student_id,
        month,
        attendance: clip(student.attendance + offset + rng.normal(0, 2), 30, 100),
        lms_logins: clip(student.lms_logins_per_week + 0.3 * offset + rng.normal(0, 1), 0, 20),
      })
    })
  })
  return { raw, trends }
}

function scoreData(raw: Row[], trends: Dataset['trends'] = null): Dataset {
  const weights = Object.fromEntries(PILLARS.map((p) => [p, DEFAULT_WEIGHTS[p] / WEIGHT_TOTAL]))
  const pillars: Record<string, number>[] = []
  const gaps: Record<string, number>[] = []
  const indexScore = (pillar: Record<string, number>, names: string[]) => {
    const total = names.reduce((sum, name) => sum + weights[name], 0)
    return names.reduce((sum, name) => sum + pillar[name] * weights[name], 0) / Math.max(total, 1e-9)
  }

  const scored = raw.map((student) => {
    const normalized: Record<string, number> = {}
    for (const [key, [, , , lower, upper, inverted]] of Object.entries(INDICATORS)) {
      const value = clip((student[key] - lower) / (upper - lower), 0, 1)
      normalized[key] = inverted ? 1 - value : value
    }
    const pillar: Record<string, number> = {}
    for (const name of PILLARS) {
      pillar[name] = INDICATOR_KEYS.filter((key) => INDICATORS[key][1] === name)
        .reduce((sum, key) => sum + INDICATORS[key][2] * normalized[key], 0) * 100
    }
    const gap: Record<string, number> = {}
    for (const key of INDICATOR_KEYS) {
      gap[key] = normalized[key] * INDICATORS[key][2] * weights[INDICATORS[key][1]] * 100
    }
    pillars.push(pillar)
    gaps.push(gap)

    const row: Row = { ...student }
    row.success_score = round(PILLARS.reduce((sum, name) => sum + pillar[name] * weights[name], 0), 1)
    row.academic_index = round(indexScore(pillar, ['Academic', 'Attendance', 'LMS']), 1)
    row.placement_index = round(indexScore(pillar, ['Placement', 'Skills', 'Engagement']), 1)
    for (const name of PILLARS) row[`P_${name}`] = round(pillar[name], 1)

    const academic: string[] = []
    const placement: string[] = []
    if (row.attendance < 70) academic.push(`attendance ${row.attendance.toFixed(0)}%`)
    if (row.cgpa < 5.5) academic.push(`CGPA ${row.cgpa.toFixed(1)}`)
    if (row.backlogs >= 3) academic.push(`${Math.trunc(row.backlogs)} backlogs`)
    if (row.assignment_completion < 45) academic.push(`assignments ${row.assignment_completion.toFixed(0)}%`)
    if (row.academic_index < 45) academic.push(`academic index ${row.academic_index.toFixed(0)}`)
    if (row.placement_index < 35) placement.push(`placement index ${row.placement_index.toFixed(0)}`)
    if (row.coding < 30) placement.push(`coding ${row.coding.toFixed(0)}`)
    if (row.aptitude < 35) placement.push(`aptitude ${row.aptitude.toFixed(0)}`)
    if (row.mock_interview < 35) placement.push(`mock interview ${row.mock_interview.toFixed(0)}`)
    row.academic_risk_reasons = academic.join('; ')
    row.placement_risk_reasons = placement.join('; ')
    row.academic_risk = academic.length > 0
    row.placement_risk = placement.length > 0
    row.risk_level = (row.academic_risk && row.placement_risk) || row.success_score < 40
      ? 'High'
      : row.academic_risk || row.placement_risk ? 'Medium' : 'Low'
    return row
  })

  const academicCut = median(scored.map((row) => row.academic_index))
  const placementCut = median(scored.map((row) => row.placement_index))
  for (const row of scored) {
    const highAcademic = row.academic_index >= academicCut
    const highPlacement = row.placement_index >= placementCut
    row.segment = highAcademic && highPlacement
      ? 'Star Performers'
      : highAcademic ? 'Academic Strong, Placement Gap'
      : highPlacement ? 'Practical Achievers' : 'Needs Holistic Support'
  }
  return { scored, gaps, pillars, trends }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (quoted) throw new Error('Unterminated quoted field')
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((value) => value.trim() !== ''))
}

function validateUpload(text: string): Row[] {
  let table: string[][]
  try {
    table = parseCsv(text.replace(/^﻿/, ''))
  } catch (error) {
    throw new HttpError(422, 'CSV could not be parsed', [String((error as Error).message)])
  }
  if (!table.length) throw new HttpError(422, 'CSV could not be parsed', ['No columns to parse from file'])
  const header = table[0].map((column) => column.trim())
  const records = table.slice(1)
  if (!records.length) throw new HttpError(422, 'CSV has no student rows', [])
  if (records.length > MAX_UPLOAD_ROWS) throw new HttpError(422, `CSV exceeds the ${MAX_UPLOAD_ROWS}-row limit`, [])

  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column))
  if (missing.length) {
    throw new HttpError(422, 'CSV is missing required columns', missing.map((c) => `Missing required column: ${c}`))
  }

  const raw: Row[] = records.map((record) => Object.fromEntries(header.map((column, i) => [column, record[i] ?? ''])))
  const issues: string[] = []
  const ids = raw.map((row) => String(row.student_id).trim())
  if (ids.some((id) => id === '')) issues.push('student_id must be present and non-empty for every row')
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  ids.forEach((id) => (id && seen.has(id) ? duplicates.add(id) : seen.add(id)))
  if (duplicates.size) {
    issues.push(`student_id values must be unique; duplicates: ${[...duplicates].slice(0, 10).join(', ')}`)
  }
  if (raw.some((row) => String(row.department).trim() === '')) {
    issues.push('department must be present and non-empty for every row')
  }

  const parsed: Record<string, number[]> = {}
  for (const column of NUMERIC_COLUMNS) {
    const values = raw.map((row) => (String(row[column]).trim() === '' ? NaN : Number(row[column])))
    const invalidRows = values.flatMap((value, i) => (Number.isFinite(value) ? [] : [i + 2]))
    if (invalidRows.length) {
      issues.push(`${column} must contain finite numeric values (rows: ${invalidRows.slice(0, 10).join(', ')})`)
      continue
    }
    parsed[column] = values
    if (column === 'year') {
      if (values.some((v) => v < 1 || v > 4 || v % 1 !== 0)) issues.push('year must be a whole number from 1 to 4')
    } else {
      const [, , , minimum, maximum] = INDICATORS[column]
      if (values.some((v) => v < minimum || v > maximum)) issues.push(`${column} must be between ${minimum} and ${maximum}`)
      if (WHOLE_NUMBER_COLUMNS.has(column) && values.some((v) => v % 1 !== 0)) {
        issues.push(`${column} must contain whole numbers`)
      }
    }
  }
  if (issues.length) throw new HttpError(422, 'CSV validation failed', issues)

  return raw.map((row, i) => {
    const clean: Row = {
      student_id: ids[i],
      student_name: String(row.student_name ?? '').trim(),
      department: String(row.department).trim(),
    }
    for (const column of NUMERIC_COLUMNS) clean[column] = parsed[column][i]
    return clean
  })
}

let synthetic: Dataset | null = null
const uploadedCache = new Map<string, Dataset>()

async function getDataset(datasetId: string | null): Promise<Dataset> {
  const key = datasetId || SYNTHETIC_DATASET_ID
  if (key === SYNTHETIC_DATASET_ID) {
    if (!synthetic) {
      const { raw, trends } = makeSyntheticData()
      synthetic = scoreData(raw, trends)
    }
    return synthetic
  }
  const cached = uploadedCache.get(key)
  if (cached) return cached
  const raw = await getStore('datasets').get(key, { type: 'json' }) as Row[] | null
  if (!raw) throw new HttpError(404, `Unknown dataset_id: ${key}`)
  const dataset = scoreData(raw)
  uploadedCache.set(key, dataset)
  return dataset
}

interface Filters {
  department: string[]
  year: number[]
  risk: string[]
  segment: string[]
}

function readFilters(params: URLSearchParams): Filters {
  const year = params.getAll('year').map((value) => {
    const parsed = Number(value)
    if (!Number.isInteger(parsed)) throw new HttpError(422, 'Request validation failed', [`year must be an integer: ${value}`])
    return parsed
  })
  return { department: params.getAll('department'), year, risk: params.getAll('risk'), segment: params.getAll('segment') }
}

function filteredData(dataset: Dataset, filters: Filters, ignoreSegment = false): Row[] {
  const invalidRisks = filters.risk.filter((risk) => !['High', 'Medium', 'Low'].includes(risk))
  if (invalidRisks.length) throw new HttpError(422, `Unsupported risk level(s): ${[...new Set(invalidRisks)].sort().join(', ')}`)
  const invalidSegments = filters.segment.filter((segment) => !(segment in SEGMENT_ACTIONS))
  if (invalidSegments.length) throw new HttpError(422, `Unsupported segment(s): ${[...new Set(invalidSegments)].sort().join(', ')}`)
  return dataset.scored.filter((row) =>
    (!filters.department.length || filters.department.includes(row.department)) &&
    (!filters.year.length || filters.year.includes(row.year)) &&
    (!filters.risk.length || filters.risk.includes(row.risk_level)) &&
    (ignoreSegment || !filters.segment.length || filters.segment.includes(row.segment)),
  )
}

function getFilters(dataset: Dataset, datasetId: string | null) {
  return {
    dataset_id: datasetId || SYNTHETIC_DATASET_ID,
    departments: [...new Set(dataset.scored.map((row) => row.department as string))].sort(),
    years: [...new Set(dataset.scored.map((row) => row.year as number))].sort((a, b) => a - b),
    risks: ['High', 'Medium', 'Low'],
    segments: Object.keys(SEGMENT_ACTIONS),
  }
}

function overview(dataset: Dataset, datasetId: string | null, filters: Filters) {
  const selected = filteredData(dataset, filters)
  const count = selected.length
  const rate = (predicate: (row: Row) => boolean) => (count ? round(selected.filter(predicate).length / count, 4) : null)
  const withoutSegment = filteredData(dataset, filters, true)
  const byDepartment = new Map<string, Row[]>()
  for (const row of selected) byDepartment.set(row.department, [...(byDepartment.get(row.department) ?? []), row])
  const departments = [...byDepartment.keys()].sort()
  const buckets: [string, number, number][] = [['0-19', 0, 20], ['20-39', 20, 40], ['40-59', 40, 60], ['60-79', 60, 80], ['80-100', 80, 100]]
  return {
    dataset_id: datasetId || SYNTHETIC_DATASET_ID,
    filters,
    students: count,
    average_success_score: count ? round(mean(selected.map((row) => row.success_score)), 1) : null,
    high_risk_rate: rate((row) => row.risk_level === 'High'),
    academic_risk_rate: rate((row) => row.academic_risk),
    placement_risk_rate: rate((row) => row.placement_risk),
    risk_counts: Object.fromEntries(['High', 'Medium', 'Low'].map((level) => [level, selected.filter((row) => row.risk_level === level).length])),
    segment_counts: Object.fromEntries(Object.keys(SEGMENT_ACTIONS).map((name) => [name, withoutSegment.filter((row) => row.segment === name).length])),
    department_counts: Object.fromEntries(departments.map((name) => [name, byDepartment.get(name)!.length])),
    department_stats: departments.map((name) => {
      const group = byDepartment.get(name)!
      return {
        name,
        students: group.length,
        avg_success_score: round(mean(group.map((row) => row.success_score)), 1),
        high_risk_count: group.filter((row) => row.risk_level === 'High').length,
      }
    }),
    distribution: buckets.map(([bucket, lower, upper]) => ({
      bucket,
      count: selected.filter((row) => row.success_score >= lower && (upper === 100 ? row.success_score <= upper : row.success_score < upper)).length,
    })),
    average_pillars: Object.fromEntries(PILLARS.map((pillar) => [pillar, count ? round(mean(selected.map((row) => row[`P_${pillar}`])), 1) : null])),
  }
}

function trends(dataset: Dataset, datasetId: string | null, filters: Filters) {
  const selected = filteredData(dataset, filters)
  if (!dataset.trends) {
    return {
      dataset_id: datasetId || SYNTHETIC_DATASET_ID,
      available: false,
      message: 'Uploaded CSV files do not contain monthly history; trends are available for synthetic data only.',
      items: [],
    }
  }
  const ids = new Set(selected.map((row) => row.student_id))
  const grouped = new Map<string, { attendance: number[]; lms_logins: number[] }>()
  for (const point of dataset.trends) {
    if (!ids.has(point.student_id)) continue
    const entry = grouped.get(point.month) ?? { attendance: [], lms_logins: [] }
    entry.attendance.push(point.attendance)
    entry.lms_logins.push(point.lms_logins)
    grouped.set(point.month, entry)
  }
  return {
    dataset_id: datasetId || SYNTHETIC_DATASET_ID,
    available: true,
    items: [...grouped].map(([month, values]) => ({
      month,
      attendance: round(mean(values.attendance), 1),
      lms_logins: round(mean(values.lms_logins), 1),
    })),
  }
}

function listStudents(dataset: Dataset, datasetId: string | null, params: URLSearchParams) {
  let selected = filteredData(dataset, readFilters(params))
  const page = Number(params.get('page') ?? 1)
  const pageSize = Number(params.get('page_size') ?? 50)
  if (!Number.isInteger(page) || page < 1) throw new HttpError(422, 'Request validation failed', ['page must be an integer >= 1'])
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new HttpError(422, 'Request validation failed', ['page_size must be an integer from 1 to 200'])
  }
  const needle = params.get('q')?.trim().toLowerCase()
  if (needle) {
    selected = selected.filter((row) =>
      [row.student_id, row.student_name, row.department].some((value) => String(value).toLowerCase().includes(needle)))
  }
  selected = [...selected].sort((a, b) => a.success_score - b.success_score || String(a.student_id).localeCompare(String(b.student_id)))
  const fields = [
    'student_id', 'student_name', 'department', 'year', 'success_score', 'academic_index',
    'placement_index', 'risk_level', 'academic_risk', 'placement_risk', 'segment',
    'academic_risk_reasons', 'placement_risk_reasons',
  ]
  const start = (page - 1) * pageSize
  return {
    dataset_id: datasetId || SYNTHETIC_DATASET_ID,
    items: selected.slice(start, start + pageSize).map((row) => Object.fromEntries(fields.map((field) => [field, row[field]]))),
    total: selected.length,
    page,
    page_size: pageSize,
  }
}

function studentProfile(dataset: Dataset, studentId: string) {
  const index = dataset.scored.findIndex((row) => String(row.student_id) === studentId)
  if (index < 0) throw new HttpError(404, `Student not found: ${studentId}`)
  const row = dataset.scored[index]
  const cohort = dataset.scored
  const indicators = Object.entries(INDICATORS).map(([key, [label, pillar, share, minimum, maximum, inverted]]) => {
    let normValue = (Number(row[key]) - minimum) / (maximum - minimum)
    if (inverted) normValue = 1 - normValue
    const contribution = dataset.gaps[index][key]
    const cohortAverage = mean(dataset.gaps.map((gap) => gap[key]))
    return {
      key,
      label,
      pillar,
      value: row[key],
      normalized: round(clip(normValue, 0, 1), 4),
      effective_weight_percent: round((share * DEFAULT_WEIGHTS[pillar]) / WEIGHT_TOTAL * 100, 3),
      score_contribution: round(contribution, 3),
      cohort_average_contribution: round(cohortAverage, 3),
      cohort_gap_points: round(contribution - cohortAverage, 3),
    }
  })
  const pillarDetails = PILLARS.map((pillar) => {
    const contribution = (dataset.pillars[index][pillar] * DEFAULT_WEIGHTS[pillar]) / 100
    const cohortPillar = mean(cohort.map((student) => student[`P_${pillar}`]))
    return {
      name: pillar,
      score: row[`P_${pillar}`],
      cohort_average: round(cohortPillar, 1),
      cohort_gap_points: round(contribution - (cohortPillar * DEFAULT_WEIGHTS[pillar]) / 100, 3),
      suggested_intervention: PILLAR_ACTIONS[pillar],
    }
  })
  const weakest = [...pillarDetails].sort((a, b) => a.cohort_gap_points - b.cohort_gap_points).slice(0, 2)
  const reasons: { type: string; text: string }[] = []
  if (row.academic_risk_reasons) reasons.push({ type: 'academic', text: row.academic_risk_reasons })
  if (row.placement_risk_reasons) reasons.push({ type: 'placement', text: row.placement_risk_reasons })
  if (!reasons.length && row.success_score < 40) reasons.push({ type: 'score', text: 'Success Score is below 40.' })
  const sortedIndicators = [...indicators].sort((a, b) => a.cohort_gap_points - b.cohort_gap_points)
  const actions: { pillar: string; cohort_gap_points: number | null; action: string }[] = weakest.map((item) => ({
    pillar: item.name,
    cohort_gap_points: item.cohort_gap_points,
    action: item.suggested_intervention,
  }))
  actions.push({ pillar: 'Segment', cohort_gap_points: null, action: SEGMENT_ACTIONS[row.segment] })
  const cohortScore = mean(cohort.map((student) => student.success_score))
  const studentKeys = ['student_id', 'student_name', 'department', 'year', 'success_score', 'academic_index', 'placement_index', 'risk_level', 'segment']
  return {
    student: Object.fromEntries(studentKeys.map((key) => [key, row[key]])),
    score: {
      value: row.success_score,
      scale: [0, 100],
      cohort_average: round(cohortScore, 1),
      cohort_gap_points: round(row.success_score - cohortScore, 1),
      formula: 'Normalized indicators are share-weighted within pillars; pillar scores use weights 30/15/12/8/22/8/5. Backlogs are inverted.',
    },
    risks: {
      level: row.risk_level,
      academic: { flagged: row.academic_risk, reasons: row.academic_risk_reasons },
      placement: { flagged: row.placement_risk, reasons: row.placement_risk_reasons },
      reasons,
    },
    cohort_cuts: {
      academic_index_median: round(median(cohort.map((student) => student.academic_index)), 1),
      placement_index_median: round(median(cohort.map((student) => student.placement_index)), 1),
    },
    pillars: pillarDetails,
    indicators,
    top_drags: sortedIndicators.slice(0, 5),
    top_strengths: sortedIndicators.slice(-5).reverse(),
    suggested_interventions: actions,
  }
}

function ruleBasedPlan(profile: ReturnType<typeof studentProfile>) {
  const { student, risks, suggested_interventions: actions } = profile
  const causes = risks.reasons.map((reason) => reason.text)
  return [
    `${student.student_id} has a Success Score of ${Number(student.success_score).toFixed(1)}/100 (${student.risk_level} risk).`,
    'Reasons: ' + (causes.length ? causes : ['No threshold-based risk flag is active.']).join('; '),
    'Next steps: ' + actions.slice(0, 2).map((item) => item.action).join(' '),
    'Segment action: ' + actions[actions.length - 1].action,
  ].join('\n')
}

async function intervention(dataset: Dataset, studentId: string) {
  const fallback = ruleBasedPlan(studentProfile(dataset, studentId))
  const apiKey = (Netlify.env.get('GROQ_API_KEY') ?? '').trim()
  if (!apiKey) return { student_id: studentId, source: 'rules', plan: fallback }
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: Netlify.env.get('GROQ_MODEL') || 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'Write a concise, kind, practical student intervention plan using only the supplied score and risk facts. Do not diagnose or invent circumstances.',
          },
          { role: 'user', content: fallback },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
    })
    if (!response.ok) throw new Error(`Groq request failed (${response.status})`)
    const body = await response.json() as { choices?: { message?: { content?: string } }[] }
    const plan = body.choices?.[0]?.message?.content?.trim()
    return { student_id: studentId, source: 'groq', plan: plan || fallback }
  } catch {
    return { student_id: studentId, source: 'rules', plan: fallback }
  }
}

async function uploadDataset(req: Request) {
  const form = await req.formData().catch(() => {
    throw new HttpError(422, 'Request validation failed', ['Expected multipart form data with a "file" field'])
  })
  const file = form.get('file')
  if (!file || typeof file === 'string') throw new HttpError(422, 'Request validation failed', ['file is required'])
  if (!file.name || !file.name.toLowerCase().endsWith('.csv')) throw new HttpError(415, 'Upload a .csv file')
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `CSV exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB upload limit`)
  }
  const raw = validateUpload(await file.text())
  const datasetId = crypto.randomUUID()
  await getStore('datasets').setJSON(datasetId, raw)
  uploadedCache.set(datasetId, scoreData(raw))
  return {
    dataset_id: datasetId,
    rows: raw.length,
    departments: [...new Set(raw.map((row) => row.department as string))].sort(),
    years: [...new Set(raw.map((row) => row.year as number))].sort((a, b) => a - b),
    trends_available: false,
  }
}

async function route(req: Request): Promise<unknown> {
  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/'
  const params = url.searchParams
  const datasetId = params.get('dataset_id')
  const method = req.method.toUpperCase()

  if (method === 'GET' && path === '/health') return { status: 'ok', service: 'smart-campus-analytics-api' }
  if (method === 'POST' && path === '/datasets') return uploadDataset(req)

  const studentMatch = path.match(/^\/students\/([^/]+)(\/intervention)?$/)
  if (method === 'GET' && path === '/filters') return getFilters(await getDataset(datasetId), datasetId)
  if (method === 'GET' && path === '/overview') return overview(await getDataset(datasetId), datasetId, readFilters(params))
  if (method === 'GET' && path === '/trends') return trends(await getDataset(datasetId), datasetId, readFilters(params))
  if (method === 'GET' && path === '/students') return listStudents(await getDataset(datasetId), datasetId, params)
  if (studentMatch) {
    const studentId = decodeURIComponent(studentMatch[1])
    if (method === 'GET' && !studentMatch[2]) {
      return { dataset_id: datasetId || SYNTHETIC_DATASET_ID, ...studentProfile(await getDataset(datasetId), studentId) }
    }
    if (method === 'POST' && studentMatch[2]) return intervention(await getDataset(datasetId), studentId)
  }
  throw new HttpError(404, 'Not Found')
}

export default async (req: Request) => {
  try {
    return Response.json(await route(req))
  } catch (error) {
    if (error instanceof HttpError) {
      const body: Record<string, unknown> = { code: 'request_error', message: error.message }
      if (error.issues) body.issues = error.issues
      return Response.json({ error: body }, { status: error.status })
    }
    console.error('Unhandled API error', error)
    return Response.json({ error: { code: 'internal_error', message: 'An unexpected error occurred' } }, { status: 500 })
  }
}

export const config: Config = {
  path: '/api/*',
}

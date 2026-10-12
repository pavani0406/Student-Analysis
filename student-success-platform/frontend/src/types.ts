export type RiskLevel = 'High' | 'Medium' | 'Low' | string

export interface Student {
  student_id: string
  student_name: string
  department: string
  year: string | number
  success_score: number
  academic_index: number
  placement_index: number
  risk_level: RiskLevel
  academic_risk: boolean
  placement_risk: boolean
  segment: string
  academic_risk_reasons: string[]
  placement_risk_reasons: string[]
}

export interface Overview {
  filters: {
    departments: string[]
    years: (string | number)[]
    risks: string[]
    segments: string[]
  }
  summary: {
    student_count: number
    avg_success_score: number | null
    high_risk_pct: number | null
    academic_risk_pct: number | null
    placement_risk_pct: number | null
    segment_counts: Record<string, number>
  }
  departments: {
    name: string
    students: number
    avg_success_score: number
    high_risk_count: number
  }[]
  trends: { month: string; attendance: number; lms_logins: number }[]
  distribution: { bucket: string; count: number }[]
  students: Student[]
}

export interface StudentDetail extends Student {
  indicators: {
    key: string
    label: string
    value: number | string
    contribution: number
    cohort_delta: number
    pillar: string
  }[]
  drivers: { label: string; delta: number }[]
  interventions: { pillar: string; action: string }[]
}

export interface UploadResult {
  dataset_id: string
  filename: string
  student_count: number
  departments: string[]
  years: (string | number)[]
}

export interface Filters {
  department: string
  year: string
  risk: string
  segment: string
}
import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  GraduationCap,
  HeartPulse,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Users,
  X,
} from 'lucide-react'
import {
  CartesianGrid,
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { generateInterventionPlan, getOverview, getStudent, uploadDataset } from './api'
import type { Filters, Overview, Student, StudentDetail, UploadResult } from './types'

const EMPTY_FILTERS: Filters = { department: '', year: '', risk: '', segment: '' }
const chartColors = ['#337763', '#dc8057', '#75958a', '#d6ad58', '#a3b9af', '#bb6847']
const SEGMENTS = [
  { name: 'Star Performers', description: 'Strong academics and placement readiness' },
  { name: 'Academic Strong, Placement Gap', description: 'Strong academics; placement preparation needed' },
  { name: 'Practical Achievers', description: 'Placement-ready; academic recovery needed' },
  { name: 'Needs Holistic Support', description: 'Coordinated academic and placement support' },
]

function number(value: number | null | undefined, digits = 0) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '—'
}

function percent(value: number | null | undefined) {
  return `${number(value)}%`
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
}

function riskClass(risk: string) {
  return `risk-${risk.toLowerCase().replace(/[^a-z]+/g, '-')}`
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="state-panel error-state" role="alert">
      <AlertCircle size={19} aria-hidden="true" />
      <div><strong>Analytics unavailable</strong><p>{message}</p></div>
      <button className="icon-button" onClick={onRetry} aria-label="Retry loading analytics" title="Retry">
        <RefreshCw size={16} />
      </button>
    </div>
  )
}

function App() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewError, setOverviewError] = useState('')
  const [datasetId, setDatasetId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<StudentDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [interventionPlan, setInterventionPlan] = useState<{ source: 'rules' | 'groq'; plan: string } | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploadNotice, setUploadNotice] = useState<UploadResult | null>(null)
  const [search, setSearch] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const [detailRefreshToken, setDetailRefreshToken] = useState(0)

  useEffect(() => {
    let active = true
    setOverviewLoading(true)
    setOverviewError('')
    getOverview(filters, datasetId)
      .then((result) => {
        if (!active) return
        setOverview(result)
        setSelectedId((current) => result.students.some((student) => student.student_id === current)
          ? current
          : result.students[0]?.student_id ?? '')
      })
      .catch((error: unknown) => {
        if (active) setOverviewError(error instanceof Error ? error.message : 'Unexpected API response.')
      })
      .finally(() => { if (active) setOverviewLoading(false) })
    return () => { active = false }
  }, [filters, datasetId, refreshToken])

  useEffect(() => {
    setInterventionPlan(null)
    setPlanError('')
    if (!selectedId) {
      setDetail(null)
      setDetailError('')
      setDetailLoading(false)
      return
    }
    let active = true
    setDetailLoading(true)
    setDetailError('')
    getStudent(selectedId, datasetId)
      .then((result) => { if (active) setDetail(result) })
      .catch((error: unknown) => {
        if (active) setDetailError(error instanceof Error ? error.message : 'Could not load this profile.')
      })
      .finally(() => { if (active) setDetailLoading(false) })
    return () => { active = false }
  }, [selectedId, datasetId, detailRefreshToken])

  const visibleStudents = useMemo(() => {
    const students = overview?.students ?? []
    const query = search.trim().toLowerCase()
    return [...students]
      .filter((student) => !query || `${student.student_name} ${student.student_id} ${student.department}`.toLowerCase().includes(query))
      .sort((left, right) => riskOrder(left.risk_level) - riskOrder(right.risk_level) || left.success_score - right.success_score)
  }, [overview, search])

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setUploading(true)
    setUploadError('')
    setUploadNotice(null)
    try {
      const result = await uploadDataset(file)
      setDatasetId(result.dataset_id)
      setFilters(EMPTY_FILTERS)
      setSearch('')
      setUploadNotice(result)
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  async function handleGeneratePlan() {
    if (!selectedId) return
    setPlanLoading(true)
    setPlanError('')
    setInterventionPlan(null)
    try {
      setInterventionPlan(await generateInterventionPlan(selectedId, datasetId))
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : 'Could not generate an intervention plan.')
    } finally {
      setPlanLoading(false)
    }
  }

  function exportWatchlist() {
    const columns: (keyof Student)[] = ['student_id', 'student_name', 'department', 'year', 'success_score', 'academic_index', 'placement_index', 'risk_level', 'segment']
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const csv = [columns.map(quote).join(','), ...visibleStudents.map((student) => columns.map((column) => quote(student[column])).join(','))].join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'student-watchlist.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  function updateFilter(key: keyof Filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  function resetFilters() {
    setFilters(EMPTY_FILTERS)
    setSearch('')
  }

  const summary = overview?.summary
  const highRiskValue = overview?.filters.risks.find((risk) => risk.toLowerCase() === 'high') ?? 'High'

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#overview" aria-label="Campus Signal home">
          <span className="brand-mark"><GraduationCap size={21} strokeWidth={2.2} /></span>
          <span className="brand-name">campus<span>signal</span></span>
        </a>
        <div className="workspace-label">CAMPUS OPERATIONS</div>
        <nav className="side-nav">
          <a href="#overview" className="nav-link active"><span className="nav-dot" />Overview</a>
          <a href="#watchlist" className="nav-link"><Users size={16} />Student watchlist</a>
          <a href="#signals" className="nav-link"><HeartPulse size={16} />Success signals</a>
        </nav>
        <div className="sidebar-spacer" />
        <div className="privacy-note"><span className="privacy-dot" />Demo only. Do not upload identifiable student data; sign-in is not configured.</div>
        <div className="user-chip">
          <span className="user-avatar">FA</span>
          <span><strong>Faculty admin</strong><small>Campus team</small></span>
          <ChevronDown size={15} aria-hidden="true" />
        </div>
      </aside>

      <main className="main-content" id="overview">
        <header className="topbar">
          <div className="breadcrumb"><span>Analytics</span><span className="crumb-slash">/</span><strong>Overview</strong></div>
          <div className="topbar-actions">
            <span className="live-status"><span />Campus data</span>
            <label className={`upload-button ${uploading ? 'is-loading' : ''}`}>
              {uploading ? <RefreshCw size={16} className="spin" /> : <Upload size={16} />}
              <span>{uploading ? 'Uploading' : 'Upload CSV'}</span>
              <input type="file" accept=".csv,text/csv" onChange={handleUpload} disabled={uploading} aria-label="Upload student CSV" />
            </label>
          </div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div>
              <p className="eyebrow">STUDENT SUCCESS / INSTITUTIONAL VIEW</p>
              <h1>Overview</h1>
              <p className="heading-copy">A clear read on student momentum, risk, and where support can make a difference.</p>
            </div>
            <div className="updated-label"><span className="update-pulse" />{datasetId ? 'Uploaded dataset' : 'Current cohort'}</div>
          </section>

          {uploadError && <div className="inline-alert" role="alert"><AlertCircle size={16} /><span>{uploadError}</span><button onClick={() => setUploadError('')} aria-label="Dismiss upload error"><X size={15} /></button></div>}
          {uploadNotice && <div className="inline-alert success-alert" role="status"><Check size={16} /><span><strong>{uploadNotice.filename}</strong> loaded · {uploadNotice.student_count.toLocaleString()} students</span><button onClick={() => setUploadNotice(null)} aria-label="Dismiss upload confirmation"><X size={15} /></button></div>}

          <section className="filter-bar" aria-label="Dashboard filters">
            <div className="filter-heading"><SlidersHorizontal size={16} /><span>Filters</span></div>
            <FilterSelect label="Department" value={filters.department} options={overview?.filters.departments ?? []} onChange={(value) => updateFilter('department', value)} />
            <FilterSelect label="Academic year" value={filters.year} options={overview?.filters.years.map(String) ?? []} onChange={(value) => updateFilter('year', value)} />
            <FilterSelect label="Risk level" value={filters.risk} options={overview?.filters.risks ?? []} onChange={(value) => updateFilter('risk', value)} />
            <FilterSelect label="Student segment" value={filters.segment} options={overview?.filters.segments ?? []} onChange={(value) => updateFilter('segment', value)} />
            <button className="reset-button" onClick={resetFilters} disabled={!filters.department && !filters.year && !filters.risk && !filters.segment && !search}>Reset</button>
          </section>

          {overviewError ? (
            <ErrorState message={overviewError} onRetry={() => setRefreshToken((token) => token + 1)} />
          ) : overviewLoading && !overview ? (
            <DashboardSkeleton />
          ) : overview && (
            <>
              <section className="kpi-grid" aria-label="Student success key metrics">
                <MetricCard label="Students in view" value={summary?.student_count.toLocaleString() ?? '—'} note="Across selected cohort" icon={<Users size={17} />} accent="green" />
                <MetricCard label="Average success score" value={number(summary?.avg_success_score, 1)} suffix="/100" note="Academic + placement signals" icon={<Sparkles size={17} />} accent="gold" />
                <MetricCard label="High-risk students" value={percent(summary?.high_risk_pct)} note="Prioritize for outreach" icon={<AlertCircle size={17} />} accent="coral" action={() => updateFilter('risk', highRiskValue)} active={filters.risk.toLowerCase() === 'high'} />
                <MetricCard label="Academic risk" value={percent(summary?.academic_risk_pct)} note="Students needing academic support" icon={<GraduationCap size={17} />} accent="blue" />
                <MetricCard label="Placement risk" value={percent(summary?.placement_risk_pct)} note="Students needing readiness support" icon={<ArrowUpRight size={17} />} accent="sage" />
              </section>

              <section className="chart-grid" id="signals" aria-label="Student success trends and risk visuals">
                <article className="panel trend-panel">
                  <PanelHeading title="Engagement over time" subtitle="Attendance and LMS activity across the cohort" badge="Monthly" />
                  {overview.trends.length ? (
                    <div className="chart-wrap trend-chart">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={overview.trends} margin={{ top: 8, right: 14, bottom: 0, left: -18 }}>
                          <CartesianGrid stroke="#e8eeea" vertical={false} />
                          <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: '#82918a', fontSize: 11 }} dy={9} />
                          <YAxis yAxisId="attendance" axisLine={false} tickLine={false} tick={{ fill: '#82918a', fontSize: 11 }} />
                          <YAxis yAxisId="lms" orientation="right" axisLine={false} tickLine={false} tick={{ fill: '#a57966', fontSize: 10 }} />
                          <Tooltip contentStyle={{ border: '1px solid #e5ebe7', borderRadius: 7, fontSize: 12 }} />
                          <Line yAxisId="attendance" type="monotone" dataKey="attendance" name="Attendance" stroke="#337763" strokeWidth={2.5} dot={{ r: 3, fill: '#337763', strokeWidth: 0 }} activeDot={{ r: 5 }} />
                          <Line yAxisId="lms" type="monotone" dataKey="lms_logins" name="LMS logins" stroke="#dc8057" strokeWidth={2.5} dot={{ r: 3, fill: '#dc8057', strokeWidth: 0 }} activeDot={{ r: 5 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <ChartEmpty label="No trend data for this cohort" />}
                  <div className="chart-legend"><span><i className="legend-line attendance" />Attendance</span><span><i className="legend-line lms" />LMS logins</span></div>
                </article>

                <article className="panel distribution-panel">
                  <PanelHeading title="Success score distribution" subtitle="Students grouped by score range" />
                  {overview.distribution.length ? (
                    <div className="chart-wrap distribution-chart">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={overview.distribution} margin={{ top: 10, right: 4, bottom: 0, left: -22 }}>
                          <CartesianGrid stroke="#e8eeea" vertical={false} />
                          <XAxis dataKey="bucket" axisLine={false} tickLine={false} tick={{ fill: '#82918a', fontSize: 10 }} dy={8} />
                          <YAxis axisLine={false} tickLine={false} tick={{ fill: '#82918a', fontSize: 10 }} />
                          <Tooltip cursor={{ fill: '#f2f6f3' }} contentStyle={{ border: '1px solid #e5ebe7', borderRadius: 7, fontSize: 12 }} />
                          <Bar dataKey="count" name="Students" radius={[3, 3, 0, 0]} maxBarSize={38}>
                            {overview.distribution.map((entry, index) => <Cell key={entry.bucket} fill={chartColors[index % chartColors.length]} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <ChartEmpty label="No score distribution available" />}
                  <div className="distribution-footer"><span>Avg. score</span><strong>{number(summary?.avg_success_score, 1)} <small>/ 100</small></strong></div>
                </article>

                <article className="panel department-panel">
                  <PanelHeading title="Department pulse" subtitle="Average success score and high-risk count" />
                  {overview.departments.length ? (
                    <div className="department-list">
                      {[...overview.departments].sort((a, b) => a.avg_success_score - b.avg_success_score).slice(0, 6).map((department) => (
                        <button className="department-row" key={department.name} onClick={() => updateFilter('department', filters.department === department.name ? '' : department.name)} aria-label={`Filter by ${department.name}`}>
                          <span className="department-name">{department.name}</span>
                          <span className="department-meter"><i style={{ width: `${Math.max(0, Math.min(100, department.avg_success_score))}%` }} /></span>
                          <strong>{number(department.avg_success_score, 0)}</strong>
                          <span className="department-risk">{department.high_risk_count} high</span>
                        </button>
                      ))}
                    </div>
                  ) : <ChartEmpty label="No department data available" />}
                </article>
              </section>

              <section className="segment-breakdown" aria-labelledby="segment-heading">
                <div className="segment-breakdown-heading"><div><p className="eyebrow">TARGETED SUPPORT</p><h2 id="segment-heading">Student segments</h2></div><span>Based on cohort median indices</span></div>
                <div className="segment-grid">
                  {SEGMENTS.map((segment, index) => <button className="segment-card" key={segment.name} onClick={() => updateFilter('segment', filters.segment === segment.name ? '' : segment.name)} aria-pressed={filters.segment === segment.name}>
                    <span className={`segment-index segment-index-${index + 1}`}>0{index + 1}</span>
                    <span className="segment-card-copy"><strong>{segment.name}</strong><small>{segment.description}</small></span>
                    <span className="segment-count">{(summary?.segment_counts[segment.name] ?? 0).toLocaleString()}</span>
                  </button>)}
                </div>
              </section>

              <section className="watchlist-layout" id="watchlist">
                <article className="panel watchlist-panel">
                  <div className="watchlist-heading">
                    <div><div className="title-with-count"><h2>Student watchlist</h2><span className="count-badge">{visibleStudents.length}</span></div><p>Students with the clearest need for a timely check-in.</p></div>
                    <div className="watchlist-tools">
                      <label className="search-field"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a student" aria-label="Search students" /><kbd>/</kbd></label>
                      <button className="export-button" onClick={exportWatchlist} disabled={!visibleStudents.length} title="Download the visible watchlist as CSV"><Download size={14} /><span>Export CSV</span></button>
                    </div>
                  </div>
                  {overviewLoading && <div className="refresh-strip"><RefreshCw size={13} className="spin" />Updating filtered cohort</div>}
                  {visibleStudents.length ? (
                    <div className="table-scroll">
                      <table>
                        <thead><tr><th>Student</th><th>Department / year</th><th>Success score</th><th>Academic</th><th>Placement</th><th>Risk</th><th><span className="sr-only">Open profile</span></th></tr></thead>
                        <tbody>
                          {visibleStudents.map((student) => <StudentRow key={student.student_id} student={student} selected={selectedId === student.student_id} onSelect={() => setSelectedId(student.student_id)} />)}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="empty-state"><span className="empty-icon"><Users size={19} /></span><strong>{overview.students.length ? 'No students match your search' : 'No students in this view'}</strong><p>{overview.students.length ? 'Try a different name or student ID.' : 'Adjust your filters or upload a student dataset.'}</p>{(search || Object.values(filters).some(Boolean)) && <button className="text-button" onClick={resetFilters}>Clear filters</button>}</div>
                  )}
                </article>

                <StudentProfile student={detail} fallback={overview.students.find((student) => student.student_id === selectedId)} loading={detailLoading} error={detailError} onRetry={() => setDetailRefreshToken((token) => token + 1)} onGeneratePlan={handleGeneratePlan} plan={interventionPlan} planLoading={planLoading} planError={planError} />
              </section>

              <footer className="page-footer"><span><CircleHelp size={14} />Risk flags are screening signals, not a substitute for faculty judgment.</span><span>Campus Signal <b>·</b> Student success analytics</span></footer>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

function riskOrder(risk: string) {
  const normalized = risk.toLowerCase()
  return normalized === 'high' ? 0 : normalized === 'medium' ? 1 : 2
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: (string | number)[]; onChange: (value: string) => void }) {
  return (
    <label className="filter-select"><span className="sr-only">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
        <option value="">{label}</option>
        {options.map((option) => <option value={String(option)} key={String(option)}>{option}</option>)}
      </select><ChevronDown size={14} aria-hidden="true" />
    </label>
  )
}

function MetricCard({ label, value, suffix, note, icon, accent, action, active }: { label: string; value: string; suffix?: string; note: string; icon: React.ReactNode; accent: string; action?: () => void; active?: boolean }) {
  const contents = <>
    <span className={`metric-icon ${accent}`}>{icon}</span>
    <span className="metric-label">{label}</span>
    <span className="metric-value">{value}<small>{suffix}</small></span>
    <span className="metric-note">{note}{action && <ArrowDownRight size={13} />}</span>
  </>
  return action
    ? <button className={`metric-card actionable ${active ? 'metric-active' : ''}`} onClick={action} aria-label={`${label}: ${value}. Filter high risk students`}>{contents}</button>
    : <article className="metric-card">{contents}</article>
}

function PanelHeading({ title, subtitle, badge }: { title: string; subtitle: string; badge?: string }) {
  return <div className="panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div>{badge && <span className="panel-badge">{badge}</span>}</div>
}

function ChartEmpty({ label }: { label: string }) {
  return <div className="chart-empty"><span className="empty-chart-mark" /><span>{label}</span></div>
}

function StudentRow({ student, selected, onSelect }: { student: Student; selected: boolean; onSelect: () => void }) {
  return (
    <tr className={selected ? 'selected-row' : ''}>
      <td><button className="student-cell" onClick={onSelect}><span className={`student-avatar ${riskClass(student.risk_level)}`}>{initials(student.student_name || student.student_id)}</span><span><strong>{student.student_name}</strong><small>{student.student_id}</small></span></button></td>
      <td><span className="department-cell">{student.department}</span><small className="year-cell">Year {student.year}</small></td>
      <td><span className={`score-value ${student.success_score < 50 ? 'score-low' : ''}`}>{number(student.success_score, 1)}</span><span className="score-track"><i style={{ width: `${Math.max(0, Math.min(100, student.success_score))}%` }} /></span></td>
      <td><IndexValue value={student.academic_index} /></td>
      <td><IndexValue value={student.placement_index} /></td>
      <td><span className={`risk-badge ${riskClass(student.risk_level)}`}><i />{student.risk_level}</span></td>
      <td><button className="row-open" onClick={onSelect} aria-label={`Open ${student.student_name} profile`}><ArrowUpRight size={15} /></button></td>
    </tr>
  )
}

function IndexValue({ value }: { value: number }) {
  return <span className={`index-value ${value < 45 ? 'index-low' : ''}`}>{number(value, 0)}</span>
}

function StudentProfile({ student, fallback, loading, error, onRetry, onGeneratePlan, plan, planLoading, planError }: { student: StudentDetail | null; fallback?: Student; loading: boolean; error: string; onRetry: () => void; onGeneratePlan: () => void; plan: { source: 'rules' | 'groq'; plan: string } | null; planLoading: boolean; planError: string }) {
  return (
    <aside className="panel profile-panel" aria-label="Selected student profile" aria-live="polite">
      <div className="profile-heading"><div><p className="eyebrow">STUDENT 360</p><h2>Profile &amp; next steps</h2></div><button className="profile-help" title="Scores and risk flags are based on the current student dataset" aria-label="About this student profile"><CircleHelp size={16} /></button></div>
      {loading ? <div className="profile-loading"><span className="loading-orbit" /><span>Loading student profile</span></div>
        : error ? <ErrorState message={error} onRetry={onRetry} />
          : student ? <ProfileContent student={student} onGeneratePlan={onGeneratePlan} plan={plan} planLoading={planLoading} planError={planError} />
            : fallback ? <ProfileFallback student={fallback} />
              : <div className="profile-empty"><span className="empty-icon"><Users size={19} /></span><strong>Select a student</strong><p>Choose a student from the watchlist to review their success signals.</p></div>}
    </aside>
  )
}

function ProfileFallback({ student }: { student: Student }) {
  return <ProfileIdentity student={student}>
    <div className="profile-section"><h3>Risk reasons</h3><ReasonList academic={student.academic_risk_reasons} placement={student.placement_risk_reasons} /></div>
    <div className="profile-section segment-section"><h3>Student segment</h3><span className="segment-pill">{student.segment || 'Unassigned'}</span></div>
    <div className="detail-pending">Detailed score explanation is not available yet.</div>
  </ProfileIdentity>
}

function ProfileContent({ student, onGeneratePlan, plan, planLoading, planError }: { student: StudentDetail; onGeneratePlan: () => void; plan: { source: 'rules' | 'groq'; plan: string } | null; planLoading: boolean; planError: string }) {
  const indicators = [...student.indicators].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 5)
  return (
    <ProfileIdentity student={student}>
      <div className="profile-section score-explanation">
        <div className="section-title-row"><h3>Success score contributions</h3><span>points / 100</span></div>
        {indicators.length ? <div className="indicator-list">{indicators.map((indicator) => <div className="indicator-row" key={indicator.key}>
          <div className="indicator-meta"><span>{indicator.label}</span><small>{indicator.pillar} · cohort {indicator.cohort_delta > 0 ? '+' : ''}{number(indicator.cohort_delta, 1)}</small></div>
          <div className="indicator-bar"><i className={indicator.contribution < 0 ? 'negative' : ''} style={{ width: `${Math.min(100, Math.max(4, Math.abs(indicator.contribution) * 4))}%` }} /></div>
          <strong className={indicator.contribution < 0 ? 'delta-negative' : 'delta-positive'}>{indicator.contribution > 0 ? '+' : ''}{number(indicator.contribution, 1)}</strong>
        </div>)}</div> : <p className="muted-copy">No indicator breakdown available.</p>}
      </div>
      <div className="profile-section"><div className="section-title-row"><h3>Largest differences vs cohort</h3><span>points</span></div>
        {student.drivers.length ? <ul className="driver-list">{student.drivers.slice(0, 4).map((driver, index) => <li key={`${driver.label}-${index}`}><span>{driver.label}</span><strong className={driver.delta < 0 ? 'delta-negative' : 'delta-positive'}>{driver.delta > 0 ? '+' : ''}{number(driver.delta, 1)}</strong></li>)}</ul> : <p className="muted-copy">No cohort drivers supplied.</p>}
      </div>
      <div className="profile-section"><h3>Risk reasons</h3><ReasonList academic={student.academic_risk_reasons} placement={student.placement_risk_reasons} /></div>
      <div className="profile-section segment-section"><h3>Student segment</h3><span className="segment-pill">{student.segment || 'Unassigned'}</span></div>
      <div className="profile-section interventions-section"><div className="section-title-row"><h3>Suggested interventions</h3><Sparkles size={15} /></div>
        {student.interventions.length ? <ul className="intervention-list">{student.interventions.map((intervention, index) => <li key={`${intervention.pillar}-${index}`}><span className="intervention-check"><Check size={12} /></span><span><small>{intervention.pillar}</small>{intervention.action}</span></li>)}</ul> : <p className="muted-copy">No interventions supplied for this profile.</p>}
      </div>
      <div className="plan-generator">
        <button className="plan-button" onClick={onGeneratePlan} disabled={planLoading}>{planLoading ? <RefreshCw size={14} className="spin" /> : <Sparkles size={14} />}{planLoading ? 'Preparing plan' : 'Generate intervention plan'}</button>
        {planError && <p className="plan-error" role="alert">{planError}</p>}
        {plan && <div className="generated-plan" role="status"><span>{plan.source === 'groq' ? 'AI-assisted plan' : 'Rule-based plan'}</span><p>{plan.plan}</p></div>}
      </div>
    </ProfileIdentity>
  )
}

function ProfileIdentity({ student, children }: { student: Student; children: React.ReactNode }) {
  const score = Math.max(0, Math.min(100, student.success_score))
  return <>
    <div className="profile-student">
      <span className={`profile-avatar ${riskClass(student.risk_level)}`}>{initials(student.student_name || student.student_id)}</span>
      <div className="profile-name"><h3>{student.student_name}</h3><span>{student.student_id}</span><p>{student.department} <i /> Year {student.year}</p></div>
      <div className="score-ring" style={{ '--score-angle': `${score * 3.6}deg` } as React.CSSProperties} aria-label={`Success score ${number(score, 1)} out of 100`}><span><strong>{number(score, 0)}</strong><small>SCORE</small></span></div>
    </div>
    <div className="profile-risk-line"><span className={`risk-badge ${riskClass(student.risk_level)}`}><i />{student.risk_level} risk</span><span>{student.academic_risk ? 'Academic flag' : 'No academic flag'}</span><span>{student.placement_risk ? 'Placement flag' : 'No placement flag'}</span></div>
    <div className="profile-body">{children}</div>
  </>
}

function ReasonList({ academic, placement }: { academic: string[]; placement: string[] }) {
  const reasons = [
    ...academic.map((reason) => ({ reason, type: 'Academic' })),
    ...placement.map((reason) => ({ reason, type: 'Placement' })),
  ]
  return reasons.length ? <ul className="reason-list">{reasons.slice(0, 5).map(({ reason, type }, index) => <li key={`${type}-${index}`}><span className={`reason-dot ${type.toLowerCase()}`} /><span>{reason}</span><small>{type}</small></li>)}</ul> : <p className="muted-copy">No specific risk reasons reported.</p>
}

function DashboardSkeleton() {
  return <div className="skeleton-dashboard" aria-label="Loading dashboard" aria-busy="true"><div className="skeleton-kpis">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div><div className="skeleton-charts"><i /><i /><i /></div><div className="skeleton-table"><i /></div></div>
}

export default App
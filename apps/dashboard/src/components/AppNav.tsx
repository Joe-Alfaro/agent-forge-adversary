import { Link } from '@tanstack/react-router'

const PANELS = [
  { to: '/findings', label: 'Findings' },
  { to: '/approvals', label: 'Approvals' },
  { to: '/queue', label: "Tonight's queue" },
  { to: '/runs', label: 'Run history' },
  { to: '/coverage', label: 'Coverage' },
  { to: '/resilience', label: 'Resilience trend' },
  { to: '/cost', label: 'Cost' },
  { to: '/judge', label: 'Judge health' },
  { to: '/activity', label: 'Agent activity' },
] as const

export function AppNav() {
  return (
    <nav className="app-nav" aria-label="Dashboard">
      <ul>
        {PANELS.map((panel) => (
          <li key={panel.to}>
            <Link to={panel.to} activeProps={{ className: 'active' }}>
              {panel.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

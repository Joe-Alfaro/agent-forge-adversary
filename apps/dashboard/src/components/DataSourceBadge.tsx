import { useQuery } from '@tanstack/react-query'

import { dataSourceModeQuery } from '../lib/queries.js'

/** Makes fixture mode obvious so demo data is never mistaken for real findings. */
export function DataSourceBadge() {
  const { data: mode } = useQuery(dataSourceModeQuery)
  if (mode === 'fixtures') {
    return (
      <p className="badge data-source-demo" title="DASHBOARD_DATA_SOURCE=fixtures">
        Demo data (fixtures)
      </p>
    )
  }
  if (mode === 'postgres') {
    return <span data-testid="data-source-live" hidden />
  }
  return null
}

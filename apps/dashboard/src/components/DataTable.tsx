import {
  flexRender,
  getCoreRowModel,
  type TableOptions,
  useReactTable,
} from '@tanstack/react-table'

export interface DataTableProps<TRow> {
  data: TRow[]
  // TanStack's own column list type, so helper-built columns of mixed value types fit.
  columns: TableOptions<TRow>['columns']
  caption: string
  emptyMessage: string
}

/** Read-only table shell shared by the findings, run, and coverage panels. */
export function DataTable<TRow>({ data, columns, caption, emptyMessage }: DataTableProps<TRow>) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() })
  const rows = table.getRowModel().rows

  return (
    <table className="data-table">
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <th key={header.id} scope="col">
                {flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td className="empty" colSpan={columns.length}>
              {emptyMessage}
            </td>
          </tr>
        )}
        {rows.map((row) => (
          <tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

import { formatDate } from '@/lib/decode'
import { HarnessBadge } from '@/components/ui/harness-badge'
import type { VersionRecord } from '@/types/claude'

interface Props {
  versions: VersionRecord[]
}

export function VersionHistoryTable({ versions }: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px] font-mono">
        <thead>
          <tr className="border-b border-border">
            {['Version', 'Sessions', 'First Seen', 'Last Seen'].map(h => (
              <th key={h} className={`py-2 text-[12px] font-bold text-muted-foreground uppercase tracking-wider ${h === 'Version' ? 'text-left' : 'text-right'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Newest first: each harness's first row is its latest version */}
          {versions.map((v, i) => (
            <tr key={`${v.harness}:${v.version}`} className={`border-b border-border/30 hover:bg-muted/30 transition-colors ${versions.findIndex(x => x.harness === v.harness) === i ? 'text-[#34d399]' : 'text-foreground/70'}`}>
              <td className="py-2 font-bold"><HarnessBadge harness={v.harness} className="mr-2" />{v.version}</td>
              <td className="py-2 text-right">{v.session_count}</td>
              <td className="py-2 text-right text-muted-foreground">{v.first_seen ? formatDate(v.first_seen) : '—'}</td>
              <td className="py-2 text-right text-muted-foreground">{v.last_seen ? formatDate(v.last_seen) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

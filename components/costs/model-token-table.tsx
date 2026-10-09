import { formatTokens, formatCost } from '@/lib/decode'
import { modelShortId } from '@/lib/model-label'
import { pricingNote } from '@/lib/pricing'
import { HarnessBadge } from '@/components/ui/harness-badge'
import type { ModelCostBreakdown } from '@/types/claude'

interface Props {
  models: ModelCostBreakdown[]
  /** Copilot's premium requests in the range: a session total, not split by model */
  premiumRequests?: number
}

export function ModelTokenTable({ models, premiumRequests }: Props) {
  const totals = models.reduce((acc, m) => ({
    input: acc.input + m.input_tokens,
    output: acc.output + m.output_tokens,
    cacheWrite: acc.cacheWrite + m.cache_write_tokens,
    cacheRead: acc.cacheRead + m.cache_read_tokens,
    cost: acc.cost + m.estimated_cost,
  }), { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 })

  const columns = ['Harness', 'Model', 'Input', 'Output', 'Cache W', 'Cache R', 'Cost']

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px] font-mono">
        <thead>
          <tr className="border-b border-border">
            {columns.map(h => (
              <th key={h} className={`py-2 text-[12px] font-bold text-muted-foreground uppercase tracking-wider ${h === 'Model' || h === 'Harness' ? 'text-left' : 'text-right'}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {models.map(m => (
            <tr key={`${m.harness}:${m.model}`} className="border-b border-border/30 hover:bg-muted/50 transition-colors">
              <td className="py-2"><HarnessBadge harness={m.harness} /></td>
              <td className="py-2 text-foreground/80">
                {modelShortId(m.model)}
                {m.priced_as !== undefined && (
                  <span className="ml-2 text-[11px] text-amber-600 dark:text-amber-400" title={`No price entry: ${pricingNote(m.priced_as).text}`}>
                    {pricingNote(m.priced_as).label}
                  </span>
                )}
              </td>
              <td className="py-2 text-right text-blue-700 dark:text-[#60a5fa]">{formatTokens(m.input_tokens)}</td>
              <td className="py-2 text-right text-[#d97706]">{formatTokens(m.output_tokens)}</td>
              <td className="py-2 text-right text-[#a78bfa]">{formatTokens(m.cache_write_tokens)}</td>
              <td className="py-2 text-right text-[#34d399]">{formatTokens(m.cache_read_tokens)}</td>
              <td className="py-2 text-right text-[#d97706] font-bold">{formatCost(m.estimated_cost)}</td>
            </tr>
          ))}
          <tr className="border-t border-border font-bold">
            <td className="py-2 text-muted-foreground" colSpan={2}>TOTAL</td>
            <td className="py-2 text-right text-blue-700 dark:text-[#60a5fa]">{formatTokens(totals.input)}</td>
            <td className="py-2 text-right text-[#d97706]">{formatTokens(totals.output)}</td>
            <td className="py-2 text-right text-[#a78bfa]">{formatTokens(totals.cacheWrite)}</td>
            <td className="py-2 text-right text-[#34d399]">{formatTokens(totals.cacheRead)}</td>
            <td className="py-2 text-right text-[#d97706]">{formatCost(totals.cost)}</td>
          </tr>
        </tbody>
      </table>
      {premiumRequests !== undefined && premiumRequests > 0 && (
        <p className="mt-2 text-[12px] text-muted-foreground font-mono">
          Copilot premium requests: <span className="text-foreground/80 font-bold">{premiumRequests.toLocaleString()}</span>
        </p>
      )}
    </div>
  )
}

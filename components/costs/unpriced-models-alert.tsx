import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { modelLabel } from '@/lib/model-label'
import { FALLBACK_MODEL } from '@/lib/pricing'
import type { ModelCostBreakdown } from '@/types/claude'
import { AlertTriangle } from 'lucide-react'

interface Props {
  models: ModelCostBreakdown[]
}

/** Renders nothing unless a model was charged at another entry's rates */
export function UnpricedModelsAlert({ models }: Props) {
  const unpriced = models.filter(m => m.priced_as)
  if (unpriced.length === 0) return null

  return (
    <Alert className="border-amber-500/40">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {unpriced.length === 1 ? 'One model has' : `${unpriced.length} models have`} no price entry, so costs are estimates
      </AlertTitle>
      <AlertDescription className="text-xs space-y-1">
        <ul className="space-y-0.5">
          {unpriced.map(m => (
            <li key={m.model}>
              {modelLabel(m.model) ?? m.model} (<code>{m.model}</code>) is charged at <code>{m.priced_as}</code> rates
              {m.priced_as === FALLBACK_MODEL ? ', the default for unknown models' : ''}.
            </li>
          ))}
        </ul>
        <p>Add an entry keyed on the model id to <code>~/.cc-lens/pricing.json</code> to price it exactly.</p>
      </AlertDescription>
    </Alert>
  )
}

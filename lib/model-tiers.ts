import { vendorOf, type Vendor } from '@/lib/pricing'

/** The cheaper model each vendor's CLI would switch to: what a premium-model
 *  insight suggests instead. An unknown vendor has none. */
const ECONOMY_MODEL_BY_VENDOR: Partial<Record<Vendor, string>> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-5-mini',
}

/** The economy model of this model's vendor, if it has one */
export function economyModelFor(model: string): string | undefined {
  return ECONOMY_MODEL_BY_VENDOR[vendorOf(model)]
}

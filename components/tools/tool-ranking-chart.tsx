'use client'

import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ResponsiveContainer } from 'recharts'
import { toolBarColor } from '@/lib/tool-categories'
import type { ToolSummary } from '@/types/claude'

interface Props {
  tools: ToolSummary[]
}

export function ToolRankingChart({ tools }: Props) {
  // The axis is SVG text, so a non-Claude tool carries its harness as a prefix
  const top = tools.slice(0, 20).map(t => ({ ...t, label: t.harness === 'claude' ? t.name : `${t.harness}: ${t.name}` }))

  return (
    <div>
      <h3 className="text-[13px] font-bold text-muted-foreground uppercase tracking-widest mb-3">
        Tool Usage — Ranked by Total Calls
      </h3>
      <ResponsiveContainer width="100%" height={Math.max(200, top.length * 26)}>
        <BarChart data={top} layout="vertical" margin={{ top: 0, right: 60, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => v.toLocaleString()}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={110}
          />
          <Tooltip
            contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}
            formatter={(val: number | undefined, _name?: string, props?: { payload?: { label?: string } }) => [
              (val ?? 0).toLocaleString() + ' calls',
              props?.payload?.label ?? '',
            ]}
          />
          <Bar dataKey="total_calls" radius={[0, 3, 3, 0]}>
            {top.map((tool, i) => (
              <Cell
                key={i}
                fill={toolBarColor(tool.name, tool.harness)}
                fillOpacity={0.92}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

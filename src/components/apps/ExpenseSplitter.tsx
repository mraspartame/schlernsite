import { useState, useEffect, useCallback } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Person {
  id: string;
  name: string;
  startDay: number;
  endDay: number;
}

interface Expense {
  id: string;
  description: string;
  amount: number;
  paidBy: string;
  splitType: 'equal' | 'by-days';
  startDay: number;
  endDay: number;
}

interface State {
  title: string;
  totalDays: number;
  people: Person[];
  expenses: Expense[];
}

type DebtMap = Record<string, Record<string, number>>;

// ── Utilities ─────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 8);

function encodeState(state: State): string {
  return btoa(encodeURIComponent(JSON.stringify(state)));
}

function decodeState(hash: string): State | null {
  try {
    return JSON.parse(decodeURIComponent(atob(hash)));
  } catch {
    return null;
  }
}

function overlapDays(pStart: number, pEnd: number, eStart: number, eEnd: number): number {
  return Math.max(0, Math.min(pEnd, eEnd) - Math.max(pStart, eStart) + 1);
}

function calcSplits(
  state: State
): { person: Person; owes: Record<string, number>; receives: Record<string, number> }[] {
  const { people, expenses } = state;
  // net[from][to] = amount `from` owes `to`
  const net: DebtMap = {};
  people.forEach((p) => { net[p.id] = {}; people.forEach((q) => { net[p.id][q.id] = 0; }); });

  expenses.forEach((exp) => {
    const payer = exp.paidBy;
    const amount = exp.amount;
    const eStart = exp.startDay;
    const eEnd = exp.endDay;

    // Only include people who were present on at least one day of this expense
    const present = people.filter((p) => overlapDays(p.startDay, p.endDay, eStart, eEnd) > 0);
    if (present.length === 0) return;

    if (exp.splitType === 'equal') {
      const share = amount / present.length;
      present.forEach((p) => {
        if (p.id !== payer) {
          net[p.id][payer] = (net[p.id][payer] ?? 0) + share;
          net[payer][p.id] = (net[payer][p.id] ?? 0) - share;
        }
      });
    } else {
      // by-days: split proportionally to overlapping days between person and expense
      const overlaps = present.map((p) => ({ p, days: overlapDays(p.startDay, p.endDay, eStart, eEnd) }));
      const totalOverlap = overlaps.reduce((s, o) => s + o.days, 0);
      if (totalOverlap === 0) return;
      overlaps.forEach(({ p, days }) => {
        const share = (days / totalOverlap) * amount;
        if (p.id !== payer) {
          net[p.id][payer] = (net[p.id][payer] ?? 0) + share;
          net[payer][p.id] = (net[payer][p.id] ?? 0) - share;
        }
      });
    }
  });

  return people.map((p) => {
    const owes: Record<string, number> = {};
    const receives: Record<string, number> = {};
    people.forEach((q) => {
      const v = net[p.id]?.[q.id] ?? 0;
      if (v > 0.005) owes[q.id] = v;
      else if (v < -0.005) receives[q.id] = -v;
    });
    return { person: p, owes, receives };
  });
}

// ── Styles (inline, brutal aesthetic) ─────────────────────────────────────────

const S = {
  card: {
    border: '3px solid #000',
    background: '#fff',
    padding: '20px',
    marginBottom: '16px',
    boxShadow: '5px 5px 0 #000',
  } as React.CSSProperties,
  h1: { fontFamily: 'DM Serif Text, serif', fontSize: 36, marginBottom: 8 } as React.CSSProperties,
  h2: { fontFamily: 'DM Serif Text, serif', fontSize: 24, marginBottom: 12 } as React.CSSProperties,
  label: { display: 'block', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 13, marginBottom: 4 } as React.CSSProperties,
  input: {
    border: '2px solid #000',
    padding: '6px 10px',
    fontFamily: 'Poppins, sans-serif',
    fontSize: 14,
    width: '100%',
    boxSizing: 'border-box',
    marginBottom: 8,
  } as React.CSSProperties,
  select: {
    border: '2px solid #000',
    padding: '6px 10px',
    fontFamily: 'Poppins, sans-serif',
    fontSize: 14,
    background: '#fff',
    marginBottom: 8,
  } as React.CSSProperties,
  btn: (bg = '#000', fg = '#fff') => ({
    border: '2px solid #000',
    background: bg,
    color: fg,
    padding: '7px 14px',
    fontFamily: 'Poppins, sans-serif',
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
    boxShadow: '3px 3px 0 #000',
    marginRight: 8,
  } as React.CSSProperties),
  row: { display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' as const },
  tag: { background: '#000', color: '#fff', padding: '3px 8px', fontFamily: 'monospace', fontSize: 12 } as React.CSSProperties,
};

// ── Component ─────────────────────────────────────────────────────────────────

const defaultState: State = {
  title: 'Trip Expenses',
  totalDays: 5,
  people: [],
  expenses: [],
};

export default function ExpenseSplitter() {
  const [state, setState] = useState<State>(defaultState);
  const [copied, setCopied] = useState(false);

  // Load from URL hash on mount
  useEffect(() => {
    const hash = new URLSearchParams(location.search).get('s');
    if (hash) {
      const loaded = decodeState(hash);
      if (loaded) setState(loaded);
    }
  }, []);

  const update = (patch: Partial<State>) => setState((s) => ({ ...s, ...patch }));

  const addPerson = () =>
    update({
      people: [
        ...state.people,
        { id: uid(), name: `Person ${state.people.length + 1}`, startDay: 1, endDay: state.totalDays },
      ],
    });

  const updatePerson = (id: string, patch: Partial<Person>) =>
    update({ people: state.people.map((p) => (p.id === id ? { ...p, ...patch } : p)) });

  const removePerson = (id: string) =>
    update({
      people: state.people.filter((p) => p.id !== id),
      expenses: state.expenses.map((e) => (e.paidBy === id ? { ...e, paidBy: '' } : e)),
    });

  const addExpense = () =>
    update({
      expenses: [
        ...state.expenses,
        {
          id: uid(),
          description: 'New expense',
          amount: 0,
          paidBy: state.people[0]?.id ?? '',
          splitType: 'by-days',
          startDay: 1,
          endDay: state.totalDays,
        },
      ],
    });

  const updateExpense = (id: string, patch: Partial<Expense>) =>
    update({ expenses: state.expenses.map((e) => (e.id === id ? { ...e, ...patch } : e)) });

  const removeExpense = (id: string) =>
    update({ expenses: state.expenses.filter((e) => e.id !== id) });

  const shareUrl = () => {
    const url = `${location.origin}${location.pathname}?s=${encodeState(state)}`;
    navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.title.replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
  };

  const importJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string) as State;
        if (!data.title || !Array.isArray(data.people) || !Array.isArray(data.expenses)) {
          alert('Invalid JSON: missing required fields.');
          return;
        }
        // Migrate older exports that lack startDay/endDay on expenses
        const totalDays = data.totalDays ?? 1;
        data.expenses = data.expenses.map((exp) => ({
          ...exp,
          startDay: exp.startDay ?? 1,
          endDay: exp.endDay ?? totalDays,
        }));
        setState(data);
      } catch {
        alert('Could not parse JSON file.');
      }
    };
    reader.readAsText(file);
  };

  const splits = state.people.length > 0 ? calcSplits(state) : [];
  const personName = (id: string) => state.people.find((p) => p.id === id)?.name ?? id;
  const total = state.expenses.reduce((s, e) => s + (e.amount || 0), 0);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* Header */}
      <div style={S.card}>
        <h1 style={S.h1}>💸 Expense Splitter</h1>
        <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 14, marginBottom: 16 }}>
          Split group expenses by days present. Share the result via URL or export to JSON.
        </p>
        <div style={S.row}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={S.label}>Trip Name</label>
            <input
              style={S.input}
              value={state.title}
              onChange={(e) => update({ title: e.target.value })}
            />
          </div>
          <div style={{ width: 120 }}>
            <label style={S.label}>Total Days</label>
            <input
              style={S.input}
              type='number'
              min={1}
              value={state.totalDays}
              onChange={(e) => update({ totalDays: parseInt(e.target.value) || 1 })}
            />
          </div>
        </div>
        <div style={S.row}>
          <button style={S.btn()} onClick={shareUrl}>
            {copied ? '✓ Copied!' : '🔗 Copy Share Link'}
          </button>
          <button style={S.btn('#fff', '#000')} onClick={exportJson}>
            ⬇ Export JSON
          </button>
          <label style={{ ...S.btn('#fff', '#000'), cursor: 'pointer', boxShadow: '3px 3px 0 #000' }}>
            ↑ Import JSON
            <input type='file' accept='.json,application/json' style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files?.[0]) { importJson(e.target.files[0]); e.target.value = ''; } }} />
          </label>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* People */}
        <div style={S.card}>
          <h2 style={S.h2}>People</h2>
          {state.people.map((p) => (
            <div key={p.id} style={{ border: '2px solid #000', padding: 10, marginBottom: 10, background: '#fafafa' }}>
              <input
                style={{ ...S.input, fontWeight: 700 }}
                value={p.name}
                onChange={(e) => updatePerson(p.id, { name: e.target.value })}
                placeholder='Name'
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={S.label}>Start day</label>
                  <input
                    style={S.input}
                    type='number'
                    min={1}
                    max={state.totalDays}
                    value={p.startDay}
                    onChange={(e) => updatePerson(p.id, { startDay: parseInt(e.target.value) || 1 })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={S.label}>End day</label>
                  <input
                    style={S.input}
                    type='number'
                    min={1}
                    max={state.totalDays}
                    value={p.endDay}
                    onChange={(e) => updatePerson(p.id, { endDay: parseInt(e.target.value) || 1 })}
                  />
                </div>
              </div>
              <span style={{ ...S.tag, marginRight: 8 }}>
                {Math.max(0, p.endDay - p.startDay + 1)} day{p.endDay - p.startDay + 1 !== 1 ? 's' : ''}
              </span>
              <button
                style={{ ...S.btn('#ff4444', '#fff'), boxShadow: 'none', padding: '3px 8px' }}
                onClick={() => removePerson(p.id)}
              >
                ✕ Remove
              </button>
            </div>
          ))}
          <button style={S.btn()} onClick={addPerson}>+ Add Person</button>
        </div>

        {/* Expenses */}
        <div style={S.card}>
          <h2 style={S.h2}>Expenses</h2>
          {state.expenses.map((exp) => (
            <div key={exp.id} style={{ border: '2px solid #000', padding: 10, marginBottom: 10, background: '#fafafa' }}>
              <input
                style={{ ...S.input, fontWeight: 700 }}
                value={exp.description}
                onChange={(e) => updateExpense(exp.id, { description: e.target.value })}
                placeholder='Description'
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={S.label}>Amount ($)</label>
                  <input
                    style={S.input}
                    type='number'
                    min={0}
                    step={0.01}
                    value={exp.amount || ''}
                    onChange={(e) => updateExpense(exp.id, { amount: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={S.label}>Paid by</label>
                  <select
                    style={S.select}
                    value={exp.paidBy}
                    onChange={(e) => updateExpense(exp.id, { paidBy: e.target.value })}
                  >
                    <option value=''>— select —</option>
                    {state.people.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              {/* Day range */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' as const }}>
                <label style={{ ...S.label, marginBottom: 0 }}>Days:</label>
                <input
                  style={{ ...S.input, width: 60, marginBottom: 0 }}
                  type='number' min={1} max={state.totalDays}
                  value={exp.startDay}
                  onChange={(e) => updateExpense(exp.id, { startDay: Math.min(parseInt(e.target.value) || 1, exp.endDay) })}
                />
                <span style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13 }}>–</span>
                <input
                  style={{ ...S.input, width: 60, marginBottom: 0 }}
                  type='number' min={1} max={state.totalDays}
                  value={exp.endDay}
                  onChange={(e) => updateExpense(exp.id, { endDay: Math.max(parseInt(e.target.value) || 1, exp.startDay) })}
                />
                <span style={S.tag}>
                  {state.people.filter((p) => overlapDays(p.startDay, p.endDay, exp.startDay, exp.endDay) > 0).length} of {state.people.length} people
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <label style={{ ...S.label, marginBottom: 0 }}>Split:</label>
                <label style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13 }}>
                  <input
                    type='radio'
                    name={`split-${exp.id}`}
                    checked={exp.splitType === 'by-days'}
                    onChange={() => updateExpense(exp.id, { splitType: 'by-days' })}
                  />{' '}
                  By days
                </label>
                <label style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13 }}>
                  <input
                    type='radio'
                    name={`split-${exp.id}`}
                    checked={exp.splitType === 'equal'}
                    onChange={() => updateExpense(exp.id, { splitType: 'equal' })}
                  />{' '}
                  Equal
                </label>
                <button
                  style={{ ...S.btn('#ff4444', '#fff'), boxShadow: 'none', padding: '3px 8px', marginLeft: 'auto' }}
                  onClick={() => removeExpense(exp.id)}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          <button style={S.btn()} onClick={addExpense}>+ Add Expense</button>
          {state.expenses.length > 0 && (
            <p style={{ fontFamily: 'Poppins, sans-serif', fontWeight: 700, marginTop: 12 }}>
              Total: ${total.toFixed(2)}
            </p>
          )}
        </div>
      </div>

      {/* Results */}
      {splits.length > 0 && (
        <div style={S.card}>
          <h2 style={S.h2}>Settlement</h2>
          {splits.map(({ person, owes, receives }) => (
            <div key={person.id} style={{ marginBottom: 12, padding: 12, border: '2px solid #ddd' }}>
              <strong style={{ fontFamily: 'Poppins, sans-serif' }}>{person.name}</strong>
              {Object.keys(owes).length === 0 && Object.keys(receives).length === 0 && (
                <span style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13, color: '#666', marginLeft: 8 }}>
                  is settled
                </span>
              )}
              {Object.entries(owes).map(([toId, amt]) => (
                <div key={toId} style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13, color: '#c00', marginLeft: 8 }}>
                  owes <strong>{personName(toId)}</strong> ${amt.toFixed(2)}
                </div>
              ))}
              {Object.entries(receives).map(([fromId, amt]) => (
                <div key={fromId} style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13, color: '#060', marginLeft: 8 }}>
                  receives <strong>${amt.toFixed(2)}</strong> from {personName(fromId)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {state.people.length === 0 && (
        <div style={{ ...S.card, textAlign: 'center', color: '#666' }}>
          <p style={{ fontFamily: 'Poppins, sans-serif' }}>Add people and expenses above to see the settlement.</p>
        </div>
      )}
    </div>
  );
}

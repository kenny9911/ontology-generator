// Graph — interactive ontology visualization computed from the CANONICAL model
// (`ctrl.ontology`). JSON adjacency only — Neo4j is NOT required to render; a
// small status badge reflects the graph runtime (connected / unreachable /
// disabled) but the SVG draws fully with Neo4j absent.
//
// Node kinds: Object · Rule · Action · Event · Process (distinct accents).
// Edges:
//   object↔object   from Relationship(source/target ObjectTypeId)
//   rule→object     from Rule.appliesToObjectTypeIds
//   action↔object   from ActionType.inputs/outputs[].objectTypeId
//   event→action    from ActionType.triggeredByEventIds
//   action→event    from ActionType.emitsEvents[].eventTypeId
//   process→action  from Process.steps[].actionTypeId (+ intra-step next edges)
//   process→object  from Process.objectTypeIds
//
// Preserves the design system: '.ontogen' classes (screen / mono-cap / scroll /
// grid-bg / tag), inline-style + CSS-var aesthetic, EN/中文 bilingual, the filter
// pills + click-to-focus inspector, and the four layout modes. Container passes
// `layout` (TopBar's selector); we default to 'force' when absent.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { LayoutMode } from './TopBar';
import type { OntologyRunController } from './useOntologyRun';
import type {
  Ontology,
  ObjectType,
  Rule,
  ActionType,
  EventType,
  Process,
} from '@/ontology/schema/types';
import * as api from './api';

// ---------------------------------------------------------------------------
// Node / edge model
// ---------------------------------------------------------------------------

type NodeKind = 'object' | 'rule' | 'action' | 'event' | 'process';
type EdgeKind = 'rel' | 'rule' | 'io' | 'trigger' | 'emit' | 'proc' | 'step';

type NodeRef = ObjectType | Rule | ActionType | EventType | Process;

interface GNode {
  /** kind-prefixed unique id, e.g. "object:order". */
  id: string;
  /** Canonical node id (without the local kind prefix collision). */
  refId: string;
  label: string;
  kind: NodeKind;
  emoji?: string;
  ref: NodeRef;
  /** Degree-ish weight used for radius. */
  weight: number;
}
interface GEdge {
  from: string; // GNode.id
  to: string; // GNode.id
  kind: EdgeKind;
}
type Positions = Record<string, { x: number; y: number }>;

type FilterState = Record<NodeKind, boolean>;

interface GraphScreenProps {
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
  /** Layout mode from the container's TopBar selector (optional). */
  layout?: LayoutMode;
}

const W = 1100;
const H = 700;

// Pan/zoom view transform applied to the whole graph content group.
const MIN_K = 0.2;
const MAX_K = 4;
const clampNum = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
interface GraphView {
  k: number;
  tx: number;
  ty: number;
}

// ---------------------------------------------------------------------------
// Colors — three theme accents + two fixed accents for action / event so all
// five kinds stay visually distinct under every '.ontogen' theme.
// ---------------------------------------------------------------------------

const KIND_COLOR: Record<NodeKind, string> = {
  object: 'var(--accent)',
  rule: 'var(--accent-2)',
  process: 'var(--accent-3)',
  action: '#22c1a6', // teal — distinct from the three CSS accents
  event: '#e0a93a', // amber
};

function kindColor(kind: NodeKind): string {
  return KIND_COLOR[kind];
}

function edgeColor(kind: EdgeKind): string {
  switch (kind) {
    case 'rel':
      return 'var(--accent)';
    case 'rule':
      return 'var(--accent-2)';
    case 'io':
      return KIND_COLOR.action;
    case 'trigger':
    case 'emit':
      return KIND_COLOR.event;
    case 'proc':
    case 'step':
    default:
      return 'var(--accent-3)';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// Build nodes + edges from the canonical ontology
// ---------------------------------------------------------------------------

function buildGraph(
  o: Ontology | null,
  filter: FilterState,
  lang: Lang,
): { nodes: GNode[]; edges: GEdge[] } {
  if (!o) return { nodes: [], edges: [] };

  const nodes: GNode[] = [];
  // Maps canonical refId -> graph node id, per kind, so edges resolve fast.
  const objId = (id: string) => 'object:' + id;
  const ruleId = (id: string) => 'rule:' + id;
  const actId = (id: string) => 'action:' + id;
  const evtId = (id: string) => 'event:' + id;
  const procId = (id: string) => 'process:' + id;

  const has = new Set<string>(); // present graph-node ids (after filtering)

  if (filter.object) {
    for (const ob of o.objects) {
      const id = objId(ob.id);
      nodes.push({
        id,
        refId: ob.id,
        label: ob.name,
        kind: 'object',
        emoji: ob.display?.emoji,
        ref: ob,
        weight: (ob.relationshipIds?.length ?? 0) + 1,
      });
      has.add(id);
    }
  }
  if (filter.rule) {
    for (const r of o.rules) {
      const id = ruleId(r.id);
      nodes.push({
        id,
        refId: r.id,
        label: r.title || r.id.replace(/^rule:/, 'R'),
        kind: 'rule',
        ref: r,
        weight: 2,
      });
      has.add(id);
    }
  }
  if (filter.action) {
    for (const a of o.actions) {
      const id = actId(a.id);
      nodes.push({
        id,
        refId: a.id,
        label: a.name,
        kind: 'action',
        ref: a,
        weight: a.inputs.length + a.outputs.length + 1,
      });
      has.add(id);
    }
  }
  if (filter.event) {
    for (const e of o.events) {
      const id = evtId(e.id);
      nodes.push({
        id,
        refId: e.id,
        label: e.name,
        kind: 'event',
        ref: e,
        weight: 2,
      });
      has.add(id);
    }
  }
  if (filter.process) {
    for (const p of o.processes) {
      const id = procId(p.id);
      nodes.push({
        id,
        refId: p.id,
        label: p.name[lang] || p.name.en,
        kind: 'process',
        ref: p,
        weight: 3,
      });
      has.add(id);
    }
  }

  const edges: GEdge[] = [];
  const push = (from: string, to: string, kind: EdgeKind) => {
    if (from === to) return;
    if (!has.has(from) || !has.has(to)) return;
    edges.push({ from, to, kind });
  };

  // object↔object via relationships
  for (const rel of o.relationships) {
    push(objId(rel.sourceObjectTypeId), objId(rel.targetObjectTypeId), 'rel');
  }
  // rule→object via appliesTo
  for (const r of o.rules) {
    for (const target of r.appliesToObjectTypeIds) {
      push(ruleId(r.id), objId(target), 'rule');
    }
  }
  // action↔object via typed IO + event wiring
  for (const a of o.actions) {
    for (const io of [...a.inputs, ...a.outputs]) {
      if (io.objectTypeId) push(actId(a.id), objId(io.objectTypeId), 'io');
    }
    for (const evId of a.triggeredByEventIds) {
      push(evtId(evId), actId(a.id), 'trigger');
    }
    for (const em of a.emitsEvents) {
      push(actId(a.id), evtId(em.eventTypeId), 'emit');
    }
  }
  // process→action (steps), intra-step next edges, process→object
  for (const p of o.processes) {
    const stepAction = new Map<string, string>(); // WorkflowStep.id -> actionTypeId
    for (const s of p.steps) {
      stepAction.set(s.id, s.actionTypeId);
      push(procId(p.id), actId(s.actionTypeId), 'proc');
    }
    for (const s of p.steps) {
      for (const edge of s.next) {
        const fromAction = s.actionTypeId;
        const toAction = stepAction.get(edge.toStepId);
        if (toAction) push(actId(fromAction), actId(toAction), 'step');
      }
    }
    for (const otId of p.objectTypeIds) {
      push(procId(p.id), objId(otId), 'proc');
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GraphScreen({ t, lang, ctrl, layout }: GraphScreenProps) {
  const mode = layout ?? 'force';
  const ontology = ctrl.ontology;

  const [focusId, setFocusId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>({
    object: true,
    rule: true,
    action: true,
    event: true,
    process: true,
  });

  // Neo4j status badge — read live via the api (the controller does not expose
  // it). Demo runs never touch a graph runtime, so report 'disabled' there.
  const [graphState, setGraphState] = useState<'connected' | 'unreachable' | 'disabled'>(
    'disabled',
  );
  useEffect(() => {
    let alive = true;
    if (ctrl.mode !== 'live') {
      setGraphState('disabled');
      return;
    }
    api
      .graphStatus()
      .then((s) => {
        if (alive) setGraphState(s);
      })
      .catch(() => {
        if (alive) setGraphState('unreachable');
      });
    return () => {
      alive = false;
    };
  }, [ctrl.mode]);

  const { nodes, edges } = useMemo(
    () => buildGraph(ontology, filter, lang),
    [ontology, filter, lang],
  );

  const positions = useMemo<Positions>(
    () => computeLayout(nodes, edges, mode),
    [nodes, edges, mode],
  );

  // User-dragged node positions override the computed layout. Cleared whenever
  // the layout mode changes (a new layout supersedes manual placement) — see the
  // effect below, after the view refs are declared.
  const [overrides, setOverrides] = useState<Positions>({});
  const posOf = (id: string): { x: number; y: number } | undefined => overrides[id] ?? positions[id];

  // 1-hop neighborhood of the focused node (dims everything else).
  const neighborhood = useMemo<Set<string> | null>(() => {
    if (!focusId) return null;
    const set = new Set([focusId]);
    for (const e of edges) {
      if (e.from === focusId) set.add(e.to);
      if (e.to === focusId) set.add(e.from);
    }
    return set;
  }, [focusId, edges]);

  const sel = focusId ? nodes.find((n) => n.id === focusId) ?? null : null;

  // ---- pan / zoom / fit + node dragging --------------------------------------
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState<GraphView>({ k: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const userAdjustedRef = useRef(false);
  const [panning, setPanning] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const panRef = useRef<{ vx0: number; vy0: number; tx0: number; ty0: number } | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);

  // A new layout mode supersedes manual node placement and re-engages auto-fit.
  useEffect(() => {
    setOverrides({});
    userAdjustedRef.current = false;
  }, [mode]);

  // Client point → SVG viewBox space (CTM is independent of the content transform).
  function toViewBoxPoint(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const sp = pt.matrixTransform(ctm.inverse());
    return { x: sp.x, y: sp.y };
  }
  // Client point → graph space (undo the content pan/zoom).
  function toGraphPoint(clientX: number, clientY: number): { x: number; y: number } {
    const { k, tx, ty } = viewRef.current;
    const v = toViewBoxPoint(clientX, clientY);
    return { x: (v.x - tx) / k, y: (v.y - ty) / k };
  }

  function computeFit(): GraphView | null {
    if (nodes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const p = posOf(n.id);
      if (!p) continue;
      const r = nodeRadius(n);
      minX = Math.min(minX, p.x - r); maxX = Math.max(maxX, p.x + r);
      minY = Math.min(minY, p.y - r); maxY = Math.max(maxY, p.y + r + 14); // label sits below
    }
    if (!Number.isFinite(minX)) return null;
    const pad = 40;
    const bw = (maxX - minX) + pad * 2;
    const bh = (maxY - minY) + pad * 2;
    const k = clampNum(Math.min(W / bw, H / bh), MIN_K, 1.4);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return { k, tx: W / 2 - k * cx, ty: H / 2 - k * cy };
  }

  // Auto-fit on first layout / layout changes, until the user takes control.
  useEffect(() => {
    if (userAdjustedRef.current) return;
    const f = computeFit();
    if (f) setView(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, positions, mode]);

  // Wheel zoom (native, non-passive so we can preventDefault page scroll).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { k, tx, ty } = viewRef.current;
      const v = toViewBoxPoint(e.clientX, e.clientY);
      const newK = clampNum(k * Math.exp(-e.deltaY * 0.0015), MIN_K, MAX_K);
      const gx = (v.x - tx) / k, gy = (v.y - ty) / k;
      userAdjustedRef.current = true;
      setView({ k: newK, tx: v.x - newK * gx, ty: v.y - newK * gy });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function zoomBy(factor: number) {
    const { k, tx, ty } = viewRef.current;
    const newK = clampNum(k * factor, MIN_K, MAX_K);
    const cx = W / 2, cy = H / 2;
    const gx = (cx - tx) / k, gy = (cy - ty) / k;
    userAdjustedRef.current = true;
    setView({ k: newK, tx: cx - newK * gx, ty: cy - newK * gy });
  }
  function fitToView() {
    const f = computeFit();
    if (!f) return;
    userAdjustedRef.current = false; // explicit fit re-engages auto-follow
    setView(f);
  }

  function onNodePointerDown(e: ReactPointerEvent, id: string) {
    e.preventDefault();
    e.stopPropagation(); // don't start a background pan
    const cur = posOf(id) ?? { x: 0, y: 0 };
    const g = toGraphPoint(e.clientX, e.clientY);
    const v = toViewBoxPoint(e.clientX, e.clientY);
    dragRef.current = { id, dx: g.x - cur.x, dy: g.y - cur.y, sx: v.x, sy: v.y, moved: false };
    setDragId(id);
    svgRef.current?.setPointerCapture(e.pointerId);
  }
  function onBackgroundPointerDown(e: ReactPointerEvent) {
    e.preventDefault();
    const v = toViewBoxPoint(e.clientX, e.clientY);
    const { tx, ty } = viewRef.current;
    panRef.current = { vx0: v.x, vy0: v.y, tx0: tx, ty0: ty };
    userAdjustedRef.current = true;
    setPanning(true);
    svgRef.current?.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent) {
    const d = dragRef.current;
    if (d) {
      const v = toViewBoxPoint(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(v.x - d.sx, v.y - d.sy) > 3) d.moved = true;
      const g = toGraphPoint(e.clientX, e.clientY);
      userAdjustedRef.current = true;
      setOverrides((prev) => ({ ...prev, [d.id]: { x: g.x - d.dx, y: g.y - d.dy } }));
      return;
    }
    const pan = panRef.current;
    if (pan) {
      const v = toViewBoxPoint(e.clientX, e.clientY);
      setView((cur) => ({ ...cur, tx: pan.tx0 + (v.x - pan.vx0), ty: pan.ty0 + (v.y - pan.vy0) }));
    }
  }
  function onPointerUp(e: ReactPointerEvent) {
    const d = dragRef.current;
    if (d) {
      svgRef.current?.releasePointerCapture(e.pointerId);
      dragRef.current = null;
      setDragId(null);
      if (!d.moved) setFocusId((prev) => (prev === d.id ? null : d.id)); // a tap = focus toggle
      return;
    }
    if (panRef.current) {
      svgRef.current?.releasePointerCapture(e.pointerId);
      panRef.current = null;
      setPanning(false);
    }
  }

  return (
    <div className="screen" style={{ gridTemplateColumns: '1fr 340px', gap: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Header */}
        <div
          style={{
            padding: 'var(--s-5) var(--s-6)',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: 'var(--s-5)',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div className="mono-cap">{lang === 'zh' ? '08 · 图谱' : '08 · GRAPH'}</div>
            <h2
              style={{
                margin: '6px 0 2px',
                fontFamily: 'var(--font-display)',
                fontSize: 24,
                fontWeight: 600,
                letterSpacing: '-0.02em',
              }}
            >
              {t.graphTitle}
            </h2>
            <p style={{ color: 'var(--fg-3)', margin: 0, fontSize: 13 }}>{t.graphSub}</p>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 'var(--s-2)',
              alignItems: 'center',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
            }}
          >
            <Neo4jBadge state={graphState} lang={lang} t={t} />
            <span className="mono-cap" style={{ marginRight: 4 }}>
              {t.filter}:
            </span>
            {FILTERS.map((f) => {
              const on = filter[f.key];
              const color = kindColor(f.key);
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter((prev) => ({ ...prev, [f.key]: !prev[f.key] }))}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 10px',
                    borderRadius: 999,
                    background: on
                      ? `color-mix(in oklab, ${color} 14%, transparent)`
                      : 'var(--bg-2)',
                    border: `1px solid ${on ? color : 'var(--line)'}`,
                    color: on ? color : 'var(--fg-4)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: on ? color : 'var(--fg-4)',
                    }}
                  />
                  {f.label[lang]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Canvas */}
        <div
          ref={wrapRef}
          className="grid-bg"
          style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}
        >
          {nodes.length === 0 ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                color: 'var(--fg-3)',
                fontSize: 13,
                textAlign: 'center',
              }}
            >
              <div>
                <div style={{ fontSize: 30, marginBottom: 12, opacity: 0.4 }}>◌</div>
                {lang === 'zh' ? '暂无可视化的节点' : 'Nothing to graph yet'}
              </div>
            </div>
          ) : (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="xMidYMid meet"
              style={{
                width: '100%', height: '100%', touchAction: 'none', userSelect: 'none',
                cursor: panning ? 'grabbing' : 'grab',
              }}
              onPointerDown={onBackgroundPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <defs>
                {(Object.keys(KIND_COLOR) as NodeKind[]).map((kind) => (
                  <radialGradient key={kind} id={`glow-${kind}`} cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor={kindColor(kind)} stopOpacity="0.7" />
                    <stop offset="60%" stopColor={kindColor(kind)} stopOpacity="0.15" />
                    <stop offset="100%" stopColor={kindColor(kind)} stopOpacity="0" />
                  </radialGradient>
                ))}
              </defs>

              {/* Pannable / zoomable content group */}
              <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
                {/* Edges */}
                {edges.map((e, i) => {
                  const a = posOf(e.from);
                  const b = posOf(e.to);
                  if (!a || !b) return null;
                  const dim =
                    neighborhood && (!neighborhood.has(e.from) || !neighborhood.has(e.to));
                  return (
                    <line
                      key={i}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={edgeColor(e.kind)}
                      strokeWidth={e.kind === 'rel' ? 1 : 0.6}
                      strokeDasharray={e.kind === 'rel' ? 'none' : '2 3'}
                      opacity={dim ? 0.08 : 0.45}
                      style={{ transition: 'opacity 0.3s' }}
                    />
                  );
                })}

                {/* Nodes */}
                {nodes.map((n) => {
                  const p = posOf(n.id);
                  if (!p) return null;
                  const isFocus = focusId === n.id;
                  const dim = neighborhood && !neighborhood.has(n.id);
                  const dragging = dragId === n.id;
                  const r = nodeRadius(n);
                  return (
                    <g
                      key={n.id}
                      transform={`translate(${p.x}, ${p.y})`}
                      style={{
                        cursor: dragging ? 'grabbing' : 'grab',
                        opacity: dim ? 0.18 : 1,
                        // No transform transition while dragging, so the node tracks the pointer.
                        transition: dragging ? 'opacity 0.3s' : 'opacity 0.3s, transform 0.5s',
                      }}
                      onPointerDown={(ev) => onNodePointerDown(ev, n.id)}
                    >
                      <circle r={r * 1.8} fill={`url(#glow-${n.kind})`} opacity={isFocus ? 1 : 0.5} />
                      <circle
                        r={r}
                        fill="var(--bg-1)"
                        stroke={kindColor(n.kind)}
                        strokeWidth={isFocus ? 2.2 : 1.2}
                      />
                      <NodeGlyph node={n} r={r} />
                    </g>
                  );
                })}
              </g>
            </svg>
          )}

          {/* Pan/zoom controls */}
          {nodes.length > 0 && (
            <div style={{
              position: 'absolute', top: 12, right: 12,
              display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <GraphCtrlBtn label="+" title={lang === 'zh' ? '放大' : 'Zoom in'} onClick={() => zoomBy(1.25)} />
              <GraphCtrlBtn label="−" title={lang === 'zh' ? '缩小' : 'Zoom out'} onClick={() => zoomBy(1 / 1.25)} />
              <GraphCtrlBtn label="⤢" title={lang === 'zh' ? '适应视图' : 'Fit graph to view'} onClick={fitToView} />
            </div>
          )}

          {/* Legend */}
          <div
            style={{
              position: 'absolute',
              bottom: 16,
              left: 16,
              background: 'color-mix(in oklab, var(--bg) 80%, transparent)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--r-2)',
              padding: '10px 14px',
              backdropFilter: 'blur(8px)',
              display: 'flex',
              gap: 14,
              flexWrap: 'wrap',
              alignItems: 'center',
              maxWidth: 'calc(100% - 32px)',
            }}
          >
            {FILTERS.filter((f) => filter[f.key]).map((f) => (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: kindColor(f.key),
                    boxShadow: `0 0 8px ${kindColor(f.key)}`,
                  }}
                />
                <span className="mono-cap">{f.label[lang]}</span>
              </div>
            ))}
            <div style={{ width: 1, height: 14, background: 'var(--line)' }} />
            <div className="mono-cap">
              {nodes.length} {lang === 'zh' ? '节点' : 'nodes'} · {edges.length}{' '}
              {lang === 'zh' ? '边' : 'edges'}
            </div>
          </div>
        </div>
      </div>

      {/* Right inspector */}
      <div
        style={{
          borderLeft: '1px solid var(--line)',
          padding: 'var(--s-5)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-4)',
          minHeight: 0,
          overflow: 'auto',
        }}
        className="scroll"
      >
        {!sel ? (
          <div
            style={{
              color: 'var(--fg-3)',
              fontSize: 13,
              textAlign: 'center',
              padding: 'var(--s-7) var(--s-3)',
            }}
          >
            <div style={{ fontSize: 30, marginBottom: 12, opacity: 0.4 }}>◌</div>
            <div>{lang === 'zh' ? '点击任一节点以聚焦' : 'Tap any node to focus'}</div>
            <div className="mono-cap" style={{ marginTop: 6 }}>
              {lang === 'zh' ? '1 跳邻域将被高亮' : '1-hop neighborhood will highlight'}
            </div>
          </div>
        ) : (
          <NodeInspector node={sel} t={t} lang={lang} edges={edges} nodes={nodes} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pan/zoom toolbar button.
// ---------------------------------------------------------------------------

function GraphCtrlBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      // Don't let a click on the toolbar start a background pan on the svg.
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        width: 30,
        height: 30,
        display: 'grid',
        placeItems: 'center',
        background: 'color-mix(in oklab, var(--bg-1) 80%, transparent)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-2)',
        color: 'var(--fg-2)',
        fontSize: 16,
        lineHeight: 1,
        cursor: 'pointer',
        backdropFilter: 'blur(4px)',
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Neo4j status badge — connected / unreachable / disabled. Renders always.
// ---------------------------------------------------------------------------

function Neo4jBadge({
  state,
  lang,
  t,
}: {
  state: 'connected' | 'unreachable' | 'disabled';
  lang: Lang;
  t: Strings;
}) {
  const color =
    state === 'connected'
      ? KIND_COLOR.action
      : state === 'unreachable'
        ? KIND_COLOR.event
        : 'var(--fg-4)';
  const label =
    state === 'connected'
      ? lang === 'zh'
        ? '已连接'
        : 'connected'
      : state === 'unreachable'
        ? lang === 'zh'
          ? '不可达'
          : 'unreachable'
        : lang === 'zh'
          ? '未启用'
          : 'disabled';
  return (
    <span
      title={t.neo4jStatus}
      className="mono-cap"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 9px',
        borderRadius: 999,
        background: 'var(--bg-2)',
        border: `1px solid ${color}`,
        color,
        marginRight: 4,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: color,
          boxShadow: state === 'connected' ? `0 0 6px ${color}` : 'none',
        }}
      />
      Neo4j · {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Node glyph (label/icon inside the circle) — per kind.
// ---------------------------------------------------------------------------

function NodeGlyph({ node, r }: { node: GNode; r: number }) {
  if (node.kind === 'object') {
    return (
      <>
        {node.emoji ? (
          <text textAnchor="middle" dominantBaseline="middle" fontSize="14" y={-1}>
            {node.emoji}
          </text>
        ) : (
          <text
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="11"
            fill={kindColor('object')}
            fontFamily="var(--font-mono)"
            fontWeight="700"
          >
            {node.label.slice(0, 2).toUpperCase()}
          </text>
        )}
        <text
          textAnchor="middle"
          y={r + 12}
          fontSize="10"
          fill="var(--fg-2)"
          fontFamily="var(--font-mono)"
        >
          {truncate(node.label, 14)}
        </text>
      </>
    );
  }
  const glyph =
    node.kind === 'rule'
      ? '§'
      : node.kind === 'action'
        ? '▶'
        : node.kind === 'event'
          ? '◆'
          : '↻'; // process
  return (
    <>
      <text
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="11"
        fill={kindColor(node.kind)}
        fontFamily="var(--font-mono)"
        fontWeight="700"
      >
        {glyph}
      </text>
      <text
        textAnchor="middle"
        y={r + 11}
        fontSize="9"
        fill="var(--fg-3)"
        fontFamily="var(--font-mono)"
      >
        {truncate(node.label, 12)}
      </text>
    </>
  );
}

function nodeRadius(n: GNode): number {
  if (n.kind === 'object') return 22 + Math.min(8, n.weight * 1.2);
  if (n.kind === 'process') return 18;
  if (n.kind === 'action') return 16;
  return 12; // rule, event
}

// ---------------------------------------------------------------------------
// Inspector — per-kind detail + connected chips. Extends to actions + events.
// ---------------------------------------------------------------------------

interface NodeInspectorProps {
  node: GNode;
  t: Strings;
  lang: Lang;
  edges: GEdge[];
  nodes: GNode[];
}

function NodeInspector({ node, t, lang, edges, nodes }: NodeInspectorProps) {
  const connected = edges
    .filter((e) => e.from === node.id || e.to === node.id)
    .map((e) => {
      const otherId = e.from === node.id ? e.to : e.from;
      return nodes.find((n) => n.id === otherId);
    })
    .filter((n): n is GNode => Boolean(n));

  const kindLabel = KIND_LABEL[node.kind][lang];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: 'var(--bg-2)',
            border: `1px solid ${kindColor(node.kind)}`,
            display: 'grid',
            placeItems: 'center',
            color: kindColor(node.kind),
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            fontSize: 14,
            flexShrink: 0,
          }}
        >
          {node.kind === 'object'
            ? node.emoji ?? '◻'
            : node.kind === 'rule'
              ? '§'
              : node.kind === 'action'
                ? '▶'
                : node.kind === 'event'
                  ? '◆'
                  : '↻'}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {node.label}
          </div>
          <div className="mono-cap">{kindLabel}</div>
        </div>
      </div>

      {node.kind === 'object' && <ObjectDetail o={node.ref as ObjectType} t={t} lang={lang} />}
      {node.kind === 'rule' && <RuleDetail r={node.ref as Rule} t={t} lang={lang} />}
      {node.kind === 'action' && <ActionDetail a={node.ref as ActionType} t={t} lang={lang} />}
      {node.kind === 'event' && <EventDetail e={node.ref as EventType} t={t} lang={lang} />}
      {node.kind === 'process' && <ProcessDetail p={node.ref as Process} t={t} lang={lang} />}

      <div>
        <div className="mono-cap" style={{ marginBottom: 6 }}>
          {lang === 'zh' ? '相连节点' : 'Connected'} · {connected.length}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {connected.slice(0, 16).map((c, i) => (
            <span
              key={c.id + ':' + i}
              style={{
                padding: '3px 8px',
                borderRadius: 999,
                background: 'var(--bg-1)',
                border: `1px solid ${kindColor(c.kind)}`,
                color: kindColor(c.kind),
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
              }}
            >
              {truncate(c.label, 16)}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function ObjectDetail({ o, t, lang }: { o: ObjectType; t: Strings; lang: Lang }) {
  return (
    <div>
      {lang === 'zh' && o.nameZh && (
        <div style={{ fontSize: 12, color: 'var(--fg-3)', marginBottom: 8 }}>{o.nameZh}</div>
      )}
      <div className="mono-cap" style={{ marginBottom: 6 }}>
        {t.attributes} · {o.properties.length}
      </div>
      <div className="scroll" style={{ maxHeight: 220, display: 'grid', gap: 4 }}>
        {o.properties.map((p, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 8,
              padding: '4px 8px',
              background: 'var(--bg-1)',
              borderRadius: 4,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {p.name === o.primary_key ? '◆ ' : p.is_foreign_key ? '◇ ' : ''}
              {p.name}
            </span>
            <span style={{ color: 'var(--fg-4)', flexShrink: 0 }}>
              {p.is_foreign_key ? 'FK · ' : ''}
              {p.type}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RuleDetail({ r, t, lang }: { r: Rule; t: Strings; lang: Lang }) {
  return (
    <div>
      <div className="mono-cap" style={{ marginBottom: 6 }}>
        {t.rulePlain} · {t[SEV_KEY[r.severity]]}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--fg-2)' }}>
        {r.statement[lang] || r.statement.en}
      </div>
      {r.formal && (
        <>
          <div className="mono-cap" style={{ margin: '10px 0 6px' }}>
            {t.ruleFormal}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--accent-3)',
              background: 'var(--bg)',
              padding: 8,
              borderRadius: 4,
              border: '1px solid var(--line)',
              wordBreak: 'break-word',
            }}
          >
            {r.formal}
          </div>
        </>
      )}
    </div>
  );
}

function ActionDetail({ a, t, lang }: { a: ActionType; t: Strings; lang: Lang }) {
  return (
    <div>
      <div className="mono-cap" style={{ marginBottom: 6 }}>
        {t.toolName}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: KIND_COLOR.action,
          background: 'var(--bg)',
          padding: '4px 8px',
          borderRadius: 4,
          border: '1px solid var(--line)',
          marginBottom: 10,
          wordBreak: 'break-all',
        }}
      >
        {a.agent.toolName}
      </div>
      <div className="mono-cap" style={{ marginBottom: 6 }}>
        {t.actionSteps} · {a.steps.length}
      </div>
      <ol
        className="scroll"
        style={{
          paddingLeft: 18,
          margin: 0,
          maxHeight: 180,
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--fg-2)',
        }}
      >
        {a.steps.map((s) => (
          <li key={s.order}>{s.text[lang] || s.text.en}</li>
        ))}
      </ol>
    </div>
  );
}

function EventDetail({ e, t, lang }: { e: EventType; t: Strings; lang: Lang }) {
  return (
    <div>
      {lang === 'zh' && e.nameZh && (
        <div style={{ fontSize: 12, color: 'var(--fg-3)', marginBottom: 8 }}>{e.nameZh}</div>
      )}
      <div className="mono-cap" style={{ marginBottom: 6 }}>
        {t.payload} · {e.payload.length}
      </div>
      <div className="scroll" style={{ maxHeight: 200, display: 'grid', gap: 4 }}>
        {e.payload.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--fg-4)', fontFamily: 'var(--font-mono)' }}>
            —
          </div>
        ) : (
          e.payload.map((f, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                padding: '4px 8px',
                background: 'var(--bg-1)',
                borderRadius: 4,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
              <span style={{ color: 'var(--fg-4)', flexShrink: 0 }}>{f.type}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ProcessDetail({ p, t, lang }: { p: Process; t: Strings; lang: Lang }) {
  return (
    <div>
      <div className="mono-cap" style={{ marginBottom: 6 }}>
        {t.procActors}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
        {p.actors.map((ac, i) => (
          <span key={i} className="tag">
            {lang === 'zh' ? ac.roleZh ?? ac.role : ac.role}
          </span>
        ))}
      </div>
      <div className="mono-cap" style={{ marginBottom: 6 }}>
        {t.procSteps} · {p.steps.length}
      </div>
      <ol
        className="scroll"
        style={{
          paddingLeft: 18,
          margin: 0,
          maxHeight: 180,
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--fg-2)',
        }}
      >
        {p.steps.map((s) => (
          <li key={s.id}>{s.actionTypeId.replace(/^action:/, '')}</li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Static label tables
// ---------------------------------------------------------------------------

const FILTERS: { key: NodeKind; label: { en: string; zh: string } }[] = [
  { key: 'object', label: { en: 'Objects', zh: '对象' } },
  { key: 'rule', label: { en: 'Rules', zh: '规则' } },
  { key: 'action', label: { en: 'Actions', zh: '动作' } },
  { key: 'event', label: { en: 'Events', zh: '事件' } },
  { key: 'process', label: { en: 'Processes', zh: '流程' } },
];

const KIND_LABEL: Record<NodeKind, { en: string; zh: string }> = {
  object: { en: 'object', zh: '对象' },
  rule: { en: 'rule', zh: '规则' },
  action: { en: 'action', zh: '动作' },
  event: { en: 'event', zh: '事件' },
  process: { en: 'process', zh: '流程' },
};

const SEV_KEY: Record<Rule['severity'], 'sevInfo' | 'sevWarn' | 'sevBlock'> = {
  info: 'sevInfo',
  warn: 'sevWarn',
  block: 'sevBlock',
};

// ---------------------------------------------------------------------------
// Layout algorithms — force / radial / hierarchical / clustered.
// Five kinds: arrange in a deterministic order so tiers/clusters stay readable.
// ---------------------------------------------------------------------------

const KIND_ORDER: NodeKind[] = ['object', 'rule', 'action', 'event', 'process'];

function computeLayout(nodes: GNode[], edges: GEdge[], mode: LayoutMode): Positions {
  const cx = W / 2;
  const cy = H / 2;
  const out: Positions = {};

  if (mode === 'radial') {
    // Objects on the central ring; the four derived kinds on an outer ring,
    // each occupying its own arc segment.
    const objs = nodes.filter((n) => n.kind === 'object');
    placeOnArc(objs, cx, cy, 190, 0, 2 * Math.PI, out);
    const outerKinds: NodeKind[] = ['rule', 'action', 'event', 'process'];
    outerKinds.forEach((kind, idx) => {
      const list = nodes.filter((n) => n.kind === kind);
      const seg = (2 * Math.PI) / outerKinds.length;
      const start = -Math.PI / 2 + idx * seg + seg * 0.08;
      const end = start + seg * 0.84;
      placeOnArc(list, cx, cy, 320, start, end, out);
    });
    return out;
  }

  if (mode === 'hierarchical') {
    // Five tiers across the width in canonical order.
    const cols = KIND_ORDER.length;
    KIND_ORDER.forEach((kind, ci) => {
      const list = nodes.filter((n) => n.kind === kind);
      const x = 120 + (ci + 0.5) * ((W - 240) / cols);
      list.forEach((n, i) => {
        const y = 90 + (i + 0.5) * ((H - 180) / Math.max(1, list.length));
        out[n.id] = { x, y };
      });
    });
    return out;
  }

  if (mode === 'clustered') {
    // One cluster centroid per kind, ringed around the canvas center.
    const present = KIND_ORDER.filter((k) => nodes.some((n) => n.kind === k));
    present.forEach((kind, idx) => {
      const angle = -Math.PI / 2 + (idx / Math.max(1, present.length)) * 2 * Math.PI;
      const gx = cx + Math.cos(angle) * 230;
      const gy = cy + Math.sin(angle) * 170;
      const list = nodes.filter((n) => n.kind === kind);
      const radius = Math.min(150, 50 + list.length * 8);
      placeOnArc(list, gx, gy, radius, 0, 2 * Math.PI, out);
    });
    return out;
  }

  // default: force
  return forceLayout(nodes, edges);
}

function placeOnArc(
  list: GNode[],
  cx: number,
  cy: number,
  radius: number,
  start: number,
  end: number,
  out: Positions,
): void {
  list.forEach((n, i) => {
    const tt = list.length === 1 ? 0.5 : i / (list.length - 1);
    const angle = start + (end - start) * tt;
    out[n.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
}

function forceLayout(nodes: GNode[], edges: GEdge[]): Positions {
  // Deterministic seed (hash-spread) + Fruchterman-Reingold-ish relaxation.
  const pos: Record<string, { x: number; y: number; vx: number; vy: number }> = {};
  nodes.forEach((n) => {
    const h = simpleHash(n.id);
    pos[n.id] = {
      x: W * 0.1 + ((h % 1000) / 1000) * W * 0.8,
      y: H * 0.1 + (((h >> 10) % 1000) / 1000) * H * 0.8,
      vx: 0,
      vy: 0,
    };
  });
  const iter = 380;
  const k = 150; // ideal edge length
  for (let it = 0; it < iter; it++) {
    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos[nodes[i].id];
        const b = pos[nodes[j].id];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy + 0.01;
        const d = Math.sqrt(d2);
        const f = (k * k * 2.5) / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }
    // Attraction along edges
    edges.forEach((e) => {
      const a = pos[e.from];
      const b = pos[e.to];
      if (!a || !b) return;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d * d) / (k * 2);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx -= fx * 0.3;
      a.vy -= fy * 0.3;
      b.vx += fx * 0.3;
      b.vy += fy * 0.3;
    });
    // Weak centering
    const cx = W / 2;
    const cy = H / 2;
    nodes.forEach((n) => {
      const p = pos[n.id];
      p.vx += (cx - p.x) * 0.002;
      p.vy += (cy - p.y) * 0.002;
    });
    // Apply with cooling
    const damp = Math.max(0.03, 1 - it / iter) * 0.15;
    nodes.forEach((n) => {
      const p = pos[n.id];
      p.x += p.vx * damp;
      p.y += p.vy * damp;
      p.vx = 0;
      p.vy = 0;
      p.x = Math.max(70, Math.min(W - 70, p.x));
      p.y = Math.max(70, Math.min(H - 70, p.y));
    });
  }
  const out: Positions = {};
  nodes.forEach((n) => {
    out[n.id] = { x: pos[n.id].x, y: pos[n.id].y };
  });
  return out;
}

function simpleHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

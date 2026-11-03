import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  collection, query, orderBy, limit, onSnapshot, where, Timestamp
} from "firebase/firestore";
import { db } from "../firebase";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, AreaChart, Area,
  ComposedChart, Legend
} from "recharts";
import { jsPDF } from "jspdf";
import {
  Calendar, Download, Activity, Thermometer, Droplets,
  AlertTriangle, ChevronLeft, ChevronRight, TrendingUp,
  TrendingDown, Minus, Settings, FileText, Filter,
  Clock, Heart, RefreshCw, ChevronDown, ChevronUp,
  Info, BarChart2, Radio, Zap, X, ShieldCheck, CheckCircle2,
  Stethoscope, Layers, Award, AlertCircle, Eye, Printer, Maximize2
} from "lucide-react";

// ─────────────────────────────────────────────
//  Clinical Constants & Reference Baselines
// ─────────────────────────────────────────────
const DEFAULT_THRESHOLDS = {
  hrMin: 60,
  hrMax: 100,
  spo2Min: 95,
  tempMin: 36.1,
  tempMax: 37.5,
};

const TIME_FILTERS = [
  { key: "24h",    label: "24 Hours" },
  { key: "7d",     label: "7 Days"   },
  { key: "30d",    label: "30 Days"  },
  { key: "90d",    label: "90 Days"  },
  { key: "custom", label: "Custom"   },
];

const PAGE_SIZE = 20;

// ─────────────────────────────────────────────
//  Pure Clinical Helper Functions
// ─────────────────────────────────────────────
function getDateRange(filter, customStart, customEnd) {
  const now = new Date();
  switch (filter) {
    case "24h":   return { start: new Date(now - 24 * 3600e3), end: now };
    case "7d":    return { start: new Date(now - 7  * 24 * 3600e3), end: now };
    case "30d":   return { start: new Date(now - 30 * 24 * 3600e3), end: now };
    case "90d":   return { start: new Date(now - 90 * 24 * 3600e3), end: now };
    case "custom":
      if (customStart && customEnd)
        return { start: new Date(customStart), end: new Date(customEnd + "T23:59:59") };
      return { start: new Date(now - 7 * 24 * 3600e3), end: now };
    default:      return { start: new Date(now - 7 * 24 * 3600e3), end: now };
  }
}

function fmtChart(ts, filter) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (filter === "24h") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
         d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtTimeShort(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function isAbnormal(r, t) {
  const hrBad   = r.heartRate > 0 && (r.heartRate < t.hrMin  || r.heartRate > t.hrMax);
  const spo2Bad = r.spo2 > 0      && r.spo2 < t.spo2Min;
  const tempBad = r.bodyTemp > 0  && (r.bodyTemp < t.tempMin || r.bodyTemp > t.tempMax);
  return hrBad || spo2Bad || tempBad;
}

function getStatus(r, t) {
  if (!isAbnormal(r, t)) return { label: "Normal",   cls: "bg-emerald-50 text-emerald-700 border-emerald-200" };
  const critical = (r.spo2 > 0 && r.spo2 < 90) ||
                   (r.heartRate > 0 && (r.heartRate < 40 || r.heartRate > 150)) ||
                   (r.bodyTemp > 0 && (r.bodyTemp < 35 || r.bodyTemp > 39));
  if (critical) return { label: "Critical", cls: "bg-rose-100 text-rose-800 border-rose-200" };
  return { label: "Warning",  cls: "bg-amber-50 text-amber-700 border-amber-200" };
}

// Detailed statistical computation (Mean, Min, Max, Latest, StdDev, Time-in-Target)
function calcDetailedStats(records, key, minThresh, maxThresh) {
  const vals = records.map(r => r[key]).filter(v => typeof v === "number" && v > 0);
  if (!vals.length) {
    return { avg: null, min: null, max: null, latest: null, stdDev: null, inTargetPct: null, count: 0 };
  }
  const count = vals.length;
  const avg = +(vals.reduce((a, b) => a + b, 0) / count).toFixed(1);
  const min = +Math.min(...vals).toFixed(1);
  const max = +Math.max(...vals).toFixed(1);
  const latest = vals[0] ?? null;

  // Standard deviation
  const variance = vals.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / count;
  const stdDev = +Math.sqrt(variance).toFixed(1);

  // Time in target (% of readings within thresholds)
  let inTargetCount = 0;
  for (const v of vals) {
    const isOk = (minThresh == null || v >= minThresh) && (maxThresh == null || v <= maxThresh);
    if (isOk) inTargetCount++;
  }
  const inTargetPct = Math.round((inTargetCount / count) * 100);

  return { avg, min, max, latest, stdDev, inTargetPct, count };
}

function calcChange(records, key) {
  const vals = records.map(r => r[key]).filter(v => typeof v === "number" && v > 0);
  if (vals.length < 4) return null;
  const half = Math.floor(vals.length / 2);
  const a = vals.slice(0, half).reduce((s, v) => s + v, 0) / half;
  const b = vals.slice(half).reduce((s, v) => s + v, 0) / (vals.length - half);
  return +(a - b).toFixed(1);
}

// Compute Overall Health Stability Index (0 - 100)
function calcHealthStabilityScore(hrStats, spo2Stats, tempStats, abnormalCount, totalCount) {
  if (totalCount === 0) return { score: 100, label: "Awaiting Data", status: "Neutral", color: "blue" };

  const spo2Weight = (spo2Stats.inTargetPct ?? 100) * 0.40;
  const hrWeight   = (hrStats.inTargetPct   ?? 100) * 0.35;
  const tempWeight = (tempStats.inTargetPct ?? 100) * 0.25;

  let score = Math.round(spo2Weight + hrWeight + tempWeight);
  const abnormalRatio = abnormalCount / totalCount;
  if (abnormalRatio > 0.1) score = Math.max(20, score - Math.round(abnormalRatio * 20));

  if (score >= 90) return { score, label: "Optimal Stability", status: "Optimal", color: "emerald" };
  if (score >= 75) return { score, label: "Clinically Stable", status: "Controlled", color: "blue" };
  if (score >= 60) return { score, label: "Mild Fluctuation", status: "Fluctuating", color: "amber" };
  return { score, label: "Attention Needed", status: "Unstable", color: "rose" };
}

// Clinical interpretation narrative builder
function generateClinicalInsights(hrStats, spo2Stats, tempStats, abnormalRecords, totalRecords) {
  if (totalRecords === 0) return ["No telemetry logs recorded for the selected monitoring window."];
  const insights = [];

  // SpO2 Analysis
  if (spo2Stats.avg !== null) {
    if (spo2Stats.avg >= 97) {
      insights.push(`Oxygenation Performance: Excellent arterial oxygenation (Mean ${spo2Stats.avg}%, TIR ${spo2Stats.inTargetPct}%). No chronic hypoxemic events observed.`);
    } else if (spo2Stats.avg >= 95) {
      insights.push(`Oxygenation Performance: Systemic blood oxygen saturation maintained within target limits (Mean ${spo2Stats.avg}%, Min ${spo2Stats.min}%).`);
    } else {
      insights.push(`Oxygenation Alert: Sub-target saturation detected (Mean ${spo2Stats.avg}%, Lowest recorded ${spo2Stats.min}%). Clinical review of pulmonary status recommended.`);
    }
  }

  // Heart Rate Analysis
  if (hrStats.avg !== null) {
    if (hrStats.avg >= 60 && hrStats.avg <= 90) {
      insights.push(`Cardiac Rhythm Dynamics: Stable resting heart rate (Mean ${hrStats.avg} bpm, SD ±${hrStats.stdDev} bpm, Range ${hrStats.min}–${hrStats.max} bpm). Chronotropic balance is intact.`);
    } else if (hrStats.avg > 90) {
      insights.push(`Cardiac Alert: Tachycardic trend identified (Mean ${hrStats.avg} bpm, Peak ${hrStats.max} bpm). Review potential triggers such as exertion, stress, or pyrexia.`);
    } else {
      insights.push(`Cardiac Notice: Sinus bradycardia tendency (Mean ${hrStats.avg} bpm, Min ${hrStats.min} bpm). Correlate with athletic fitness baseline or pharmacological regimen.`);
    }
  }

  // Body Temperature Analysis
  if (tempStats.avg !== null) {
    if (tempStats.max > 37.8) {
      insights.push(`Thermoregulatory Alert: Pyretic peak detected (${tempStats.max} °C). Clinical evaluation for infectious or inflammatory response advised.`);
    } else if (tempStats.avg >= 36.1 && tempStats.avg <= 37.4) {
      insights.push(`Thermal Homeostasis: Normothermic profile (Mean ${tempStats.avg} °C, Variance ±${tempStats.stdDev} °C). Baseline temperature regulation is normal.`);
    } else {
      insights.push(`Thermal Profile: Mean temperature of ${tempStats.avg} °C (Min ${tempStats.min} °C, Max ${tempStats.max} °C). Thermal variance is controlled.`);
    }
  }

  // Overall Concordance
  if (abnormalRecords.length === 0) {
    insights.push(`Telemetry Compliance: 100% adherence to all clinical safety thresholds across ${totalRecords} continuous records.`);
  } else {
    const pct = ((abnormalRecords.length / totalRecords) * 100).toFixed(1);
    insights.push(`Threshold Excursions: ${abnormalRecords.length} records (${pct}% of telemetry) recorded outside nominal ranges. Individual events logged below.`);
  }

  return insights;
}

// ─────────────────────────────────────────────
//  Sub-components & Visual Cards
// ─────────────────────────────────────────────

function LiveTelemetryBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-200 border border-emerald-400/30 text-[11px] sm:text-xs font-semibold backdrop-blur-sm">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"/>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"/>
      </span>
      <span>Live Stream Active</span>
    </span>
  );
}

function ChangePill({ value }) {
  if (value === null || value === undefined) return null;
  const up   = value > 0;
  const zero = value === 0;
  return (
    <div className={"inline-flex items-center gap-1 text-[11px] sm:text-xs font-bold px-2 py-0.5 rounded-full " + (
      zero ? "bg-slate-100 text-slate-500"
           : up ? "bg-amber-50 text-amber-600 border border-amber-200"
                : "bg-emerald-50 text-emerald-600 border border-emerald-200"
    )}>
      {zero ? <Minus size={10}/> : up ? <TrendingUp size={10}/> : <TrendingDown size={10}/>}
      <span>{up ? "+" : ""}{value}</span>
    </div>
  );
}

function AbnormalDot({ cx, cy, payload }) {
  if (!payload || !payload.abnormal) return null;
  return <circle cx={cx} cy={cy} r={4.5} fill="#ef4444" stroke="#fff" strokeWidth={2}/>;
}

function ProfessionalChartTip({ active, payload, label, unit }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0];
  const isAbn = p.payload && p.payload.abnormal;
  return (
    <div className="bg-slate-900/95 backdrop-blur-md text-white border border-slate-700 rounded-xl shadow-2xl px-3.5 py-2.5 text-xs min-w-[130px] max-w-[220px]">
      <p className="text-slate-400 mb-1 font-medium text-[11px] truncate">{label}</p>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-slate-300 font-semibold truncate">{p.name || "Reading"}:</span>
        <span className="text-sm font-bold text-white tabular-nums shrink-0">
          {p.value} <span className="text-[10px] font-normal text-slate-300">{unit}</span>
        </span>
      </div>
      {isAbn && (
        <div className="mt-1.5 pt-1.5 border-t border-slate-800 flex items-center gap-1 text-rose-400 font-semibold text-[10px]">
          <AlertTriangle size={11} className="shrink-0"/>
          <span>Outside reference baseline</span>
        </div>
      )}
    </div>
  );
}

// Production-Grade Metric Card with In-Depth Clinical Stats & Responsive Layout
function ClinicalMetricCard({ icon, label, value, unit, color, stats, change, sparkData, sparkKey, threshLabel }) {
  const themes = {
    rose: {
      bar: "from-rose-500 to-red-600",
      iconBg: "bg-rose-50 text-rose-600",
      stroke: "#f43f5e",
      tirBar: "bg-rose-500",
    },
    sky: {
      bar: "from-sky-500 to-blue-600",
      iconBg: "bg-sky-50 text-sky-600",
      stroke: "#0284c7",
      tirBar: "bg-sky-500",
    },
    amber: {
      bar: "from-amber-400 to-orange-500",
      iconBg: "bg-amber-50 text-amber-600",
      stroke: "#d97706",
      tirBar: "bg-amber-500",
    },
  };
  const theme = themes[color] || themes.sky;

  return (
    <div className="bg-white rounded-3xl border border-slate-200/70 shadow-sm hover:shadow-md transition-all duration-300 overflow-hidden flex flex-col justify-between">
      {/* Top accent bar */}
      <div className={"h-1.5 w-full bg-gradient-to-r " + theme.bar}/>

      <div className="p-4 sm:p-5 flex-1 flex flex-col justify-between">
        {/* Header */}
        <div>
          <div className="flex items-center justify-between mb-2 sm:mb-3">
            <div>
              <span className="text-[11px] sm:text-xs font-bold text-slate-400 tracking-wider uppercase block">{label}</span>
              <span className="text-[10px] sm:text-[11px] text-slate-500 font-medium">Ref: {threshLabel}</span>
            </div>
            <div className={"w-9 h-9 sm:w-10 sm:h-10 rounded-2xl flex items-center justify-center shrink-0 " + theme.iconBg}>
              {icon}
            </div>
          </div>

          {/* Current reading */}
          <div className="flex items-baseline gap-2 mb-3 flex-wrap">
            <span className="text-3xl sm:text-4xl font-extrabold text-slate-900 tabular-nums tracking-tight">
              {value !== null && value !== undefined ? value : "—"}
            </span>
            <span className="text-xs sm:text-sm font-semibold text-slate-500">{unit}</span>
            <div className="ml-auto">
              <ChangePill value={change}/>
            </div>
          </div>

          {/* Time In Target Progress Bar */}
          <div className="mb-3.5 bg-slate-50 rounded-xl p-2.5 border border-slate-100">
            <div className="flex justify-between items-center text-[11px] sm:text-xs mb-1.5">
              <span className="text-slate-600 font-medium">Time in Target (TIR)</span>
              <span className="font-bold text-slate-900 tabular-nums">
                {stats?.inTargetPct != null ? `${stats.inTargetPct}%` : "—"}
              </span>
            </div>
            <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
              <div
                className={"h-full rounded-full transition-all duration-500 " + theme.tirBar}
                style={{ width: `${stats?.inTargetPct || 0}%` }}
              />
            </div>
          </div>
        </div>

        {/* Statistical Grid (Responsive: 2-col on small mobile, 4-col on tablet/desktop) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-100 text-center">
          <div className="bg-slate-50/70 p-2 rounded-xl">
            <p className="text-[10px] text-slate-400 font-semibold uppercase">Mean</p>
            <p className="text-xs font-bold text-slate-800 mt-0.5 tabular-nums">
              {stats?.avg != null ? stats.avg : "—"}
            </p>
          </div>
          <div className="bg-slate-50/70 p-2 rounded-xl">
            <p className="text-[10px] text-slate-400 font-semibold uppercase">Std Dev</p>
            <p className="text-xs font-bold text-slate-800 mt-0.5 tabular-nums">
              {stats?.stdDev != null ? `±${stats.stdDev}` : "—"}
            </p>
          </div>
          <div className="bg-slate-50/70 p-2 rounded-xl">
            <p className="text-[10px] text-slate-400 font-semibold uppercase">Min</p>
            <p className="text-xs font-bold text-slate-800 mt-0.5 tabular-nums">
              {stats?.min != null ? stats.min : "—"}
            </p>
          </div>
          <div className="bg-slate-50/70 p-2 rounded-xl">
            <p className="text-[10px] text-slate-400 font-semibold uppercase">Max</p>
            <p className="text-xs font-bold text-slate-800 mt-0.5 tabular-nums">
              {stats?.max != null ? stats.max : "—"}
            </p>
          </div>
        </div>
      </div>

      {/* Sparkline mini-visualizer */}
      {sparkData && sparkData.length > 2 && (
        <div className="h-10 sm:h-12 w-full opacity-60 hover:opacity-90 transition-opacity">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`grad-${sparkKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={theme.stroke} stopOpacity={0.3}/>
                  <stop offset="100%" stopColor={theme.stroke} stopOpacity={0.0}/>
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey={sparkKey} stroke={theme.stroke} strokeWidth={2} fill={`url(#grad-${sparkKey})`} dot={false} isAnimationActive={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
//  Main Component: HistoryView
// ─────────────────────────────────────────────
export default function HistoryView({ currentUser }) {
  // ── Core Telemetry State ──
  const [records, setRecords]               = useState([]);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState(null);
  const [isLive, setIsLive]                 = useState(false);
  const [lastRefresh, setLastRefresh]       = useState(null);

  // ── Filters & Configuration ──
  const [timeFilter, setTimeFilter]         = useState("7d");
  const [customStart, setCustomStart]       = useState("");
  const [customEnd, setCustomEnd]           = useState("");
  const [chartViewMode, setChartViewMode]   = useState("single"); // 'single' | 'multi'
  const [activeChart, setActiveChart]       = useState("hr");     // 'hr' | 'spo2' | 'temp'

  // ── Table State ──
  const [sortField, setSortField]           = useState("timestamp");
  const [sortDir, setSortDir]               = useState("desc");
  const [page, setPage]                     = useState(1);

  // ── UI Controls & Thresholds ──
  const [showThresholds, setShowThresholds] = useState(false);
  const [thresholds, setThresholds]         = useState(DEFAULT_THRESHOLDS);
  const [showAbnormal, setShowAbnormal]     = useState(false);
  const [generatingPDF, setGeneratingPDF]   = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  const unsubRef = useRef(null);

  // ── Realtime Data Subscription ──
  const subscribe = useCallback(() => {
    if (!currentUser?.uid) return;

    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }

    setLoading(true);
    setError(null);
    setPage(1);
    setIsLive(false);

    try {
      const { start, end } = getDateRange(timeFilter, customStart, customEnd);
      const histRef = collection(db, "users", currentUser.uid, "vitalsHistory");
      const q = query(
        histRef,
        where("timestamp", ">=", Timestamp.fromDate(start)),
        where("timestamp", "<=", Timestamp.fromDate(end)),
        orderBy("timestamp", "desc"),
        limit(500)
      );

      unsubRef.current = onSnapshot(
        q,
        (snap) => {
          const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          setRecords(docs);
          setLoading(false);
          setIsLive(true);
          setLastRefresh(new Date());
          setError(null);
        },
        (err) => {
          console.error("HistoryView realtime snapshot error:", err);
          setError("Failed to stream telemetry records. Check network connectivity.");
          setLoading(false);
          setIsLive(false);
        }
      );
    } catch (e) {
      console.error("HistoryView subscription setup error:", e);
      setError("Failed to initialize telemetry listener.");
      setLoading(false);
    }
  }, [currentUser?.uid, timeFilter, customStart, customEnd]);

  useEffect(() => {
    subscribe();
    return () => {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      setIsLive(false);
    };
  }, [subscribe]);

  // ── In-Depth Clinical Analytics ──
  const hrStats = useMemo(
    () => calcDetailedStats(records, "heartRate", thresholds.hrMin, thresholds.hrMax),
    [records, thresholds.hrMin, thresholds.hrMax]
  );

  const spo2Stats = useMemo(
    () => calcDetailedStats(records, "spo2", thresholds.spo2Min, null),
    [records, thresholds.spo2Min]
  );

  const tempStats = useMemo(
    () => calcDetailedStats(records, "bodyTemp", thresholds.tempMin, thresholds.tempMax),
    [records, thresholds.tempMin, thresholds.tempMax]
  );

  const hrChange   = useMemo(() => calcChange(records, "heartRate"), [records]);
  const spo2Change = useMemo(() => calcChange(records, "spo2"),      [records]);
  const tempChange = useMemo(() => calcChange(records, "bodyTemp"),  [records]);

  const abnormalRecords = useMemo(
    () => records.filter(r => isAbnormal(r, thresholds)),
    [records, thresholds]
  );

  const stability = useMemo(
    () => calcHealthStabilityScore(hrStats, spo2Stats, tempStats, abnormalRecords.length, records.length),
    [hrStats, spo2Stats, tempStats, abnormalRecords.length, records.length]
  );

  const clinicalInsights = useMemo(
    () => generateClinicalInsights(hrStats, spo2Stats, tempStats, abnormalRecords, records.length),
    [hrStats, spo2Stats, tempStats, abnormalRecords, records.length]
  );

  // Chronological chart data
  const chartData = useMemo(() =>
    [...records].reverse().map(r => ({
      time:     fmtChart(r.timestamp, timeFilter),
      hr:       r.heartRate || null,
      spo2:     r.spo2      || null,
      temp:     r.bodyTemp  || null,
      abnormal: isAbnormal(r, thresholds),
    })),
    [records, timeFilter, thresholds]
  );

  // Sorted Table Records
  const sortedRecords = useMemo(() => {
    const copy = [...records];
    copy.sort((a, b) => {
      let av = 0, bv = 0;
      if (sortField === "timestamp") {
        av = a.timestamp?.seconds || 0;
        bv = b.timestamp?.seconds || 0;
      } else {
        av = a[sortField] || 0;
        bv = b[sortField] || 0;
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return copy;
  }, [records, sortField, sortDir]);

  const totalPages   = Math.max(1, Math.ceil(sortedRecords.length / PAGE_SIZE));
  const pagedRecords = sortedRecords.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Single Chart Configuration
  const CHARTS = {
    hr: {
      label: "Heart Rate",
      unit: "bpm",
      color: "#f43f5e",
      dataKey: "hr",
      refMin: thresholds.hrMin,
      refMax: thresholds.hrMax,
      domain: [40, 160],
    },
    spo2: {
      label: "Blood Oxygen (SpO₂)",
      unit: "%",
      color: "#0284c7",
      dataKey: "spo2",
      refMin: thresholds.spo2Min,
      refMax: null,
      domain: [85, 102],
    },
    temp: {
      label: "Body Temperature",
      unit: "°C",
      color: "#d97706",
      dataKey: "temp",
      refMin: thresholds.tempMin,
      refMax: thresholds.tempMax,
      domain: [34, 41],
    },
  };
  const activeCfg = CHARTS[activeChart];

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  // ─────────────────────────────────────────────
  //  Hospital-Grade PDF Report Generation
  // ─────────────────────────────────────────────
  const generatePDF = async () => {
    setGeneratingPDF(true);
    try {
      const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      let y = 0;

      const ln = (n = 5) => { y += n; };
      const chkPage = (needed = 15) => {
        if (y + needed > ph - 25) {
          doc.addPage();
          drawReportHeaderSmall();
          y = 30;
        }
      };

      const reportId = "MDS-" + Math.floor(100000 + Math.random() * 900000);
      const generatedAt = new Date().toLocaleString();
      const { start, end } = getDateRange(timeFilter, customStart, customEnd);
      const periodLabel = TIME_FILTERS.find(f => f.key === timeFilter)?.label || timeFilter;

      // Draw Institutional Header Banner
      doc.setFillColor(15, 41, 66); // Medical Navy
      doc.rect(0, 0, pw, 38, "F");

      // Accent teal line
      doc.setFillColor(2, 132, 199); // Clinical Teal
      doc.rect(0, 38, pw, 2, "F");

      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(15);
      doc.text("MEDISENSE CLINICAL TELEMETRY & HEALTH ANALYTICS", 14, 15);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(203, 213, 225);
      doc.text("CONTINUOUS PHYSIOLOGICAL MONITORING & BIO-TELEMETRY REPORT", 14, 22);
      doc.text("IoT-Enabled Smart Healthcare Diagnostic Surveillance System", 14, 28);

      // Top Right Meta in Header
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(224, 242, 254);
      doc.text(`REPORT ID: ${reportId}`, pw - 14, 15, { align: "right" });
      doc.setFont("helvetica", "normal");
      doc.text(`SECURITY: CONFIDENTIAL MEDICAL RECORD`, pw - 14, 21, { align: "right" });
      doc.text(`GENERATED: ${generatedAt}`, pw - 14, 27, { align: "right" });

      y = 48;

      const drawReportHeaderSmall = () => {
        doc.setFillColor(15, 41, 66);
        doc.rect(0, 0, pw, 18, "F");
        doc.setFillColor(2, 132, 199);
        doc.rect(0, 18, pw, 1.2, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.text("MEDISENSE CLINICAL TELEMETRY AUDIT REPORT", 14, 11);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.text(`PATIENT: ${currentUser?.fullName || "ANONYMOUS"} | ${reportId}`, pw - 14, 11, { align: "right" });
      };

      // ── Section 1: Patient Demographics & Protocol Frame ──
      doc.setFillColor(248, 250, 252);
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(14, y, pw - 28, 38, 2, 2, "FD");

      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(15, 41, 66);
      doc.text("PATIENT DEMOGRAPHICS & TELEMETRY PROTOCOL", 18, y + 7);

      doc.setDrawColor(203, 213, 225);
      doc.line(18, y + 9, pw - 18, y + 9);

      doc.setFontSize(8.5);
      const col1 = 18;
      const col2 = 62;
      const col3 = 110;
      const col4 = 152;
      let py = y + 16;

      doc.setFont("helvetica", "bold"); doc.setTextColor(71, 85, 105);
      doc.text("Full Name:", col1, py);
      doc.setFont("helvetica", "normal"); doc.setTextColor(15, 23, 42);
      doc.text(currentUser?.fullName || "N/A", col2, py);

      doc.setFont("helvetica", "bold"); doc.setTextColor(71, 85, 105);
      doc.text("Monitoring Interval:", col3, py);
      doc.setFont("helvetica", "normal"); doc.setTextColor(15, 23, 42);
      doc.text(`${periodLabel} (${start.toLocaleDateString()} - ${end.toLocaleDateString()})`, col4, py);

      py += 6;
      doc.setFont("helvetica", "bold"); doc.setTextColor(71, 85, 105);
      doc.text("Patient Identifier:", col1, py);
      doc.setFont("helvetica", "normal"); doc.setTextColor(15, 23, 42);
      doc.text(currentUser?.uid ? currentUser.uid.substring(0, 14).toUpperCase() : "PT-MEDISENSE", col2, py);

      doc.setFont("helvetica", "bold"); doc.setTextColor(71, 85, 105);
      doc.text("Total Data Points:", col3, py);
      doc.setFont("helvetica", "normal"); doc.setTextColor(15, 23, 42);
      doc.text(`${records.length} Continuous Records`, col4, py);

      py += 6;
      doc.setFont("helvetica", "bold"); doc.setTextColor(71, 85, 105);
      doc.text("Assigned Device MAC:", col1, py);
      doc.setFont("helvetica", "normal"); doc.setTextColor(15, 23, 42);
      doc.text(currentUser?.connectedDeviceId || "IoT Biometric Sensor Node (Simulated)", col2, py);

      doc.setFont("helvetica", "bold"); doc.setTextColor(71, 85, 105);
      doc.text("Physician Linkage:", col3, py);
      doc.setFont("helvetica", "normal"); doc.setTextColor(15, 23, 42);
      doc.text(currentUser?.assignedDoctorId ? "Active Clinical Telemetry Link" : "Independent Patient Monitoring", col4, py);

      y += 46;

      // ── Section 2: Clinical Vital Signs Scorecard ──
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(15, 41, 66);
      doc.text("CLINICAL VITAL SIGNS SCORECARD & VARIABILITY ANALYSIS", 14, y);
      ln(5);

      const scCols = [14, 52, 82, 110, 134, 158, 180];
      const tableW = pw - 28;

      doc.setFillColor(30, 58, 138); // Deep Blue
      doc.rect(14, y, tableW, 7, "F");

      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.text("PHYSIOLOGICAL PARAMETER", scCols[0] + 2, y + 4.8);
      doc.text("CLINICAL TARGET", scCols[1], y + 4.8);
      doc.text("OBSERVED MEAN", scCols[2], y + 4.8);
      doc.text("RANGE (MIN - MAX)", scCols[3], y + 4.8);
      doc.text("LATEST", scCols[4], y + 4.8);
      doc.text("TIR (%)", scCols[5], y + 4.8);
      doc.text("STATUS", scCols[6], y + 4.8);

      y += 7;

      const scoreRows = [
        {
          param: "Heart Rate (Pulse)",
          ref: `${thresholds.hrMin} - ${thresholds.hrMax} bpm`,
          mean: hrStats.avg != null ? `${hrStats.avg} ± ${hrStats.stdDev} bpm` : "—",
          range: hrStats.min != null ? `${hrStats.min} - ${hrStats.max} bpm` : "—",
          latest: hrStats.latest != null ? `${hrStats.latest} bpm` : "—",
          tir: hrStats.inTargetPct != null ? `${hrStats.inTargetPct}%` : "—",
          status: hrStats.inTargetPct >= 90 ? "OPTIMAL" : hrStats.inTargetPct >= 75 ? "CONTROLLED" : "ATTENTION",
          statusColor: hrStats.inTargetPct >= 90 ? [22, 163, 74] : hrStats.inTargetPct >= 75 ? [2, 132, 199] : [220, 38, 38]
        },
        {
          param: "Blood Oxygen (SpO2)",
          ref: `≥ ${thresholds.spo2Min}%`,
          mean: spo2Stats.avg != null ? `${spo2Stats.avg} ± ${spo2Stats.stdDev}%` : "—",
          range: spo2Stats.min != null ? `${spo2Stats.min} - ${spo2Stats.max}%` : "—",
          latest: spo2Stats.latest != null ? `${spo2Stats.latest}%` : "—",
          tir: spo2Stats.inTargetPct != null ? `${spo2Stats.inTargetPct}%` : "—",
          status: spo2Stats.inTargetPct >= 95 ? "OPTIMAL" : spo2Stats.inTargetPct >= 85 ? "CONTROLLED" : "ATTENTION",
          statusColor: spo2Stats.inTargetPct >= 95 ? [22, 163, 74] : spo2Stats.inTargetPct >= 85 ? [2, 132, 199] : [220, 38, 38]
        },
        {
          param: "Core Temperature (deg C)",
          ref: `${thresholds.tempMin} - ${thresholds.tempMax} deg C`,
          mean: tempStats.avg != null ? `${tempStats.avg} ± ${tempStats.stdDev} deg C` : "—",
          range: tempStats.min != null ? `${tempStats.min} - ${tempStats.max} deg C` : "—",
          latest: tempStats.latest != null ? `${tempStats.latest} deg C` : "—",
          tir: tempStats.inTargetPct != null ? `${tempStats.inTargetPct}%` : "—",
          status: tempStats.inTargetPct >= 90 ? "OPTIMAL" : tempStats.inTargetPct >= 75 ? "CONTROLLED" : "ATTENTION",
          statusColor: tempStats.inTargetPct >= 90 ? [22, 163, 74] : tempStats.inTargetPct >= 75 ? [2, 132, 199] : [220, 38, 38]
        }
      ];

      scoreRows.forEach((r, idx) => {
        const bg = idx % 2 === 0 ? 255 : 248;
        doc.setFillColor(bg, bg, bg);
        doc.rect(14, y, tableW, 8.5, "F");

        doc.setDrawColor(226, 232, 240);
        doc.line(14, y + 8.5, pw - 14, y + 8.5);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        doc.setTextColor(30, 41, 59);
        doc.text(r.param, scCols[0] + 2, y + 5.5);

        doc.setFont("helvetica", "normal");
        doc.setTextColor(71, 85, 105);
        doc.text(r.ref, scCols[1], y + 5.5);
        doc.text(r.mean, scCols[2], y + 5.5);
        doc.text(r.range, scCols[3], y + 5.5);
        doc.text(r.latest, scCols[4], y + 5.5);
        doc.text(r.tir, scCols[5], y + 5.5);

        doc.setFont("helvetica", "bold");
        doc.setTextColor(r.statusColor[0], r.statusColor[1], r.statusColor[2]);
        doc.text(r.status, scCols[6], y + 5.5);

        y += 8.5;
      });

      y += 6;

      // ── Section 3: Diagnostic Observations & Clinical Interpretation ──
      chkPage(45);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(15, 41, 66);
      doc.text("CLINICAL OBSERVATIONS & TELEMETRY INTERPRETATION", 14, y);
      ln(4);

      doc.setFillColor(241, 245, 249);
      doc.roundedRect(14, y, pw - 28, 9, 1.5, 1.5, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(15, 41, 66);
      doc.text(`OVERALL PHYSIOLOGICAL STABILITY INDEX: ${stability.score} / 100 — ${stability.label.toUpperCase()}`, 18, y + 6);
      y += 13;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(51, 65, 85);

      clinicalInsights.forEach(item => {
        chkPage(10);
        doc.setDrawColor(2, 132, 199);
        doc.setFillColor(2, 132, 199);
        doc.circle(18, y - 1, 1, "FD");

        const splitText = doc.splitTextToSize(item, pw - 42);
        doc.text(splitText, 22, y);
        y += splitText.length * 4.5 + 2;
      });

      y += 4;

      // ── Section 4: Abnormal Threshold Excursions Log ──
      chkPage(45);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(15, 41, 66);
      doc.text("THRESHOLD EXCURSIONS & ABNORMAL EVENTS LOG", 14, y);
      ln(4);

      if (abnormalRecords.length === 0) {
        doc.setFillColor(240, 253, 244);
        doc.setDrawColor(187, 247, 208);
        doc.roundedRect(14, y, pw - 28, 12, 1.5, 1.5, "FD");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.setTextColor(22, 101, 52);
        doc.text("CLEAN TELEMETRY PROFILE: No physiological threshold excursions detected during this monitoring period.", 18, y + 7.5);
        y += 18;
      } else {
        const abCols = [14, 55, 85, 115, 145];
        doc.setFillColor(254, 242, 242);
        doc.rect(14, y, pw - 28, 6.5, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(7.5);
        doc.setTextColor(153, 27, 27);
        doc.text("TIMESTAMP", abCols[0] + 2, y + 4.5);
        doc.text("HEART RATE", abCols[1], y + 4.5);
        doc.text("SPO2 (%)", abCols[2], y + 4.5);
        doc.text("TEMP (deg C)", abCols[3], y + 4.5);
        doc.text("DEVIATION TYPE / SEVERITY", abCols[4], y + 4.5);
        y += 6.5;

        abnormalRecords.slice(0, 15).forEach((r, idx) => {
          chkPage(7);
          const st = getStatus(r, thresholds);
          const issues = [];
          if (r.heartRate > 0 && r.heartRate < thresholds.hrMin) issues.push(`Low Pulse (${r.heartRate} bpm)`);
          if (r.heartRate > 0 && r.heartRate > thresholds.hrMax) issues.push(`Tachycardia (${r.heartRate} bpm)`);
          if (r.spo2 > 0 && r.spo2 < thresholds.spo2Min)         issues.push(`Hypoxemia (${r.spo2}%)`);
          if (r.bodyTemp > 0 && r.bodyTemp < thresholds.tempMin)  issues.push(`Hypothermia (${r.bodyTemp} C)`);
          if (r.bodyTemp > 0 && r.bodyTemp > thresholds.tempMax)  issues.push(`Pyrexia (${r.bodyTemp} C)`);

          const bg = idx % 2 === 0 ? 255 : 254;
          doc.setFillColor(bg, bg, bg);
          doc.rect(14, y, pw - 28, 6.5, "F");
          doc.setDrawColor(254, 226, 226);
          doc.line(14, y + 6.5, pw - 14, y + 6.5);

          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(71, 85, 105);
          doc.text(fmtTime(r.timestamp), abCols[0] + 2, y + 4.5);
          doc.text(r.heartRate ? `${r.heartRate} bpm` : "—", abCols[1], y + 4.5);
          doc.text(r.spo2 ? `${r.spo2}%` : "—", abCols[2], y + 4.5);
          doc.text(r.bodyTemp ? `${r.bodyTemp} deg C` : "—", abCols[3], y + 4.5);

          doc.setFont("helvetica", "bold");
          doc.setTextColor(st.label === "Critical" ? 185 : 180, st.label === "Critical" ? 28 : 83, 28);
          doc.text(`[${st.label}] ${issues.join(", ")}`, abCols[4], y + 4.5);
          y += 6.5;
        });

        if (abnormalRecords.length > 15) {
          doc.setFont("helvetica", "italic");
          doc.setFontSize(7.5);
          doc.setTextColor(153, 27, 27);
          doc.text(`+ ${abnormalRecords.length - 15} additional threshold events archived in electronic health log.`, 16, y + 5);
          y += 8;
        }
        y += 5;
      }

      // ── Section 5: Telemetry Chronological Audit Table ──
      chkPage(45);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(15, 41, 66);
      doc.text("TELEMETRY CHRONOLOGICAL AUDIT LOG (RECENT 60 OBSERVATIONS)", 14, y);
      ln(4);

      const logCols = [14, 60, 95, 130, 165];
      doc.setFillColor(30, 41, 59); // Slate Dark
      doc.rect(14, y, pw - 28, 6.5, "F");

      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.text("RECORDED TIMESTAMP", logCols[0] + 2, y + 4.5);
      doc.text("PULSE RATE", logCols[1], y + 4.5);
      doc.text("OXYGENATION (SpO2)", logCols[2], y + 4.5);
      doc.text("CORE TEMP", logCols[3], y + 4.5);
      doc.text("EVALUATION", logCols[4], y + 4.5);
      y += 6.5;

      sortedRecords.slice(0, 60).forEach((r, idx) => {
        chkPage(7);
        const st = getStatus(r, thresholds);
        const isAbn = isAbnormal(r, thresholds);
        const bg = isAbn ? 254 : (idx % 2 === 0 ? 255 : 248);

        doc.setFillColor(bg, bg, bg);
        doc.rect(14, y, pw - 28, 6.2, "F");

        doc.setDrawColor(226, 232, 240);
        doc.line(14, y + 6.2, pw - 14, y + 6.2);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(71, 85, 105);
        doc.text(fmtTime(r.timestamp), logCols[0] + 2, y + 4.2);
        doc.text(r.heartRate ? `${r.heartRate} bpm` : "—", logCols[1], y + 4.2);
        doc.text(r.spo2 ? `${r.spo2}%` : "—", logCols[2], y + 4.2);
        doc.text(r.bodyTemp ? `${r.bodyTemp} deg C` : "—", logCols[3], y + 4.2);

        if (st.label === "Normal") {
          doc.setTextColor(22, 163, 74);
        } else if (st.label === "Critical") {
          doc.setTextColor(185, 28, 28);
        } else {
          doc.setTextColor(180, 83, 9);
        }
        doc.setFont("helvetica", "bold");
        doc.text(st.label.toUpperCase(), logCols[4], y + 4.2);

        y += 6.2;
      });

      // ── Attestation & Regulatory Signature Box ──
      chkPage(35);
      y += 6;
      doc.setFillColor(248, 250, 252);
      doc.setDrawColor(203, 213, 225);
      doc.roundedRect(14, y, pw - 28, 26, 1.5, 1.5, "FD");

      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.5);
      doc.setTextColor(71, 85, 105);
      doc.text("ATTENDING CLINICIAN / REVIEWING PHYSICIAN SIGN-OFF:", 18, y + 6);
      doc.text("SIGNATURE & CLINICAL STAMP:", 120, y + 6);

      doc.setDrawColor(148, 163, 184);
      doc.line(18, y + 19, 100, y + 19);
      doc.line(120, y + 19, pw - 18, y + 19);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text("MD / DO / Nurse Practitioner Signature", 18, y + 23);
      doc.text("Verification Date & Medical Registration ID", 120, y + 23);

      const totalPagesCount = doc.internal.getNumberOfPages();
      for (let p = 1; p <= totalPagesCount; p++) {
        doc.setPage(p);
        doc.setDrawColor(226, 232, 240);
        doc.line(14, ph - 12, pw - 14, ph - 12);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor(148, 163, 184);
        doc.text(
          "CONFIDENTIAL MEDICAL RECORD — Generated via Medisense IoT Biometric Telemetry System. Not a substitute for formal clinical diagnosis.",
          14,
          ph - 7
        );
        doc.setFont("helvetica", "bold");
        doc.text(`Page ${p} of ${totalPagesCount}`, pw - 14, ph - 7, { align: "right" });
      }

      doc.save(`Medisense-Clinical-Analysis-${currentUser?.fullName ? currentUser.fullName.replace(/\s+/g, "_") : "Patient"}-${Date.now()}.pdf`);
    } catch (e) {
      console.error("PDF generation failed:", e);
      alert("Failed to generate PDF report. Check console.");
    } finally {
      setGeneratingPDF(false);
    }
  };

  // ─────────────────────────────────────────────
  //  Render: Full Production UI
  // ─────────────────────────────────────────────
  const latest = records[0];
  const lastMeasuredStr = latest?.timestamp ? fmtTime(latest.timestamp) : null;
  const lastSyncStr = lastRefresh
    ? lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  return (
    <div className="min-h-screen bg-slate-50/80 pb-12">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-5 sm:space-y-6">

        {/* ══════════════════════════════════════════════════════
            1. INSTITUTIONAL CLINICAL HEADER (RESPONSIVE)
        ══════════════════════════════════════════════════════ */}
        <div className="bg-white rounded-3xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-blue-900 p-5 sm:p-7 text-white relative">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5 sm:gap-6">
              <div className="flex items-start sm:items-center gap-3.5 sm:gap-4">
                <div className="p-3 sm:p-3.5 bg-blue-600/30 rounded-2xl border border-blue-400/30 text-white backdrop-blur-md shadow-inner shrink-0">
                  <Activity size={26} className="text-blue-300"/>
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
                      Clinical Health Analysis &amp; Trends
                    </h1>
                    {isLive && <LiveTelemetryBadge/>}
                  </div>
                  <p className="text-xs sm:text-sm text-slate-300 mt-1 max-w-2xl leading-relaxed">
                    Automated biometric surveillance, multi-vital trend correlation, and hospital-grade diagnostic report generation.
                  </p>
                  {lastSyncStr && (
                    <div className="flex items-center gap-2 mt-2 text-[11px] sm:text-xs text-blue-200/80 flex-wrap">
                      <div className="flex items-center gap-1">
                        <Clock size={12}/>
                        <span>Stream synced at {lastSyncStr}</span>
                      </div>
                      <span className="text-slate-400 hidden xs:inline">•</span>
                      <span>{records.length} Continuous Samples</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons: Responsive Wrap */}
              <div className="flex items-center gap-2 sm:gap-3 flex-wrap w-full lg:w-auto">
                <button
                  onClick={subscribe}
                  disabled={loading}
                  className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs sm:text-sm font-semibold transition-all border border-white/15 disabled:opacity-50"
                  title="Force re-sync with Firestore"
                >
                  <RefreshCw size={14} className={loading ? "animate-spin" : ""}/>
                  <span>Re-Sync</span>
                </button>

                <button
                  onClick={() => setShowReportModal(true)}
                  disabled={loading || records.length === 0}
                  className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-xl bg-indigo-500/30 hover:bg-indigo-500/40 text-indigo-100 text-xs sm:text-sm font-semibold transition-all border border-indigo-400/30 disabled:opacity-50"
                  title="Preview interactive clinical report"
                >
                  <Eye size={15}/>
                  <span>View Report</span>
                </button>

                <button
                  onClick={generatePDF}
                  disabled={loading || records.length === 0 || generatingPDF}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 sm:px-5 py-2.5 rounded-xl bg-blue-500 hover:bg-blue-600 text-white text-xs sm:text-sm font-bold transition-all shadow-lg shadow-blue-500/25 disabled:opacity-50"
                >
                  {generatingPDF ? (
                    <><RefreshCw size={15} className="animate-spin"/> Generating PDF&hellip;</>
                  ) : (
                    <><Download size={15}/> Export Diagnostic PDF</>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* ── Sub-Navigation & Filter Toolbar (Responsive Scroll & Stack) ── */}
          <div className="p-3.5 sm:px-6 sm:py-3.5 bg-slate-50 border-b border-slate-200/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 w-full sm:w-auto">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5 shrink-0">
                <Filter size={12}/> Window:
              </span>
              <div className="flex bg-slate-200/70 p-1 rounded-xl gap-1 overflow-x-auto max-w-full">
                {TIME_FILTERS.map(f => (
                  <button
                    key={f.key}
                    onClick={() => setTimeFilter(f.key)}
                    className={"px-3 py-1 rounded-lg text-xs font-bold transition-all whitespace-nowrap " + (
                      timeFilter === f.key
                        ? "bg-white text-blue-700 shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {timeFilter === "custom" && (
                <div className="flex items-center gap-2 flex-wrap pt-1 sm:pt-0">
                  <input
                    type="date"
                    value={customStart}
                    onChange={e => setCustomStart(e.target.value)}
                    className="text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400 w-32"
                  />
                  <span className="text-slate-400 text-xs">to</span>
                  <input
                    type="date"
                    value={customEnd}
                    onChange={e => setCustomEnd(e.target.value)}
                    className="text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400 w-32"
                  />
                  <button
                    onClick={subscribe}
                    className="px-3 py-1 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition-colors"
                  >
                    Apply
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2.5">
              <button
                onClick={() => setShowThresholds(s => !s)}
                className={"inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors w-full sm:w-auto justify-center " + (
                  showThresholds
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white border-slate-200 text-slate-600 hover:bg-slate-100"
                )}
              >
                <Settings size={13}/> Config Baselines
              </button>
            </div>
          </div>

          {/* ── Reference Threshold Configuration Drawer ── */}
          {showThresholds && (
            <div className="p-4 sm:p-6 bg-slate-100/70 border-b border-slate-200 animate-in slide-in-from-top-2 duration-200">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Stethoscope size={16} className="text-blue-600"/>
                  <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Physiological Reference Threshold Configuration
                  </h3>
                </div>
                <button onClick={() => setShowThresholds(false)} className="text-slate-400 hover:text-slate-600">
                  <X size={16}/>
                </button>
              </div>
              <p className="text-xs text-slate-500 mb-4 leading-relaxed">
                Customise clinical alert bounds for this patient. Readings breaching these limits trigger warning highlights in analytics, trend charts, and exportable reports.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                {[
                  { k: "hrMin",   l: "Heart Rate Min",   suffix: "bpm", min: 30,  max: 80,  step: 1   },
                  { k: "hrMax",   l: "Heart Rate Max",   suffix: "bpm", min: 80,  max: 220, step: 1   },
                  { k: "spo2Min", l: "SpO₂ Min Alert",   suffix: "%",   min: 75,  max: 100, step: 1   },
                  { k: "tempMin", l: "Temperature Min",  suffix: "°C",  min: 34,  max: 37,  step: 0.1 },
                  { k: "tempMax", l: "Temperature Max",  suffix: "°C",  min: 37,  max: 42,  step: 0.1 },
                ].map(({ k, l, suffix, min, max, step }) => (
                  <div key={k} className="bg-white p-3 rounded-2xl border border-slate-200">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1">
                      {l} <span className="text-slate-400">({suffix})</span>
                    </label>
                    <input
                      type="number"
                      min={min}
                      max={max}
                      step={step}
                      value={thresholds[k]}
                      onChange={e => setThresholds(t => ({ ...t, [k]: parseFloat(e.target.value) || 0 }))}
                      className="w-full text-sm font-bold text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-3.5 flex justify-end">
                <button
                  onClick={() => setThresholds(DEFAULT_THRESHOLDS)}
                  className="text-xs text-blue-600 hover:text-blue-800 font-bold"
                >
                  Reset Standard Clinical Baselines
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ══════════════════════════════════════════════════════
            2. STATE HANDLING (LOADING & ERROR)
        ══════════════════════════════════════════════════════ */}
        {loading && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="h-28 sm:h-32 bg-white rounded-3xl border border-slate-100 p-5 animate-pulse"/>
              ))}
            </div>
            <div className="h-64 sm:h-72 bg-white rounded-3xl border border-slate-100 animate-pulse"/>
          </div>
        )}

        {!loading && error && (
          <div className="bg-rose-50 border border-rose-200 rounded-3xl p-5 sm:p-6 flex items-center gap-4 text-rose-800">
            <AlertCircle size={28} className="text-rose-600 shrink-0"/>
            <div>
              <h3 className="font-bold text-base">Telemetry Stream Offline</h3>
              <p className="text-sm mt-0.5 text-rose-700">{error}</p>
              <button onClick={subscribe} className="mt-2 text-xs font-bold text-rose-800 underline">
                Retry Connection
              </button>
            </div>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* ══════════════════════════════════════════════════════
                3. EXECUTIVE CLINICAL KPI & STABILITY SCORECARD
            ══════════════════════════════════════════════════════ */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 sm:gap-4">
              {/* Overall Health Stability Score */}
              <div className="bg-white rounded-3xl border border-slate-200/70 p-4 sm:p-5 shadow-sm flex items-center justify-between">
                <div>
                  <span className="text-[11px] sm:text-xs font-bold text-slate-400 uppercase tracking-wider block mb-1">
                    Physiological Stability
                  </span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl sm:text-3xl font-extrabold text-slate-900 tabular-nums">
                      {stability.score}
                    </span>
                    <span className="text-xs font-semibold text-slate-400">/ 100</span>
                  </div>
                  <span className={`inline-block mt-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${
                    stability.color === "emerald" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" :
                    stability.color === "blue" ? "bg-blue-50 text-blue-700 border border-blue-200" :
                    stability.color === "amber" ? "bg-amber-50 text-amber-700 border border-amber-200" :
                    "bg-rose-50 text-rose-700 border border-rose-200"
                  }`}>
                    {stability.label}
                  </span>
                </div>
                <div className={`w-11 h-11 sm:w-12 sm:h-12 rounded-2xl flex items-center justify-center shrink-0 ${
                  stability.color === "emerald" ? "bg-emerald-50 text-emerald-600" :
                  stability.color === "blue" ? "bg-blue-50 text-blue-600" :
                  stability.color === "amber" ? "bg-amber-50 text-amber-600" :
                  "bg-rose-50 text-rose-600"
                }`}>
                  <ShieldCheck size={24}/>
                </div>
              </div>

              {/* Data Density */}
              <div className="bg-white rounded-3xl border border-slate-200/70 p-4 sm:p-5 shadow-sm flex items-center justify-between">
                <div>
                  <span className="text-[11px] sm:text-xs font-bold text-slate-400 uppercase tracking-wider block mb-1">
                    Captured Telemetry
                  </span>
                  <span className="text-2xl sm:text-3xl font-extrabold text-slate-900 tabular-nums">
                    {records.length}
                  </span>
                  <p className="text-[11px] sm:text-xs text-slate-500 mt-1">
                    Continuous records analyzed
                  </p>
                </div>
                <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                  <BarChart2 size={24}/>
                </div>
              </div>

              {/* Excursions outside bounds */}
              <div className="bg-white rounded-3xl border border-slate-200/70 p-4 sm:p-5 shadow-sm flex items-center justify-between">
                <div>
                  <span className="text-[11px] sm:text-xs font-bold text-slate-400 uppercase tracking-wider block mb-1">
                    Threshold Excursions
                  </span>
                  <span className="text-2xl sm:text-3xl font-extrabold text-slate-900 tabular-nums">
                    {abnormalRecords.length}
                  </span>
                  <p className="text-[11px] sm:text-xs text-slate-500 mt-1 truncate">
                    {abnormalRecords.length === 0 ? "100% Within nominal limits" : "Requires clinical review"}
                  </p>
                </div>
                <div className={`w-11 h-11 sm:w-12 sm:h-12 rounded-2xl flex items-center justify-center shrink-0 ${
                  abnormalRecords.length > 0 ? "bg-amber-50 text-amber-600" : "bg-emerald-50 text-emerald-600"
                }`}>
                  <AlertTriangle size={24}/>
                </div>
              </div>

              {/* Latest Transmission */}
              <div className="bg-white rounded-3xl border border-slate-200/70 p-4 sm:p-5 shadow-sm flex items-center justify-between">
                <div className="min-w-0 pr-2">
                  <span className="text-[11px] sm:text-xs font-bold text-slate-400 uppercase tracking-wider block mb-1">
                    Latest Transmission
                  </span>
                  <span className="text-sm sm:text-base font-extrabold text-slate-900 block truncate">
                    {lastMeasuredStr ? lastMeasuredStr.split(",")[0] : "—"}
                  </span>
                  <span className="text-[11px] sm:text-xs text-slate-500 block truncate mt-0.5">
                    {lastMeasuredStr ? lastMeasuredStr.split(",").slice(1).join(",").trim() : "No packets"}
                  </span>
                </div>
                <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-purple-50 text-purple-600 flex items-center justify-center shrink-0">
                  <Clock size={24}/>
                </div>
              </div>
            </div>

            {/* ══════════════════════════════════════════════════════
                4. CLINICAL VITAL SIGNS ANALYTICS CARDS (RESPONSIVE)
            ══════════════════════════════════════════════════════ */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
              <ClinicalMetricCard
                icon={<Heart size={20}/>}
                label="Heart Rate"
                value={hrStats.latest}
                unit="bpm"
                color="rose"
                stats={hrStats}
                change={hrChange}
                threshLabel={`${thresholds.hrMin} - ${thresholds.hrMax} bpm`}
                sparkData={chartData}
                sparkKey="hr"
              />

              <ClinicalMetricCard
                icon={<Droplets size={20}/>}
                label="Blood Oxygen (SpO₂)"
                value={spo2Stats.latest}
                unit="%"
                color="sky"
                stats={spo2Stats}
                change={spo2Change}
                threshLabel={`≥ ${thresholds.spo2Min}%`}
                sparkData={chartData}
                sparkKey="spo2"
              />

              <div className="md:col-span-2 lg:col-span-1">
                <ClinicalMetricCard
                  icon={<Thermometer size={20}/>}
                  label="Body Temperature"
                  value={tempStats.latest}
                  unit="°C"
                  color="amber"
                  stats={tempStats}
                  change={tempChange}
                  threshLabel={`${thresholds.tempMin} - ${thresholds.tempMax} °C`}
                  sparkData={chartData}
                  sparkKey="temp"
                />
              </div>
            </div>

            {/* ══════════════════════════════════════════════════════
                5. CLINICAL OBSERVATIONS & TELEMETRY INSIGHTS
            ══════════════════════════════════════════════════════ */}
            <div className="bg-white rounded-3xl border border-slate-200/80 shadow-sm p-4 sm:p-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 bg-blue-50 text-blue-600 rounded-xl shrink-0">
                    <Stethoscope size={18}/>
                  </div>
                  <div>
                    <h2 className="text-sm sm:text-base font-bold text-slate-900 tracking-tight">
                      Automated Clinical Telemetry Analysis
                    </h2>
                    <p className="text-[11px] sm:text-xs text-slate-500">
                      Algorithmic assessment of stability, variability, and homeostatic trends
                    </p>
                  </div>
                </div>
                <span className="self-start sm:self-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-semibold">
                  <Award size={13} className="text-blue-600"/> Diagnostic Summary
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 sm:pt-2">
                {clinicalInsights.map((text, idx) => (
                  <div key={idx} className="flex items-start gap-3 p-3.5 rounded-2xl bg-slate-50/70 border border-slate-100">
                    <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 shrink-0"/>
                    <p className="text-xs leading-relaxed text-slate-700 font-medium">{text}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* ══════════════════════════════════════════════════════
                6. INTERACTIVE TREND VISUALIZER (RESPONSIVE)
            ══════════════════════════════════════════════════════ */}
            <div className="bg-white rounded-3xl border border-slate-200/80 shadow-sm overflow-hidden">
              {/* Visualizer Toolbar */}
              <div className="p-4 sm:px-6 sm:py-5 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm sm:text-base font-bold text-slate-900">
                      Physiological Trend Surveillance
                    </h2>
                    <span className="text-xs font-medium text-slate-400">• Dynamic Time Axis</span>
                  </div>
                  <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
                    Continuous monitoring across baseline clinical thresholds. Red markers denote deviations.
                  </p>
                </div>

                {/* View switcher: Single Metric vs Multi-Vital Correlation */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <div className="flex bg-slate-100 p-1 rounded-xl">
                    <button
                      onClick={() => setChartViewMode("single")}
                      className={"flex-1 sm:flex-initial px-3 py-1.5 rounded-lg text-xs font-bold transition-all " + (
                        chartViewMode === "single" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"
                      )}
                    >
                      Single Metric
                    </button>
                    <button
                      onClick={() => setChartViewMode("multi")}
                      className={"flex-1 sm:flex-initial px-3 py-1.5 rounded-lg text-xs font-bold transition-all " + (
                        chartViewMode === "multi" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"
                      )}
                    >
                      Multi-Vital Overlaid
                    </button>
                  </div>

                  {chartViewMode === "single" && (
                    <div className="flex bg-slate-100 p-1 rounded-xl overflow-x-auto">
                      {Object.entries(CHARTS).map(([k, cfg]) => (
                        <button
                          key={k}
                          onClick={() => setActiveChart(k)}
                          style={activeChart === k ? { backgroundColor: cfg.color } : {}}
                          className={"px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap " + (
                            activeChart === k ? "text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
                          )}
                        >
                          {cfg.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Chart Canvas */}
              {records.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-56 sm:h-64 text-slate-400 gap-3 p-4">
                  <Activity size={32} className="opacity-30"/>
                  <p className="text-sm font-semibold text-center">No telemetry data recorded in this period</p>
                </div>
              ) : chartViewMode === "single" ? (
                /* Single Metric Deep-Dive Chart */
                <div className="p-3 sm:p-6">
                  <div className="h-[260px] sm:h-[320px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 15, right: 10, left: -25, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false}/>
                        <XAxis
                          dataKey="time"
                          tick={{ fontSize: 10, fill: "#94a3b8" }}
                          interval="preserveStartEnd"
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          domain={activeCfg.domain}
                          tick={{ fontSize: 10, fill: "#94a3b8" }}
                          tickLine={false}
                          axisLine={false}
                          width={32}
                        />
                        <Tooltip content={<ProfessionalChartTip unit={activeCfg.unit}/>}/>
                        {activeCfg.refMin != null && (
                          <ReferenceLine
                            y={activeCfg.refMin}
                            stroke="#ef4444"
                            strokeDasharray="4 4"
                            strokeWidth={1.5}
                            label={{ value: `Min: ${activeCfg.refMin}`, fontSize: 9, fill: "#ef4444", position: "insideBottomLeft" }}
                          />
                        )}
                        {activeCfg.refMax != null && (
                          <ReferenceLine
                            y={activeCfg.refMax}
                            stroke="#ef4444"
                            strokeDasharray="4 4"
                            strokeWidth={1.5}
                            label={{ value: `Max: ${activeCfg.refMax}`, fontSize: 9, fill: "#ef4444", position: "insideTopLeft" }}
                          />
                        )}
                        <Line
                          type="monotone"
                          dataKey={activeCfg.dataKey}
                          name={activeCfg.label}
                          stroke={activeCfg.color}
                          strokeWidth={2.5}
                          dot={<AbnormalDot/>}
                          activeDot={{ r: 6, strokeWidth: 2, stroke: "#fff" }}
                          connectNulls
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              ) : (
                /* Multi-Vital Overlaid Correlation Chart */
                <div className="p-3 sm:p-6">
                  <div className="h-[280px] sm:h-[340px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chartData} margin={{ top: 15, right: 10, left: -25, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false}/>
                        <XAxis
                          dataKey="time"
                          tick={{ fontSize: 10, fill: "#94a3b8" }}
                          interval="preserveStartEnd"
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          yAxisId="hr"
                          domain={[40, 160]}
                          tick={{ fontSize: 9, fill: "#f43f5e" }}
                          tickLine={false}
                          axisLine={false}
                          width={30}
                        />
                        <YAxis
                          yAxisId="spo2"
                          orientation="right"
                          domain={[80, 102]}
                          tick={{ fontSize: 9, fill: "#0284c7" }}
                          tickLine={false}
                          axisLine={false}
                          width={30}
                        />
                        <Tooltip content={<ProfessionalChartTip unit=""/>}/>
                        <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }}/>
                        <Line
                          yAxisId="hr"
                          type="monotone"
                          dataKey="hr"
                          name="Heart Rate (bpm)"
                          stroke="#f43f5e"
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                          isAnimationActive={false}
                        />
                        <Line
                          yAxisId="spo2"
                          type="monotone"
                          dataKey="spo2"
                          name="SpO₂ (%)"
                          stroke="#0284c7"
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                          isAnimationActive={false}
                        />
                        <Line
                          yAxisId="hr"
                          type="monotone"
                          dataKey="temp"
                          name="Temp (°C scaled)"
                          stroke="#d97706"
                          strokeWidth={2}
                          strokeDasharray="4 4"
                          dot={false}
                          connectNulls
                          isAnimationActive={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Chart Legend Footer */}
              <div className="p-3.5 sm:px-6 sm:py-3.5 bg-slate-50/80 border-t border-slate-100 flex flex-wrap items-center justify-between text-[11px] sm:text-xs text-slate-500 gap-2.5">
                <div className="flex items-center gap-4 flex-wrap">
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 border-t-2 border-dashed border-red-500 inline-block"/>
                    Clinical Limit
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block"/>
                    Excursion
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"/>
                    Nominal
                  </span>
                </div>
                {isLive && (
                  <span className="flex items-center gap-1.5 text-emerald-600 font-bold ml-auto sm:ml-0">
                    <Radio size={12} className="animate-pulse"/> Realtime Sync Active
                  </span>
                )}
              </div>
            </div>

            {/* ══════════════════════════════════════════════════════
                7. THRESHOLD EXCURSIONS DRAWER (ABNORMAL READINGS)
            ══════════════════════════════════════════════════════ */}
            {abnormalRecords.length > 0 && (
              <div className="rounded-3xl border border-amber-200/90 bg-white shadow-sm overflow-hidden">
                <button
                  onClick={() => setShowAbnormal(s => !s)}
                  className="w-full flex items-center justify-between p-4 sm:px-6 sm:py-4.5 bg-gradient-to-r from-amber-50/90 to-orange-50/60 hover:bg-amber-100/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-2xl bg-amber-500/20 text-amber-700 flex items-center justify-center shrink-0">
                      <AlertTriangle size={18}/>
                    </div>
                    <div className="text-left">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-amber-950 text-xs sm:text-sm">
                          {abnormalRecords.length} Threshold Excursions Recorded
                        </h3>
                        <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-200/80 text-amber-800">
                          Attention
                        </span>
                      </div>
                      <p className="text-[11px] sm:text-xs text-amber-700 mt-0.5">
                        Deviations logged outside nominal medical bounds for patient review.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-amber-700 text-xs font-bold shrink-0">
                    <span className="hidden xs:inline">{showAbnormal ? "Collapse Log" : "View Details"}</span>
                    {showAbnormal ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
                  </div>
                </button>

                {showAbnormal && (
                  <div className="border-t border-amber-200/60 overflow-x-auto">
                    <div className="min-w-[600px]">
                      <table className="min-w-full text-sm">
                        <thead className="bg-amber-50/50">
                          <tr>
                            {["Timestamp", "Heart Rate", "SpO₂", "Body Temp", "Identified Anomaly"].map(h => (
                              <th key={h} className="text-left px-4 sm:px-6 py-3 text-xs font-bold text-amber-800 uppercase tracking-wider">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-amber-100/60">
                          {abnormalRecords.slice(0, 15).map(r => {
                            const issues = [];
                            if (r.heartRate > 0 && r.heartRate < thresholds.hrMin) issues.push(`Low Pulse (${r.heartRate} bpm)`);
                            if (r.heartRate > 0 && r.heartRate > thresholds.hrMax) issues.push(`Tachycardia (${r.heartRate} bpm)`);
                            if (r.spo2 > 0 && r.spo2 < thresholds.spo2Min)         issues.push(`Hypoxemia (${r.spo2}%)`);
                            if (r.bodyTemp > 0 && r.bodyTemp < thresholds.tempMin)  issues.push(`Hypothermia (${r.bodyTemp} °C)`);
                            if (r.bodyTemp > 0 && r.bodyTemp > thresholds.tempMax)  issues.push(`Pyrexia (${r.bodyTemp} °C)`);

                            return (
                              <tr key={r.id} className="hover:bg-amber-50/30 transition-colors">
                                <td className="px-4 sm:px-6 py-3 text-xs font-medium text-slate-700 whitespace-nowrap">
                                  {fmtTime(r.timestamp)}
                                </td>
                                <td className="px-4 sm:px-6 py-3 text-slate-800 font-bold">
                                  {r.heartRate ? `${r.heartRate} bpm` : "—"}
                                </td>
                                <td className="px-4 sm:px-6 py-3 text-slate-800 font-bold">
                                  {r.spo2 ? `${r.spo2}%` : "—"}
                                </td>
                                <td className="px-4 sm:px-6 py-3 text-slate-800 font-bold">
                                  {r.bodyTemp ? `${r.bodyTemp} °C` : "—"}
                                </td>
                                <td className="px-4 sm:px-6 py-3">
                                  <div className="flex flex-wrap gap-1.5">
                                    {issues.map((txt, i) => (
                                      <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold bg-amber-100/90 text-amber-800 border border-amber-200">
                                        {txt}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {abnormalRecords.length > 15 && (
                      <div className="px-4 sm:px-6 py-2.5 bg-amber-50/40 text-xs text-amber-700 font-semibold border-t border-amber-200/60">
                        + {abnormalRecords.length - 15} additional threshold events archived.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ══════════════════════════════════════════════════════
                8. TELEMETRY LOG DATA TABLE (RESPONSIVE SCROLL & SWIPE)
            ══════════════════════════════════════════════════════ */}
            <div className="bg-white rounded-3xl border border-slate-200/80 shadow-sm overflow-hidden">
              <div className="p-4 sm:px-6 sm:py-4.5 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm sm:text-base font-bold text-slate-900">
                    Comprehensive Telemetry Log
                  </h2>
                  <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
                    Interactive audit log with sortable columns and abnormal indicator flags
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
                    {records.length} Total Records
                  </span>
                </div>
              </div>

              {records.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-2 p-4">
                  <Calendar size={32} className="opacity-30"/>
                  <p className="text-sm font-semibold text-center">No telemetry records located</p>
                </div>
              ) : (
                <>
                  {/* Table with responsive horizontal scroll wrapper */}
                  <div className="overflow-x-auto">
                    <div className="min-w-[640px]">
                      <table className="min-w-full text-sm">
                        <thead className="bg-slate-50">
                          <tr>
                            {[
                              { key: "timestamp", label: "Recorded Timestamp" },
                              { key: "heartRate", label: "Heart Rate (bpm)"   },
                              { key: "spo2",      label: "Blood Oxygen (SpO₂)" },
                              { key: "bodyTemp",  label: "Body Temp (°C)"      },
                              { key: "_status",   label: "Clinical Status", noSort: true },
                            ].map(col => (
                              <th
                                key={col.key}
                                onClick={col.noSort ? undefined : () => toggleSort(col.key)}
                                className={"px-4 sm:px-6 py-3.5 text-left text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100 " + (
                                  col.noSort ? "" : "cursor-pointer select-none hover:text-blue-600 hover:bg-slate-100 transition-colors"
                                )}
                              >
                                <div className="flex items-center gap-1.5">
                                  <span>{col.label}</span>
                                  {!col.noSort && sortField === col.key && (
                                    <span className="text-blue-600 font-extrabold">
                                      {sortDir === "asc" ? "↑" : "↓"}
                                    </span>
                                  )}
                                </div>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {pagedRecords.map((r, idx) => {
                            const status = getStatus(r, thresholds);
                            const abn    = isAbnormal(r, thresholds);
                            const isEven = idx % 2 === 0;
                            return (
                              <tr
                                key={r.id}
                                className={"transition-colors hover:bg-blue-50/40 " + (
                                  abn ? "bg-rose-50/20" : isEven ? "bg-white" : "bg-slate-50/40"
                                )}
                              >
                                <td className="px-4 sm:px-6 py-3.5 text-xs font-semibold text-slate-700 whitespace-nowrap">
                                  {fmtTime(r.timestamp)}
                                </td>
                                <td className="px-4 sm:px-6 py-3.5">
                                  <span className="font-extrabold text-slate-900 tabular-nums">
                                    {r.heartRate || "—"}
                                  </span>
                                  {r.heartRate > 0 && <span className="text-slate-400 text-xs ml-1">bpm</span>}
                                </td>
                                <td className="px-4 sm:px-6 py-3.5">
                                  <span className="font-extrabold text-slate-900 tabular-nums">
                                    {r.spo2 || "—"}
                                  </span>
                                  {r.spo2 > 0 && <span className="text-slate-400 text-xs ml-0.5">%</span>}
                                </td>
                                <td className="px-4 sm:px-6 py-3.5">
                                  <span className="font-extrabold text-slate-900 tabular-nums">
                                    {r.bodyTemp || "—"}
                                  </span>
                                  {r.bodyTemp > 0 && <span className="text-slate-400 text-xs ml-0.5">°C</span>}
                                </td>
                                <td className="px-4 sm:px-6 py-3.5">
                                  <span className={"inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border " + status.cls}>
                                    {abn && <AlertTriangle size={11}/>}
                                    {status.label}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Responsive Pagination Toolbar */}
                  {totalPages > 1 && (
                    <div className="p-3.5 sm:px-6 sm:py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                      <p className="text-xs font-semibold text-slate-500">
                        Displaying {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, records.length)} of {records.length}
                      </p>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setPage(p => Math.max(1, p - 1))}
                          disabled={page === 1}
                          className="w-8 h-8 rounded-xl border border-slate-200 bg-white flex items-center justify-center text-slate-600 hover:bg-slate-100 disabled:opacity-40 transition-colors shadow-sm"
                          aria-label="Previous page"
                        >
                          <ChevronLeft size={15}/>
                        </button>
                        <div className="hidden sm:flex gap-1">
                          {Array.from({ length: Math.min(totalPages, 6) }, (_, i) => {
                            const pg = i + 1;
                            return (
                              <button
                                key={pg}
                                onClick={() => setPage(pg)}
                                className={"w-8 h-8 rounded-xl text-xs font-bold transition-all " + (
                                  page === pg
                                    ? "bg-blue-600 text-white shadow-sm"
                                    : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-100"
                                )}
                              >
                                {pg}
                              </button>
                            );
                          })}
                          {totalPages > 6 && <span className="self-center text-slate-400 text-xs px-1">…</span>}
                        </div>
                        <span className="sm:hidden text-xs font-bold text-slate-600 px-2">
                          {page} / {totalPages}
                        </span>
                        <button
                          onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                          disabled={page === totalPages}
                          className="w-8 h-8 rounded-xl border border-slate-200 bg-white flex items-center justify-center text-slate-600 hover:bg-slate-100 disabled:opacity-40 transition-colors shadow-sm"
                          aria-label="Next page"
                        >
                          <ChevronRight size={15}/>
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ══════════════════════════════════════════════════════
                9. CLINICAL ADVISORY & REGULATORY FOOTER
            ══════════════════════════════════════════════════════ */}
            <div className="flex items-start gap-3.5 p-4 sm:px-6 sm:py-4 bg-blue-50/70 border border-blue-200/60 rounded-3xl text-xs text-blue-900 leading-relaxed shadow-sm">
              <Info size={18} className="text-blue-600 shrink-0 mt-0.5"/>
              <div>
                <p className="font-semibold text-blue-950 mb-0.5">Clinical Telemetry Surveillance Notice</p>
                <p className="text-blue-800/90 text-[11px] sm:text-xs">
                  This health analytics module continuously streams IoT telemetry data for remote trend surveillance.
                  Calculated metrics (including Time-in-Target, Stability Score, and Anomaly Indicators) are decision-support aids
                  and must be interpreted in conjunction with standard clinical evaluations by a qualified medical professional.
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════
          10. RESPONSIVE CLINICAL REPORT PREVIEW MODAL
      ══════════════════════════════════════════════════════ */}
      {showReportModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/80 backdrop-blur-sm flex justify-center p-2 sm:p-4 md:p-6 animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col my-auto border border-slate-200 max-h-[92vh]">
            {/* Modal Header */}
            <div className="bg-slate-900 text-white px-5 sm:px-8 py-4 sm:py-5 flex items-center justify-between border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-600 rounded-xl text-white">
                  <FileText size={18}/>
                </div>
                <div>
                  <h3 className="font-bold text-sm sm:text-base">Clinical Diagnostic Report Preview</h3>
                  <p className="text-xs text-slate-400">Institutional Telemetry &amp; Homeostatic Analysis</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors"
                >
                  <Printer size={14}/> Print
                </button>
                <button
                  onClick={generatePDF}
                  disabled={generatingPDF}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition-colors shadow-sm"
                >
                  <Download size={14}/> {generatingPDF ? "Exporting..." : "Download PDF"}
                </button>
                <button
                  onClick={() => setShowReportModal(false)}
                  className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-colors ml-1"
                >
                  <X size={20}/>
                </button>
              </div>
            </div>

            {/* Modal Body: Responsive Simulated Clinical Document */}
            <div className="p-4 sm:p-8 overflow-y-auto space-y-6 text-slate-800 bg-slate-50/50">
              {/* Document Banner */}
              <div className="bg-slate-900 text-white p-5 sm:p-6 rounded-2xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                  <h4 className="font-extrabold text-base sm:text-lg tracking-tight">MEDISENSE CLINICAL TELEMETRY</h4>
                  <p className="text-xs text-slate-300 mt-0.5">CONTINUOUS PHYSIOLOGICAL BIO-TELEMETRY REPORT</p>
                </div>
                <div className="text-left sm:text-right text-xs text-blue-200">
                  <span className="font-bold block">CONFIDENTIAL MEDICAL RECORD</span>
                  <span className="text-[11px] text-slate-400">Generated: {new Date().toLocaleString()}</span>
                </div>
              </div>

              {/* Patient Protocol Card (Responsive Grid) */}
              <div className="bg-white p-4 sm:p-5 rounded-2xl border border-slate-200 shadow-sm">
                <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                  Patient Demographics &amp; Protocol
                </h5>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div><span className="font-bold text-slate-500">Patient Name:</span> <span className="font-bold text-slate-900 ml-1">{currentUser?.fullName || "Anonymous"}</span></div>
                  <div><span className="font-bold text-slate-500">Monitoring Window:</span> <span className="text-slate-900 ml-1">{TIME_FILTERS.find(f => f.key === timeFilter)?.label || timeFilter}</span></div>
                  <div><span className="font-bold text-slate-500">MRN / Identifier:</span> <span className="font-mono text-slate-900 ml-1">{currentUser?.uid ? currentUser.uid.substring(0, 14).toUpperCase() : "PT-MEDISENSE"}</span></div>
                  <div><span className="font-bold text-slate-500">Telemetry Points:</span> <span className="font-bold text-slate-900 ml-1">{records.length} Continuous Records</span></div>
                  <div><span className="font-bold text-slate-500">Device Hardware:</span> <span className="font-mono text-slate-900 ml-1">{currentUser?.connectedDeviceId || "Simulated Telemetry Node"}</span></div>
                  <div><span className="font-bold text-slate-500">Physician Status:</span> <span className="text-slate-900 ml-1">{currentUser?.assignedDoctorId ? "Active Link" : "Self-Monitored"}</span></div>
                </div>
              </div>

              {/* Scorecard Table (Responsive Touch-Scroll) */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 bg-slate-900 text-white font-bold text-xs uppercase tracking-wider">
                  Vital Signs Scorecard &amp; Target Adherence
                </div>
                <div className="overflow-x-auto">
                  <div className="min-w-[540px]">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-100 text-slate-600 font-bold border-b border-slate-200">
                        <tr>
                          <th className="px-4 py-2.5 text-left">Parameter</th>
                          <th className="px-4 py-2.5 text-left">Target</th>
                          <th className="px-4 py-2.5 text-left">Mean ± SD</th>
                          <th className="px-4 py-2.5 text-left">Min – Max</th>
                          <th className="px-4 py-2.5 text-left">TIR (%)</th>
                          <th className="px-4 py-2.5 text-left">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        <tr>
                          <td className="px-4 py-3 font-bold text-slate-900">Heart Rate</td>
                          <td className="px-4 py-3 text-slate-600">{thresholds.hrMin} - {thresholds.hrMax} bpm</td>
                          <td className="px-4 py-3 font-semibold text-slate-800">{hrStats.avg != null ? `${hrStats.avg} ± ${hrStats.stdDev}` : "—"}</td>
                          <td className="px-4 py-3 text-slate-700">{hrStats.min != null ? `${hrStats.min} - ${hrStats.max}` : "—"}</td>
                          <td className="px-4 py-3 font-bold text-blue-600">{hrStats.inTargetPct != null ? `${hrStats.inTargetPct}%` : "—"}</td>
                          <td className="px-4 py-3"><span className="px-2 py-0.5 rounded-full font-bold bg-emerald-50 text-emerald-700">STABLE</span></td>
                        </tr>
                        <tr>
                          <td className="px-4 py-3 font-bold text-slate-900">Blood Oxygen (SpO₂)</td>
                          <td className="px-4 py-3 text-slate-600">≥ {thresholds.spo2Min}%</td>
                          <td className="px-4 py-3 font-semibold text-slate-800">{spo2Stats.avg != null ? `${spo2Stats.avg} ± ${spo2Stats.stdDev}%` : "—"}</td>
                          <td className="px-4 py-3 text-slate-700">{spo2Stats.min != null ? `${spo2Stats.min} - ${spo2Stats.max}%` : "—"}</td>
                          <td className="px-4 py-3 font-bold text-blue-600">{spo2Stats.inTargetPct != null ? `${spo2Stats.inTargetPct}%` : "—"}</td>
                          <td className="px-4 py-3"><span className="px-2 py-0.5 rounded-full font-bold bg-emerald-50 text-emerald-700">OPTIMAL</span></td>
                        </tr>
                        <tr>
                          <td className="px-4 py-3 font-bold text-slate-900">Core Temp</td>
                          <td className="px-4 py-3 text-slate-600">{thresholds.tempMin} - {thresholds.tempMax} °C</td>
                          <td className="px-4 py-3 font-semibold text-slate-800">{tempStats.avg != null ? `${tempStats.avg} ± ${tempStats.stdDev} °C` : "—"}</td>
                          <td className="px-4 py-3 text-slate-700">{tempStats.min != null ? `${tempStats.min} - ${tempStats.max} °C` : "—"}</td>
                          <td className="px-4 py-3 font-bold text-blue-600">{tempStats.inTargetPct != null ? `${tempStats.inTargetPct}%` : "—"}</td>
                          <td className="px-4 py-3"><span className="px-2 py-0.5 rounded-full font-bold bg-emerald-50 text-emerald-700">CONTROLLED</span></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Clinical Observations */}
              <div className="bg-white p-4 sm:p-5 rounded-2xl border border-slate-200 shadow-sm space-y-2">
                <div className="flex items-center justify-between mb-1">
                  <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                    Diagnostic Telemetry Interpretation
                  </h5>
                  <span className="text-xs font-bold text-blue-600">Stability Index: {stability.score}/100</span>
                </div>
                {clinicalInsights.map((ins, i) => (
                  <p key={i} className="text-xs leading-relaxed text-slate-700 font-medium pl-3 border-l-2 border-blue-500">
                    {ins}
                  </p>
                ))}
              </div>

              {/* Sign-off box */}
              <div className="bg-white p-4 sm:p-5 rounded-2xl border border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <p className="font-bold text-slate-600 mb-6">Attending Clinician / Reviewing Practitioner:</p>
                  <div className="border-b border-slate-300 w-3/4 mb-1"/>
                  <p className="text-[11px] text-slate-400">MD / DO / Registered Specialist</p>
                </div>
                <div>
                  <p className="font-bold text-slate-600 mb-6">Clinical Verification &amp; Date:</p>
                  <div className="border-b border-slate-300 w-3/4 mb-1"/>
                  <p className="text-[11px] text-slate-400">Date &amp; Telemetry Stamp</p>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="bg-white px-5 py-3 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setShowReportModal(false)}
                className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-100 transition-colors"
              >
                Close Preview
              </button>
              <button
                onClick={generatePDF}
                disabled={generatingPDF}
                className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition-colors shadow-sm flex items-center gap-1.5"
              >
                <Download size={14}/> Download Official PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

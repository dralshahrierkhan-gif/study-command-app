"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, BarChart, Bar } from "recharts";

// =========================
// TYPES & CONSTANTS
// =========================
const STORAGE_KEY = "study-command-v9-ultimate";

type TimeBlock = "Morning" | "Afternoon" | "Evening" | "Night";
type Priority = "Must do" | "Should do" | "Optional";
type Category = "Qbank" | "Revision" | "Reading" | "Notes" | "Exam" | "Exercise" | "Mindfulness";
type GoalStatus = "pending" | "in-progress" | "awaiting-review" | "completed" | "missed";
type FailReason = "Phone" | "Tired" | "Overplanned" | "Low Mood" | "Interruptions" | "None";
type AlertType = "info" | "start" | "mid" | "end" | "mindfulness";

type Task = { id: string; text: string; done: boolean; block: TimeBlock; priority: Priority; category: Category; createdAt: string; };
type Goal = { id: string; title: string; startTime: string; endTime: string; status: GoalStatus; note?: string; linkedTaskId?: string | null; alerts: { before5: boolean; midway: boolean; end: boolean; autoStarted: boolean; }; };
type Reflection = { submitted: boolean; mcqsTotal: number; mcqsCorrect: number; failReason: FailReason; mood: number; notes: string; };
type AppAlert = { id: string; time: string; message: string; type: AlertType; };
type MindfulnessPreset = { id: string; title: string; everyMinutes: number; enabled: boolean; };
type DayData = { tasks: Task[]; goals: Goal[]; pomodoros: number; reflection: Reflection; alerts: AppAlert[]; deepWorkMinutesManual: number; carriedForward: boolean; };

const BLOCKS: TimeBlock[] = ["Morning", "Afternoon", "Evening", "Night"];
const PRIORITIES: Priority[] = ["Must do", "Should do", "Optional"];
const CATEGORIES: Category[] = ["Qbank", "Revision", "Reading", "Notes", "Exam", "Exercise", "Mindfulness"];

const todayStr = () => {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().split("T")[0];
};

const safeUUID = () => Math.random().toString(36).slice(2, 11);

const getEmptyDay = (): DayData => ({
  tasks: [], goals: [], pomodoros: 0, alerts: [], deepWorkMinutesManual: 0, carriedForward: false,
  reflection: { submitted: false, mcqsTotal: 0, mcqsCorrect: 0, failReason: "None", mood: 3, notes: "" },
});

const formatTime = (secs: number) => `${Math.floor(secs / 60).toString().padStart(2, "0")}:${(secs % 60).toString().padStart(2, "0")}`;
const parseDateTime = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00`);
const minutesBetween = (start: string, end: string) => {
  const s = parseDateTime("2000-01-01", start);
  const e = parseDateTime("2000-01-01", end);
  return Math.max(0, Math.round((e.getTime() - s.getTime()) / 60000));
};

const dayLabel = (dateStr: string) => new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" });

// =========================
// MAIN COMPONENT
// =========================
export default function StudyCommandSystem() {
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<Record<string, DayData>>({});
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [activeTray, setActiveTray] = useState(0);
  const [muted, setMuted] = useState(false);

  // --- Task Form ---
  const [taskText, setTaskText] = useState("");
  const [taskBlock, setTaskBlock] = useState<TimeBlock>("Morning");
  const [taskPrio, setTaskPrio] = useState<Priority>("Must do");
  const [taskCat, setTaskCat] = useState<Category>("Revision");

  // --- Goal Form ---
  const [goalTitle, setGoalTitle] = useState("");
  const [goalStart, setGoalStart] = useState("");
  const [goalEnd, setGoalEnd] = useState("");
  const [goalNote, setGoalNote] = useState("");

  // --- Pre-plan Form ---
  const [futureDate, setFutureDate] = useState(todayStr());
  const [futureText, setFutureText] = useState("");

  // --- Focus Lab ---
  const [timerLeft, setTimerLeft] = useState(25 * 60);
  const [timerActive, setTimerActive] = useState(false);
  const [activeDuration, setActiveDuration] = useState(25);
  const [focusTitle, setFocusTitle] = useState("Deep Work Session");
  const timerCountedRef = useRef(false);

  // --- Mindfulness ---
  const [mindfulnessPresets, setMindfulnessPresets] = useState<MindfulnessPreset[]>([
    { id: "m1", title: "Eye close & Relax", everyMinutes: 45, enabled: false },
    { id: "m2", title: "Stand & Stretch", everyMinutes: 90, enabled: false },
    { id: "m3", title: "Hydration Drop", everyMinutes: 60, enabled: false },
  ]);
  const mindfulnessRef = useRef<Record<string, number>>({});

  // =========================
  // INITIALIZATION
  // =========================
  useEffect(() => {
    setMounted(true);
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setData(JSON.parse(saved));
    } catch { setData({}); }
  }, []);

  useEffect(() => {
    if (mounted) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data, mounted]);

  // =========================
  // CORE HELPERS
  // =========================
  const updateDay = (date: string, fn: (d: DayData) => DayData) => {
    setData((prev) => ({ ...prev, [date]: fn(prev[date] || getEmptyDay()) }));
  };

  const pushAlert = (date: string, message: string, type: AlertType) => {
    updateDay(date, (d) => ({
      ...d, alerts: [{ id: safeUUID(), time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), message, type }, ...d.alerts].slice(0, 50),
    }));
  };

  const playSound = (type: "start" | "alert") => {
    if (muted || typeof window === "undefined") return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      if (type === "start") {
        osc.type = "sine"; osc.frequency.setValueAtTime(450, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(820, ctx.currentTime + 0.25);
        gain.gain.setValueAtTime(0.08, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(); osc.stop(ctx.currentTime + 0.25);
      } else {
        osc.type = "triangle"; osc.frequency.setValueAtTime(700, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(320, ctx.currentTime + 0.8);
        gain.gain.setValueAtTime(0.14, ctx.currentTime); gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
        osc.start(); osc.stop(ctx.currentTime + 0.8);
      }
    } catch {}
  };

  const notify = (date: string, title: string, body: string, type: AlertType) => {
    playSound(type === "start" ? "start" : "alert");
    if (typeof window !== "undefined" && !muted && "Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
    pushAlert(date, `${title}: ${body}`, type);
  };

  // =========================
  // DERIVED DATA (ANALYTICS)
  // =========================
  const selData = data[selectedDate] || getEmptyDay();
  const accuracy = selData.reflection.mcqsTotal > 0 ? Math.round((selData.reflection.mcqsCorrect / selData.reflection.mcqsTotal) * 100) : 0;
  const totalDeepWork = Math.round(selData.pomodoros * 25 + selData.deepWorkMinutesManual);
  
  const yesterdayDate = useMemo(() => {
    const d = new Date(`${selectedDate}T00:00:00`); d.setDate(d.getDate() - 1);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split("T")[0];
  }, [selectedDate]);

  const growthStats = useMemo(() => {
    const y = data[yesterdayDate] || getEmptyDay();
    const yAcc = y.reflection.mcqsTotal > 0 ? Math.round((y.reflection.mcqsCorrect / y.reflection.mcqsTotal) * 100) : 0;
    return {
      pomsDiff: Math.round(selData.pomodoros * 25) - Math.round(y.pomodoros * 25),
      accDiff: accuracy - yAcc,
    };
  }, [data, yesterdayDate, selData, accuracy]);

  const sortedGoals = useMemo(() => [...selData.goals].sort((a, b) => a.startTime.localeCompare(b.startTime)), [selData.goals]);

  const graphData = useMemo(() => {
    const arr = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(`${todayStr()}T00:00:00`); d.setDate(d.getDate() - i);
      const date = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split("T")[0];
      const day = data[date] || getEmptyDay();
      arr.push({
        date, day: dayLabel(date),
        accuracy: day.reflection.mcqsTotal > 0 ? Math.round((day.reflection.mcqsCorrect / day.reflection.mcqsTotal) * 100) : 0,
        deepWork: Math.round(day.pomodoros * 25 + day.deepWorkMinutesManual),
        mood: day.reflection.mood,
        doneTasks: day.tasks.filter((t) => t.done).length,
      });
    }
    return arr;
  }, [data]);

  const mustDoTotal = selData.tasks.filter((t) => t.priority === "Must do").length;
  const mustDoDone = selData.tasks.filter((t) => t.priority === "Must do" && t.done).length;
  const mustDoProgress = mustDoTotal > 0 ? Math.round((mustDoDone / mustDoTotal) * 100) : 0;

  // =========================
  // ACTIONS
  // =========================
  const handleAddTask = (overrideText?: string, overrideCat?: Category) => {
    const finalTxt = overrideText || taskText;
    if (!finalTxt.trim()) return;
    updateDay(selectedDate, (d) => ({
      ...d, tasks: [...d.tasks, { id: safeUUID(), text: finalTxt.trim(), done: false, block: taskBlock, priority: taskPrio, category: overrideCat || taskCat, createdAt: new Date().toISOString() }],
    }));
    setTaskText("");
  };

  const carryForwardUnfinished = () => {
    const prev = data[yesterdayDate] || getEmptyDay();
    const unfinished = prev.tasks.filter((t) => !t.done);
    if (!unfinished.length) return;
    updateDay(selectedDate, (d) => {
      if (d.carriedForward) return d;
      return { ...d, carriedForward: true, tasks: [...unfinished.map((t) => ({ ...t, id: safeUUID(), createdAt: new Date().toISOString() })), ...d.tasks] };
    });
    pushAlert(selectedDate, `Carried ${unfinished.length} unfinished task(s) from yesterday.`, "info");
  };

  const addGoal = () => {
    if (!goalTitle.trim() || !goalStart || !goalEnd) return;
    if (goalEnd <= goalStart) return pushAlert(selectedDate, "Goal end time must be after start.", "info");
    updateDay(selectedDate, (d) => ({
      ...d, goals: [...d.goals, { id: safeUUID(), title: goalTitle.trim(), startTime: goalStart, endTime: goalEnd, note: goalNote.trim(), status: "pending", linkedTaskId: null, alerts: { before5: false, midway: false, end: false, autoStarted: false } }],
    }));
    setGoalTitle(""); setGoalStart(""); setGoalEnd(""); setGoalNote("");
  };

  // =========================
  // ENGINES
  // =========================
  useEffect(() => {
    let interval: any = null;
    if (timerActive && timerLeft > 0) {
      interval = setInterval(() => setTimerLeft((prev) => prev - 1), 1000);
    }
    if (timerActive && timerLeft === 0 && !timerCountedRef.current) {
      timerCountedRef.current = true;
      setTimerActive(false);
      playSound("alert");
      updateDay(todayStr(), (d) => ({ ...d, pomodoros: d.pomodoros + activeDuration / 25 }));
      pushAlert(todayStr(), `Focus session completed: ${focusTitle}`, "end");
    }
    return () => { if (interval) clearInterval(interval); };
  }, [timerActive, timerLeft, activeDuration, focusTitle]);

  const setTimerPreset = (mins: number) => {
    timerCountedRef.current = false;
    setActiveDuration(mins); setTimerLeft(mins * 60); setTimerActive(false);
  };

  if (!mounted) return null;

  // =========================
  // UI RENDERING
  // =========================
  return (
    <div className={`min-h-screen font-sans flex flex-col md:flex-row transition-colors duration-1000 ${timerActive ? "bg-[#0B0F19] text-slate-200" : "bg-slate-50 text-slate-900"}`}>
      
      {/* SIDEBAR */}
      <nav className={`w-full md:w-72 p-6 flex flex-col shrink-0 z-20 transition-all duration-1000 ${timerActive ? "bg-black/60 border-r border-white/5 backdrop-blur-xl" : "bg-slate-900 border-r border-slate-800 shadow-2xl"}`}>
        <div className="mb-10 text-center md:text-left animate-in slide-in-from-left-4 duration-500">
          <h1 className="text-white text-3xl font-black italic tracking-tighter">COMMAND<span className="text-indigo-500">.v9</span></h1>
          <p className="text-[10px] text-indigo-400 font-bold uppercase tracking-[0.2em] mt-2">Study Command Center</p>
        </div>

        <div className="space-y-2 flex-1">
          {["Mission Planning", "Time Blocking", "Focus Lab", "End-Day Protocol", "Future Horizon", "Intelligence"].map((n, i) => (
            <button key={i} onClick={() => setActiveTray(i)} className={`w-full text-left px-5 py-4 rounded-2xl text-sm font-bold transition-all duration-300 ${activeTray === i ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/40 scale-105" : "text-slate-400 hover:bg-slate-800 hover:text-white"}`}>
              {n}
            </button>
          ))}
        </div>

        <div className="mt-auto pt-6 border-t border-slate-800 space-y-3">
          <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="w-full bg-slate-800/50 border border-slate-700 text-white p-3 rounded-xl text-xs font-mono outline-none focus:border-indigo-500 transition-colors" />
          <div className="flex gap-2">
            <button onClick={() => setMuted(!muted)} className="flex-1 bg-slate-800/50 border border-slate-700 text-slate-400 p-2 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:text-white transition-colors">
              {muted ? "🔇 Audio Off" : "🔊 Audio On"}
            </button>
            <button onClick={() => { if ("Notification" in window) Notification.requestPermission(); }} className="flex-1 bg-slate-800/50 border border-slate-700 text-slate-400 p-2 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:text-white transition-colors">
              🔔 Alerts
            </button>
          </div>
        </div>
      </nav>

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 p-4 md:p-10 overflow-y-auto h-screen scroll-smooth relative z-10">
        <div className="max-w-6xl mx-auto space-y-8">

          {/* TOP METRICS HUD */}
          {!timerActive && (
            <header className="grid grid-cols-2 lg:grid-cols-4 gap-4 animate-in slide-in-from-top-6 duration-700 fade-in">
              <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Deep Work Yield</span>
                <div className="text-4xl font-black text-indigo-600 mt-2">{totalDeepWork}<span className="text-lg text-indigo-300">m</span></div>
                <div className={`text-[10px] font-bold mt-3 flex items-center gap-1 ${growthStats.pomsDiff >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                  {growthStats.pomsDiff >= 0 ? "▲" : "▼"} {Math.abs(growthStats.pomsDiff)}m vs Yesterday
                </div>
              </div>
              <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Live Accuracy</span>
                <div className="text-4xl font-black text-emerald-500 mt-2">{accuracy}<span className="text-lg text-emerald-300">%</span></div>
                <div className={`text-[10px] font-bold mt-3 flex items-center gap-1 ${growthStats.accDiff >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                  {growthStats.accDiff >= 0 ? "▲" : "▼"} {Math.abs(growthStats.accDiff)}% vs Yesterday
                </div>
              </div>
              <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Must-Do Integrity</span>
                <div className="text-4xl font-black text-slate-800 mt-2">{mustDoDone} <span className="text-lg text-slate-300">/ {mustDoTotal}</span></div>
                <div className="w-full h-1.5 bg-slate-100 rounded-full mt-3 overflow-hidden">
                  <div className="h-full bg-rose-500 transition-all duration-1000" style={{ width: `${mustDoProgress}%` }} />
                </div>
              </div>
              <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Missions Completed</span>
                <div className="text-4xl font-black text-slate-800 mt-2">{selData.tasks.filter((t) => t.done).length} <span className="text-lg text-slate-300">/ {selData.tasks.length}</span></div>
                <button onClick={carryForwardUnfinished} className="mt-3 text-[10px] font-bold text-indigo-500 hover:text-indigo-700 uppercase tracking-widest transition-colors">
                  + Sweep Yesterday
                </button>
              </div>
            </header>
          )}

          {/* =========================================================
              TRAY 0: PLANNING (Manual + Quick QBank)
          ========================================================= */}
          {activeTray === 0 && (
            <div className="space-y-6 animate-in slide-in-from-bottom-8 duration-700 fade-in">
              <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-sm">
                <h2 className="text-sm font-black uppercase tracking-widest text-slate-800 mb-6 flex items-center gap-3">
                  <span className="w-3 h-3 rounded-full bg-indigo-500 animate-pulse shadow-[0_0_10px_rgba(99,102,241,0.6)]" /> Mission Control
                </h2>
                
                {/* The Input Bar */}
                <div className="flex flex-col md:flex-row gap-3 mb-8">
                  <input value={taskText} onChange={(e) => setTaskText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAddTask()} placeholder="What is the highest leverage task?" className="flex-1 bg-slate-50 border border-slate-200 p-5 rounded-2xl text-sm font-medium outline-none focus:ring-2 ring-indigo-500/20 transition-all shadow-inner" />
                  <select value={taskBlock} onChange={(e) => setTaskBlock(e.target.value as TimeBlock)} className="bg-slate-50 border border-slate-200 p-5 rounded-2xl text-xs font-bold text-slate-600 outline-none cursor-pointer hover:bg-slate-100 transition-colors">
                    {BLOCKS.map((b) => <option key={b}>{b}</option>)}
                  </select>
                  <select value={taskPrio} onChange={(e) => setTaskPrio(e.target.value as Priority)} className={`p-5 rounded-2xl text-xs font-bold border outline-none cursor-pointer transition-colors ${taskPrio === "Must do" ? "bg-rose-50 border-rose-200 text-rose-600" : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"}`}>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <button onClick={() => handleAddTask()} className="bg-indigo-600 text-white px-10 py-5 rounded-2xl font-black tracking-widest hover:bg-indigo-700 active:scale-95 transition-all shadow-lg hover:shadow-indigo-500/30">
                    ADD
                  </button>
                </div>

                {/* Quick Add Buttons */}
                <div className="border-t border-slate-100 pt-6">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">Quick Deploy (QBank Modules)</p>
                  <div className="flex flex-wrap gap-3">
                    {["Cardiology", "Renal", "Neuro", "Surgical", "Pharmacology"].map((sub) => (
                      <button key={sub} onClick={() => handleAddTask(`${sub} QBank Mastery`, "Qbank")} className="bg-indigo-50/50 text-indigo-600 px-5 py-3 rounded-xl text-xs font-bold border border-indigo-100 hover:bg-indigo-500 hover:text-white transition-all shadow-sm">
                        + {sub} Module
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Task List (Grouped by Priority execution) */}
              <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-sm">
                 {selData.tasks.length === 0 && <div className="text-center text-slate-400 text-sm py-12 font-bold italic border-2 border-dashed border-slate-100 rounded-3xl">No missions deployed for this cycle.</div>}
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                   {selData.tasks.map((t) => (
                     <div key={t.id} className="flex items-start gap-4 p-5 rounded-3xl border border-slate-100 hover:border-indigo-200 hover:bg-indigo-50/40 transition-all group shadow-sm">
                       <input type="checkbox" checked={t.done} onChange={() => updateDay(selectedDate, (d) => ({ ...d, tasks: d.tasks.map((x) => x.id === t.id ? { ...x, done: !x.done } : x) }))} className="mt-1 w-6 h-6 accent-indigo-600 cursor-pointer rounded-lg transition-transform active:scale-90" />
                       <div className="flex-1">
                         <p className={`text-base font-bold transition-all ${t.done ? "line-through text-slate-300" : "text-slate-800"}`}>{t.text}</p>
                         <div className="flex gap-2 mt-2">
                           <span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full ${t.priority === "Must do" ? "bg-rose-100 text-rose-600" : "bg-slate-100 text-slate-500"}`}>{t.priority}</span>
                           <span className="text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full bg-slate-100 text-slate-500">{t.block}</span>
                         </div>
                       </div>
                       <button onClick={() => updateDay(selectedDate, (d) => ({ ...d, tasks: d.tasks.filter((x) => x.id !== t.id) }))} className="text-slate-200 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity p-2 rounded-full hover:bg-rose-50">✕</button>
                     </div>
                   ))}
                 </div>
              </div>
            </div>
          )}

          {/* =========================================================
              TRAY 1: TIME BLOCKING (Scheduled Goals)
          ========================================================= */}
          {activeTray === 1 && (
            <div className="space-y-6 animate-in slide-in-from-bottom-8 duration-700 fade-in">
              <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-sm flex flex-col md:flex-row gap-4">
                <input value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} placeholder="Time Block Title (e.g. Deep Work: SBA)" className="flex-1 bg-slate-50 border border-slate-200 p-5 rounded-2xl text-sm font-bold outline-none focus:border-indigo-400 transition-colors shadow-inner" />
                <input type="time" value={goalStart} onChange={(e) => setGoalStart(e.target.value)} className="bg-slate-50 border border-slate-200 p-5 rounded-2xl text-sm font-bold text-slate-600 outline-none focus:border-indigo-400 transition-colors shadow-inner" />
                <input type="time" value={goalEnd} onChange={(e) => setGoalEnd(e.target.value)} className="bg-slate-50 border border-slate-200 p-5 rounded-2xl text-sm font-bold text-slate-600 outline-none focus:border-indigo-400 transition-colors shadow-inner" />
                <button onClick={addGoal} className="bg-indigo-600 text-white px-10 py-5 rounded-2xl font-black tracking-widest hover:bg-indigo-700 transition-all shadow-lg active:scale-95">BLOCK TIME</button>
              </div>

              <div className="space-y-4">
                {sortedGoals.map((g) => (
                  <div key={g.id} className={`p-8 rounded-[40px] border flex flex-col md:flex-row md:items-center justify-between transition-all duration-500 ${g.status === "in-progress" ? "bg-indigo-50 border-indigo-200 shadow-[0_0_30px_rgba(99,102,241,0.15)] scale-[1.01]" : g.status === "completed" ? "bg-emerald-50/50 border-emerald-100 opacity-60 hover:opacity-100" : "bg-white border-slate-200 shadow-sm hover:shadow-md"}`}>
                    <div className="mb-6 md:mb-0">
                      <h4 className="font-black text-slate-800 text-xl">{g.title}</h4>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-xs font-mono font-black tracking-widest bg-slate-900 text-white px-3 py-1 rounded-lg">{g.startTime} — {g.endTime}</span>
                        <span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full ${g.status === 'completed' ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>{g.status.replace('-', ' ')}</span>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      {g.status === "pending" && <button onClick={() => updateDay(selectedDate, (d) => ({ ...d, goals: d.goals.map((x) => x.id === g.id ? { ...x, status: "in-progress" } : x) }))} className="bg-slate-900 text-white px-8 py-4 rounded-2xl text-xs font-black tracking-widest hover:bg-slate-800 transition-colors shadow-md active:scale-95">COMMENCE</button>}
                      {(g.status === "in-progress" || g.status === "awaiting-review") && (
                        <button onClick={() => updateDay(selectedDate, (d) => ({ ...d, goals: d.goals.map((x) => x.id === g.id ? { ...x, status: "completed" } : x) }))} className="bg-emerald-500 text-white px-8 py-4 rounded-2xl text-xs font-black tracking-widest hover:bg-emerald-600 transition-colors shadow-md active:scale-95">MARK SECURED</button>
                      )}
                      <button onClick={() => updateDay(selectedDate, (d) => ({ ...d, goals: d.goals.filter((x) => x.id !== g.id) }))} className="bg-slate-50 border border-slate-200 text-slate-400 hover:text-rose-500 hover:border-rose-200 hover:bg-rose-50 px-5 py-4 rounded-2xl transition-all font-black">✕</button>
                    </div>
                  </div>
                ))}
                {sortedGoals.length === 0 && <div className="text-center text-slate-400 text-sm font-bold italic py-16 bg-white rounded-[40px] border-2 border-slate-100 border-dashed">No temporal blocks established for today.</div>}
              </div>
            </div>
          )}

          {/* =========================================================
              TRAY 2: FOCUS LAB (Breathtaking Animation)
          ========================================================= */}
          {activeTray === 2 && (
            <div className="flex flex-col items-center justify-center min-h-[75vh] animate-in zoom-in-[0.98] duration-1000 fade-in">
              
              {!timerActive && (
                <div className="flex flex-wrap justify-center gap-4 mb-16 animate-in slide-in-from-bottom-8 duration-700">
                  {[15, 25, 50, 90].map((m) => (
                    <button key={m} onClick={() => setTimerPreset(m)} className={`px-8 py-4 rounded-3xl text-sm font-black border-2 transition-all duration-300 ${activeDuration === m ? "border-indigo-500 bg-indigo-50 text-indigo-600 shadow-[0_10px_20px_rgba(99,102,241,0.2)] scale-110" : "border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-white"}`}>
                      {m} Min
                    </button>
                  ))}
                </div>
              )}

              {/* The Master Clock Element */}
              <div className="relative group flex items-center justify-center w-[22rem] h-[22rem] mb-16">
                {timerActive && (
                  <>
                    {/* Glowing Core */}
                    <div className="absolute inset-0 bg-indigo-500 rounded-full blur-[100px] opacity-30 animate-pulse" style={{ animationDuration: '4s' }} />
                    {/* Expanding Rings */}
                    <div className="absolute inset-[-40px] border-[3px] border-indigo-400/20 rounded-full animate-ping" style={{ animationDuration: '3s' }} />
                    <div className="absolute inset-[-80px] border-[1px] border-indigo-400/10 rounded-full animate-ping" style={{ animationDuration: '4s', animationDelay: '1s' }} />
                  </>
                )}
                
                <div className={`relative z-10 w-full h-full rounded-full flex flex-col items-center justify-center border-[6px] transition-all duration-1000 ${timerActive ? "border-indigo-400 bg-slate-900/60 backdrop-blur-xl shadow-[0_0_100px_rgba(99,102,241,0.6)] scale-[1.05]" : "border-slate-200 bg-white shadow-2xl"}`}>
                  <div className={`text-8xl font-mono font-black tracking-tighter transition-colors duration-1000 ${timerActive ? "text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.8)]" : "text-slate-800"}`}>
                    {formatTime(timerLeft)}
                  </div>
                  <div className={`text-xs font-black uppercase tracking-[0.5em] mt-6 transition-colors duration-1000 ${timerActive ? "text-indigo-300" : "text-slate-400"}`}>
                    {timerActive ? "Deep State Engaged" : "Awaiting Sequence"}
                  </div>
                </div>
              </div>

              {/* Controls */}
              <div className="flex gap-6 w-full max-w-md">
                <button onClick={() => {
                  if (!timerActive) {
                    timerCountedRef.current = false;
                    playSound("start");
                  }
                  setTimerActive(!timerActive);
                }} className={`flex-1 py-6 rounded-[40px] font-black text-xl tracking-widest transition-all active:scale-95 shadow-2xl ${timerActive ? "bg-rose-500 text-white shadow-rose-500/50 hover:bg-rose-600" : "bg-indigo-600 text-white shadow-indigo-600/50 hover:bg-indigo-700 hover:shadow-indigo-600/70"}`}>
                  {timerActive ? "ABORT MISSION" : "INITIATE"}
                </button>
                {!timerActive && (
                  <button onClick={() => setTimerPreset(activeDuration)} className="flex-1 py-6 rounded-[40px] bg-slate-200 text-slate-600 font-black tracking-widest hover:bg-slate-300 active:scale-95 transition-all shadow-md">
                    SYSTEM RESET
                  </button>
                )}
              </div>
            </div>
          )}

          {/* =========================================================
              TRAY 3: END-DAY PROTOCOL
          ========================================================= */}
          {activeTray === 3 && (
            <div className="max-w-3xl mx-auto space-y-6 animate-in slide-in-from-bottom-8 duration-700 fade-in">
              <div className="bg-white p-10 md:p-12 rounded-[48px] border border-slate-200 shadow-xl relative overflow-hidden">
                {selData.reflection.submitted && (
                  <div className="absolute top-8 right-10 bg-emerald-100 text-emerald-600 px-5 py-2 rounded-full text-[10px] font-black uppercase tracking-widest shadow-sm border border-emerald-200">
                    Data Locked
                  </div>
                )}
                <h2 className="text-3xl font-black text-slate-800 mb-10">End-Day Protocol</h2>
                
                <div className="grid grid-cols-2 gap-8 mb-10">
                  <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Total MCQs Done</label>
                    <input type="number" value={selData.reflection.mcqsTotal || ""} onChange={(e) => updateDay(selectedDate, (d) => ({ ...d, reflection: { ...d.reflection, mcqsTotal: Number(e.target.value) } }))} className="w-full bg-slate-50 border border-slate-200 p-6 rounded-[32px] text-3xl font-black outline-none focus:border-indigo-400 transition-colors shadow-inner" />
                  </div>
                  <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Correct Answers</label>
                    <input type="number" value={selData.reflection.mcqsCorrect || ""} onChange={(e) => updateDay(selectedDate, (d) => ({ ...d, reflection: { ...d.reflection, mcqsCorrect: Number(e.target.value) } }))} className="w-full bg-slate-50 border border-slate-200 p-6 rounded-[32px] text-3xl font-black outline-none focus:border-emerald-400 transition-colors shadow-inner" />
                  </div>
                </div>

                <div className="space-y-4 mb-10">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Mental Energy / Mood Rating</label>
                  <div className="flex justify-between gap-4">
                    {[1, 2, 3, 4, 5].map((m) => (
                      <button key={m} onClick={() => updateDay(selectedDate, (d) => ({ ...d, reflection: { ...d.reflection, mood: m } }))} className={`flex-1 py-6 rounded-[32px] font-black text-2xl transition-all ${selData.reflection.mood === m ? "bg-slate-900 text-white shadow-xl scale-105" : "bg-slate-50 text-slate-400 hover:bg-slate-100 border border-slate-200"}`}>
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-4 mb-12">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Primary Focus Leak</label>
                  <div className="flex flex-wrap gap-3">
                    {["None", "Phone", "Tired", "Overplanned", "Interruptions", "Low Mood"].map((r) => (
                      <button key={r} onClick={() => updateDay(selectedDate, (d) => ({ ...d, reflection: { ...d.reflection, failReason: r as FailReason } }))} className={`px-6 py-4 rounded-2xl text-xs font-black tracking-widest uppercase transition-all ${selData.reflection.failReason === r ? "bg-rose-50 border-rose-200 text-rose-600 border-2 shadow-sm" : "bg-slate-50 text-slate-400 border border-slate-200 hover:bg-slate-100"}`}>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                <button onClick={() => { playSound("alert"); updateDay(selectedDate, (d) => ({ ...d, reflection: { ...d.reflection, submitted: true } })); }} className="w-full bg-indigo-600 text-white py-8 rounded-[40px] font-black text-xl tracking-widest hover:bg-indigo-700 transition-all active:scale-95 shadow-[0_20px_40px_rgba(99,102,241,0.3)]">
                  LOCK DATA & FINISH DAY
                </button>
              </div>
            </div>
          )}

          {/* =========================================================
              TRAY 4: FUTURE HORIZON
          ========================================================= */}
          {activeTray === 4 && (
            <div className="space-y-6 animate-in slide-in-from-bottom-8 duration-700 fade-in">
              <div className="mb-8 bg-white p-8 rounded-[40px] shadow-sm border border-slate-200">
                <h2 className="text-3xl font-black text-slate-800">Future Horizon</h2>
                <p className="text-sm text-slate-500 font-bold mt-2">Pre-load your upcoming days to maintain momentum without cluttering today's dashboard.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {[1, 2, 3].map((offset) => {
                  const targetDate = new Date(selectedDate);
                  targetDate.setDate(targetDate.getDate() + offset);
                  const tStr = new Date(targetDate.getTime() - targetDate.getTimezoneOffset() * 60000).toISOString().split("T")[0];
                  const dayName = targetDate.toLocaleDateString("en-US", { weekday: "long" });
                  const tData = data[tStr] || getEmptyDay();

                  return (
                    <div key={offset} className="bg-white p-8 rounded-[48px] border border-slate-200 shadow-sm flex flex-col h-[500px] hover:shadow-xl transition-all duration-500 group">
                      <div className="mb-6 pb-6 border-b border-slate-100">
                        <div className="text-2xl font-black text-indigo-600 group-hover:scale-105 transition-transform origin-left">{dayName}</div>
                        <div className="text-[10px] font-black uppercase text-slate-400 tracking-widest mt-1">{tStr}</div>
                      </div>
                      
                      <div className="flex-1 overflow-y-auto space-y-3 mb-6 pr-2">
                        {tData.tasks.map((t) => (
                          <div key={t.id} className="text-sm font-bold text-slate-700 bg-slate-50 p-4 rounded-2xl border border-slate-100 flex items-start gap-3 shadow-sm">
                            <span className="text-indigo-400 mt-0.5">●</span> {t.text}
                          </div>
                        ))}
                        {tData.tasks.length === 0 && <div className="text-xs text-slate-300 italic font-black uppercase tracking-widest text-center py-10">Blank Slate</div>}
                      </div>

                      <div className="mt-auto">
                        <input type="text" placeholder="+ Pre-plan Mission..." onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const val = e.currentTarget.value;
                            if (!val.trim()) return;
                            updateDay(tStr, (d) => ({ ...d, tasks: [...d.tasks, { id: safeUUID(), text: val, done: false, block: "Morning", priority: "Should do", category: "Revision", createdAt: new Date().toISOString() }] }));
                            e.currentTarget.value = "";
                          }
                        }} className="w-full bg-slate-50 border border-slate-200 p-5 rounded-3xl text-sm font-bold outline-none focus:border-indigo-400 focus:ring-4 ring-indigo-500/10 transition-all" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* =========================================================
              TRAY 5: INTELLIGENCE / ANALYTICS
          ========================================================= */}
          {activeTray === 5 && (
            <div className="space-y-6 animate-in slide-in-from-bottom-8 duration-700 fade-in">
              <div className="bg-[#0B0F19] p-10 md:p-14 rounded-[56px] text-white shadow-2xl overflow-hidden relative">
                {/* Background Glows */}
                <div className="absolute -top-32 -right-32 w-96 h-96 bg-indigo-600/30 rounded-full blur-[120px]" />
                <div className="absolute -bottom-32 -left-32 w-96 h-96 bg-rose-600/20 rounded-full blur-[120px]" />
                
                <h3 className="text-xs font-black uppercase tracking-[0.3em] text-indigo-400 mb-10 relative z-10">System Velocity (7-Day Yield)</h3>
                
          <div className="w-full h-[260px] min-w-0">
  <ResponsiveContainer width="100%" height="100%">
    <AreaChart data={[...graphData].reverse()}>
      <defs>
        <linearGradient id="colorPoms" x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor="#818cf8" stopOpacity={0.6}/>
          <stop offset="95%" stopColor="#818cf8" stopOpacity={0}/>
        </linearGradient>
      </defs>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#ffffff10" />
      <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 12, fontWeight: 'bold' }} dy={10} />
      <YAxis hide domain={[0, 'dataMax + 20']} />
      <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '24px', color: '#fff', fontWeight: 'bold', padding: '16px' }} itemStyle={{ color: '#818cf8' }} />
      <Area type="monotone" dataKey="deepWork" stroke="#818cf8" strokeWidth={6} fill="url(#colorPoms)" animationDuration={2000} />
    </AreaChart>
  </ResponsiveContainer>
</div>

                <div className="mt-12 grid grid-cols-2 md:grid-cols-4 gap-6 relative z-10">
                  <div className="bg-white/5 p-6 rounded-3xl border border-white/10 backdrop-blur-md">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Total Yield</p>
                    <p className="text-3xl font-black text-white">{graphData.reduce((a, b) => a + b.deepWork, 0)}<span className="text-sm text-slate-500 ml-1">mins</span></p>
                  </div>
                  <div className="bg-white/5 p-6 rounded-3xl border border-white/10 backdrop-blur-md">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Peak Accuracy</p>
                    <p className="text-3xl font-black text-emerald-400">{Math.max(...graphData.map(d => d.accuracy))}<span className="text-sm text-emerald-700 ml-1">%</span></p>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
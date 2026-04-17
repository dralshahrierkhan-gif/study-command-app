"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, BarChart, Bar, Legend } from "recharts";
import { supabase } from "@/lib/supabase";

// =========================
// TYPES & CONSTANTS
// =========================
const STORAGE_KEY = "study-command-v10-local";

type TimeBlock = "Morning" | "Afternoon" | "Evening" | "Night";
type Priority = "Must do" | "Should do" | "Optional";
type Category = "Qbank" | "Revision" | "Reading" | "Notes" | "Exam" | "Exercise" | "Mindfulness";
type GoalStatus = "pending" | "in-progress" | "awaiting-review" | "completed" | "missed";
type FailReason = "Phone" | "Tired" | "Overplanned" | "Low Mood" | "Interruptions" | "None";
type AlertType = "info" | "start" | "mid" | "end" | "mindfulness" | "success";

type DailyHabits = { workout: boolean; reading: boolean; anki: boolean; noScreens: boolean; };
type Task = { id: string; text: string; done: boolean; block: TimeBlock; priority: Priority; category: Category; createdAt: string; };
type Goal = { id: string; title: string; startTime: string; endTime: string; status: GoalStatus; note?: string; alerts: { before5: boolean; midway: boolean; end: boolean; autoStarted: boolean; }; };
type Reflection = { submitted: boolean; mcqsTotal: number; mcqsCorrect: number; failReason: FailReason; mood: number; notes: string; habits: DailyHabits; };
type AppAlert = { id: string; time: string; message: string; type: AlertType; };
type MindfulnessPreset = { id: string; title: string; everyMinutes: number; enabled: boolean; };

type DayData = { tasks: Task[]; goals: Goal[]; pomodoros: number; reflection: Reflection; alerts: AppAlert[]; deepWorkMinutesManual: number; carriedForward: boolean; hydrationDone: boolean; mealsDone: boolean; };
type DbTaskRow = { id: string; user_id: string; date: string | null; text: string | null; done: boolean | null; block: string | null; priority: string | null; category: string | null; created_at: string | null; };

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
  tasks: [], goals: [], pomodoros: 0, alerts: [], deepWorkMinutesManual: 0, carriedForward: false, hydrationDone: false, mealsDone: false,
  reflection: { submitted: false, mcqsTotal: 0, mcqsCorrect: 0, failReason: "None", mood: 3, notes: "", habits: { workout: false, reading: false, anki: false, noScreens: false } },
});

const formatTime = (secs: number) => {
  const mm = Math.floor(secs / 60).toString().padStart(2, "0");
  const ss = (secs % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
};

const parseDateTime = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00`);

const minutesBetween = (start: string, end: string) => {
  const s = parseDateTime("2000-01-01", start);
  const e = parseDateTime("2000-01-01", end);
  return Math.max(0, Math.round((e.getTime() - s.getTime()) / 60000));
};

const dayLabel = (dateStr: string) => new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" });

const dbToTask = (row: DbTaskRow): Task => ({
  id: row.id, text: row.text ?? "", done: row.done ?? false, block: (row.block as TimeBlock) ?? "Morning", priority: (row.priority as Priority) ?? "Should do", category: (row.category as Category) ?? "Revision", createdAt: row.created_at ?? new Date().toISOString(),
});

// =========================
// MAIN COMPONENT
// =========================
export default function StudyCommandSystem() {
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<Record<string, DayData>>({});
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [activeTray, setActiveTray] = useState(0);
  const [muted, setMuted] = useState(false);
  const [now, setNow] = useState(new Date());

  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);

  // Forms
  const [taskText, setTaskText] = useState("");
  const [taskBlock, setTaskBlock] = useState<TimeBlock>("Morning");
  const [taskPrio, setTaskPrio] = useState<Priority>("Must do");
  const [taskCat, setTaskCat] = useState<Category>("Revision");

  const [goalTitle, setGoalTitle] = useState("");
  const [goalStart, setGoalStart] = useState("");
  const [goalEnd, setGoalEnd] = useState("");

  // Focus lab
  const [timerLeft, setTimerLeft] = useState(25 * 60);
  const [timerActive, setTimerActive] = useState(false);
  const [timerPaused, setTimerPaused] = useState(false);
  const [activeDuration, setActiveDuration] = useState(25);
  const [focusTitle, setFocusTitle] = useState("Deep Work Session");
  const timerCountedRef = useRef(false);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Mindfulness
  const [mindfulnessPresets, setMindfulnessPresets] = useState<MindfulnessPreset[]>([
    { id: "m1", title: "Eye close relax", everyMinutes: 45, enabled: false },
    { id: "m2", title: "Pushups break", everyMinutes: 90, enabled: false },
    { id: "m3", title: "Water reminder", everyMinutes: 60, enabled: false },
  ]);
  const mindfulnessRef = useRef<Record<string, number>>({});

  // =========================
  // INIT & AUTH
  // =========================
  useEffect(() => {
    setMounted(true);
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setData(JSON.parse(saved));
    } catch { setData({}); }
  }, []);

  useEffect(() => { if (mounted) localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }, [data, mounted]);

  useEffect(() => { const clock = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(clock); }, []);

  useEffect(() => {
    const loadSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setUserId(session?.user?.id ?? null);
      setUserEmail(session?.user?.email ?? null);
      setAuthLoading(false);
    };
    loadSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? null); setUserEmail(session?.user?.email ?? null); setAuthLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleLogin = async () => {
    const email = prompt("Enter your email"); if (!email) return;
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: typeof window !== "undefined" ? window.location.origin : undefined } });
    if (error) alert("Login failed: " + error.message); else alert("Check your email for the login link.");
  };

  const handleLogout = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) alert("Logout failed: " + error.message);
  };

  // =========================
  // HELPERS & PREMIUM AUDIO
  // =========================
  const updateDay = (date: string, fn: (d: DayData) => DayData) => setData((prev) => ({ ...prev, [date]: fn(prev[date] || getEmptyDay()) }));

  const pushAlert = (date: string, message: string, type: AlertType) => {
    updateDay(date, (d) => ({ ...d, alerts: [{ id: safeUUID(), time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), message, type }, ...d.alerts].slice(0, 50) }));
  };

  const playSound = (type: "start" | "alert" | "success") => {
    if (muted || typeof window === "undefined") return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      
      if (type === "start") {
        osc.type = "sine"; osc.frequency.setValueAtTime(440, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0, ctx.currentTime); gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.05); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(); osc.stop(ctx.currentTime + 0.3);
      } else if (type === "alert") {
        osc.type = "triangle"; osc.frequency.setValueAtTime(700, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.6);
        gain.gain.setValueAtTime(0.15, ctx.currentTime); gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
        osc.start(); osc.stop(ctx.currentTime + 0.6);
      } else if (type === "success") {
        osc.type = "sine"; osc.frequency.setValueAtTime(600, ctx.currentTime); osc.frequency.setValueAtTime(800, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.05, ctx.currentTime); gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
        osc.start(); osc.stop(ctx.currentTime + 0.2);
      }
    } catch {}
  };

  const sendBrowserNotification = (title: string, body: string) => {
    if (typeof window === "undefined" || muted || !("Notification" in window)) return;
    if (Notification.permission === "granted") new Notification(title, { body });
  };

  const notify = (date: string, title: string, body: string, type: AlertType) => {
    playSound(type === "start" ? "start" : "alert");
    sendBrowserNotification(title, body);
    pushAlert(date, `${title}: ${body}`, type);
  };

  const requestNotificationPermission = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      alert("Browser notifications are not supported on this device.");
      return;
    }
    if (Notification.permission === "granted") {
      alert("✅ Notifications are already enabled and active!");
    } else if (Notification.permission === "denied") {
      alert("❌ Notifications are blocked. Please enable them in your browser settings to receive alerts.");
    } else {
      try { 
        const perm = await Notification.requestPermission(); 
        if (perm === "granted") alert("✅ Notifications enabled successfully!");
      } catch (e) {
        console.error(e);
      }
    }
  };

  // =========================
  // SUPABASE TASK SYNC
  // =========================
  const loadTasksForDate = async (date: string) => {
    if (!userId) return;
    setTasksLoading(true);
    const { data: rows, error } = await supabase.from("Tasks").select("*").eq("user_id", userId).eq("date", date).order("created_at", { ascending: true });
    setTasksLoading(false);
    if (error) { console.error("Load tasks failed:", error.message); pushAlert(date, "Failed to load tasks from cloud.", "info"); return; }
    updateDay(date, (d) => ({ ...d, tasks: (rows as DbTaskRow[]).map(dbToTask) }));
  };

  useEffect(() => { if (userId && mounted) loadTasksForDate(selectedDate); }, [userId, selectedDate, mounted]);

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
    return { accDiff: accuracy - yAcc, deepWorkDiff: totalDeepWork - Math.round(y.pomodoros * 25 + y.deepWorkMinutesManual) };
  }, [data, yesterdayDate, selData, accuracy, totalDeepWork]);

  const sortedGoals = useMemo(() => [...selData.goals].sort((a, b) => a.startTime.localeCompare(b.startTime)), [selData.goals]);

  const graphData = useMemo(() => {
    const arr = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(`${todayStr()}T00:00:00`); d.setDate(d.getDate() - i);
      const date = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split("T")[0];
      const day = data[date] || getEmptyDay();
      arr.push({ date, day: dayLabel(date), accuracy: day.reflection.mcqsTotal > 0 ? Math.round((day.reflection.mcqsCorrect / day.reflection.mcqsTotal) * 100) : 0, deepWork: Math.round(day.pomodoros * 25 + day.deepWorkMinutesManual), mood: day.reflection.mood, doneTasks: day.tasks.filter((t) => t.done).length, totalTasks: day.tasks.length });
    }
    return arr;
  }, [data]);

  const mustDoTotal = selData.tasks.filter((t) => t.priority === "Must do").length;
  const mustDoDone = selData.tasks.filter((t) => t.priority === "Must do" && t.done).length;
  const mustDoProgress = mustDoTotal > 0 ? Math.round((mustDoDone / mustDoTotal) * 100) : 0;

  const smartSuggestion = useMemo(() => {
    if (accuracy < 50 && selData.reflection.mcqsTotal >= 20) return "Accuracy is low. Shift next session to revision before doing more SBA.";
    if (totalDeepWork < 60) return "Deep work is low. Try two 25 minute sessions before sleep or early morning.";
    if (selData.tasks.length > 8 && mustDoProgress < 50) return "You may be overplanning. Cut Optional tasks and finish Must do items first.";
    if (selData.reflection.failReason === "Phone") return "Phone is your biggest leak today. Use airplane mode in the next focus block.";
    return "Steady trajectory detected. Keep your next block highly specific and time-bound.";
  }, [accuracy, selData, totalDeepWork, mustDoProgress]);

  // =========================
  // TASK ACTIONS
  // =========================
  const handleAddTask = async () => {
    if (!taskText.trim()) return;
    if (!userId) { alert("Please login first."); return; }
    
    const payload = { user_id: userId, date: selectedDate, text: taskText.trim(), done: false, block: taskBlock, priority: taskPrio, category: taskCat };
    const { data: inserted, error } = await supabase.from("Tasks").insert(payload).select().single();
    if (error) { alert("Could not save task: " + error.message); return; }
    
    updateDay(selectedDate, (d) => ({ ...d, tasks: [...d.tasks, dbToTask(inserted as DbTaskRow)] }));
    setTaskText(""); playSound("start");
  };

  const toggleTask = async (taskId: string) => {
    const currentTask = selData.tasks.find((t) => t.id === taskId);
    if (!currentTask) return;
    if (!userId) { alert("Please login first."); return; }
    
    const nextDone = !currentTask.done;
    if (nextDone) playSound("success");
    
    const { error } = await supabase.from("Tasks").update({ done: nextDone }).eq("id", taskId).eq("user_id", userId);
    if (error) { alert("Could not update task: " + error.message); return; }
    
    updateDay(selectedDate, (d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === taskId ? { ...t, done: nextDone } : t)) }));
  };

  const deleteTask = async (taskId: string) => {
    if (!userId) { alert("Please login first."); return; }
    const { error } = await supabase.from("Tasks").delete().eq("id", taskId).eq("user_id", userId);
    if (error) { alert("Could not delete task: " + error.message); return; }
    updateDay(selectedDate, (d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== taskId) }));
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

  // =========================
  // GOAL ACTIONS
  // =========================
  const addGoal = () => {
    if (!goalTitle.trim() || !goalStart || !goalEnd) return;
    if (goalEnd <= goalStart) { pushAlert(selectedDate, "Goal end time must be after start time.", "info"); return; }
    updateDay(selectedDate, (d) => ({ ...d, goals: [...d.goals, { id: safeUUID(), title: goalTitle.trim(), startTime: goalStart, endTime: goalEnd, status: "pending", alerts: { before5: false, midway: false, end: false, autoStarted: false } }] }));
    setGoalTitle(""); setGoalStart(""); setGoalEnd("");
  };

  // =========================
  // ENGINES (FOCUS LAB & SCHEDULE)
  // =========================
  
  // ✅ EXPLICIT HANDLERS FOR IMPERATIVE TIMER CONTROL
  const handleInitiate = () => {
    timerCountedRef.current = false;
    setTimerLeft(activeDuration * 60);
    setTimerPaused(false);
    setTimerActive(true);
    playSound("start");
  };

  const handleAbort = () => {
    setTimerActive(false);
    setTimerPaused(false);
    setTimerLeft(activeDuration * 60);
  };

  const handlePause = () => setTimerPaused(true);
  const handleResume = () => setTimerPaused(false);

  const setTimerPreset = (mins: number) => { 
    timerCountedRef.current = false; 
    setActiveDuration(mins); 
    setTimerLeft(mins * 60); 
    setTimerActive(false); 
    setTimerPaused(false); 
  };

  // Bulletproof Interval Execution
  useEffect(() => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);

    if (timerActive && !timerPaused) {
      timerIntervalRef.current = setInterval(() => {
        setTimerLeft((prev) => { 
          if (prev <= 1) { 
            if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
            return 0; 
          } 
          return prev - 1; 
        });
      }, 1000);
    }
    return () => { 
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current); 
    };
  }, [timerActive, timerPaused]);

  // Completion Check
  useEffect(() => {
    if (timerActive && timerLeft === 0 && !timerCountedRef.current) {
      timerCountedRef.current = true; 
      setTimerActive(false); 
      setTimerPaused(false); 
      playSound("alert");
      updateDay(todayStr(), (d) => ({ ...d, pomodoros: d.pomodoros + activeDuration / 25 }));
      pushAlert(todayStr(), `Focus session completed: ${focusTitle}`, "end");
    }
  }, [timerLeft, timerActive, activeDuration, focusTitle]);

  // Goal Auto-Start & Notifications
  useEffect(() => {
    const interval = setInterval(() => {
      const currentTime = new Date();
      const currentDate = todayStr();
      const currentDay = data[currentDate] || getEmptyDay();

      currentDay.goals.forEach((goal) => {
        const start = parseDateTime(currentDate, goal.startTime);
        const end = parseDateTime(currentDate, goal.endTime);
        const midway = new Date((start.getTime() + end.getTime()) / 2);
        
        const before5Diff = Math.floor((start.getTime() - currentTime.getTime()) / 1000);
        const startDiffAbs = Math.abs(start.getTime() - currentTime.getTime());
        const midwayDiffAbs = Math.abs(midway.getTime() - currentTime.getTime());
        const endDiffAbs = Math.abs(end.getTime() - currentTime.getTime());

        let nextStatus: GoalStatus = goal.status;
        if (currentTime < start && goal.status !== "completed" && goal.status !== "missed") nextStatus = "pending";
        if (currentTime >= start && currentTime < end && goal.status !== "completed" && goal.status !== "missed") nextStatus = "in-progress";
        if (currentTime > end && goal.status === "in-progress") nextStatus = "awaiting-review";
        if (currentTime > end && goal.status === "pending") nextStatus = "missed";

        if (nextStatus !== goal.status) {
          updateDay(currentDate, (d) => ({ ...d, goals: d.goals.map((g) => (g.id === goal.id ? { ...g, status: nextStatus } : g)) }));
        }

        if (!goal.alerts.before5 && before5Diff <= 300 && before5Diff >= 296) {
          notify(currentDate, "Upcoming Goal", `${goal.title} starts at ${goal.startTime}`, "info");
          updateDay(currentDate, (d) => ({ ...d, goals: d.goals.map((g) => g.id === goal.id ? { ...g, alerts: { ...g.alerts, before5: true } } : g ) }));
        }

        if (!goal.alerts.autoStarted && startDiffAbs <= 1200) {
          const mins = Math.max(1, minutesBetween(goal.startTime, goal.endTime));
          setFocusTitle(goal.title); setActiveDuration(mins); setTimerLeft(mins * 60); timerCountedRef.current = false; setTimerActive(true); setTimerPaused(false);
          notify(currentDate, "Goal Started", `${goal.title} is starting now`, "start");
          updateDay(currentDate, (d) => ({ ...d, goals: d.goals.map((g) => g.id === goal.id ? { ...g, status: "in-progress", alerts: { ...g.alerts, autoStarted: true } } : g ) }));
        }

        if (!goal.alerts.midway && midwayDiffAbs <= 1200) {
          notify(currentDate, "Midway Check", `${goal.title} is halfway done`, "mid");
          updateDay(currentDate, (d) => ({ ...d, goals: d.goals.map((g) => g.id === goal.id ? { ...g, alerts: { ...g.alerts, midway: true } } : g ) }));
        }

        if (!goal.alerts.end && endDiffAbs <= 1200) {
          notify(currentDate, "Goal Ended", `${goal.title} ended at ${goal.endTime}`, "end");
          updateDay(currentDate, (d) => ({ ...d, goals: d.goals.map((g) => g.id === goal.id ? { ...g, status: g.status === "completed" ? "completed" : "awaiting-review", alerts: { ...g.alerts, end: true } } : g ) }));
        }
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [data]);

  // Mindfulness Engine
  useEffect(() => {
    const interval = setInterval(() => {
      const currentTime = Date.now();
      mindfulnessPresets.forEach((m) => {
        if (!m.enabled) return;
        const last = mindfulnessRef.current[m.id] || currentTime;
        if (currentTime - last >= m.everyMinutes * 60 * 1000) {
          mindfulnessRef.current[m.id] = currentTime;
          notify(todayStr(), "Mindfulness Reminder", m.title, "mindfulness");
        }
      });
    }, 15000);
    return () => clearInterval(interval);
  }, [mindfulnessPresets]);

  const toggleMindfulness = (id: string) => {
    setMindfulnessPresets(prev => prev.map(m => {
      if (m.id === id) {
        if (!m.enabled) mindfulnessRef.current[m.id] = Date.now();
        return { ...m, enabled: !m.enabled };
      }
      return m;
    }));
  };

  if (!mounted) return null;

  const renderedChartData = [...graphData].reverse();

  // =========================
  // UI RENDERING
  // =========================
  return (
    // ✅ BACKGROUND NEVER TURNS BLACK
    <div className="min-h-screen font-sans flex flex-col md:flex-row bg-[#F4F4F6] text-slate-900 selection:bg-indigo-200">
      
      {/* GLOBAL LOGIN */}
      <div className="fixed top-6 right-8 z-50 flex gap-3 animate-in slide-in-from-top-6 duration-700 fade-in">
        {userId ? (
          <>
            <div className="hidden md:flex items-center rounded-full bg-white/60 backdrop-blur-md border border-slate-200/50 px-4 py-2.5 text-[10px] font-black tracking-widest text-slate-700 shadow-[0_4px_20px_rgb(0,0,0,0.03)] transition-all hover:-translate-y-0.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 mr-2 animate-pulse" /> {userEmail}
            </div>
            <button onClick={handleLogout} className="px-5 py-2.5 rounded-full bg-gradient-to-b from-rose-500 to-rose-600 text-white text-[10px] font-black tracking-widest uppercase hover:from-rose-400 hover:to-rose-500 shadow-[0_10px_25px_rgba(244,63,94,0.3)] transition-all hover:-translate-y-0.5 border-t border-white/20">
              Logout
            </button>
          </>
        ) : (
          <button onClick={handleLogin} className="px-5 py-2.5 rounded-full bg-gradient-to-b from-emerald-500 to-emerald-600 text-white text-[10px] font-black tracking-widest uppercase hover:from-emerald-400 hover:to-emerald-500 shadow-[0_10px_25px_rgba(16,185,129,0.3)] transition-all hover:-translate-y-0.5 border-t border-white/20">
            {authLoading ? "Syncing..." : "Authenticate"}
          </button>
        )}
      </div>

      {/* ULTRA-CRISP SIDEBAR */}
      <nav className="w-full md:w-[300px] p-8 flex flex-col shrink-0 z-20 bg-[#0A0E17] border-r border-[#151B2B] shadow-2xl">
        <div className="mb-14 text-center md:text-left">
          <h1 className="text-white text-3xl font-black tracking-tighter flex items-center gap-1.5">
            <span className="bg-gradient-to-br from-indigo-400 to-violet-500 bg-clip-text text-transparent">COMMAND</span>
            <span className="text-white">.v10</span>
          </h1>
          <p className="text-[9px] text-slate-500 font-bold uppercase tracking-[0.3em] mt-3">Study Operating System</p>
        </div>

        <div className="space-y-3 flex-1">
          {["Mission Planning", "Scheduled Goals", "Focus Lab", "End-Day Protocol", "Future Horizon", "Intelligence"].map((n, i) => (
            <button key={i} onClick={() => setActiveTray(i)} className={`w-full text-left px-5 py-4 rounded-2xl text-sm font-bold transition-all duration-300 flex items-center justify-between group ${activeTray === i ? "bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-[0_0_30px_rgba(99,102,241,0.2)] border-t border-white/10" : "text-slate-400 hover:bg-[#121826] hover:text-slate-200"}`}>
              {n}
              {activeTray === i && <span className="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_10px_white] animate-pulse" />}
            </button>
          ))}
        </div>

        <div className="mt-auto pt-8 border-t border-slate-800/50 space-y-4 flex flex-col">
          <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="w-full bg-[#121826] border border-slate-700/50 text-slate-300 p-4 rounded-xl text-xs font-mono font-bold outline-none focus:border-indigo-500/50 focus:ring-2 focus:ring-indigo-500/20 transition-all" />
          <button onClick={requestNotificationPermission} className="w-full bg-gradient-to-b from-indigo-600 to-indigo-700 border-t border-white/10 text-white p-3 rounded-xl text-[9px] font-black uppercase tracking-[0.2em] shadow-lg hover:shadow-[0_0_20px_rgba(99,102,241,0.4)] transition-all">Enable Notifications</button>
          <button onClick={() => setMuted(!muted)} className="w-full bg-[#121826] border border-slate-700/50 text-slate-400 p-3 rounded-xl text-[9px] font-bold uppercase tracking-widest hover:text-slate-200 hover:bg-[#1A2235] transition-all">
            {muted ? "🔇 Unmute Audio" : "🔊 Mute Audio"}
          </button>
        </div>
      </nav>

      {/* MAIN DASHBOARD */}
      <main className="flex-1 p-4 md:p-12 overflow-y-auto h-screen scroll-smooth relative z-10 custom-scrollbar">
        <div className="max-w-[1200px] mx-auto space-y-10">

          {/* HUD METRICS */}
          {activeTray !== 2 && (
            <header className="grid grid-cols-2 lg:grid-cols-4 gap-6 animate-in slide-in-from-top-6 duration-700 fade-in">
              <CardStat label="Deep Work Yield" value={`${totalDeepWork}`} unit="m" diff={growthStats.deepWorkDiff} color="text-indigo-600" bg="bg-indigo-50/50" />
              <CardStat label="Live Accuracy" value={`${accuracy}`} unit="%" diff={growthStats.accDiff} color="text-emerald-500" bg="bg-emerald-50/50" />
              
              <div className="bg-white p-7 rounded-[2rem] border border-slate-200/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] hover:-translate-y-1 transition-transform duration-500 ease-out">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Must-Do Integrity</span>
                <div className="text-5xl font-black text-slate-800 mt-3 tracking-tighter">{mustDoDone} <span className="text-xl text-slate-300 ml-1">/ {mustDoTotal}</span></div>
                <div className="w-full h-2 bg-slate-100 rounded-full mt-5 overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-rose-400 to-rose-500 transition-all duration-1000 ease-out" style={{ width: `${mustDoProgress}%` }} />
                </div>
              </div>

              <div className="bg-white p-7 rounded-[2rem] border border-slate-200/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] hover:-translate-y-1 transition-transform duration-500 ease-out flex flex-col justify-between">
                <div>
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Total Missions</span>
                  <div className="text-5xl font-black text-slate-800 mt-3 tracking-tighter">{selData.tasks.filter(t => t.done).length} <span className="text-xl text-slate-300 ml-1">/ {selData.tasks.length}</span></div>
                </div>
                <button onClick={carryForwardUnfinished} className="mt-3 text-[9px] font-black text-indigo-500 hover:text-indigo-700 uppercase tracking-[0.2em] transition-colors text-left">
                  + Sweep Yesterday
                </button>
              </div>
            </header>
          )}

          {/* TRAY 0: MISSION CONTROL */}
          {activeTray === 0 && (
            <div className="grid lg:grid-cols-3 gap-8 animate-in slide-in-from-bottom-12 duration-700 ease-out fade-in">
              <section className="lg:col-span-2 space-y-8">
                <div className="bg-white p-10 rounded-[2.5rem] border border-slate-200/60 shadow-[0_10px_40px_rgb(0,0,0,0.03)] relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-indigo-500 to-violet-500" />
                  <div className="flex justify-between items-center mb-8">
                    <h2 className="text-sm font-black uppercase tracking-widest text-slate-800 flex items-center gap-3">
                      <span className="w-3 h-3 rounded-full bg-indigo-500 animate-pulse shadow-[0_0_15px_rgba(99,102,241,0.6)]" /> Mission Control
                    </h2>
                    {userId ? ( <span className="px-4 py-2 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200 text-[9px] font-black tracking-widest uppercase">Cloud Sync Active</span> ) : ( <span className="px-4 py-2 rounded-full bg-amber-50 text-amber-600 border border-amber-200 text-[9px] font-black tracking-widest uppercase">Local Mode</span> )}
                  </div>
                  
                  <div className="flex flex-col xl:flex-row gap-4 mb-6">
                    <input value={taskText} onChange={(e) => setTaskText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAddTask()} placeholder="Define highest leverage task..." className="flex-1 bg-slate-50 border border-slate-200/60 p-6 rounded-[1.5rem] text-sm font-bold text-slate-900 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 ring-indigo-500/10 transition-all placeholder:text-slate-400 shadow-inner" />
                    <div className="flex gap-4">
                      <select value={taskBlock} onChange={(e) => setTaskBlock(e.target.value as TimeBlock)} className="bg-slate-50 border border-slate-200/60 px-6 py-6 rounded-[1.5rem] text-xs font-bold text-slate-700 outline-none cursor-pointer focus:border-indigo-400 focus:ring-4 ring-indigo-500/10 transition-all shadow-inner">
                        {BLOCKS.map((b) => <option key={b}>{b}</option>)}
                      </select>
                      <select value={taskPrio} onChange={(e) => setTaskPrio(e.target.value as Priority)} className={`px-6 py-6 rounded-[1.5rem] text-xs font-bold border outline-none cursor-pointer focus:ring-4 transition-all shadow-inner ${taskPrio === "Must do" ? "bg-rose-50 border-rose-200 text-rose-700 focus:border-rose-400 ring-rose-500/10" : "bg-slate-50 border-slate-200/60 text-slate-700 focus:border-indigo-400 ring-indigo-500/10"}`}>
                        {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                      <button onClick={handleAddTask} className="bg-gradient-to-b from-indigo-500 to-indigo-600 text-white px-12 py-6 rounded-[1.5rem] font-black tracking-widest hover:from-indigo-400 hover:to-indigo-500 hover:-translate-y-1 transition-all shadow-[0_10px_25px_rgba(99,102,241,0.3)] border-t border-white/20 active:scale-95">DEPLOY</button>
                    </div>
                  </div>
                </div>

                <div className="bg-white p-10 rounded-[2.5rem] border border-slate-200/60 shadow-[0_10px_40px_rgb(0,0,0,0.03)]">
                  {tasksLoading ? <EmptyBox text="Syncing missions from cloud..." /> : selData.tasks.length === 0 ? <EmptyBox text="No tasks established for the current cycle." /> : (
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                      {selData.tasks.map((t) => (
                        <div key={t.id} className="flex items-start gap-5 p-6 rounded-[1.5rem] border border-slate-100 hover:border-indigo-100 hover:bg-indigo-50/30 transition-all hover:-translate-y-0.5 group shadow-sm">
                          <div className="relative pt-0.5">
                            <input type="checkbox" checked={t.done} onChange={() => toggleTask(t.id)} className="w-6 h-6 appearance-none rounded-lg border-2 border-slate-200 checked:bg-indigo-500 checked:border-indigo-500 cursor-pointer transition-all active:scale-90 peer checkbox-pop" />
                            {t.done && <svg className="absolute top-[5px] left-[5px] w-3.5 h-3.5 text-white pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                          </div>
                          <div className="flex-1">
                            <p className={`text-[15px] font-bold leading-snug transition-all ${t.done ? "line-through text-slate-300" : "text-slate-800"}`}>{t.text}</p>
                            <div className="flex gap-2 mt-3">
                              <span className={`text-[9px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full ${t.priority === "Must do" ? "bg-rose-50 text-rose-600 border border-rose-100" : "bg-slate-50 text-slate-500 border border-slate-100"}`}>{t.priority}</span>
                              <span className="text-[9px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full bg-slate-50 text-slate-500 border border-slate-100">{t.block}</span>
                            </div>
                          </div>
                          <button onClick={() => deleteTask(t.id)} className="text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity p-2 rounded-full hover:bg-rose-50">✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <aside className="space-y-8">
                {/* AI Intel Card */}
                <div className="bg-gradient-to-br from-indigo-500 to-violet-600 p-8 rounded-[2.5rem] text-white shadow-[0_15px_40px_rgba(99,102,241,0.2)] border-t border-white/20 hover:-translate-y-1 transition-transform duration-500">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="text-[10px] font-black uppercase tracking-[0.3em] text-indigo-200">AI Intel Analyst</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_#34d399] animate-pulse" />
                  </div>
                  <p className="text-[17px] font-bold leading-relaxed">{smartSuggestion}</p>
                </div>

                {/* Biological Baselines & Mindfulness */}
                <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200/60 shadow-[0_10px_40px_rgb(0,0,0,0.03)]">
                  <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-6">Biological & Mental Baselines</h3>
                  <div className="flex flex-col gap-3">
                    <button onClick={() => updateDay(selectedDate, d => ({...d, hydrationDone: !d.hydrationDone}))} className={`px-5 py-4 rounded-[1.25rem] text-xs font-bold border transition-all text-left flex justify-between items-center ${selData.hydrationDone ? "bg-emerald-50 text-emerald-600 border-emerald-200" : "bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300 hover:-translate-y-0.5"}`}>
                      <span>💧 Log Adequate Hydration</span>
                      {selData.hydrationDone && <span className="bg-emerald-500 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px]">✓</span>}
                    </button>
                    <button onClick={() => updateDay(selectedDate, d => ({...d, mealsDone: !d.mealsDone}))} className={`px-5 py-4 rounded-[1.25rem] text-xs font-bold border transition-all text-left flex justify-between items-center ${selData.mealsDone ? "bg-emerald-50 text-emerald-600 border-emerald-200" : "bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300 hover:-translate-y-0.5"}`}>
                      <span>🍽️ Log Meals (x3)</span>
                      {selData.mealsDone && <span className="bg-emerald-500 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px]">✓</span>}
                    </button>
                  </div>
                  
                  <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mt-8 mb-4">Mindfulness Engine</h3>
                  <div className="space-y-3">
                    {mindfulnessPresets.map(m => (
                      <button key={m.id} onClick={() => toggleMindfulness(m.id)} className={`w-full px-5 py-4 rounded-[1.25rem] text-[11px] font-black tracking-widest uppercase border transition-all text-left flex justify-between items-center ${m.enabled ? "bg-indigo-50 text-indigo-600 border-indigo-200 shadow-sm" : "bg-white text-slate-400 border-slate-200 hover:bg-slate-50"}`}>
                        {m.title} <span className="text-[9px] opacity-60">Every {m.everyMinutes}m</span>
                        <div className={`w-10 h-5 rounded-full p-1 transition-colors ${m.enabled ? "bg-indigo-500" : "bg-slate-200"}`}>
                          <div className={`w-3 h-3 rounded-full bg-white transition-transform ${m.enabled ? "translate-x-5" : "translate-x-0"}`} />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </aside>
            </div>
          )}

          {/* TRAY 1: TIME BLOCKING */}
          {activeTray === 1 && (
            <div className="space-y-8 animate-in slide-in-from-bottom-12 duration-700 ease-out fade-in">
              <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200/60 shadow-[0_10px_40px_rgb(0,0,0,0.03)] flex flex-col lg:flex-row gap-4 relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-emerald-400 to-teal-500" />
                <input value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} placeholder="Define block parameter (e.g. Deep Work)" className="flex-1 bg-slate-50 border border-slate-200/60 p-6 rounded-[1.5rem] text-sm font-bold text-slate-900 outline-none focus:bg-white focus:border-emerald-400 focus:ring-4 ring-emerald-500/10 transition-all shadow-inner" />
                <input type="time" value={goalStart} onChange={(e) => setGoalStart(e.target.value)} className="bg-slate-50 border border-slate-200/60 p-6 rounded-[1.5rem] text-sm font-bold text-slate-900 outline-none focus:bg-white focus:border-emerald-400 focus:ring-4 ring-emerald-500/10 transition-all shadow-inner" />
                <input type="time" value={goalEnd} onChange={(e) => setGoalEnd(e.target.value)} className="bg-slate-50 border border-slate-200/60 p-6 rounded-[1.5rem] text-sm font-bold text-slate-900 outline-none focus:bg-white focus:border-emerald-400 focus:ring-4 ring-emerald-500/10 transition-all shadow-inner" />
                <button onClick={addGoal} className="bg-gradient-to-b from-emerald-500 to-emerald-600 text-white px-10 py-6 rounded-[1.5rem] font-black tracking-widest hover:from-emerald-400 hover:to-emerald-500 hover:-translate-y-1 transition-all shadow-[0_10px_25px_rgba(16,185,129,0.3)] border-t border-white/20 active:scale-95">ALLOCATE</button>
              </div>

              <div className="space-y-6">
                {sortedGoals.map((g) => {
                  const blockStart = new Date(`${selectedDate}T${g.startTime}:00`).getTime();
                  const blockEnd = new Date(`${selectedDate}T${g.endTime}:00`).getTime();
                  const current = now.getTime();
                  
                  let pctRaw = 0; let minsLeft = 0;
                  if (current >= blockStart && current <= blockEnd) {
                    pctRaw = ((current - blockStart) / (blockEnd - blockStart)) * 100;
                    minsLeft = Math.ceil((blockEnd - current) / 60000);
                  } else if (current > blockEnd) { pctRaw = 100; minsLeft = 0; } 
                  else if (current < blockStart) { pctRaw = 0; minsLeft = Math.ceil((blockEnd - blockStart) / 60000); }

                  const remainingPct = Math.max(0, 100 - pctRaw);
                  
                  const waveColorHex = remainingPct < 15 ? "%23f43f5e" : remainingPct < 40 ? "%23f59e0b" : "%236366f1";
                  const textAlertColor = remainingPct < 15 ? "text-rose-600" : remainingPct < 40 ? "text-amber-600" : "text-indigo-600";
                  const borderAlert = remainingPct < 15 ? "border-rose-300 shadow-[0_15px_40px_rgba(244,63,94,0.15)]" : remainingPct < 40 ? "border-amber-300 shadow-[0_15px_40px_rgba(245,158,11,0.15)]" : "border-indigo-300 shadow-[0_15px_40px_rgba(99,102,241,0.15)]";

                  const waveBgFront = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 88.7'%3E%3Cpath d='M800 56.9c-155.5 0-204.9-50-405.5-49.9-200 0-250 49.9-394.5 49.9v31.8h800v-.2-31.6z' fill='${waveColorHex}' fill-opacity='0.08'/%3E%3C/svg%3E")`;
                  const waveBgBack = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 88.7'%3E%3Cpath d='M0 56.9c155.5 0 204.9-50 405.5-49.9 200 0 250 49.9 394.5 49.9v31.8H0v-.2-31.6z' fill='${waveColorHex}' fill-opacity='0.04'/%3E%3C/svg%3E")`;

                  return (
                    <div key={g.id} className={`relative overflow-hidden p-8 rounded-[2rem] border flex flex-col md:flex-row md:items-center justify-between transition-all duration-500 group ${g.status === "in-progress" ? `${borderAlert} scale-[1.01] bg-white` : g.status === "completed" ? "bg-slate-50/50 border-slate-200 opacity-60 grayscale hover:grayscale-0 hover:opacity-100" : "bg-white border-slate-200/60 shadow-[0_8px_30px_rgb(0,0,0,0.02)] hover:-translate-y-1"}`}>
                      
                      {g.status === "in-progress" && (
                        <>
                          <div className="absolute top-0 left-0 h-full pointer-events-none transition-all duration-1000 ease-linear rounded-l-[2rem] opacity-80" style={{ width: `${remainingPct}%`, backgroundImage: waveBgBack, backgroundSize: '200% 100%', backgroundPosition: 'bottom', animation: 'waveSlideSlow 15s linear infinite' }} />
                          <div className="absolute top-0 left-0 h-full pointer-events-none transition-all duration-1000 ease-linear rounded-l-[2rem]" style={{ width: `${remainingPct}%`, backgroundImage: waveBgFront, backgroundSize: '200% 100%', backgroundPosition: 'bottom', animation: 'waveSlideFast 10s linear infinite' }} />
                          <div className="absolute inset-0 bg-gradient-to-r from-transparent to-white/40 pointer-events-none" />
                        </>
                      )}

                      <div className="relative z-10 mb-6 md:mb-0 w-full md:w-auto">
                        <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-5">
                          <h4 className="font-black text-slate-800 text-2xl tracking-tight">{g.title}</h4>
                          {g.status === "in-progress" && (
                            <div className={`flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.1em] bg-white/90 backdrop-blur-md px-3.5 py-1.5 rounded-[10px] border border-white/80 shadow-sm ${textAlertColor} ${remainingPct < 15 ? 'animate-pulse' : ''} w-fit`}>
                              <svg className="w-4 h-4 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                              {minsLeft > 0 ? `${minsLeft}m REMAINING` : "TIME UP"}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-4">
                          <span className="text-xs font-mono font-bold tracking-widest bg-slate-100/90 backdrop-blur-sm text-slate-600 px-3 py-1.5 rounded-lg border border-slate-200">{g.startTime} — {g.endTime}</span>
                          <span className={`text-[9px] font-black uppercase tracking-[0.2em] px-3 py-1.5 rounded-full border backdrop-blur-sm ${g.status === 'completed' ? 'bg-emerald-50/90 text-emerald-600 border-emerald-200' : 'bg-white/90 text-slate-400 border-slate-200'}`}>{g.status.replace('-', ' ')}</span>
                        </div>
                      </div>
                      
                      <div className="relative z-10 flex gap-3">
                        {g.status === "pending" && <button onClick={() => updateDay(selectedDate, (d) => ({ ...d, goals: d.goals.map((x) => x.id === g.id ? { ...x, status: "in-progress" } : x) }))} className="bg-slate-900 text-white px-8 py-4 rounded-[1.25rem] text-xs font-black tracking-widest hover:bg-slate-800 transition-all shadow-md hover:-translate-y-0.5 active:scale-95">COMMENCE</button>}
                        {g.status === "in-progress" && <button onClick={() => updateDay(selectedDate, (d) => ({ ...d, goals: d.goals.map((x) => x.id === g.id ? { ...x, status: "completed" } : x) }))} className="bg-emerald-500 text-white px-8 py-4 rounded-[1.25rem] text-xs font-black tracking-widest hover:bg-emerald-400 transition-all shadow-md hover:-translate-y-0.5 active:scale-95">SECURE</button>}
                        <button onClick={() => updateDay(selectedDate, (d) => ({ ...d, goals: d.goals.filter((x) => x.id !== g.id) }))} className="bg-white border border-slate-200/60 text-slate-400 hover:text-rose-600 hover:border-rose-200 hover:bg-rose-50 px-5 py-4 rounded-[1.25rem] transition-all font-black">✕</button>
                      </div>
                    </div>
                  );
                })}
                {sortedGoals.length === 0 && <EmptyBox text="Timeline is completely open. Plan your trajectory." />}
              </div>
            </div>
          )}

          {/* ✅ TRAY 2: FOCUS LAB (BEAUTIFUL LIGHT MODE GLOW) */}
          {activeTray === 2 && (
            <div className="flex flex-col items-center justify-center min-h-[75vh] animate-in zoom-in-[0.98] duration-1000 ease-out fade-in">
              {!timerActive && (
                <div className="flex flex-wrap justify-center gap-5 mb-16 animate-in slide-in-from-bottom-8 duration-700">
                  {[15, 25, 50, 90].map((m) => (
                    <button key={m} onClick={() => setTimerPreset(m)} className={`px-8 py-4 rounded-3xl text-sm font-black border-2 transition-all duration-300 ${activeDuration === m ? "border-indigo-500 bg-indigo-50 text-indigo-600 shadow-[0_10px_30px_rgba(99,102,241,0.2)] scale-110" : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:-translate-y-1 shadow-sm"}`}>
                      {m} Mins
                    </button>
                  ))}
                </div>
              )}

              <div className="relative group flex items-center justify-center w-[24rem] h-[24rem] mb-20">
                {timerActive && (
                  <>
                    <div className={`absolute inset-0 rounded-full blur-[100px] opacity-40 ${timerPaused ? 'bg-amber-400' : 'bg-indigo-500 animate-pulse'}`} style={{ animationDuration: '4s' }} />
                    <div className={`absolute inset-[-40px] border-[2px] rounded-full ${timerPaused ? 'border-amber-400/30' : 'border-indigo-400/30 animate-ping'}`} style={{ animationDuration: '3s' }} />
                    <div className={`absolute inset-[-80px] border-[1px] rounded-full ${timerPaused ? 'border-amber-400/10' : 'border-indigo-400/10 animate-ping'}`} style={{ animationDuration: '4s', animationDelay: '1s' }} />
                  </>
                )}
                
                <div className={`relative z-10 w-full h-full rounded-full flex flex-col items-center justify-center border-[8px] transition-all duration-1000 bg-white shadow-2xl ${timerActive ? (timerPaused ? "border-amber-300 shadow-[0_0_80px_rgba(245,158,11,0.2)]" : "border-indigo-300 shadow-[0_0_100px_rgba(99,102,241,0.3)] scale-[1.02]") : "border-slate-100"}`}>
                  <div className={`text-[6rem] leading-none font-mono font-black tracking-tighter transition-colors duration-1000 ${timerActive ? (timerPaused ? "text-amber-500" : "text-indigo-600") : "text-slate-800"}`}>
                    {formatTime(timerLeft)}
                  </div>
                  <div className={`text-[10px] font-black uppercase tracking-[0.4em] mt-6 transition-colors duration-1000 ${timerActive ? (timerPaused ? "text-amber-500" : "text-indigo-400") : "text-slate-400"}`}>
                    {timerActive ? (timerPaused ? "SYSTEM PAUSED" : "Deep State Active") : "Awaiting Sequence"}
                  </div>
                </div>
              </div>

              {/* ✅ ROBUST FOCUS LAB CONTROLS */}
              <div className="flex gap-5 w-full max-w-[500px]">
                {timerActive ? (
                  <button onClick={handleAbort} className="flex-1 py-7 rounded-[2rem] font-black text-xl tracking-[0.2em] transition-all active:scale-95 bg-rose-50 border border-rose-200 text-rose-600 shadow-md hover:shadow-rose-500/20 hover:bg-rose-500 hover:text-white">
                    ABORT
                  </button>
                ) : (
                  <button onClick={handleInitiate} className="flex-1 py-7 rounded-[2rem] font-black text-xl tracking-[0.2em] transition-all active:scale-95 bg-gradient-to-b from-indigo-500 to-indigo-600 text-white shadow-[0_20px_40px_rgba(99,102,241,0.3)] hover:from-indigo-400 hover:to-indigo-500 border-t border-white/20 hover:-translate-y-1">
                    INITIATE
                  </button>
                )}

                {timerActive && (
                  <button onClick={timerPaused ? handleResume : handlePause} className={`flex-1 py-7 rounded-[2rem] font-black text-xl tracking-[0.2em] transition-all active:scale-95 ${timerPaused ? "bg-gradient-to-b from-emerald-400 to-emerald-500 text-white shadow-[0_20px_40px_rgba(16,185,129,0.3)] border-t border-white/20 hover:-translate-y-1" : "bg-amber-50 border border-amber-200 text-amber-600 shadow-md hover:shadow-amber-500/20 hover:bg-amber-500 hover:text-white"}`}>
                    {timerPaused ? "RESUME" : "PAUSE"}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* TRAY 3: END-DAY PROTOCOL */}
          {activeTray === 3 && (
            <div className="max-w-5xl mx-auto space-y-8 animate-in slide-in-from-bottom-12 duration-700 ease-out fade-in">
              <div className="bg-white p-12 lg:p-16 rounded-[3rem] border border-slate-200/60 shadow-[0_20px_60px_rgb(0,0,0,0.04)] relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-slate-800 to-slate-900" />
                {selData.reflection.submitted && <div className="absolute top-10 right-12 bg-emerald-50 text-emerald-600 px-5 py-2.5 rounded-full text-[10px] font-black uppercase tracking-[0.2em] shadow-sm border border-emerald-200">Data Secured</div>}
                
                <h2 className="text-4xl font-black text-slate-800 mb-12 tracking-tight">End-Day Protocol</h2>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
                  <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 ml-2">Total MCQs Done</label>
                    <input type="number" value={selData.reflection.mcqsTotal || ""} onChange={(e) => updateDay(selectedDate, (d) => ({ ...d, reflection: { ...d.reflection, mcqsTotal: Number(e.target.value) } }))} className="w-full bg-slate-50 border border-slate-200/60 p-8 rounded-[2rem] text-4xl font-black outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 ring-indigo-500/10 transition-all shadow-inner" />
                  </div>
                  <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 ml-2">Correct Answers</label>
                    <input type="number" value={selData.reflection.mcqsCorrect || ""} onChange={(e) => updateDay(selectedDate, (d) => ({ ...d, reflection: { ...d.reflection, mcqsCorrect: Number(e.target.value) } }))} className="w-full bg-slate-50 border border-slate-200/60 p-8 rounded-[2rem] text-4xl font-black outline-none focus:bg-white focus:border-emerald-400 focus:ring-4 ring-emerald-500/10 transition-all shadow-inner text-emerald-600" />
                  </div>
                </div>

                <div className="space-y-5 mb-12">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 ml-2">Protocol Checklist</label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {[
                      { key: 'workout', label: 'Physical Training' },
                      { key: 'reading', label: 'Deep Reading (20m+)' },
                      { key: 'anki', label: 'Spaced Repetition' },
                      { key: 'noScreens', label: 'Digital Sunset' },
                    ].map(h => {
                      const habits = selData.reflection.habits || { workout: false, reading: false, anki: false, noScreens: false };
                      const isDone = habits[h.key as keyof DailyHabits];
                      return (
                        <button key={h.key} onClick={() => updateDay(selectedDate, (d) => ({ ...d, reflection: { ...d.reflection, habits: { ...(d.reflection.habits || {}), [h.key]: !isDone } as DailyHabits } }))} className={`p-6 rounded-[1.5rem] border flex items-center justify-between transition-all duration-300 hover:-translate-y-0.5 shadow-sm ${isDone ? 'bg-indigo-50 border-indigo-200' : 'bg-slate-50 border-slate-200/60 hover:bg-white hover:border-slate-300'}`}>
                          <span className={`font-black text-xs uppercase tracking-widest ${isDone ? 'text-indigo-600' : 'text-slate-500'}`}>{h.label}</span>
                          <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${isDone ? 'border-indigo-500 bg-indigo-500 text-white scale-110 shadow-md' : 'border-slate-300 bg-white'}`}>
                            {isDone && <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-5 mb-12">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 ml-2">Mental Energy / Mood Rating</label>
                  <div className="flex justify-between gap-4 bg-slate-50 p-4 rounded-[2rem] border border-slate-200/60 shadow-inner">
                    {[1, 2, 3, 4, 5].map((m) => (
                      <button key={m} onClick={() => updateDay(selectedDate, (d) => ({ ...d, reflection: { ...d.reflection, mood: m } }))} className={`flex-1 py-6 rounded-[1.5rem] font-black text-2xl transition-all hover:-translate-y-1 ${selData.reflection.mood === m ? "bg-white text-indigo-600 shadow-[0_10px_20px_rgb(0,0,0,0.08)] scale-105 border border-slate-100" : "text-slate-400 hover:bg-slate-200/50"}`}>
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-5 mb-16">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 ml-2">Primary Focus Leak</label>
                  <div className="flex flex-wrap gap-3">
                    {["None", "Phone", "Tired", "Overplanned", "Interruptions", "Low Mood"].map((r) => (
                      <button key={r} onClick={() => updateDay(selectedDate, (d) => ({ ...d, reflection: { ...d.reflection, failReason: r as FailReason } }))} className={`px-7 py-4 rounded-full text-xs font-black tracking-widest uppercase transition-all ${selData.reflection.failReason === r ? "bg-rose-50 border border-rose-200 text-rose-600 shadow-[0_4px_15px_rgba(244,63,94,0.1)] -translate-y-0.5" : "bg-white text-slate-400 border border-slate-200/60 hover:bg-slate-50 hover:-translate-y-0.5"}`}>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                <button onClick={() => { playSound("success"); updateDay(selectedDate, (d) => ({ ...d, reflection: { ...d.reflection, submitted: true } })); }} className="w-full bg-gradient-to-b from-slate-800 to-slate-900 text-white py-8 rounded-[2rem] font-black text-xl tracking-[0.2em] hover:from-slate-700 hover:to-slate-800 transition-all active:scale-95 shadow-[0_20px_40px_rgba(0,0,0,0.2)] border-t border-white/10 hover:-translate-y-1">
                  LOCK ARCHIVE & FINISH
                </button>
              </div>
            </div>
          )}

          {/* TRAY 4: FUTURE HORIZON */}
          {activeTray === 4 && (
            <div className="space-y-8 animate-in slide-in-from-bottom-12 duration-700 ease-out fade-in">
              <div className="mb-10 bg-white p-10 rounded-[2.5rem] shadow-[0_8px_30px_rgb(0,0,0,0.03)] border border-slate-200/60">
                <h2 className="text-4xl font-black text-slate-800 tracking-tight">Future Horizon</h2>
                <p className="text-sm text-slate-500 font-bold mt-3">Pre-load structural directives into upcoming cycles.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {[1, 2, 3].map((offset) => {
                  const targetDate = new Date(selectedDate); targetDate.setDate(targetDate.getDate() + offset);
                  const tStr = new Date(targetDate.getTime() - targetDate.getTimezoneOffset() * 60000).toISOString().split("T")[0];
                  const dayName = targetDate.toLocaleDateString("en-US", { weekday: "long" });
                  const tData = data[tStr] || getEmptyDay();
                  
                  return (
                    <div key={offset} className="bg-white p-8 rounded-[2.5rem] border border-slate-200/60 shadow-[0_8px_30px_rgb(0,0,0,0.03)] flex flex-col h-[550px] hover:shadow-[0_20px_50px_rgb(0,0,0,0.06)] hover:-translate-y-1 transition-all duration-500 group relative overflow-hidden">
                      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-slate-200 to-slate-100" />
                      
                      <div className="mb-8 pb-6 border-b border-slate-100/80 flex justify-between items-start mt-2">
                        <div>
                          <div className="text-2xl font-black text-slate-800 tracking-tight">{dayName}</div>
                          <div className="text-[10px] font-black uppercase text-indigo-400 tracking-[0.2em] mt-1">{tStr}</div>
                        </div>
                        {tData.tasks.length > 0 && <button onClick={() => updateDay(tStr, (d) => ({ ...d, tasks: [] }))} className="text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-rose-600 bg-slate-50 hover:bg-rose-50 px-4 py-2 rounded-full transition-colors border border-slate-100">WIPE</button>}
                      </div>
                      
                      <div className="flex-1 overflow-y-auto space-y-3 mb-6 pr-2 custom-scrollbar">
                        {tData.tasks.map((t) => (
                          <div key={t.id} className="text-[13px] font-bold text-slate-700 bg-slate-50/80 p-5 rounded-[1.5rem] border border-slate-100 flex items-start justify-between gap-3 shadow-sm group/task transition-all hover:bg-white hover:border-indigo-100 hover:shadow-md hover:-translate-y-0.5">
                            <div className="flex items-start gap-3 leading-snug"><span className="text-indigo-400 mt-0.5 opacity-50">●</span> {t.text}</div>
                            <button onClick={() => updateDay(tStr, (d) => ({ ...d, tasks: d.tasks.filter((x) => x.id !== t.id) }))} className="text-slate-300 hover:text-rose-500 opacity-0 group-hover/task:opacity-100 transition-opacity p-1 rounded-full hover:bg-rose-50" title="Delete">✕</button>
                          </div>
                        ))}
                        {tData.tasks.length === 0 && <EmptyBox text="Blank Slate" />}
                      </div>

                      <div className="mt-auto">
                        <input type="text" placeholder="+ Define Objective..." onKeyDown={(e) => { if (e.key === "Enter" && e.currentTarget.value.trim()) { updateDay(tStr, (d) => ({ ...d, tasks: [...d.tasks, { id: safeUUID(), text: e.currentTarget.value, done: false, block: "Morning", priority: "Should do", category: "Revision", createdAt: new Date().toISOString() }] })); e.currentTarget.value = ""; } }} className="w-full bg-slate-50 border border-slate-200/60 p-6 rounded-[1.5rem] text-sm font-bold outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 ring-indigo-500/10 transition-all placeholder:text-slate-400" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TRAY 5: INTELLIGENCE */}
          {activeTray === 5 && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 animate-in slide-in-from-bottom-12 duration-700 ease-out fade-in">
              <div className="bg-[#0A0E17] p-12 rounded-[3rem] text-white shadow-[0_30px_60px_rgba(0,0,0,0.3)] relative border border-[#151B2B] hover:-translate-y-1 transition-all duration-500 overflow-hidden flex flex-col h-[500px]">
                <div className="absolute -top-40 -right-40 w-[400px] h-[400px] bg-indigo-600/20 rounded-full blur-[100px] pointer-events-none" />
                <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-500 mb-8 relative z-10 flex items-center gap-3">
                  <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" /> System Velocity (Yield)
                </h3>
                <div className="flex-1 w-full min-h-0 relative z-10">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={renderedChartData} margin={{ top: 20, right: 0, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorPoms" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#6366f1" stopOpacity={0.4}/><stop offset="95%" stopColor="#6366f1" stopOpacity={0}/></linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#ffffff0a" />
                      <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10, fontWeight: 'bold' }} dy={10} />
                      <YAxis hide domain={[0, 'dataMax + 20']} />
                      <Tooltip cursor={{ stroke: '#ffffff1a', strokeWidth: 2 }} contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '1rem', color: '#fff', fontWeight: 'bold', padding: '12px' }} itemStyle={{ color: '#818cf8' }} />
                      <Area type="monotone" dataKey="deepWork" name="Focus Mins" stroke="#6366f1" strokeWidth={4} fill="url(#colorPoms)" animationDuration={2000} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-8 bg-white/5 p-6 rounded-[1.5rem] border border-white/10 backdrop-blur-xl relative z-10 flex justify-between items-center">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 mb-1">Gross Yield (7d)</p>
                    <p className="text-3xl font-black text-white tracking-tighter">{renderedChartData.reduce((a, b) => a + b.deepWork, 0)}<span className="text-xs text-slate-500 ml-1 font-bold">m</span></p>
                  </div>
                </div>
              </div>

              <div className="bg-[#0A0E17] p-12 rounded-[3rem] text-white shadow-[0_30px_60px_rgba(0,0,0,0.3)] relative border border-[#151B2B] hover:-translate-y-1 transition-all duration-500 overflow-hidden flex flex-col h-[500px]">
                <div className="absolute -bottom-40 -left-40 w-[400px] h-[400px] bg-emerald-600/10 rounded-full blur-[100px] pointer-events-none" />
                <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-500 mb-8 relative z-10 flex items-center gap-3">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> Execution Rate
                </h3>
                <div className="flex-1 w-full min-h-0 relative z-10">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={renderedChartData} margin={{ top: 20, right: 0, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#ffffff0a" />
                      <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10, fontWeight: 'bold' }} dy={10} />
                      <YAxis hide domain={[0, 'dataMax + 2']} />
                      <Tooltip cursor={{ fill: '#ffffff05' }} contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '1rem', color: '#fff', fontWeight: 'bold', padding: '12px' }} />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: '10px', fontWeight: 'bold', color: '#94a3b8', paddingTop: '20px' }} />
                      <Bar dataKey="doneTasks" name="Missions Cleared" fill="#34d399" radius={[4,4,0,0]} barSize={20} animationDuration={2000} />
                      <Bar dataKey="totalTasks" name="Total Assigned" fill="#ffffff20" radius={[4,4,0,0]} barSize={20} animationDuration={2000} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-8 bg-white/5 p-6 rounded-[1.5rem] border border-white/10 backdrop-blur-xl relative z-10 flex justify-between items-center">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 mb-1">Peak Accuracy</p>
                    <p className="text-3xl font-black text-emerald-400 tracking-tighter">{Math.max(...renderedChartData.map(d => d.accuracy))}<span className="text-xs text-emerald-700 ml-1 font-bold">%</span></p>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </main>
      
      {/* GLOBAL CSS */}
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        .custom-scrollbar:hover::-webkit-scrollbar-thumb { background: #94a3b8; }
        @keyframes waveSlideFast { 0% { background-position-x: 0%; } 100% { background-position-x: 100%; } }
        @keyframes waveSlideSlow { 0% { background-position-x: 100%; } 100% { background-position-x: 0%; } }
        .checkbox-pop:checked { animation: pop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        @keyframes pop { 0% { transform: scale(1); } 50% { transform: scale(1.2); } 100% { transform: scale(1); } }
      `}} />
    </div>
  );
}

// =========================
// HELPER COMPONENTS
// =========================
function CardStat({ label, value, unit, diff, color, bg }: { label: string; value: string; unit?: string; diff?: number; color: string; bg?: string; sub?: string; accent?: string; valueColor?: string }) {
  const finalValue = value;
  const finalLabel = label;
  const finalDiff = diff ?? 0;
  
  return (
    <div className="bg-white p-7 rounded-[2rem] border border-slate-200/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] hover:-translate-y-1 transition-transform duration-500 ease-out group flex flex-col justify-between">
      <div>
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{finalLabel}</span>
        <div className={`text-5xl font-black ${color || "text-slate-900"} mt-3 tracking-tighter`}>{finalValue}<span className="text-xl opacity-50 ml-1">{unit || ''}</span></div>
      </div>
      {diff !== undefined ? (
        <div className={`text-[10px] font-bold mt-4 px-3 py-1.5 rounded-lg w-fit inline-flex items-center gap-1.5 ${bg} ${finalDiff >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
          {finalDiff >= 0 ? "▲" : "▼"} {Math.abs(finalDiff)}{unit} vs Prev
        </div>
      ) : null}
    </div>
  );
}

function EmptyBox({ text }: { text: string }) {
  return (
    <div className="p-8 rounded-[2.5rem] border-2 border-dashed border-slate-200 text-center text-slate-400 text-sm font-bold italic bg-slate-50/50 my-10">
      {text}
    </div>
  );
}
/**
 * ath-core.js
 *
 * Shared data + gating logic for the Analytical Training Hub, used by
 * ALL THREE skins (Option A, B, C). Nothing visual lives here — only
 * roster/progress/notes persistence, the scoring API call, the timer,
 * and the pass-streak gating rules.
 *
 * Load order in each skin's HTML:
 *   1. React / ReactDOM (UMD, as today)
 *   2. Supabase JS UMD build
 *   3. This file (plain script, not type="module", not Babel)
 *   4. Babel standalone
 *   5. The skin's own JSX app script, which reads window.ATHCore
 *
 * Each skin sets window.ATH_CONFIG BEFORE this script runs, e.g.:
 *   <script>
 *     window.ATH_CONFIG = {
 *       supabaseUrl: "https://YOUR_PROJECT.supabase.co",
 *       supabaseAnonKey: "YOUR_ANON_KEY",
 *       edgeFunctionUrl: "https://YOUR_PROJECT.functions.supabase.co/score",
 *     };
 *   </script>
 *   <script src="ath-core.js"></script>
 *
 * All three skins point at the SAME Supabase project — a student's
 * progress is shared across skins, since only the visual layer differs.
 */
(function (global) {
  const { useState, useEffect, useRef } = React;

  function cfg() {
    if (!global.ATH_CONFIG) {
      throw new Error("window.ATH_CONFIG must be set before ath-core.js runs");
    }
    return global.ATH_CONFIG;
  }

  function supabaseClient() {
    if (!global._athSupabaseClient) {
      global._athSupabaseClient = global.supabase.createClient(cfg().supabaseUrl, cfg().supabaseAnonKey);
    }
    return global._athSupabaseClient;
  }

  // ---------------------------------------------------------------------
  // Persistence — replaces window.storage.get/set for "roster", "progress:*", "notes:*"
  // ---------------------------------------------------------------------

  async function getRoster() {
    const { data, error } = await supabaseClient().from("roster").select("*").order("created_at");
    if (error) { console.error(error); return []; }
    return data;
  }

  async function addRosterStudent(name) {
    const { data, error } = await supabaseClient().from("roster").insert({ name }).select().single();
    if (error) { console.error(error); return null; }
    return data;
  }

  async function removeRosterStudent(studentId) {
    const { error } = await supabaseClient().from("roster").delete().eq("id", studentId);
    if (error) console.error(error);
  }

  async function getProgress(studentId, moduleKey) {
    if (!studentId) return null;
    const { data, error } = await supabaseClient()
      .from("progress")
      .select("*")
      .eq("student_id", studentId)
      .eq("module_key", moduleKey)
      .maybeSingle();
    if (error) { console.error(error); return null; }
    return data;
  }

  async function setProgress(studentId, moduleKey, { consecutivePasses, passed, attempts, best }) {
    if (!studentId) return;
    const { error } = await supabaseClient().from("progress").upsert({
      student_id: studentId,
      module_key: moduleKey,
      consecutive_passes: consecutivePasses,
      passed,
      attempts,
      best,
      last_updated: new Date().toISOString(),
    });
    if (error) console.error(error);
  }

  async function getNotes(studentId) {
    if (!studentId) return "";
    const { data, error } = await supabaseClient().from("notes").select("content").eq("student_id", studentId).maybeSingle();
    if (error) { console.error(error); return ""; }
    return data?.content ?? "";
  }

  async function setNotes(studentId, content) {
    if (!studentId) return;
    const { error } = await supabaseClient().from("notes").upsert({
      student_id: studentId,
      content,
      updated_at: new Date().toISOString(),
    });
    if (error) console.error(error);
  }

  // ---------------------------------------------------------------------
  // Scoring — replaces the 17 direct fetch("https://api.anthropic.com/...") calls
  // ---------------------------------------------------------------------

  async function scoreResponse(promptText, systemPrompt) {
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 900,
      messages: [{ role: "user", content: promptText }],
    };
    if (systemPrompt) body.system = systemPrompt;
    const res = await fetch(cfg().edgeFunctionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    const text = data.content.map((i) => i.text || "").join("");
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  }

  // ---------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------

  function useAuth() {
    const [role, setRole] = useState(null);
    const [pin, setPin] = useState("");
    const [pinError, setPinError] = useState("");
    function login(r) {
      if (r === "tutor" && pin !== "1234") { setPinError("Incorrect PIN."); return; }
      setPinError("");
      setRole(r);
    }
    return { role, setRole, pin, setPin, pinError, setPinError, login };
  }

  function useRoster() {
    const [roster, setRosterState] = useState([]);
    const [studentId, setStudentId] = useState(null);
    const [demoMode, setDemoMode] = useState(false);

    useEffect(() => {
      let cancelled = false;
      (async () => {
        const r = await getRoster();
        if (!cancelled) setRosterState(r);
      })();
      return () => { cancelled = true; };
    }, []);

    async function refreshRoster() {
      setRosterState(await getRoster());
    }

    return { roster, studentId, setStudentId, demoMode, setDemoMode, refreshRoster };
  }

  // The gating hook — this is where the audit's race-condition fix now lives ONCE.
  // Serves BOTH module families:
  //   Family 1 (Intro: Hook/Shift/Thesis/Outline) — tracks `best`, score field "pass"/"overall"
  //   Family 2 (the other 12) — no `best`, score field "passed"/"overall_score", exposes progressLoaded
  function useModuleProgress(studentId, moduleKey, demoMode, opts) {
    const passField = (opts && opts.passField) || "pass";
    const scoreField = (opts && opts.scoreField) || "overall";
    const trackBest = !!(opts && opts.trackBest);
    // Family 1 (Intro modules) originally capped the streak counter at 3; Family 2 originally did not
    // (a pre-existing, harmless cosmetic difference — preserved exactly rather than normalized).
    const capAtThree = opts && opts.capAtThree === false ? false : true;

    const [consecutivePasses, setConsecutivePasses] = useState(0);
    const [passed, setPassed] = useState(false);
    const [attempts, setAttempts] = useState([]);
    const [best, setBest] = useState(0);
    const [progressLoaded, setProgressLoaded] = useState(false);

    useEffect(() => {
      if (!studentId || demoMode) { setProgressLoaded(true); return; }
      let cancelled = false;
      (async () => {
        const data = await getProgress(studentId, moduleKey);
        if (!cancelled) {
          if (data) {
            setConsecutivePasses(data.consecutive_passes || 0);
            setPassed(data.passed || false);
            setAttempts(data.attempts || []);
            setBest(data.best || 0);
          }
          setProgressLoaded(true);
        }
      })();
      return () => { cancelled = true; };
    }, [studentId, moduleKey, demoMode]);

    async function persist(newAttempts, newConsec, newPassedVal, newBest) {
      if (!studentId || demoMode) return;
      await setProgress(studentId, moduleKey, {
        consecutivePasses: newConsec, passed: newPassedVal, attempts: newAttempts, best: newBest,
      });
    }

    // Call after every scored attempt — centralizes the pass-streak rule (3 consecutive @ 80%+)
    function recordAttempt(parsedScore, rawResponse) {
      const newAttempts = [...attempts, { ...parsedScore, response: rawResponse, timestamp: new Date().toISOString() }];
      setAttempts(newAttempts);

      let newConsec = consecutivePasses;
      let newPassedVal = passed;
      let newBest = best;

      if (parsedScore[passField]) {
        newConsec = capAtThree ? Math.min(3, consecutivePasses + 1) : consecutivePasses + 1;
        setConsecutivePasses(newConsec);
        if (newConsec >= 3) { setPassed(true); newPassedVal = true; }
        if (trackBest && parsedScore[scoreField] > best) { newBest = parsedScore[scoreField]; setBest(newBest); }
      } else {
        newConsec = 0;
        setConsecutivePasses(0);
      }

      persist(newAttempts, newConsec, newPassedVal, newBest);
      return { newConsec, newPassedVal, newBest };
    }

    function tutorOverride() {
      setPassed(true);
      setConsecutivePasses(3);
      persist(attempts, 3, true, best);
    }

    return {
      consecutivePasses, passed, attempts, best, progressLoaded,
      recordAttempt, tutorOverride,
    };
  }

  function useBenchmarkTimer(benchmarkTime) {
    const [timerMode, setTimerMode] = useState("countdown");
    const [timeLeft, setTimeLeft] = useState(benchmarkTime);
    const [timerRunning, setTimerRunning] = useState(false);
    const [timerExpired, setTimerExpired] = useState(false);
    const timerRef = useRef(null);

    useEffect(() => {
      if (!timerRunning) return;
      timerRef.current = setInterval(() => {
        setTimeLeft((prev) => {
          if (timerMode === "countup") return prev + 1;
          if (prev <= 1) { clearInterval(timerRef.current); setTimerExpired(true); setTimerRunning(false); return 0; }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timerRef.current);
    }, [timerRunning, timerMode]);

    function startTimer() { setTimerRunning(true); }
    function resetTimer() {
      clearInterval(timerRef.current);
      setTimerRunning(false);
      setTimerExpired(false);
      setTimeLeft(timerMode === "countup" ? 0 : benchmarkTime);
    }
    function switchTimerMode(mode) {
      resetTimer();
      setTimerMode(mode);
      setTimeLeft(mode === "countup" ? 0 : benchmarkTime);
    }

    return { timerMode, timeLeft, timerRunning, timerExpired, startTimer, resetTimer, switchTimerMode };
  }

  function useTopicRotation(topics) {
    const [topicIdx, setTopicIdx] = useState(() => Math.floor(Math.random() * topics.length));
    function newTopic() {
      let idx;
      do { idx = Math.floor(Math.random() * topics.length); } while (idx === topicIdx && topics.length > 1);
      setTopicIdx(idx);
      return topics[idx]; // returned so callers needing the new topic synchronously (e.g. Shift's hook regen) can use it before re-render
    }
    return { topic: topics[topicIdx], topicIdx, newTopic };
  }

  global.ATHCore = {
    // persistence (exposed directly too, for the Tutor Dashboard / notes / roster CRUD)
    getRoster, addRosterStudent, removeRosterStudent,
    getProgress, setProgress, getNotes, setNotes,
    scoreResponse,
    // hooks
    useAuth, useRoster, useModuleProgress, useBenchmarkTimer, useTopicRotation,
  };
})(window);

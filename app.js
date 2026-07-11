
import { auth, db } from './firebase-config.js';
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged, 
  sendEmailVerification 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
  doc, 
  setDoc, 
  onSnapshot 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

let firestoreUnsubscribe = null;
let currentUser = null;

  const STORAGE_KEY      = 'attendx_data_v2';
  const HISTORY_LIMIT    = 10;
  const REQUIRED_PCT     = 0.75;
  const SVG_RADIUS       = 34;
  const SVG_CIRCUMFERENCE = 2 * Math.PI * SVG_RADIUS;
  const SPARKLINE_DAYS   = 7;

  const SUBJECT_COLOURS = {
    mce:  { hue: '#a78bfa', label: 'Violet'  },
    dsgt: { hue: '#2dd4bf', label: 'Teal'    },
    aoa:  { hue: '#60a5fa', label: 'Blue'    },
    coa:  { hue: '#f472b6', label: 'Pink'    },
    oe:   { hue: '#a3e635', label: 'Lime'    },
    fsjp: { hue: '#fb923c', label: 'Orange'  },
    ed:   { hue: '#facc15', label: 'Yellow'  },
    ese:  { hue: '#38bdf8', label: 'Sky'     },
  };
  const DEFAULT_COLOUR = '#94a3b8';

  const QUOTES = [
    "Consistency beats intensity.",
    "75% is the floor, not the ceiling.",
    "Show up. It compounds.",
    "Discipline is choosing what you want most.",
    "Your attendance graph is your autobiography.",
    "Every class attended is a vote for your future self.",
    "The compound effect of showing up is real.",
    "Small daily improvements lead to stunning results.",
    "Don't count the days, make the days count.",
    "Excellence is not an act, it's a habit.",
    "Attendance today, freedom tomorrow.",
    "One lecture at a time.",
    "Your future self will thank you.",
    "Brick by brick, class by class.",
  ];

  const DEFAULT_TIMETABLE = {
    1: [], 
    2: [], 
    3: [], 
    4: [], 
    5: [], 
    6: [], 
  };

  const DEFAULT_ALERTS_CONFIG = {
    enabled: true,
    serviceId: 'service_cumb9in',
    templateId: 'template_2wt1y28',
    publicKey: 'iR4SdkDjIPclQHxNz'
  };

  const Store = {
    _state: {
      courses: [],
      history: [],
      nextId: 1,
    },

    clearState() {
      this._state = {
        courses: [],
        history: [],
        nextId: 1,
      };
    },

    async _persist() {
      if (!currentUser) return;
      try {
        await setDoc(doc(db, "users", currentUser.uid), this._state);
      } catch (e) {
        console.error('[AttendX] Persist to Firestore failed:', e);
        showToast('Database write failed. Check connection.');
      }
    },

    hydrate() {
    },

    getCourses()  { return this._state.courses; },
    getHistory()  { return this._state.history; },

    findComponent(courseId, type) {
      const c = this._state.courses.find(c => c.id === courseId);
      return c ? (c.components.find(comp => comp.type === type) || null) : null;
    },

    addCourse(name, hasTheory, hasLab) {
      const components = [];
      if (hasTheory) components.push({ type: 'theory', attended: 0, conducted: 0, log: [], streak: 0 });
      if (hasLab)    components.push({ type: 'lab',    attended: 0, conducted: 0, log: [], streak: 0 });
      const course = { id: this._state.nextId++, name: name.trim(), components, tasks: [] };
      this._state.courses.push(course);
      this._addHistory('create', `Created <strong>${course.name}</strong>`);
      this._persist();
      return course;
    },

    deleteCourse(courseId) {
      const idx = this._state.courses.findIndex(c => c.id === courseId);
      if (idx === -1) return;
      const name = this._state.courses[idx].name;
      this._state.courses.splice(idx, 1);
      this._addHistory('delete', `Deleted <strong>${name}</strong>`);
      this._persist();
    },

    markPresent(courseId, type) {
      const comp = this.findComponent(courseId, type);
      if (!comp) return;
      const course = this._state.courses.find(c => c.id === courseId);
      comp.attended  += 1;
      comp.conducted += 1;
      comp.streak     = (comp.streak || 0) + 1;
      this._appendLog(comp, 'P');
      this._addHistory('add',
        `+1 Present — <strong>${course.name}</strong> (${this._typeLabel(type)})`,
        { courseId, type, action: 'present' }
      );
      this._persist();
    },

    markAbsent(courseId, type) {
      const comp = this.findComponent(courseId, type);
      if (!comp) return;
      const course = this._state.courses.find(c => c.id === courseId);
      comp.conducted += 1;
      comp.streak     = 0;
      this._appendLog(comp, 'A');
      this._addHistory('add',
        `+1 Absent — <strong>${course.name}</strong> (${this._typeLabel(type)})`,
        { courseId, type, action: 'absent' }
      );
      this._persist();
      AlertManager.checkAndSendAlert(course, comp);
    },

    decrementAttended(courseId, type) {
      const comp = this.findComponent(courseId, type);
      if (!comp || comp.attended <= 0) return;
      const course = this._state.courses.find(c => c.id === courseId);
      comp.attended -= 1;
      this._popLog(comp);
      this._addHistory('subtract',
        `−1 Attended — <strong>${course.name}</strong> (${this._typeLabel(type)})`,
        { courseId, type, action: 'dec-attended' }
      );
      this._persist();
      AlertManager.checkAndSendAlert(course, comp);
    },

    decrementConducted(courseId, type) {
      const comp = this.findComponent(courseId, type);
      if (!comp || comp.conducted <= 0) return;
      const course = this._state.courses.find(c => c.id === courseId);
      comp.conducted -= 1;
      if (comp.attended > comp.conducted) comp.attended = comp.conducted;
      this._popLog(comp);
      this._addHistory('subtract',
        `−1 Conducted — <strong>${course.name}</strong> (${this._typeLabel(type)})`,
        { courseId, type, action: 'dec-conducted' }
      );
      this._persist();
      AlertManager.checkAndSendAlert(course, comp);
    },

    undoEntry(historyIndex) {
      const entry = this._state.history[historyIndex];
      if (!entry || !entry.meta) return false;
      const { courseId, type, action } = entry.meta;
      const comp = this.findComponent(courseId, type);
      if (!comp) return false;

      switch (action) {
        case 'present':
          if (comp.attended > 0)  comp.attended  -= 1;
          if (comp.conducted > 0) comp.conducted -= 1;
          this._popLog(comp);
          break;
        case 'absent':
          if (comp.conducted > 0) comp.conducted -= 1;
          if (comp.attended > comp.conducted) comp.attended = comp.conducted;
          this._popLog(comp);
          break;
        case 'dec-attended':
          comp.attended += 1;
          if (comp.attended > comp.conducted) comp.conducted = comp.attended;
          break;
        case 'dec-conducted':
          comp.conducted += 1;
          break;
        default: return false;
      }

      entry.undone = true;
      const course = this._state.courses.find(c => c.id === courseId);
      this._addHistory('undo', `Undid action on <strong>${course ? course.name : '?'}</strong> (${this._typeLabel(type)})`);
      this._persist();
      return true;
    },

    addTask(courseId, text) {
      const course = this._state.courses.find(c => c.id === courseId);
      if (!course) return;
      if (!course.tasks) course.tasks = [];
      const id = Date.now();
      course.tasks.push({ id, text: text.trim(), done: false });
      this._persist();
    },

    toggleTask(courseId, taskId, done) {
      const course = this._state.courses.find(c => c.id === courseId);
      if (!course || !course.tasks) return;
      const task = course.tasks.find(t => t.id === taskId);
      if (task) {
        task.done = done;
        this._persist();
      }
    },

    deleteTask(courseId, taskId) {
      const course = this._state.courses.find(c => c.id === courseId);
      if (!course || !course.tasks) return;
      course.tasks = course.tasks.filter(t => t.id !== taskId);
      this._persist();
    },

    _appendLog(comp, mark) {
      if (!comp.log) comp.log = [];
      comp.log.push({ mark, ts: Date.now() });
      if (comp.log.length > 30) comp.log.shift(); 
    },
    _popLog(comp) {
      if (comp.log && comp.log.length > 0) comp.log.pop();
    },

    _addHistory(type, text, meta = null) {
      this._state.history.unshift({ type, text, meta, time: Date.now(), undone: false });
      if (this._state.history.length > HISTORY_LIMIT) this._state.history.length = HISTORY_LIMIT;
    },
    _typeLabel(t) { return t === 'theory' ? 'Theory' : 'Lab'; },
  };

  const MathEngine = {
    calc(attended, conducted) {
      if (conducted === 0) return { percentage: 100, isSafe: true, safeBunks: 0, requiredLectures: 0 };
      const percentage = (attended / conducted) * 100;
      const isSafe = percentage >= REQUIRED_PCT * 100;
      let safeBunks = 0, requiredLectures = 0;
      if (isSafe) {
        safeBunks = Math.floor((attended - REQUIRED_PCT * conducted) / REQUIRED_PCT);
        if (safeBunks < 0) safeBunks = 0;
      } else {
        requiredLectures = Math.ceil((REQUIRED_PCT * conducted - attended) / (1 - REQUIRED_PCT));
        if (requiredLectures < 0) requiredLectures = 0;
      }
      return { percentage: Math.round(percentage * 100) / 100, isSafe, safeBunks, requiredLectures };
    },
    calcOverall(courses) {
      let tA = 0, tC = 0;
      for (const c of courses) for (const comp of c.components) { tA += comp.attended; tC += comp.conducted; }
      return this.calc(tA, tC);
    },
  };

  function getSubjectColour(courseName) {
    const lower = courseName.toLowerCase();
    for (const key of Object.keys(SUBJECT_COLOURS)) {
      if (lower.startsWith(key)) return SUBJECT_COLOURS[key].hue;
    }
    return DEFAULT_COLOUR;
  }

  const GradientBG = {
    canvas: null, ctx: null, time: 0, raf: null,

    init() {
      this.canvas = document.getElementById('gradient-canvas');
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext('2d');
      this._resize();
      window.addEventListener('resize', () => this._resize());
      this._loop();
    },

    _resize() {
      this.canvas.width  = window.innerWidth;
      this.canvas.height = window.innerHeight;
    },

    _loop() {
      this.time += 0.003;
      const w = this.canvas.width, h = this.canvas.height;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, w, h);

      const x1 = w * (0.3 + 0.2 * Math.sin(this.time * 0.7));
      const y1 = h * (0.2 + 0.15 * Math.cos(this.time * 0.5));
      const g1 = ctx.createRadialGradient(x1, y1, 0, x1, y1, w * 0.6);
      g1.addColorStop(0, 'rgba(99, 102, 241, 0.12)');
      g1.addColorStop(1, 'transparent');
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, w, h);

      const x2 = w * (0.7 + 0.2 * Math.cos(this.time * 0.6));
      const y2 = h * (0.8 + 0.15 * Math.sin(this.time * 0.8));
      const g2 = ctx.createRadialGradient(x2, y2, 0, x2, y2, w * 0.5);
      g2.addColorStop(0, 'rgba(34, 197, 94, 0.08)');
      g2.addColorStop(1, 'transparent');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, w, h);

      const x3 = w * (0.5 + 0.3 * Math.sin(this.time * 0.4));
      const y3 = h * (0.5 + 0.2 * Math.cos(this.time * 0.9));
      const g3 = ctx.createRadialGradient(x3, y3, 0, x3, y3, w * 0.4);
      g3.addColorStop(0, 'rgba(244, 114, 182, 0.06)');
      g3.addColorStop(1, 'transparent');
      ctx.fillStyle = g3;
      ctx.fillRect(0, 0, w, h);

      this.raf = requestAnimationFrame(() => this._loop());
    },
  };

  const Confetti = {
    canvas: null, ctx: null, particles: [], active: false,

    init() {
      this.canvas = document.getElementById('confetti-canvas');
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext('2d');
      this._resize();
      window.addEventListener('resize', () => this._resize());
    },

    _resize() {
      this.canvas.width  = window.innerWidth;
      this.canvas.height = window.innerHeight;
    },

    burst(x, y) {
      const colours = ['#22c55e', '#60a5fa', '#f472b6', '#facc15', '#a78bfa', '#fb923c'];
      for (let i = 0; i < 35; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 3 + Math.random() * 5;
        this.particles.push({
          x, y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 3,
          size: 4 + Math.random() * 4,
          color: colours[Math.floor(Math.random() * colours.length)],
          life: 1,
          decay: 0.015 + Math.random() * 0.01,
          rotation: Math.random() * 360,
          rotSpeed: (Math.random() - 0.5) * 12,
        });
      }
      if (!this.active) { this.active = true; this._loop(); }
    },

    _loop() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.x  += p.vx;
        p.y  += p.vy;
        p.vy += 0.15;        
        p.life -= p.decay;
        p.rotation += p.rotSpeed;

        if (p.life <= 0) { this.particles.splice(i, 1); continue; }

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation * Math.PI / 180);
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }

      if (this.particles.length > 0) {
        requestAnimationFrame(() => this._loop());
      } else {
        this.active = false;
      }
    },
  };

  const Renderer = {
    $grid: null, $emptyState: null, $headerStats: null,
    $historyList: null, $historyEmpty: null,

    init() {
      this.$grid        = document.getElementById('dashboard-grid');
      this.$emptyState  = document.getElementById('empty-state');
      this.$headerStats = document.getElementById('header-stats');
      this.$historyList = document.getElementById('history-list');
      this.$historyEmpty= document.getElementById('history-empty');
      this.$historySection = document.getElementById('history-section');
    },

    _quoteLoaded: false,
    render() {
      this.renderCards();
      this.renderOverall();
      this.renderSummaryBar();
      this.renderHistory();
      this.renderTimetable();
      this.renderWelcomeBanner();
      this.renderAnalytics();
      BunkSimulator.populateOptions();
    },

    renderWelcomeBanner() {
      const sem = Store._state.semester || 3;
      const dept = Store._state.department || 'Computer Engineering';
      const name = Store._state.name || '';
      const courses = Store.getCourses();
      const headerTagline = document.getElementById('header-tagline');
      if (headerTagline) {
        headerTagline.textContent = `Semester ${sem} · ${dept}`;
      }

      const welcomeTitle = document.getElementById('welcome-title');
      if (welcomeTitle) {
        welcomeTitle.textContent = name ? `Welcome back, ${name}! 👋` : `Welcome back! 👋`;
      }

      const welcomeBadge = document.getElementById('welcome-profile-badge');
      if (welcomeBadge) {
        welcomeBadge.textContent = `Semester ${sem} · ${dept}`;
      }

      const welcomeQuote = document.getElementById('welcome-quote');
      if (welcomeQuote) {
        let dynamicText = "";
        if (courses.length === 0) {
          dynamicText = "Initialize your course list below to start tracking.";
        } else {
          const overall = MathEngine.calcOverall(courses);
          const dayOfWeek = new Date().getDay();
          const currentTimetable = Store._state.timetable || DEFAULT_TIMETABLE;
          const slots = currentTimetable[dayOfWeek] || [];
          const classCount = slots.length;
          const classesText = classCount > 0 ? `${classCount} class${classCount === 1 ? '' : 'es'} scheduled today` : 'No classes scheduled today';
          const statusText = overall.isSafe ? `your attendance is safe (${Math.round(overall.percentage)}%)` : `attendance shortage: ${Math.round(overall.percentage)}%`;
          dynamicText = `${classesText} · ${statusText}`;
        }
        welcomeQuote.textContent = dynamicText;
      }
    },

    renderAnalytics() {
      const courses = Store.getCourses();
      let safeCount = 0;
      let warnCount = 0;
      let dangerCount = 0;

      courses.forEach(course => {
        course.components.forEach(comp => {
          const metrics = MathEngine.calc(comp.attended, comp.conducted);
          const pct = comp.conducted === 0 ? 100 : metrics.percentage;
          if (pct >= 75) {
            safeCount++;
          } else if (pct >= 70) {
            warnCount++;
          } else {
            dangerCount++;
          }
        });
      });

      document.getElementById('analytics-safe-count').textContent = safeCount;
      document.getElementById('analytics-warn-count').textContent = warnCount;
      document.getElementById('analytics-danger-count').textContent = dangerCount;
    },

    renderCards() {
      const courses = Store.getCourses();
      this.$grid.querySelectorAll('.card-flip-container').forEach(el => el.remove());

      const addCourseBar = document.querySelector('.add-course-bar');
      const headerAddBtn = document.getElementById('btn-header-add-course');
      const simLocked = document.getElementById('sim-locked-state');
      const simControls = document.getElementById('sim-content-wrapper');

      if (courses.length === 0) {
        this.$emptyState.style.display = '';
        if (addCourseBar) addCourseBar.style.display = 'none';
        if (headerAddBtn) headerAddBtn.style.display = 'none';
        if (simLocked) simLocked.style.display = 'block';
        if (simControls) simControls.style.display = 'none';
        return;
      }
      this.$emptyState.style.display = 'none';
      if (addCourseBar) addCourseBar.style.display = '';
      if (headerAddBtn) {
        headerAddBtn.style.display = currentUser ? 'inline-flex' : 'none';
      }
      if (simLocked) simLocked.style.display = 'none';
      if (simControls) simControls.style.display = 'block';

      for (const course of courses) {
        for (const comp of course.components) {
          const metrics = MathEngine.calc(comp.attended, comp.conducted);
          const el = this._buildFlipCard(course, comp, metrics);
          this.$grid.appendChild(el);
        }
      }
    },

    _buildFlipCard(course, comp, metrics) {
      const container = document.createElement('div');
      container.className = 'card-flip-container';
      container.dataset.courseId = course.id;
      container.dataset.compType = comp.type;

      const accentColour = getSubjectColour(course.name);
      const streak = comp.streak || 0;

      container.innerHTML = `
        <div class="card-flipper">
          <div class="card-front">
            ${this._buildFrontCard(course, comp, metrics, accentColour, streak)}
          </div>
          <div class="card-back">
            ${this._buildBackCard(course, comp, metrics, accentColour, streak)}
          </div>
        </div>`;

      return container;
    },

    _buildFrontCard(course, comp, metrics, accentColour, streak) {
      const badgeClass = comp.type === 'theory' ? 'theory' : 'lab';
      const badgeIcon  = comp.type === 'theory' ? '📖' : '🧪';
      const badgeLabel = comp.type === 'theory' ? 'Theory' : 'Lab';

      let statusHtml = '';
      if (metrics.isSafe) {
        statusHtml = `<div class="stat-row"><span class="stat-label">Can Bunk</span><span class="stat-value safe">${metrics.safeBunks}</span></div>`;
      } else {
        statusHtml = `<div class="stat-row"><span class="stat-label">Need</span><span class="stat-value danger">${metrics.requiredLectures} more</span></div>`;
      }

      const pct = comp.conducted === 0 ? 100 : metrics.percentage;
      const offset = SVG_CIRCUMFERENCE - (SVG_CIRCUMFERENCE * Math.min(pct, 100) / 100);
      const strokeColor = metrics.isSafe ? 'var(--safe)' : 'var(--danger)';

      const sparkHtml = this._buildSparkline(comp);

      const streakHtml = streak >= 2
        ? `<span class="streak-badge">🔥 ${streak}</span>`
        : '';

      const shortName = course.name.split('—')[0].trim();

      return `
        <div class="attend-card" style="--card-accent: ${accentColour};">
          <div class="card-head">
            <div class="card-title-group">
              <div class="card-title">${this._esc(shortName)} ${streakHtml}</div>
              <div class="card-badge ${badgeClass}">${badgeIcon} ${badgeLabel}</div>
            </div>
            <div class="card-actions-top">
              <button class="btn-icon-sm flip-btn" data-action="flip" data-course-id="${course.id}" data-type="${comp.type}" title="Detailed stats">📊</button>
              <button class="btn-icon-sm delete" data-action="delete" data-course-id="${course.id}" title="Delete">🗑</button>
            </div>
          </div>
          <div class="card-body">
            <div class="ring-wrapper">
              <svg class="ring-svg" viewBox="0 0 80 80">
                <circle class="ring-bg" cx="40" cy="40" r="${SVG_RADIUS}"></circle>
                <circle class="ring-fg" cx="40" cy="40" r="${SVG_RADIUS}"
                        stroke="${accentColour}"
                        stroke-dasharray="${SVG_CIRCUMFERENCE}"
                        stroke-dashoffset="${offset}"></circle>
              </svg>
              <div class="ring-text" style="color:${metrics.isSafe ? 'var(--safe)' : 'var(--danger)'}">
                ${Math.round(pct)}<span class="pct-symbol">%</span>
              </div>
            </div>
            <div class="card-stats">
              <div class="stat-row"><span class="stat-label">Attended</span><span class="stat-value">${comp.attended}</span></div>
              <div class="stat-row"><span class="stat-label">Conducted</span><span class="stat-value">${comp.conducted}</span></div>
              ${statusHtml}
            </div>
          </div>
          ${sparkHtml}
          <div class="card-quick-actions">
            <div class="quick-group">
              <button class="btn-quick plus"  data-action="present"       data-course-id="${course.id}" data-type="${comp.type}" title="Present (+1 both)">＋</button>
              <span class="quick-group-label">Attend</span>
              <button class="btn-quick minus" data-action="dec-attended"  data-course-id="${course.id}" data-type="${comp.type}" title="−1 attended" ${comp.attended <= 0 ? 'disabled' : ''}>−</button>
            </div>
            <div class="quick-group">
              <button class="btn-quick plus"  data-action="absent"        data-course-id="${course.id}" data-type="${comp.type}" title="Absent (+1 conducted)">＋</button>
              <span class="quick-group-label">Conduct</span>
              <button class="btn-quick minus" data-action="dec-conducted" data-course-id="${course.id}" data-type="${comp.type}" title="−1 conducted" ${comp.conducted <= 0 ? 'disabled' : ''}>−</button>
            </div>
          </div>
        </div>`;
    },

    _buildBackCard(course, comp, metrics, accentColour, streak) {
      const shortName = course.name.split('—')[0].trim();
      const fullName  = course.name.includes('—') ? course.name.split('—')[1].trim() : course.name;
      const typeLabel = comp.type === 'theory' ? 'Theory' : 'Lab';
      const pct = comp.conducted === 0 ? 100 : metrics.percentage;

      let tasksHtml = '';
      const tasks = course.tasks || [];
      if (tasks.length === 0) {
        tasksHtml = `<li style="font-size:0.65rem;color:var(--text-muted);padding:8px 0;text-align:center;width:100%;">No pending tasks.</li>`;
      } else {
        tasks.forEach(task => {
          const doneClass = task.done ? 'done' : '';
          const checkedAttr = task.done ? 'checked' : '';
          tasksHtml += `
            <li class="task-item ${doneClass}">
              <label class="task-checkbox-label">
                <input type="checkbox" data-task-id="${task.id}" data-course-id="${course.id}" data-action="toggle-task" ${checkedAttr} />
                <span class="task-text" title="${this._esc(task.text)}">${this._esc(task.text)}</span>
              </label>
              <button class="btn-delete-task" data-action="delete-task" data-task-id="${task.id}" data-course-id="${course.id}">✕</button>
            </li>`;
        });
      }

      return `
        <div class="card-back-inner" style="border-top: 3px solid ${accentColour};">
          <div class="card-back-title">
            <span>${this._esc(shortName)} · ${typeLabel}</span>
            <button class="btn-icon-sm flip-btn" data-action="flip" data-course-id="${course.id}" data-type="${comp.type}" title="Back to front">✕</button>
          </div>
          <div class="back-stats-grid" style="margin-bottom:12px;">
            <div class="back-stat-item" style="padding:6px 4px;">
              <span class="back-stat-value" style="font-size:0.95rem;color:${metrics.isSafe ? 'var(--safe)' : 'var(--danger)'};">${Math.round(pct)}%</span>
              <span class="back-stat-label" style="font-size:0.5rem;">Percent</span>
            </div>
            <div class="back-stat-item" style="padding:6px 4px;">
              <span class="back-stat-value" style="font-size:0.95rem;">${comp.attended}/${comp.conducted}</span>
              <span class="back-stat-label" style="font-size:0.5rem;">Attended</span>
            </div>
            <div class="back-stat-item" style="padding:6px 4px;">
              <span class="back-stat-value" style="font-size:0.95rem;color:var(--safe);">${metrics.safeBunks}</span>
              <span class="back-stat-label" style="font-size:0.5rem;">Bunks</span>
            </div>
            <div class="back-stat-item" style="padding:6px 4px;">
              <span class="back-stat-value" style="font-size:0.95rem;color:var(--danger);">${metrics.requiredLectures}</span>
              <span class="back-stat-label" style="font-size:0.5rem;">Needed</span>
            </div>
          </div>
          <div class="tasks-container">
            <div class="tasks-header">📋 Course Tasks</div>
            <ul class="tasks-list">
              ${tasksHtml}
            </ul>
            <form class="task-add-form" data-course-id="${course.id}">
              <input type="text" placeholder="Add task..." required />
              <button type="submit" class="btn-task-add">Add</button>
            </form>
          </div>
          <button class="btn-flip-back" data-action="flip" data-course-id="${course.id}" data-type="${comp.type}">← Back to Card</button>
        </div>`;
    },

    _buildSparkline(comp) {
      const log = comp.log || [];
      const recent = log.slice(-SPARKLINE_DAYS);
      if (recent.length === 0) return '';

      let bars = '';
      for (let i = 0; i < SPARKLINE_DAYS; i++) {
        if (i < recent.length) {
          const cls = recent[i].mark === 'P' ? 'present' : 'absent';
          const h = recent[i].mark === 'P' ? '100%' : '40%';
          bars += `<div class="sparkline-bar ${cls}" style="height:${h};" title="${recent[i].mark === 'P' ? 'Present' : 'Absent'}"></div>`;
        } else {
          bars += `<div class="sparkline-bar empty" style="height:20%;"></div>`;
        }
      }
      return `<div class="sparkline-row"><div class="sparkline-label">Last ${Math.min(recent.length, SPARKLINE_DAYS)} classes</div><div class="sparkline-bar-container">${bars}</div></div>`;
    },

    renderOverall() {
      const courses = Store.getCourses();
      if (courses.length === 0) { this.$headerStats.innerHTML = ''; return; }
      const o = MathEngine.calcOverall(courses);
      const cls = o.isSafe ? 'safe' : 'danger';
      this.$headerStats.innerHTML = `<div class="overall-pill ${cls}"><span class="pill-label">Overall</span>${Math.round(o.percentage)}%</div>`;
    },

    renderSummaryBar() {
      const courses = Store.getCourses();
      let totalAttended = 0, totalConducted = 0, totalBunks = 0;
      for (const c of courses) {
        for (const comp of c.components) {
          totalAttended  += comp.attended;
          totalConducted += comp.conducted;
          const m = MathEngine.calc(comp.attended, comp.conducted);
          if (m.isSafe) totalBunks += m.safeBunks;
        }
      }
      document.getElementById('sum-total-attended').textContent  = totalAttended;
      document.getElementById('sum-total-conducted').textContent = totalConducted;

      const bunksEl = document.getElementById('sum-total-bunks');
      bunksEl.textContent = totalBunks;
      bunksEl.className   = 'summary-value ' + (totalBunks > 0 ? 'safe' : 'danger');

    },

    renderTimetable() {
      const dayOfWeek = new Date().getDay(); 
      const currentTimetable = Store._state.timetable || DEFAULT_TIMETABLE;
      const slots = currentTimetable[dayOfWeek] || [];
      const toggleBar = document.querySelector('.timetable-toggle-bar');
      const section = document.getElementById('timetable-section');

      if (slots.length === 0) {
        if (toggleBar) toggleBar.style.display = 'none';
        if (section) section.style.display = 'none';
        return;
      } else {
        if (toggleBar) toggleBar.style.display = '';
        if (section) section.style.display = '';
      }

      const grid = document.getElementById('timetable-grid');
      grid.innerHTML = '';
      const courses = Store.getCourses();

      for (const slot of slots) {
        const abbr = slot.subject.split(/[\s/\-]/)[0].toLowerCase();
        const colour = SUBJECT_COLOURS[abbr] ? SUBJECT_COLOURS[abbr].hue : DEFAULT_COLOUR;

        const slotSubjectLower = slot.subject.trim().toLowerCase();
        const matchedCourse = courses.find(c => {
          const cNameLower = c.name.toLowerCase();
          return cNameLower.includes(slotSubjectLower) || slotSubjectLower.includes(cNameLower);
        });

        const el = document.createElement('div');
        el.className = 'tt-slot';
        el.style.borderLeftColor = colour;

        let actionsHtml = `<div class="tt-room">${slot.room}</div>`;
        if (matchedCourse) {
          actionsHtml = `
            <div class="tt-slot-actions">
              <button class="btn-tt-action p" data-action="tt-present" data-course-id="${matchedCourse.id}" data-type="${slot.type}" title="Quick Present">✓</button>
              <button class="btn-tt-action a" data-action="tt-absent" data-course-id="${matchedCourse.id}" data-type="${slot.type}" title="Quick Absent">✗</button>
            </div>
          `;
        }

        el.innerHTML = `
          <div class="tt-slot-info">
            <div class="tt-time">${slot.time}</div>
            <div class="tt-subject" style="color:${colour};">${slot.subject}</div>
            ${!matchedCourse ? `<div class="tt-room">${slot.room}</div>` : ''}
          </div>
          ${actionsHtml}
        `;
        grid.appendChild(el);
      }
    },

    renderHistory() {
      const history = Store.getHistory();
      this.$historyList.innerHTML = '';
      if (history.length === 0) {
        if (this.$historySection) this.$historySection.style.display = 'none';
        return;
      }
      if (this.$historySection) this.$historySection.style.display = 'block';
      this.$historyEmpty.style.display = 'none';

      history.forEach((entry, idx) => {
        const li = document.createElement('li');
        li.className = 'history-item';
        const timeStr = this._timeAgo(entry.time);
        let undoBtn = '';
        if (entry.meta && !entry.undone && entry.type !== 'undo') {
          undoBtn = `<button class="history-undo-btn" data-undo-idx="${idx}">Undo</button>`;
        }
        const strike = entry.undone ? 'text-decoration:line-through;opacity:.45;' : '';
        li.innerHTML = `
          <span class="history-dot ${entry.type}"></span>
          <span class="history-text" style="${strike}">${entry.text}</span>
          <span class="history-time">${timeStr}</span>
          ${undoBtn}`;
        this.$historyList.appendChild(li);
      });
    },

    _esc(s) { const el = document.createElement('span'); el.textContent = s; return el.innerHTML; },
    _timeAgo(ts) {
      const d = Math.floor((Date.now() - ts) / 1000);
      if (d < 5) return 'now';
      if (d < 60) return `${d}s`;
      if (d < 3600) return `${Math.floor(d/60)}m`;
      if (d < 86400) return `${Math.floor(d/3600)}h`;
      return `${Math.floor(d/86400)}d`;
    },
  };

  function showToast(msg, duration = 2000) {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg; c.appendChild(t);
    setTimeout(() => { t.classList.add('out'); t.addEventListener('animationend', () => t.remove()); }, duration);
  }

  const Controller = {
    init() {
      document.getElementById('btn-open-add-modal').addEventListener('click', () => this.openModal());
      const headerAddBtn = document.getElementById('btn-header-add-course');
      if (headerAddBtn) {
        headerAddBtn.addEventListener('click', () => this.openModal());
      }

      document.getElementById('modal-close').addEventListener('click',      () => this.closeModal());
      document.getElementById('btn-cancel-modal').addEventListener('click', () => this.closeModal());
      document.getElementById('modal-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'modal-overlay') this.closeModal();
      });
      document.getElementById('course-form').addEventListener('submit', (e) => {
        e.preventDefault(); this.handleFormSubmit();
      });

      document.getElementById('dashboard-grid').addEventListener('click', (e) => {
        const emptyAddBtn = e.target.closest('#btn-empty-add-course');
        if (emptyAddBtn) {
          this.openModal();
          return;
        }
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        this.handleCardAction(btn, e);
      });

      document.getElementById('history-list').addEventListener('click', (e) => {
        const btn = e.target.closest('.history-undo-btn');
        if (!btn) return;
        if (Store.undoEntry(parseInt(btn.dataset.undoIdx, 10))) {
          showToast('Action undone');
          Renderer.render();
        }
      });

      document.getElementById('confirm-cancel').addEventListener('click',  () => this.closeConfirm());
      document.getElementById('confirm-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'confirm-overlay') this.closeConfirm();
      });

      document.getElementById('btn-toggle-timetable').addEventListener('click', () => {
        const section = document.getElementById('timetable-section');
        const btn = document.getElementById('btn-toggle-timetable');
        section.classList.toggle('collapsed');
        btn.classList.toggle('open');
      });

      document.getElementById('timetable-grid').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="tt-present"], [data-action="tt-absent"]');
        if (!btn) return;
        const courseId = parseInt(btn.dataset.courseId, 10);
        const type = btn.dataset.type;
        const action = btn.dataset.action;
        if (action === 'tt-present') {
          Store.markPresent(courseId, type);
          const rect = btn.getBoundingClientRect();
          Confetti.burst(rect.left + rect.width / 2, rect.top);
          showToast('Marked Present!');
        } else {
          Store.markAbsent(courseId, type);
          showToast('Marked Absent!');
        }
        Renderer.render();
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { this.closeModal(); this.closeConfirm(); }
      });

      setInterval(() => Renderer.renderHistory(), 30000);

      this.initSettingsAndTools();
    },

    openModal() {
      document.getElementById('modal-title').textContent = 'Add Course';
      document.getElementById('btn-submit-modal').textContent = 'Add Course';
      document.getElementById('course-name').value = '';
      document.getElementById('has-theory').checked = true;
      document.getElementById('has-lab').checked = false;
      document.getElementById('modal-overlay').classList.add('open');
      document.getElementById('modal-overlay').setAttribute('aria-hidden', 'false');
      setTimeout(() => document.getElementById('course-name').focus(), 100);
    },

    closeModal() {
      document.getElementById('modal-overlay').classList.remove('open');
      document.getElementById('modal-overlay').setAttribute('aria-hidden', 'true');
    },

    handleFormSubmit() {
      const name = document.getElementById('course-name').value.trim();
      const hasT = document.getElementById('has-theory').checked;
      const hasL = document.getElementById('has-lab').checked;
      if (!name) { showToast('Enter a course name'); return; }
      if (!hasT && !hasL) { showToast('Select at least one component'); return; }
      Store.addCourse(name, hasT, hasL);
      this.closeModal();
      Renderer.render();
      showToast(`${name} added!`);
    },

    handleCardAction(btn, event) {
      const action  = btn.dataset.action;
      const courseId = parseInt(btn.dataset.courseId, 10);
      const type    = btn.dataset.type;

      switch (action) {
        case 'present':
          Store.markPresent(courseId, type);
          if (event) {
            const rect = btn.getBoundingClientRect();
            Confetti.burst(rect.left + rect.width / 2, rect.top);
          }
          Renderer.render();
          break;

        case 'absent':
          Store.markAbsent(courseId, type);
          Renderer.render();
          break;

        case 'dec-attended':
          Store.decrementAttended(courseId, type);
          Renderer.render();
          break;

        case 'dec-conducted':
          Store.decrementConducted(courseId, type);
          Renderer.render();
          break;

        case 'flip':
          const container = btn.closest('.card-flip-container');
          if (container) container.classList.toggle('flipped');
          break;

        case 'delete-task':
          const tId = parseInt(btn.dataset.taskId, 10);
          Store.deleteTask(courseId, tId);
          Renderer.render();
          showToast('Task deleted');
          break;

        case 'delete':
          this._pendingDeleteId = courseId;
          const course = Store.getCourses().find(c => c.id === courseId);
          document.getElementById('confirm-message').textContent =
            `This will permanently remove "${course ? course.name : ''}" and all its data.`;
          document.getElementById('confirm-overlay').classList.add('open');
          document.getElementById('confirm-overlay').setAttribute('aria-hidden', 'false');
          document.getElementById('confirm-ok').onclick = () => {
            Store.deleteCourse(this._pendingDeleteId);
            this.closeConfirm();
            Renderer.render();
            showToast('Course deleted');
          };
          break;
      }
    },

    closeConfirm() {
      document.getElementById('confirm-overlay').classList.remove('open');
      document.getElementById('confirm-overlay').setAttribute('aria-hidden', 'true');
    },

    initSettingsAndTools() {
      document.querySelectorAll('.settings-tabs .tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          document.querySelectorAll('.settings-tabs .tab-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('.modal-settings .tab-content').forEach(c => c.classList.add('hidden'));
          e.target.classList.add('active');
          const tabId = e.target.dataset.tab;
          document.getElementById(tabId).classList.remove('hidden');
          if (tabId === 'tab-timetable') {
            this.renderTimetableEditor();
          }
        });
      });

      const settingsOverlay = document.getElementById('settings-overlay');
      document.getElementById('btn-settings').addEventListener('click', () => {
        this.openSettingsModal();
      });
      document.getElementById('settings-close').addEventListener('click', () => {
        settingsOverlay.classList.remove('open');
        settingsOverlay.setAttribute('aria-hidden', 'true');
      });
      settingsOverlay.addEventListener('click', (e) => {
        if (e.target.id === 'settings-overlay') {
          settingsOverlay.classList.remove('open');
          settingsOverlay.setAttribute('aria-hidden', 'true');
        }
      });

      const alertsCheckbox = document.getElementById('alerts-enabled');
      alertsCheckbox.addEventListener('change', (e) => {
        const fields = document.getElementById('alerts-config-fields');
        if (e.target.checked) {
          fields.style.opacity = '1';
          fields.style.pointerEvents = 'auto';
        } else {
          fields.style.opacity = '0.5';
          fields.style.pointerEvents = 'none';
        }
      });

      document.getElementById('settings-profile-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('settings-name').value.trim();
        const sem = parseInt(document.getElementById('settings-semester').value, 10);
        const dept = document.getElementById('settings-department').value.trim();
        Store._state.name = name;
        Store._state.semester = sem;
        Store._state.department = dept;
        Store._persist();
        settingsOverlay.classList.remove('open');
        settingsOverlay.setAttribute('aria-hidden', 'true');
        showToast('Profile updated!');
        Renderer.render();
      });

      document.getElementById('settings-alerts-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const enabled = document.getElementById('alerts-enabled').checked;
        const serviceId = document.getElementById('alerts-service-id').value.trim();
        const templateId = document.getElementById('alerts-template-id').value.trim();
        const publicKey = document.getElementById('alerts-public-key').value.trim();
        if (enabled && (!serviceId || !templateId || !publicKey)) {
          showToast('Please fill all EmailJS parameters to enable.');
          return;
        }

        if (!Store._state.emailAlertsConfig) Store._state.emailAlertsConfig = {};
        Store._state.emailAlertsConfig.enabled = enabled;
        Store._state.emailAlertsConfig.serviceId = serviceId;
        Store._state.emailAlertsConfig.templateId = templateId;
        Store._state.emailAlertsConfig.publicKey = publicKey;
        Store._persist();
        settingsOverlay.classList.remove('open');
        settingsOverlay.setAttribute('aria-hidden', 'true');
        showToast('Alert configurations saved!');
      });

      document.getElementById('onboarding-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('onboard-name').value.trim();
        const sem = parseInt(document.getElementById('onboard-semester').value, 10);
        const dept = document.getElementById('onboard-department').value.trim();
        Store._state.name = name;
        Store._state.semester = sem;
        Store._state.department = dept;
        Store._state.timetable = JSON.parse(JSON.stringify(DEFAULT_TIMETABLE));
        Store._persist();
        document.getElementById('onboarding-overlay').classList.remove('open');
        document.getElementById('onboarding-overlay').setAttribute('aria-hidden', 'true');
        showToast('Profile initialized!');
        Renderer.render();
      });

      document.getElementById('tt-add-slot-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const day = parseInt(document.getElementById('tt-editor-day').value, 10);
        const time = document.getElementById('tt-slot-time').value.trim();
        const subject = document.getElementById('tt-slot-subject').value.trim();
        const room = document.getElementById('tt-slot-room').value.trim();
        const type = document.getElementById('tt-slot-type').value;

        if (!Store._state.timetable) {
          Store._state.timetable = JSON.parse(JSON.stringify(DEFAULT_TIMETABLE));
        }
        if (!Store._state.timetable[day]) Store._state.timetable[day] = [];
        Store._state.timetable[day].push({ time, subject, room, type });
        Store._persist();

        document.getElementById('tt-slot-time').value = '';
        document.getElementById('tt-slot-subject').value = '';
        document.getElementById('tt-slot-room').value = '';
        this.renderTimetableEditor();
        Renderer.render();
        showToast('Class slot added!');
      });

      document.getElementById('tt-slots-list').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="delete-slot"]');
        if (!btn) return;
        const day = parseInt(btn.dataset.day, 10);
        const idx = parseInt(btn.dataset.idx, 10);
        if (!Store._state.timetable) {
          Store._state.timetable = JSON.parse(JSON.stringify(DEFAULT_TIMETABLE));
        }
        Store._state.timetable[day].splice(idx, 1);
        Store._persist();
        this.renderTimetableEditor();
        Renderer.render();
        showToast('Class slot deleted!');
      });

      document.getElementById('tt-editor-day').addEventListener('change', () => {
        this.renderTimetableEditor();
      });

      document.getElementById('dashboard-grid').addEventListener('submit', (e) => {
        const form = e.target.closest('.task-add-form');
        if (!form) return;
        e.preventDefault();
        const courseId = parseInt(form.dataset.courseId, 10);
        const input = form.querySelector('input');
        const text = input.value.trim();
        if (text) {
          Store.addTask(courseId, text);
          input.value = '';
          Renderer.render();
          showToast('Task added!');
        }
      });

      document.getElementById('dashboard-grid').addEventListener('change', (e) => {
        const checkbox = e.target.closest('[data-action="toggle-task"]');
        if (!checkbox) return;
        const courseId = parseInt(checkbox.dataset.courseId, 10);
        const taskId = parseInt(checkbox.dataset.taskId, 10);
        Store.toggleTask(courseId, taskId, checkbox.checked);
        Renderer.render();
      });
    },

    openSettingsModal() {
      document.getElementById('settings-name').value = Store._state.name || '';
      document.getElementById('settings-semester').value = Store._state.semester || 3;
      document.getElementById('settings-department').value = Store._state.department || '';
      const config = (Store._state.emailAlertsConfig && Store._state.emailAlertsConfig.serviceId) ? Store._state.emailAlertsConfig : DEFAULT_ALERTS_CONFIG;
      const alertsCheckbox = document.getElementById('alerts-enabled');
      alertsCheckbox.checked = config.enabled || false;
      document.getElementById('alerts-service-id').value = config.serviceId || '';
      document.getElementById('alerts-template-id').value = config.templateId || '';
      document.getElementById('alerts-public-key').value = config.publicKey || '';

      const fields = document.getElementById('alerts-config-fields');
      if (alertsCheckbox.checked) {
        fields.style.opacity = '1';
        fields.style.pointerEvents = 'auto';
      } else {
        fields.style.opacity = '0.5';
        fields.style.pointerEvents = 'none';
      }

      document.querySelectorAll('.settings-tabs .tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.modal-settings .tab-content').forEach(c => c.classList.add('hidden'));
      const activeBtn = document.querySelector('.settings-tabs .tab-btn[data-tab="tab-profile"]');
      activeBtn.classList.add('active');
      document.getElementById('tab-profile').classList.remove('hidden');

      document.getElementById('settings-overlay').classList.add('open');
      document.getElementById('settings-overlay').setAttribute('aria-hidden', 'false');
    },

    renderTimetableEditor() {
      const day = parseInt(document.getElementById('tt-editor-day').value, 10);
      const timetable = Store._state.timetable || DEFAULT_TIMETABLE;
      const slots = timetable[day] || [];
      const list = document.getElementById('tt-slots-list');
      list.innerHTML = '';
      if (slots.length === 0) {
        list.innerHTML = '<p style="color:var(--text-muted);font-size:0.75rem;text-align:center;padding:12px 0;">No classes scheduled for this day.</p>';
        return;
      }

      slots.forEach((slot, idx) => {
        const item = document.createElement('div');
        item.className = 'tt-edit-slot-item';
        item.style.marginBottom = '6px';
        item.innerHTML = `
          <div class="tt-edit-slot-info">
            <span class="tt-edit-slot-time" style="font-size:0.65rem;color:var(--accent);font-family:var(--font-mono);font-weight:700;">${slot.time}</span>
            <span class="tt-edit-slot-sub" style="font-size:0.75rem;font-weight:600;">${slot.subject} (Room: ${slot.room || '—'})</span>
          </div>
          <button class="btn-delete-slot" data-action="delete-slot" data-day="${day}" data-idx="${idx}" style="cursor:pointer;">🗑</button>
        `;
        list.appendChild(item);
      });
    },
  };

  const AuthManager = {
    init() {
      const $overlay = document.getElementById('auth-overlay');
      const $loginView = document.getElementById('login-view');
      const $registerView = document.getElementById('register-view');
      const $verificationView = document.getElementById('verification-view');
      const $userEmailPlaceholder = document.getElementById('user-email-placeholder');
      const $toRegisterBtn = document.getElementById('to-register-btn');
      const $toLoginBtn = document.getElementById('to-login-btn');
      const $loginForm = document.getElementById('login-form');
      const $registerForm = document.getElementById('register-form');
      const $resendBtn = document.getElementById('btn-resend-verification');
      const $verifyLogoutBtn = document.getElementById('btn-verification-logout');
      const $headerLogoutBtn = document.getElementById('btn-logout');

      $toRegisterBtn.addEventListener('click', (e) => {
        e.preventDefault();
        $loginView.classList.add('hidden');
        $registerView.classList.remove('hidden');
      });

      $toLoginBtn.addEventListener('click', (e) => {
        e.preventDefault();
        $registerView.classList.add('hidden');
        $loginView.classList.remove('hidden');
      });

      $loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value.trim();
        const pass = document.getElementById('login-password').value;
        const btn = document.getElementById('btn-login-submit');
        try {
          btn.disabled = true;
          btn.textContent = 'Signing In...';
          await signInWithEmailAndPassword(auth, email, pass);
          showToast('Signed in successfully!');
        } catch (err) {
          console.error(err);
          showToast(this.getFriendlyError(err.code) || err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Sign In';
        }
      });

      $registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('register-email').value.trim();
        const pass = document.getElementById('register-password').value;
        const confirm = document.getElementById('register-confirm').value;
        const btn = document.getElementById('btn-register-submit');

        if (pass.length < 6) {
          showToast('Password must be at least 6 characters');
          return;
        }
        if (pass !== confirm) {
          showToast('Passwords do not match');
          return;
        }

        try {
          btn.disabled = true;
          btn.textContent = 'Creating Account...';
          const userCredential = await createUserWithEmailAndPassword(auth, email, pass);
          await sendEmailVerification(userCredential.user);
          showToast('Verification email sent!');
        } catch (err) {
          console.error(err);
          showToast(this.getFriendlyError(err.code) || err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Register';
        }
      });

      $resendBtn.addEventListener('click', async () => {
        if (auth.currentUser) {
          try {
            $resendBtn.disabled = true;
            $resendBtn.textContent = 'Sending...';
            await sendEmailVerification(auth.currentUser);
            showToast('Verification link resent!');
          } catch (err) {
            showToast('Resend failed: ' + err.message);
          } finally {
            $resendBtn.disabled = false;
            $resendBtn.textContent = 'Resend Verification Link';
          }
        }
      });

      const logoutAction = async () => {
        try {
          showToast('Logging out...');
          await signOut(auth);
        } catch (err) {
          showToast('Logout failed');
        }
      };

      $verifyLogoutBtn.addEventListener('click', logoutAction);
      $headerLogoutBtn.addEventListener('click', logoutAction);

      onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        if (user) {
          if (user.emailVerified) {
            this.stopVerificationCheck();
            $overlay.classList.remove('open');
            $overlay.setAttribute('aria-hidden', 'true');
            $headerLogoutBtn.style.display = 'block';
            this.setupDatabaseSync(user.uid);
          } else {
            this.stopVerificationCheck();
            $userEmailPlaceholder.textContent = user.email || '';
            $loginView.classList.add('hidden');
            $registerView.classList.add('hidden');
            $verificationView.classList.remove('hidden');
            $overlay.classList.add('open');
            $overlay.setAttribute('aria-hidden', 'false');
            $headerLogoutBtn.style.display = 'none';
            this.startVerificationCheck();
          }
        } else {
          this.stopVerificationCheck();
          if (firestoreUnsubscribe) {
            firestoreUnsubscribe();
            firestoreUnsubscribe = null;
          }
          Store.clearState();
          $userEmailPlaceholder.textContent = '';
          $loginView.classList.remove('hidden');
          $registerView.classList.add('hidden');
          $verificationView.classList.add('hidden');
          $overlay.classList.add('open');
          $overlay.setAttribute('aria-hidden', 'false');
          $headerLogoutBtn.style.display = 'none';
          Renderer.render();
        }
      });
    },

    verificationInterval: null,
    startVerificationCheck() {
      if (this.verificationInterval) return;
      this.verificationInterval = setInterval(async () => {
        if (auth.currentUser) {
          await auth.currentUser.reload();
          if (auth.currentUser.emailVerified) {
            this.stopVerificationCheck();
            showToast('Email verified! Loading dashboard...');
            const user = auth.currentUser;
            const $overlay = document.getElementById('auth-overlay');
            const $headerLogoutBtn = document.getElementById('btn-logout');
            $overlay.classList.remove('open');
            $overlay.setAttribute('aria-hidden', 'true');
            $headerLogoutBtn.style.display = 'block';
            this.setupDatabaseSync(user.uid);
          }
        }
      }, 3000);
    },
    stopVerificationCheck() {
      if (this.verificationInterval) {
        clearInterval(this.verificationInterval);
        this.verificationInterval = null;
      }
    },

    setupDatabaseSync(uid) {
      if (firestoreUnsubscribe) return;
      showToast('Syncing database...');
      firestoreUnsubscribe = onSnapshot(doc(db, "users", uid), async (docSnap) => {
        if (docSnap.exists()) {
          Store._state = docSnap.data();
          if (!Store._state.emailAlertsConfig || !Store._state.emailAlertsConfig.serviceId) {
            Store._state.emailAlertsConfig = JSON.parse(JSON.stringify(DEFAULT_ALERTS_CONFIG));
            Store._persist();
          }
          const onboardOverlay = document.getElementById('onboarding-overlay');
          if (!Store._state.name || !Store._state.semester || !Store._state.department) {
            onboardOverlay.classList.add('open');
            onboardOverlay.setAttribute('aria-hidden', 'false');
          } else {
            onboardOverlay.classList.remove('open');
            onboardOverlay.setAttribute('aria-hidden', 'true');
          }
        } else {
          Store._state = {
            courses: [],
            history: [],
            nextId: 1,
            emailAlertsConfig: JSON.parse(JSON.stringify(DEFAULT_ALERTS_CONFIG))
          };
          try {
            await setDoc(doc(db, "users", uid), Store._state);
            const onboardOverlay = document.getElementById('onboarding-overlay');
            onboardOverlay.classList.add('open');
            onboardOverlay.setAttribute('aria-hidden', 'false');
          } catch (e) {
            console.error('Error initializing user doc:', e);
          }
        }
        Renderer.render();
      }, (error) => {
        console.error("Firestore sync error:", error);
        showToast("Database connection error");
      });
    },

    getFriendlyError(code) {
      switch (code) {
        case 'auth/invalid-email': return 'Invalid email address';
        case 'auth/user-disabled': return 'This account has been disabled';
        case 'auth/user-not-found': return 'Account not found';
        case 'auth/wrong-password': return 'Incorrect password';
        case 'auth/invalid-credential': return 'Incorrect email or password';
        case 'auth/email-already-in-use': return 'Email already registered';
        case 'auth/weak-password': return 'Password is too weak (min 6 chars)';
        case 'auth/network-request-failed': return 'Network error. Check connection';
        case 'auth/configuration-not-found': return 'Email/Password sign-in is disabled in Firebase Console. Please enable it.';
        default: return null;
      }
    }
  };

  const AlertManager = {
    async checkAndSendAlert(course, comp) {
      const config = Store._state.emailAlertsConfig;
      if (!config || !config.enabled || !config.serviceId || !config.templateId || !config.publicKey) return;
      const metrics = MathEngine.calc(comp.attended, comp.conducted);
      if (metrics.percentage >= 75) return;
      if (!config.alertHistory) config.alertHistory = {};
      const key = `${course.id}_${comp.type}`;
      const lastSent = config.alertHistory[key] || 0;
      const now = Date.now();
      if (now - lastSent < 24 * 60 * 60 * 1000) {
        console.log(`[AlertManager] Suppressed drop email alert for ${course.name} (${comp.type}) to limit rate.`);
        return;
      }
      try {
        emailjs.init(config.publicKey);
        const params = {
          to_email: auth.currentUser.email,
          to_name: Store._state.name || 'Student',
          subject_name: `${course.name} (${comp.type === 'theory' ? 'Theory' : 'Lab'})`,
          course_name: `${course.name} (${comp.type === 'theory' ? 'Theory' : 'Lab'})`,
          current_percentage: Math.round(metrics.percentage),
          percentage: Math.round(metrics.percentage)
        };
        await emailjs.send(config.serviceId, config.templateId, params);
        console.log(`[AlertManager] Attendance alert email sent for ${course.name}`);
        config.alertHistory[key] = now;
        Store._persist();
        showToast(`Email alert sent for ${course.name}!`);
      } catch (e) {
        console.error('[AlertManager] Failed to trigger email alert:', e);
      }
    }
  };

  const Pomodoro = {
    timer: null,
    timeLeft: 1500, 
    isRunning: false,
    audio: null,

    init() {
      const $startBtn = document.getElementById('btn-pomo-start');
      const $pauseBtn = document.getElementById('btn-pomo-pause');
      const $resetBtn = document.getElementById('btn-pomo-reset');
      const $audioSelect = document.getElementById('pomo-audio-track');
      $startBtn.addEventListener('click', () => this.start());
      $pauseBtn.addEventListener('click', () => this.pause());
      $resetBtn.addEventListener('click', () => this.reset());
      $audioSelect.addEventListener('change', (e) => this.setAudioTrack(e.target.value));

      document.querySelectorAll('.pomo-mode-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          document.querySelectorAll('.pomo-mode-btn').forEach(b => b.classList.remove('active'));
          e.target.classList.add('active');
          this.setTime(parseInt(e.target.dataset.time, 10));
        });
      });
    },

    setTime(seconds) {
      this.pause();
      this.timeLeft = seconds;
      this.updateDisplay();
    },

    start() {
      if (this.isRunning) return;
      this.isRunning = true;
      document.getElementById('btn-pomo-start').disabled = true;
      document.getElementById('btn-pomo-pause').disabled = false;
      this.timer = setInterval(() => {
        this.timeLeft--;
        this.updateDisplay();
        if (this.timeLeft <= 0) {
          this.complete();
        }
      }, 1000);

      this.playAudio();
    },

    pause() {
      if (!this.isRunning) return;
      this.isRunning = false;
      clearInterval(this.timer);
      document.getElementById('btn-pomo-start').disabled = false;
      document.getElementById('btn-pomo-pause').disabled = true;
      this.pauseAudio();
    },

    reset() {
      this.pause();
      const activeMode = document.querySelector('.pomo-mode-btn.active');
      this.timeLeft = activeMode ? parseInt(activeMode.dataset.time, 10) : 1500;
      this.updateDisplay();
    },

    complete() {
      this.pause();
      showToast("⏱️ Focus session complete! Time to take a break.");
      const alarm = new Audio("https://assets.mixkit.co/active_storage/sfx/2869/2869-84.wav");
      alarm.play().catch(e => console.log('Audio alarm blocked by browser policy'));
    },

    updateDisplay() {
      const mins = Math.floor(this.timeLeft / 60);
      const secs = this.timeLeft % 60;
      document.getElementById('pomo-time').textContent = 
        `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    },

    setAudioTrack(track) {
      this.pauseAudio();
      if (track === 'none') {
        this.audio = null;
        return;
      }
      let src = '';
      if (track === 'lofi') src = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3';
      if (track === 'rain') src = 'https://archive.org/download/rain_loop/rain_loop.mp3';
      if (track === 'forest') src = 'https://archive.org/download/nature_sound_loop/nature_sound_loop.mp3';

      this.audio = new Audio(src);
      this.audio.loop = true;
      if (this.isRunning) {
        this.playAudio();
      }
    },

    playAudio() {
      if (this.audio) {
        this.audio.play().catch(e => {
          console.log('[Pomodoro] Audio playback blocked by user guest policy');
        });
      }
    },

    pauseAudio() {
      if (this.audio) {
        this.audio.pause();
      }
    }
  };

  const BunkSimulator = {
    init() {
      const $select = document.getElementById('sim-subject-select');
      const $slider = document.getElementById('sim-slider');
      const $valLabel = document.getElementById('sim-value-label');
      $select.addEventListener('change', () => {
        const key = $select.value;
        if (key) {
          $slider.disabled = false;
          $slider.style.opacity = '1';
          $slider.style.cursor = 'pointer';
        } else {
          $slider.disabled = true;
          $slider.style.opacity = '0.5';
          $slider.style.cursor = 'not-allowed';
          $slider.value = 0;
          $valLabel.textContent = '0';
        }
        this.runSimulation();
      });
      $slider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        $valLabel.textContent = val > 0 ? `+${val}` : `${val}`;
        this.runSimulation();
      });
    },

    populateOptions() {
      const $select = document.getElementById('sim-subject-select');
      const courses = Store.getCourses();
      const currentSelected = $select.value;
      $select.innerHTML = '<option value="">-- Choose Subject Component --</option>';
      courses.forEach(c => {
        c.components.forEach(comp => {
          const key = `${c.id}_${comp.type}`;
          const typeLabel = comp.type === 'theory' ? 'Theory' : 'Lab';
          $select.innerHTML += `<option value="${key}">${c.name} (${typeLabel})</option>`;
        });
      });
      if (currentSelected) {
        $select.value = currentSelected;
      }
    },

    runSimulation() {
      const $select = document.getElementById('sim-subject-select');
      const $slider = document.getElementById('sim-slider');
      const $results = document.getElementById('sim-results');
      const key = $select.value;
      if (!key) {
        $results.textContent = 'Select a subject component above to simulate.';
        return;
      }

      const [courseId, type] = key.split('_');
      const comp = Store.findComponent(parseInt(courseId, 10), type);
      if (!comp) return;

      const delta = parseInt($slider.value, 10);
      let simulatedAttended = comp.attended;
      let simulatedConducted = comp.conducted;

      if (delta > 0) {
        simulatedAttended += delta;
        simulatedConducted += delta;
      } else if (delta < 0) {
        simulatedConducted += Math.abs(delta);
      }

      const simMetrics = MathEngine.calc(simulatedAttended, simulatedConducted);
      const pct = simulatedConducted === 0 ? 100 : simMetrics.percentage;
      const currentMetrics = MathEngine.calc(comp.attended, comp.conducted);
      const colorClass = simMetrics.isSafe ? 'var(--safe)' : 'var(--danger)';
      const currentPct = comp.conducted === 0 ? 100 : currentMetrics.percentage;

      let resultText = `<div style="margin-bottom:8px;">Current: <strong>${Math.round(currentPct)}%</strong>. Projected: <strong style="color:${colorClass}">${Math.round(pct)}%</strong>.</div>`;
      if (simMetrics.isSafe) {
        resultText += `<div style="margin-bottom:10px;">Simulation: <span style="color:var(--safe);font-weight:700;">SAFE</span>. You will have <strong>${simMetrics.safeBunks}</strong> safe bunks left.</div>`;
      } else {
        resultText += `<div style="margin-bottom:10px;">Simulation: <span style="color:var(--danger);font-weight:700;">SHORTAGE</span>. You will need to attend <strong>${simMetrics.requiredLectures}</strong> classes to recover.</div>`;
      }

      resultText += `<div style="border-top:1px solid var(--border); padding-top:8px; font-size:0.7rem; color:var(--text-secondary); text-align:left;">`;
      if (currentMetrics.isSafe) {
        resultText += `🎯 <strong>Threshold Forecast:</strong> You are currently above 75%. You can safely bunk the next <strong>${currentMetrics.safeBunks}</strong> classes consecutive.`;
      } else {
        resultText += `⚠️ <strong>Threshold Forecast:</strong> You are below 75%. You must attend the next <strong>${currentMetrics.requiredLectures}</strong> classes consecutive to hit 75%.`;
      }
      resultText += `</div>`;

      $results.innerHTML = resultText;
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    Renderer.init();
    Controller.init();
    GradientBG.init();
    Confetti.init();
    AuthManager.init();
    Pomodoro.init();
    BunkSimulator.init();

    onAuthStateChanged(auth, (user) => {
      const settingsBtn = document.getElementById('btn-settings');
      if (settingsBtn) {
        settingsBtn.style.display = user ? 'block' : 'none';
      }
    });

    console.log('[AttendX] Booted successfully with Pomodoro, Bunk Simulator, and Email Alerts.');
  });


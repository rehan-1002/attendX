# 📊 AttendX — Your College Attendance Companion

> A sleek, premium, and feature-rich attendance tracking web application built specifically for college students to monitor classes, simulate safety thresholds, manage assignments, and stay focused.

🖥️ **Live Demo:** [rehan-1002.github.io/attendX/](https://rehan-1002.github.io/attendX/)  
⚡ **Production URL:** [attend-pi.vercel.app](https://attend-pi.vercel.app)

---

## ✨ Features

*   **🔐 Firebase Authentication:** Secure email registration and sign-in with instant onboarding.
*   **🔄 Real-time Firestore Sync:** Automatic database sync for courses, timetables, profile configuration, and activity feeds.
*   **📊 Widescreen Welcome Banner:** Dynamic dashboard tagline displaying overall metrics and study focus quotes.
*   **🧮 Bunk Simulator & Threshold Calculator:** Simulate future attendance margins with directional controls (`Bunk ← 0 → Attend`) and get automated warnings/safety guidelines instantly.
*   **⏱️ Pomodoro Study Timer:** Tabbed timer widget featuring Focus/Break selectors and ambient background loops (Lofi, Gentle Rain, Forest Ambience).
*   **🗓️ Timetable Quick Check-ins:** Dynamically checks matching courses from today's schedule and renders quick check-in buttons (✓ / ✗) with interactive confetti animations.
*   **📋 Course Task Checklists:** Flip attendance cards to reveal a persistent checklist tracker for pending assignments and projects.
*   **🚨 Automatic Email Alerts:** Connect your EmailJS API keys in settings to receive automatic warnings if any subject drops below 75%.
*   **🎨 Premium Glassmorphic Design:** Smooth pastel gradient backgrounds, responsive flex grids, custom dark glass inputs, and vivid crimson indicators for shortage components.

---

## 🛠️ Technology Stack

*   **Core:** Semantic HTML5, Vanilla JavaScript (ES6 Modules)
*   **Styling:** Modern Vanilla CSS3, Google Fonts (Outfit)
*   **Database & Auth:** Firebase Authentication & Google Cloud Firestore (v10 SDK)
*   **Email Engine:** EmailJS integrations
*   **Hosting:** Vercel Production & GitHub Pages

---

## 🚀 Getting Started

### 1. Database Setup (Firestore Rules)
Initialize a **Cloud Firestore** database inside your Firebase Console and set these rules in the **Rules** tab to allow users to securely sync their data:
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

### 2. Local Execution
Simply open `index.html` in your browser (preferably using a local development server like VS Code Live Server) or clone the files directly. No build steps are required.

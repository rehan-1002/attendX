import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCRjZqgGb3BqMWMnzRvjFl44dhJxjt97zs",
  authDomain: "attend-4c0d0.firebaseapp.com",
  databaseURL: "https://attend-4c0d0-default-rtdb.firebaseio.com",
  projectId: "attend-4c0d0",
  storageBucket: "attend-4c0d0.firebasestorage.app",
  messagingSenderId: "633095442860",
  appId: "1:633095442860:web:08e08cdcac2c1cf6cfaa09"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };

/* =====================================================================
 * Firebase Configuration — SIGAP Lereng
 * Project : sigaplereng
 * Database: Cloud Firestore
 * ===================================================================== */

const firebaseConfig = {
  apiKey:            "AIzaSyBsU9m0ERFiLwb_BO2W-YA2SLc4yDHyKu4",
  authDomain:        "sigaplereng.firebaseapp.com",
  projectId:         "sigaplereng",
  storageBucket:     "sigaplereng.firebasestorage.app",
  messagingSenderId: "1021383021407",
  appId:             "1:1021383021407:web:74c3aaee7ec3a7bc105cea",
  measurementId:     "G-3DX1EQE6QE",
};

firebase.initializeApp(firebaseConfig);

/* Global Firestore instance — dipakai oleh laporan.js */
const db = firebase.firestore();

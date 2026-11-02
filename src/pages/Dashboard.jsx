// src/pages/Dashboard.jsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Calendar, Users, LogOut, Activity, BarChart3,
  MessageSquare, Clock, CheckCircle2, AlertCircle,
  Share2 // Icons for Patient Vitals
} from 'lucide-react';

// Firebase Imports
import { auth, db } from "../firebase";
import { signOut } from "firebase/auth";
import { doc, getDoc, onSnapshot, updateDoc } from "firebase/firestore";

import logo from "../assets/logo.png";

// Sub-components
import PatientsView from '../components/PatientsView';
import AppointmentsView from '../components/AppointmentsView';
import MessagesView from '../components/MessagesView';
import ShareDataView from '../components/ShareDataView';
import MyVitalsView from '../components/MyVitalsView';
import HistoryView from '../components/HistoryView';
import DoctorDashboardView from '../components/DoctorDashboardView';

const Dashboard = () => {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeNav, setActiveNav] = useState('dashboard');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [directMessageUser, setDirectMessageUser] = useState(null);

  // 1. FETCH REAL USER ROLE FROM FIREBASE
  useEffect(() => {
    let unsubscribeUserDoc = () => { };

    const unsubscribeAuth = auth.onAuthStateChanged((currentUser) => {
      // Always unsubscribe previous listener if auth state changes
      unsubscribeUserDoc();

      if (currentUser) {
        const docRef = doc(db, "users", currentUser.uid);
        // Use onSnapshot for real-time updates (e.g. when connecting to a doctor)
        unsubscribeUserDoc = onSnapshot(docRef, (docSnap) => {
          if (docSnap.exists()) {
            const newData = { ...docSnap.data(), uid: currentUser.uid };
            setUser(prev => {
              if (!prev) return newData;
              // Optimization: Ignore updates if only currentVitals changed
              // This prevents the whole dashboard from re-rendering 1/sec when device is streaming
              const { currentVitals: pV, ...pRest } = prev;
              const { currentVitals: nV, ...nRest } = newData;
              if (JSON.stringify(pRest) === JSON.stringify(nRest)) return prev;
              return newData;
            });
          }
          setLoading(false);
        });
      } else {
        setUser(null);
        navigate('/login');
        setLoading(false);
      }
    });

    return () => { unsubscribeAuth(); unsubscribeUserDoc(); };
  }, [navigate]);

  // 2. CLOCK & PATIENT SIMULATION LOOP
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 2000);

    return () => clearInterval(timer);
  }, [user]);

  // 3. MANAGE ONLINE STATUS (For Patients)
  useEffect(() => {
    if (user?.role === 'patient') {
      const userRef = doc(db, "users", user.uid);
      // Set Online on mount
      updateDoc(userRef, { isOnline: true }).catch(err => console.error("Error setting online:", err));

      // Set Offline on unmount
      return () => {
        updateDoc(userRef, { isOnline: false }).catch(err => console.error("Error setting offline:", err));
      };
    }
  }, [user?.uid, user?.role]);

  const handleLogout = async () => {
    if (user?.role === 'patient') {
      // Attempt to set offline before signing out
      try { await updateDoc(doc(db, "users", user.uid), { isOnline: false }); } catch (e) { /* ignore */ }
    }
    await signOut(auth);
    navigate('/login');
  };

  const handleDirectMessage = (patient) => {
    setDirectMessageUser(patient);
    setActiveNav('message');
  };

  // --- RENDER CONTENT: DOCTOR ---
  const renderDoctorContent = () => {
    switch (activeNav) {
      case 'dashboard':
        return <DoctorDashboardView currentUser={user} />;
      case 'patients': return <PatientsView currentUser={user} onMessageClick={handleDirectMessage} />;
      case 'appointments': return <AppointmentsView currentUser={user} />;
      case 'message': return <MessagesView currentUser={user} initialSelectedUser={directMessageUser} />;
      default: return <div>Select an option</div>;
    }
  };

  // --- RENDER CONTENT: PATIENT ---
  const renderPatientContent = () => {
    switch (activeNav) {
      case 'message':
        return <MessagesView currentUser={user} />;
      case 'share':
        return <ShareDataView currentUser={user} />;
      case 'analysis':
      case 'history':
        return <HistoryView currentUser={user} />;
      case 'appointments':
        return <AppointmentsView currentUser={user} />;
      case 'dashboard':
      default:
        return <MyVitalsView currentUser={user} setActiveNav={setActiveNav} />;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-slate-500 text-lg font-medium">Loading...</p>
        </div>
      </div>
    );
  }

  // Define Menu Items based on Role
  const doctorNav = [
    { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
    { id: 'patients', label: 'My Patients', icon: Users },
    { id: 'appointments', label: 'Appointments', icon: Calendar },
    { id: 'message', label: 'Messages', icon: MessageSquare },
  ];

  const patientNav = [
    { id: 'dashboard', label: 'My Vitals', icon: Activity },
    { id: 'analysis', label: 'Analysis', icon: BarChart3 },
    { id: 'appointments', label: 'Appointments', icon: Calendar },
    { id: 'message', label: 'Consult Doctor', icon: MessageSquare },
    { id: 'share', label: 'Share Data', icon: Share2 },
  ];

  const navItems = user?.role === 'doctor' ? doctorNav : patientNav;

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans text-slate-900">
      {/* Sidebar (Common for both, but items change) */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col hidden md:flex z-20 shadow-sm">
        <div className="h-20 flex items-center px-6 border-b border-slate-100">
          <div className="flex items-center gap-2">
            {/* Replace with your actual logo or keep the image */}
            <img src={logo} alt="MediSense" className="h-12 w-auto object-contain" />
          </div>
        </div>

        <nav className="flex-1 py-6 px-3 space-y-1 overflow-y-auto">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => {
                setActiveNav(item.id);
                setDirectMessageUser(null);
              }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 ${activeNav === item.id
                ? 'bg-blue-100 text-blue-700 shadow-sm ring-1 ring-blue-100'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
            >
              <item.icon size={20} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="p-4 border-t border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-3 mb-4 px-2">
            <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-sm shadow-sm border border-blue-200">
              {user?.fullName?.split(' ').map(n => n[0]).join('') || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-slate-900 truncate">{user?.fullName || 'User'}</p>
              <p className="text-xs text-slate-500 capitalize truncate">{user?.role || 'Member'}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-medium text-slate-700 hover:bg-red-50 hover:text-red-600 hover:border-red-100 transition-colors shadow-sm"
          >
            <LogOut size={18} /> Logout
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto relative scroll-smooth">
        <div className="max-w-7xl mx-auto p-4 md:p-8 space-y-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white/80 backdrop-blur-md p-4 rounded-2xl border border-slate-200/60 shadow-sm">
            <div>
              <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">Hello, {user?.role === 'doctor' ? 'Dr. ' : ''}{user?.fullName?.split(' ')[0]}!</h1>
              <p className="text-sm text-slate-500">{user?.role === 'doctor' ? "Here's your daily overview" : "Here are your live health vitals"}</p>
            </div>
            <div className="flex items-center gap-3 bg-white px-3 py-2 rounded-xl border border-slate-100 shadow-sm">
              <div className="p-1.5 bg-blue-50 text-blue-600 rounded-lg">
                <Clock size={18} />
              </div>
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Current Time</p>
                <p className="text-base font-bold text-slate-900 tabular-nums leading-none">{currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            </div>
          </div>

          <div className="min-h-[500px]">
            {user?.role === 'doctor' ? renderDoctorContent() : renderPatientContent()}
          </div>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;

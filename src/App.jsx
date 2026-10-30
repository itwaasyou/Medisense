import { BrowserRouter, Routes, Route } from "react-router-dom";
import './App.css'
import Home from './Home';
import Layout from "./components/Layout";
import Features from "./pages/features";
import About from "./pages/About";
import Contact from "./pages/Contact";
import Signup from "./pages/Signup";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import { firebaseConfigured } from "./firebase";

function FirebaseSetupRequired() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <section className="max-w-lg text-center">
        <h1 className="text-2xl font-bold text-gray-900">Firebase setup required</h1>
        <p className="mt-3 text-gray-600">
          Add the Firebase values listed in the README to a root-level .env.local file, then restart the app.
        </p>
      </section>
    </main>
  );
}

function App() {
  

  return (
    <BrowserRouter>
      <Routes>
        {/* Default page → Login */}
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path='/features' element={<Features />} />
          <Route path='/About' element={<About />} />
          <Route path="/contact" element={<Contact />} /> 

        </Route>
        
        {/* Signup page */}
        <Route path="/signup" element={firebaseConfigured ? <Signup /> : <FirebaseSetupRequired />} />
        <Route path='/Login' element={firebaseConfigured ? <Login /> : <FirebaseSetupRequired />} />
        <Route path="/Dashboard" element={firebaseConfigured ? <Dashboard /> : <FirebaseSetupRequired />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App

import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import type { User } from './api';
import { getMe } from './api';

export default function App() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem('ace_token'));
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  // On mount, if there's a token, validate it via /auth/me.
  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    getMe(token)
      .then((u) => setUser(u))
      .catch(() => {
        sessionStorage.removeItem('ace_token');
        setToken(null);
      })
      .finally(() => setLoading(false));
  }, [token]);

  function handleLoginSuccess(newToken: string, newUser: User) {
    sessionStorage.setItem('ace_token', newToken);
    setToken(newToken);
    setUser(newUser);
    navigate('/dashboard');
  }

  function handleLogout() {
    sessionStorage.removeItem('ace_token');
    setToken(null);
    setUser(null);
    navigate('/login');
  }

  if (loading) return <div className="centered">Loading…</div>;

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/dashboard" /> : <Login onSuccess={handleLoginSuccess} />}
      />
      <Route
        path="/dashboard"
        element={user ? <Dashboard user={user} onLogout={handleLogout} /> : <Navigate to="/login" />}
      />
      <Route path="*" element={<Navigate to={user ? '/dashboard' : '/login'} />} />
    </Routes>
  );
}

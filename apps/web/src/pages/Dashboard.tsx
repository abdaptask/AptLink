import type { User } from '../api';

interface Props {
  user: User;
  onLogout: () => void;
}

export default function Dashboard({ user, onLogout }: Props) {
  return (
    <div className="dashboard">
      <header>
        <h1>ACE Dialer</h1>
        <button className="link" onClick={onLogout}>Sign out</button>
      </header>

      <main>
        <section className="card">
          <h2>Welcome, {user.firstName ?? user.email}</h2>
          <p className="muted">You are signed in to the new ACE Dialer.</p>

          <dl className="kv">
            <dt>User ID</dt><dd>{user.id}</dd>
            <dt>Email</dt><dd>{user.email}</dd>
            <dt>Name</dt><dd>{user.firstName} {user.lastName}</dd>
            <dt>Role</dt><dd>{user.isAdmin ? 'Admin' : 'User'}</dd>
          </dl>
        </section>

        <section className="card">
          <h3>Coming next</h3>
          <ul>
            <li>SIP registration against Telnyx</li>
            <li>Dialer keypad + place call</li>
            <li>Chat / SMS</li>
            <li>Voicemail list + playback</li>
            <li>JobDiva candidate lookup</li>
          </ul>
        </section>
      </main>
    </div>
  );
}

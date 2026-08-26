// Shown instead of the login screen or the app to anyone who isn't an admin
// while maintenance mode is on (App.jsx). Admins bypass this entirely, so
// whoever turned it on can still reach the toggle to turn it back off.
export default function MaintenanceScreen() {
  return (
    <div className="login-wrap">
      <div className="panel login-panel">
        <div className="wordmark" style={{ marginBottom: 18 }}>
          <img className="wordmark-logo" src="/sales-logo-light.svg" alt="Scytale Sales" />
          <span className="wordmark-rule" />
          <span className="wordmark-text">Prospector</span>
        </div>

        <h2>Down for maintenance</h2>
        <p className="muted">
          We're doing some work behind the scenes. This won't take long — check back shortly.
        </p>
      </div>
    </div>
  );
}
